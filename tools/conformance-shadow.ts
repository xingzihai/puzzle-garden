/* eslint-disable max-lines -- 证据聚合、datum 与磁盘 / 内存入口共享同一份适配器契约。 */
/**
 * Phase 1 Wave 2 / V3 / Wave 3B S1：构建自证影子适配器（仅报告）。
 *
 * 复用 conformance-diff 的同一份报告口径（含 evaluateOpenings 的 grid-backed 洞口证据），
 * 写入 conformance-diff.json + conformance-evidence.json；不修改构建 outcome / exit code，
 * 不向模型注入提示，不接入 submit。所有错误收口为 `error`，不抛出。
 *
 * 入口：computeShadowConformance / computeShadowForRun 走磁盘存档；computeShadowForArchive
 * 收已读出的存档字节，仍走同一条 canonical diff 路径，供 check_code 等中性调用点复用。
 *
 * V2 证据 schema 仍是提案（schemaVersion: 2）；本文件不修改 object-diff / interaction 的共享类型。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import { loadRegistry } from '@pg/blocks/load';
import { readArchive } from '@pg/core/archive';
import type { Grid } from '@pg/core/grid';
import type { BuildSpec } from '@pg/interaction/schema';

import type {
  MustClauseEvaluation,
  MustClauseEvaluationSummary,
  MustClauseEvidence,
  MustClauseGroupEvidence,
} from '../packages/interaction/src/must-clause.ts';
import { adoptVerifiedMustMapping, buildBuildSheet, isVerifiedMustMapping } from './build-sheet.ts';
import { buildConformanceDiffReport, loadArchive, loadSpec } from './conformance-diff.ts';
import type { ConformanceDiffReport } from './conformance-diff.ts';
import { evaluateCoverage } from './coverage-evidence.ts';
import type { CoverageCheckResult, CoverageEvidence } from './coverage-evidence.ts';
import { evaluateMustClauses } from './must-clause-evidence.ts';

export type MustEvidenceStatus = 'met' | 'not-met' | 'waived' | 'unverified';
export type MustEvidenceConfidence = 'high' | 'medium' | 'low';
export type EvidenceKind = 'geometry' | 'diff' | 'check' | 'render' | 'waiver';

export type EntryTransition = 'flush' | 'one-step' | 'unknown';

/** 与 ReviewMustEvidence 的 objects / evidence 上限一致；状态仍按全部链接计算。 */
export const MAX_EVIDENCE_LINKS = 50;

/**
 * 统一标高合同。只保留 FloorDatum 的明确字段；不再暴露 / 依赖歧义的 floorY。
 * slabTopY 是结构楼板顶所在格，楼板占 [slabTopY, standingY)。
 */
export interface EvidenceDatum {
  readonly slabTopY: number;
  readonly standingY: number;
  readonly gradeY: number;
  readonly entryTransition: EntryTransition;
  readonly floorThickness: number;
  readonly source: 'build-sheet' | 'build-spec' | 'floor-datum';
}

export interface EvidenceObjectRef {
  readonly expectedId: string;
  readonly actualId: string | null;
  readonly status: string;
  readonly severity: string;
}

export interface EvidenceRef {
  readonly kind: EvidenceKind;
  readonly ref: string;
  readonly summary: string;
}

export interface MustEvidence {
  readonly mustId: string;
  readonly text: string;
  readonly source: string;
  readonly status: MustEvidenceStatus;
  readonly confidence: MustEvidenceConfidence;
  readonly objects: readonly EvidenceObjectRef[];
  readonly evidence: readonly EvidenceRef[];
  /** 显式用户豁免；本轮不产生，留给后续冲突持久化。 */
  readonly waiver: { readonly conflictId: string; readonly by: 'user'; readonly choice: string } | null;
  readonly reason: string | null;
}

export interface ConformanceEvidence {
  readonly schemaVersion: 2;
  readonly tool: 'conformance-evidence';
  readonly mode: 'report-only';
  readonly generatedBy: 'conformance-shadow';
  /** BuildSheet 目前是启发式 must→object 链接；verified 留给 Build Lead 的显式映射。 */
  readonly mapping: 'heuristic' | 'verified';
  readonly datum: EvidenceDatum;
  readonly spec: {
    readonly schemeId: string;
    readonly schemeRevision: number;
    readonly sha256: string;
  };
  readonly archive: {
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly musts: readonly MustEvidence[];
  readonly summary: {
    readonly met: number;
    readonly notMet: number;
    readonly waived: number;
    readonly unverified: number;
    readonly acceptEligible: boolean;
  };
  /** 扁平 clause 证据，顺序与 plan 的 must / group 一致。 */
  readonly clauses: readonly MustClauseEvidence[];
  readonly clauseSummary: MustClauseEvaluationSummary;
  readonly clauseGroups: readonly MustClauseGroupEvidence[];
}

export interface VerifiedMustMapping {
  readonly schemaVersion: 1;
  readonly tool: 'verified-must-map';
  readonly mapping: 'verified';
  /** mapping 绑定的设计 revision；旧文件缺省时不能进入 verified 语义。 */
  readonly schemeRevision: number;
  /** schemeId -> mustId -> expected object ids。只用于显式验证过的 golden / 人工确认映射。 */
  readonly schemes: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

export interface ShadowConformanceInput {
  readonly specPath: string;
  readonly archivePath: string;
  readonly outDir: string;
  /** 显式 must→object 映射；提供时才允许把 linked pass 标成 met。 */
  readonly verifiedMapping?: VerifiedMustMapping;
  /** 从文件读取显式映射；与 verifiedMapping 二选一。 */
  readonly mappingPath?: string;
  /** 统一标高合同；可直接传 BuildSheet.datum；不传时从 BuildSpec 派生。 */
  readonly datum?: ShadowDatumInput;
}

/**
 * 统一标高输入：只收 BuildSheet / FloorDatum 的四个明确字段，`floorThickness` 与
 * `source` 由影子适配器派生；旧别名 `floorY` 不参与计算。
 */
export type ShadowDatumInput = Pick<EvidenceDatum, 'slabTopY' | 'standingY' | 'gradeY' | 'entryTransition'>;

/** 中性 check / delivery 接口：存档以字节传入，不依赖磁盘上的 building.pgar 路径。 */
export interface ShadowCheckInput {
  readonly specPath: string;
  readonly archive: Uint8Array;
  readonly outDir: string;
  /** 可直接传 BuildSheet.datum；不传时从 BuildSpec 派生。 */
  readonly datum?: ShadowDatumInput;
  /** 显式 must→object 映射；提供时才允许把 linked pass 标成 met。 */
  readonly verifiedMapping?: VerifiedMustMapping;
  /** 从文件读取显式映射；与 verifiedMapping 二选一。 */
  readonly mappingPath?: string;
}

export interface ShadowForRunInput {
  readonly specPath: string;
  readonly runDir: string;
  /** 默认写到 runDir；可显式指定其他目录。 */
  readonly outDir?: string;
  readonly verifiedMapping?: VerifiedMustMapping;
  readonly mappingPath?: string;
  readonly datum?: ShadowDatumInput;
}

export interface ShadowConformanceResult {
  readonly mode: 'report-only';
  readonly diffPath: string | null;
  readonly evidencePath: string | null;
  readonly report: ConformanceDiffReport | null;
  readonly evidence: ConformanceEvidence | null;
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkStatus(check: CoverageCheckResult): { readonly status: string; readonly severity: string } {
  return { status: check.status === 'pass' ? 'pass' : check.status, severity: 'hard' };
}

/**
 * 结构化 must → check 关联：只读 must id / check / kind（以及 spec 对象），不读文本。
 * 关联用于“失败传播”：即使 must 不在 allowlist / verifiedRefs，检查 hard fail 也必须 not-met。
 */
function linkedCheckIds(mustId: string, spec: BuildSpec): readonly string[] {
  const levelId = spec.levels[0]?.id ?? 'f1';
  const door = spec.openings.find((opening) => opening.kind !== 'window')?.id;
  const ids = new Set<string>();
  const add = (id: string): void => {
    ids.add(id);
  };
  if (mustId.includes('single-storey')) {
    add(`check:storey:${levelId}`);
    add('check:absence:stairs-basement');
  }
  if (mustId.includes('no-mezzanine')) add('check:absence:mezzanine');
  if (mustId.includes('no-partitions')) add('check:absence:partition');
  if (mustId.includes('no-glass-door')) {
    for (const side of ['north', 'east', 'south', 'west']) add(`check:schedule:${side}`);
    add('check:absence:glass-door');
  }
  if (mustId.includes('no-steps') || mustId.includes('entry-flush') || mustId.includes('entrance-from-north')) {
    if (door !== undefined) add(`check:flush:${door}`);
  }
  if (mustId.includes('door-clear')) {
    if (door !== undefined) add(`check:door-clear:${door}`);
  }
  if (mustId.includes('stone-base')) {
    add('check:material:base');
    add('check:absence:base-platform');
    if (door !== undefined) add(`check:flush:${door}`);
  }
  if (mustId.includes('wood-wall-column')) add('check:material:structure');
  if (mustId.includes('gable-tile-roof')) add('check:material:roof');
  if (mustId.includes('material-selection')) {
    add('check:material:structure');
    add('check:material:base');
    add('check:material:roof');
  }
  if (mustId.includes('eave-only') || mustId.includes('no-outdoor-zone')) add('check:absence:eave-platform');
  if (mustId.includes('counter-no-service')) add('check:absence:counter-service');
  if (mustId.includes('interior')) add(`check:clear:${levelId}`);
  if (mustId.includes('wall-thick') || mustId.includes('wall-1m')) add(`check:thickness:${levelId}`);
  if (mustId.includes('block-budget') || mustId.includes('budget'))
    add(`check:budget:${String(spec.budget.maxBlocks)}`);
  if (mustId.includes('door')) {
    add('check:schedule:north');
    if (door !== undefined) {
      add(`check:door-position:${door}`);
      add(`check:door-clear:${door}`);
    }
  }
  if (mustId.includes('window')) add('check:schedule:south');
  if (mustId.includes('seats')) {
    const seats = /seats-(\d+)/u.exec(mustId)?.[1];
    if (seats !== undefined) add(`check:seats:${seats}`);
  }
  return [...ids].sort();
}

function evidenceForVerifiedRefs(
  must: {
    readonly id: string;
    readonly text: string;
    readonly source: string;
  },
  report: ConformanceDiffReport,
  verifiedRefs: readonly string[] | undefined,
  spec: BuildSpec,
  coverage: CoverageEvidence,
): MustEvidence {
  const refs = [...new Set([...linkedCheckIds(must.id, spec), ...(verifiedRefs ?? [])])];
  const mappingVerified = verifiedRefs !== undefined && verifiedRefs.length > 0;
  const linked = report.items.filter((item) => item.expectedId !== null && refs.includes(item.expectedId));
  const furniture = coverage.furnitureItems.filter(
    (item) => item.expectedId !== null && refs.includes(item.expectedId),
  );
  const checks = coverage.checks.filter((check) => refs.includes(check.id));
  const covered = new Set<string>([
    ...linked.map((item) => item.expectedId ?? item.id),
    ...furniture.map((item) => item.expectedId ?? item.id),
    ...checks.map((check) => check.id),
  ]);
  const missingRefs = refs.filter((reference) => !covered.has(reference));

  const allObjects: EvidenceObjectRef[] = [
    ...linked.map((item) => ({
      expectedId: item.expectedId ?? item.id,
      actualId: item.actualId,
      status: item.status,
      severity: item.severity,
    })),
    ...furniture.map((item) => ({
      expectedId: item.expectedId ?? item.id,
      actualId: item.actualId,
      status: item.status,
      severity: item.severity,
    })),
    ...checks.map((check) => ({
      expectedId: check.id,
      actualId: null,
      status: checkStatus(check).status,
      severity: checkStatus(check).severity,
    })),
  ];
  const allEvidence: EvidenceRef[] = [
    ...linked.map((item) => ({
      kind: 'diff' as const,
      ref: `conformance-diff.json#${item.id}`,
      summary: item.reason ?? `${item.status}/${item.severity}`,
    })),
    ...furniture.map((item) => ({
      kind: 'diff' as const,
      ref: `coverage-evidence#${item.id}`,
      summary: item.reason ?? `${item.status}/${item.severity}`,
    })),
    ...checks.map((check) => ({
      kind: 'geometry' as const,
      ref: check.id,
      summary: check.reason ?? `${check.status}${check.evidence.length === 0 ? '' : `: ${check.evidence.join('; ')}`}`,
    })),
  ];
  // 状态看全部链接；输出数组按 consumer schema 上限截断。
  const objects = allObjects.slice(0, MAX_EVIDENCE_LINKS);
  const evidence = allEvidence.slice(0, MAX_EVIDENCE_LINKS);
  const omitted = linked.length + furniture.length + checks.length > MAX_EVIDENCE_LINKS;

  const hardFailure =
    linked.some((item) => item.severity === 'hard' && (item.status === 'fail' || item.status === 'missing')) ||
    furniture.some((item) => item.severity === 'hard' && (item.status === 'fail' || item.status === 'missing')) ||
    checks.some((check) => check.status === 'fail');
  if (hardFailure) {
    return {
      mustId: must.id,
      text: must.text,
      source: must.source,
      status: 'not-met',
      confidence: 'high',
      objects,
      evidence,
      waiver: null,
      reason: 'linked-object-hard-fail',
    };
  }
  const hardUnverified =
    linked.some((item) => item.severity === 'hard' && item.status === 'unverified') ||
    furniture.some((item) => item.severity === 'hard' && item.status === 'unverified') ||
    checks.some((check) => check.status === 'unverified') ||
    missingRefs.length > 0;
  if (hardUnverified || refs.length === 0) {
    return {
      mustId: must.id,
      text: must.text,
      source: must.source,
      status: 'unverified',
      confidence: 'medium',
      objects,
      evidence,
      waiver: null,
      reason: refs.length === 0 ? 'no-object-mapping' : 'linked-object-unverified',
    };
  }
  if (!mappingVerified) {
    return {
      mustId: must.id,
      text: must.text,
      source: must.source,
      status: 'unverified',
      confidence: 'medium',
      objects,
      evidence,
      waiver: null,
      reason: 'not-in-allowlist',
    };
  }
  return {
    mustId: must.id,
    text: must.text,
    source: must.source,
    status: 'met',
    confidence: 'high',
    objects,
    evidence,
    waiver: null,
    reason: omitted ? 'evidence-links-truncated-after-pass' : null,
  };
}

function mustEvidence(
  must: {
    readonly id: string;
    readonly text: string;
    readonly source: string;
    readonly objectIds: readonly string[];
  },
  report: ConformanceDiffReport,
  verifiedObjectIds: readonly string[] | undefined,
  spec: BuildSpec,
  coverage?: CoverageEvidence,
): MustEvidence {
  if (coverage !== undefined) {
    return evidenceForVerifiedRefs(must, report, verifiedObjectIds, spec, coverage);
  }
  const objectIds = new Set(must.objectIds);
  const linked = report.items.filter((item) => item.expectedId !== null && objectIds.has(item.expectedId));
  // 状态必须看全部链接；输出数组截断到 consumer schema 的上限，避免整个证据文件不可解析。
  const emitted = linked.slice(0, MAX_EVIDENCE_LINKS);
  const objects: EvidenceObjectRef[] = emitted.map((item) => ({
    expectedId: item.expectedId ?? item.id,
    actualId: item.actualId,
    status: item.status,
    severity: item.severity,
  }));
  const evidence: EvidenceRef[] = emitted.map((item) => ({
    kind: 'diff',
    ref: `conformance-diff.json#${item.id}`,
    summary: item.reason ?? `${item.status}/${item.severity}`,
  }));

  if (must.objectIds.length === 0) {
    return {
      mustId: must.id,
      text: must.text,
      source: must.source,
      status: 'unverified',
      confidence: 'low',
      objects,
      evidence,
      waiver: null,
      reason: 'no-object-mapping',
    };
  }
  if (linked.some((item) => item.severity === 'hard' && (item.status === 'fail' || item.status === 'missing'))) {
    return {
      mustId: must.id,
      text: must.text,
      source: must.source,
      status: 'not-met',
      confidence: 'high',
      objects,
      evidence,
      waiver: null,
      reason: 'linked-object-hard-fail',
    };
  }
  if (linked.some((item) => item.status === 'fail')) {
    return {
      mustId: must.id,
      text: must.text,
      source: must.source,
      status: 'unverified',
      confidence: 'medium',
      objects,
      evidence,
      waiver: null,
      reason: 'linked-object-soft-fail',
    };
  }
  if (linked.some((item) => item.status === 'unverified')) {
    return {
      mustId: must.id,
      text: must.text,
      source: must.source,
      status: 'unverified',
      confidence: 'medium',
      objects,
      evidence,
      waiver: null,
      reason: 'linked-object-unverified',
    };
  }
  if (linked.length > 0 && linked.every((item) => item.status === 'pass')) {
    // BuildSheet 的 must→object 链接是启发式的；几何 pass 不能单独把 must 标成 met。
    return {
      mustId: must.id,
      text: must.text,
      source: must.source,
      status: 'unverified',
      confidence: 'medium',
      objects,
      evidence,
      waiver: null,
      reason: 'heuristic-object-link-not-verified',
    };
  }
  return {
    mustId: must.id,
    text: must.text,
    source: must.source,
    status: 'unverified',
    confidence: 'low',
    objects,
    evidence,
    waiver: null,
    reason: 'linked-object-unmatched',
  };
}

function firstLevel(spec: BuildSpec): BuildSpec['levels'][number] {
  const level = [...spec.levels].sort((a, b) => a.elevation - b.elevation)[0];
  if (level === undefined) throw new Error('BuildSpec.levels is empty');
  return level;
}

function siteTopY(spec: BuildSpec, standingY: number): number {
  const min = spec.siteBounds.min[1];
  const max = spec.siteBounds.max[1];
  return max <= standingY ? max : min + 1;
}

/** 优先复用 BuildSheet 的统一 FloorDatum 字段；只有拿不到 sheet 时才从 BuildSpec 派生。 */
export function deriveEvidenceDatum(spec: BuildSpec, sheetDatum?: unknown): EvidenceDatum {
  if (typeof sheetDatum === 'object' && sheetDatum !== null) {
    const datum = sheetDatum as {
      readonly slabTopY?: unknown;
      readonly standingY?: unknown;
      readonly gradeY?: unknown;
      readonly entryTransition?: unknown;
    };
    if (
      typeof datum.slabTopY === 'number' &&
      typeof datum.standingY === 'number' &&
      typeof datum.gradeY === 'number' &&
      (datum.entryTransition === 'flush' || datum.entryTransition === 'one-step' || datum.entryTransition === 'unknown')
    ) {
      return {
        slabTopY: datum.slabTopY,
        standingY: datum.standingY,
        gradeY: datum.gradeY,
        entryTransition: datum.entryTransition,
        floorThickness: datum.standingY - datum.slabTopY,
        source: 'build-sheet',
      };
    }
  }
  const level = firstLevel(spec);
  const standingY = level.elevation;
  const floorThickness = spec.structure.floorThickness;
  const slabTopY = standingY - floorThickness;
  const gradeY = siteTopY(spec, standingY);
  const hasDoor = spec.openings.some((opening) => opening.kind !== 'window');
  const entryTransition: EntryTransition = !hasDoor
    ? 'unknown'
    : gradeY === standingY
      ? 'flush'
      : gradeY === standingY - 1
        ? 'one-step'
        : 'unknown';
  return { slabTopY, standingY, gradeY, entryTransition, floorThickness, source: 'build-spec' };
}

const EMPTY_CLAUSE_SUMMARY: MustClauseEvaluationSummary = {
  musts: 0,
  met: 0,
  notMet: 0,
  waived: 0,
  unverified: 0,
  leaves: 0,
  conflicts: 0,
  unattributedHardFails: [],
  globalBlockers: [],
  attributedHardFails: [],
};

function firstUnverifiedLeafReason(group: MustClauseGroupEvidence): string | null {
  return group.leaves.find((leaf) => leaf.status === 'unverified')?.reason ?? null;
}

/** clause group 是父 must 的唯一状态来源；证据与链接仍保留 heuristic 适配器的输出。 */
function applyClauseStatus(must: MustEvidence, group: MustClauseGroupEvidence): MustEvidence {
  if (group.status === 'met') {
    return { ...must, status: 'met', confidence: 'high', reason: null };
  }
  if (group.status === 'not-met') {
    return { ...must, status: 'not-met', confidence: 'high', reason: 'clause-hard-fail' };
  }
  if (group.status === 'waived') {
    return { ...must, status: 'waived', confidence: 'high', reason: 'clause-waived' };
  }
  return {
    ...must,
    status: 'unverified',
    confidence: 'medium',
    reason: firstUnverifiedLeafReason(group) ?? 'clause-unverified',
  };
}

export function buildConformanceEvidence(
  spec: BuildSpec,
  sheet: ReturnType<typeof buildBuildSheet>,
  report: ConformanceDiffReport,
  specSha256: string,
  archiveSha256: string,
  archiveBytes: number,
  verifiedMapping?: VerifiedMustMapping,
  datum?: EvidenceDatum,
  coverage?: CoverageEvidence,
  /** 生产 shadow 路径传入；直接调用可省略并保留旧 heuristic must 状态。 */
  clauseEvaluation?: MustClauseEvaluation,
): ConformanceEvidence {
  const resolvedDatum = datum ?? deriveEvidenceDatum(spec, sheet.datum);
  // 普通调用方手写的 mapping 不具 provenance：没有 builder / loader 登记时按 heuristic 处理。
  const provenancedMapping =
    verifiedMapping !== undefined &&
    isVerifiedMustMapping(verifiedMapping) &&
    verifiedMapping.schemeRevision === spec.schemeRevision
      ? verifiedMapping
      : undefined;
  const schemeMapping = provenancedMapping?.schemes[spec.schemeId];
  // verified 映射必须覆盖当前 scheme；只带其他 scheme 的映射文件不能让本方案变成 verified。
  const mappingVerified = schemeMapping !== undefined;
  const heuristicMusts = sheet.musts.map((must) =>
    mustEvidence(
      must,
      report,
      schemeMapping === undefined ? undefined : (schemeMapping[must.id] ?? []),
      spec,
      coverage,
    ),
  );
  const clauseGroupByMust = new Map((clauseEvaluation?.groups ?? []).map((group) => [group.mustId, group] as const));
  const musts = heuristicMusts.map((must) => {
    const group = clauseGroupByMust.get(must.mustId);
    return group === undefined ? must : applyClauseStatus(must, group);
  });
  const count = (status: MustEvidenceStatus): number => musts.filter((must) => must.status === status).length;
  const met = count('met');
  const notMet = count('not-met');
  const waived = count('waived');
  const unverified = count('unverified');
  return {
    schemaVersion: 2,
    tool: 'conformance-evidence',
    mode: 'report-only',
    generatedBy: 'conformance-shadow',
    mapping: mappingVerified ? 'verified' : 'heuristic',
    datum: resolvedDatum,
    spec: {
      schemeId: spec.schemeId,
      schemeRevision: spec.schemeRevision,
      sha256: specSha256,
    },
    archive: { sha256: archiveSha256, bytes: archiveBytes },
    musts,
    summary: {
      met,
      notMet,
      waived,
      unverified,
      acceptEligible:
        notMet === 0 &&
        unverified === 0 &&
        (clauseEvaluation?.summary.unattributedHardFails.length ?? 0) === 0 &&
        (clauseEvaluation?.summary.globalBlockers.length ?? 0) === 0,
    },
    clauses: clauseEvaluation === undefined ? [] : clauseEvaluation.groups.flatMap((group) => group.leaves),
    clauseSummary: clauseEvaluation?.summary ?? EMPTY_CLAUSE_SUMMARY,
    clauseGroups: clauseEvaluation?.groups ?? [],
  };
}

/** 从磁盘读取并 adopt verified mapping；测试 / CLI 也需要在 shadow 之外复用同一信任根。 */
export function loadVerifiedMapping(path: string): VerifiedMustMapping {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    (parsed as { tool?: unknown }).tool !== 'verified-must-map' ||
    (parsed as { mapping?: unknown }).mapping !== 'verified' ||
    typeof (parsed as { schemeRevision?: unknown }).schemeRevision !== 'number' ||
    typeof (parsed as { schemes?: unknown }).schemes !== 'object' ||
    (parsed as { schemes?: unknown }).schemes === null
  ) {
    throw new Error(`不是合法 verified-must-map：${path}`);
  }
  // 只有经过本 loader 形状校验的磁盘 mapping 才能进入 verified 语义；
  // 普通调用方手写对象在 buildConformanceEvidence 里仍会被当作 heuristic。
  return adoptVerifiedMustMapping(parsed);
}

function resolveVerifiedMapping(input: {
  readonly mappingPath?: string;
  readonly verifiedMapping?: VerifiedMustMapping;
}): VerifiedMustMapping | undefined {
  if (input.mappingPath !== undefined && input.verifiedMapping !== undefined) {
    throw new Error('mappingPath 与 verifiedMapping 只能提供一个');
  }
  return input.mappingPath === undefined ? input.verifiedMapping : loadVerifiedMapping(input.mappingPath);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** BuildSheet 四个统一字段 → EvidenceDatum；floorThickness / source 只在这里派生。 */
function normalizeShadowDatum(datum: ShadowDatumInput): EvidenceDatum {
  return {
    slabTopY: datum.slabTopY,
    standingY: datum.standingY,
    gradeY: datum.gradeY,
    entryTransition: datum.entryTransition,
    floorThickness: datum.standingY - datum.slabTopY,
    source: 'build-sheet',
  };
}

function failure(error: unknown): ShadowConformanceResult {
  return {
    mode: 'report-only',
    diffPath: null,
    evidencePath: null,
    report: null,
    evidence: null,
    error: errorMessage(error),
  };
}

interface ShadowArtifactsInput {
  readonly specPath: string;
  readonly spec: BuildSpec;
  readonly specSha256: string;
  readonly registry: ReturnType<typeof loadRegistry>;
  readonly grid: Grid;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
  readonly outDir: string;
  readonly verifiedMapping: VerifiedMustMapping | undefined;
  readonly datum: EvidenceDatum | undefined;
}

/** 已解码输入 → 同一份 canonical diff + evidence，并写两份 JSON。 */
function writeShadowArtifacts(input: ShadowArtifactsInput): ShadowConformanceResult {
  const graph = extractAsBuiltObjects(input.grid, input.registry);
  const report = buildConformanceDiffReport({
    spec: input.spec,
    grid: input.grid,
    registry: input.registry,
    graph,
    specPath: input.specPath,
    specSha256: input.specSha256,
    archivePath: input.archivePath,
    archiveSha256: input.archiveSha256,
    archiveBytes: input.archiveBytes,
  });
  const verifiedObjects = input.verifiedMapping?.schemes[input.spec.schemeId] ?? {};
  const sheet = buildBuildSheet(input.spec, verifiedObjects);
  const coverage = evaluateCoverage(input.spec, graph, input.grid, input.registry);
  const clauseEvaluation = evaluateMustClauses({
    spec: input.spec,
    graph,
    grid: input.grid,
    registry: input.registry,
    report,
    coverage,
  });
  const evidence = buildConformanceEvidence(
    input.spec,
    sheet,
    report,
    input.specSha256,
    input.archiveSha256,
    input.archiveBytes,
    input.verifiedMapping,
    input.datum,
    coverage,
    clauseEvaluation,
  );

  mkdirSync(input.outDir, { recursive: true });
  const diffPath = join(input.outDir, 'conformance-diff.json');
  const evidencePath = join(input.outDir, 'conformance-evidence.json');
  writeFileSync(diffPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return {
    mode: 'report-only',
    diffPath,
    evidencePath,
    report,
    evidence,
    error: null,
  };
}

/** 纯适配器：成功时写两份 JSON；任何读取 / 解析 / 写入错误都返回 error，不抛出。 */
export function computeShadowConformance(input: ShadowConformanceInput): ShadowConformanceResult {
  try {
    const verifiedMapping = resolveVerifiedMapping(input);
    const { spec, sha256: specSha256 } = loadSpec(input.specPath);
    const registry = loadRegistry();
    const { grid, sha256: archiveSha256, bytes } = loadArchive(input.archivePath, registry);
    return writeShadowArtifacts({
      specPath: input.specPath,
      spec,
      specSha256,
      registry,
      grid,
      archivePath: input.archivePath,
      archiveSha256,
      archiveBytes: bytes,
      outDir: input.outDir,
      verifiedMapping,
      datum: input.datum === undefined ? undefined : normalizeShadowDatum(input.datum),
    });
  } catch (error) {
    return failure(error);
  }
}

/** 存档没有磁盘路径时的稳定占位；身份以 sha256 为准。 */
const IN_MEMORY_ARCHIVE_PATH = '<archive-bytes>';

/**
 * 中性 check / delivery 入口：存档已读成字节，仍走与 buildConformanceDiffReport
 * 相同的 grid-backed 洞口路径；不抛错，不影响 outcome / exit / submit。
 */
export function computeShadowForArchive(input: ShadowCheckInput): ShadowConformanceResult {
  try {
    const verifiedMapping = resolveVerifiedMapping(input);
    const { spec, sha256: specSha256 } = loadSpec(input.specPath);
    const registry = loadRegistry();
    let grid: Grid;
    try {
      grid = readArchive(registry.table, input.archive).grid;
    } catch (error) {
      throw new Error(`无法解码内存存档：${errorMessage(error)}`, { cause: error });
    }
    return writeShadowArtifacts({
      specPath: input.specPath,
      spec,
      specSha256,
      registry,
      grid,
      archivePath: IN_MEMORY_ARCHIVE_PATH,
      archiveSha256: sha256Hex(input.archive),
      archiveBytes: input.archive.byteLength,
      outDir: input.outDir,
      verifiedMapping,
      datum: input.datum === undefined ? undefined : normalizeShadowDatum(input.datum),
    });
  } catch (error) {
    return failure(error);
  }
}

/** run 目录便捷入口；缺 delivery/building.pgar 时与坏存档一样返回 error。 */
export function computeShadowForRun(input: ShadowForRunInput): ShadowConformanceResult {
  const archivePath = join(input.runDir, 'delivery', 'building.pgar');
  if (!existsSync(archivePath)) {
    return {
      mode: 'report-only',
      diffPath: null,
      evidencePath: null,
      report: null,
      evidence: null,
      error: `缺 delivery/building.pgar：${archivePath}`,
    };
  }
  return computeShadowConformance({
    specPath: input.specPath,
    archivePath,
    outDir: input.outDir ?? input.runDir,
    ...(input.verifiedMapping === undefined ? {} : { verifiedMapping: input.verifiedMapping }),
    ...(input.mappingPath === undefined ? {} : { mappingPath: input.mappingPath }),
    ...(input.datum === undefined ? {} : { datum: input.datum }),
  });
}

/** 构建日志一行的影子摘要；不参与 outcome / exit code。 */
export function shadowSummaryLine(result: ShadowConformanceResult): string {
  if (result.error !== null) return `构建自证（影子，仅报告）：不可用：${result.error}`;
  const summary = result.report?.summary;
  if (summary === undefined) return '构建自证（影子，仅报告）：报告缺失';
  return `构建自证（影子，仅报告）：blocking=${String(summary.blockingCount)}，pass ${String(summary.pass)} / fail ${String(summary.fail)} / unverified ${String(summary.unverified)}；diff ${String(result.diffPath)}`;
}
