/**
 * ReviewEvidence / ReviewWaiver 的共享契约。
 *
 * 消费 Build Lead 的 conformance-evidence.json（schemaVersion 2），但不 import tools。
 * 定义共享结构，并提供 JSON 归一、must 映射、waiver 合并与接受门槛等纯函数。
 */
/* eslint-disable max-lines -- must 级与 clause 级证据解析、豁免归一共享同一份冻结契约，拆分会复制信任边界逻辑。 */
import { z } from 'zod';

import {
  MustClauseEvidence,
  MustClauseEvaluationSummary,
  MustClauseGroupEvidence,
  aggregateMustClauseStatus,
} from './must-clause.ts';
import type { MustClauseStatus } from './must-clause.ts';
import { ID_MAX, Identifier, TEXT_MAX, Text } from './primitives.ts';

export const ReviewMustStatus = z.enum(['met', 'not-met', 'unverified', 'waived']);
export type ReviewMustStatus = z.infer<typeof ReviewMustStatus>;

/** 用户显式豁免；revision + must 双绑定，新 revision 自动失效。 */
export const ReviewWaiver = z
  .strictObject({
    mustId: Identifier,
    designRevision: z.int().positive(),
    by: z.literal('user'),
    choice: Text,
    conflictId: Identifier.nullable(),
    note: Text.nullable(),
    /** 绑定到单个 clause leaf；缺省 / null 是旧版 must 级通配豁免。 */
    clauseId: Identifier.nullable().optional(),
  })
  .readonly();
export type ReviewWaiver = z.infer<typeof ReviewWaiver>;

export const ReviewEvidenceObject = z
  .strictObject({
    expectedId: Identifier,
    actualId: Identifier.nullable(),
    status: z.string().min(1).max(64),
    severity: z.string().min(1).max(64),
  })
  .readonly();
export type ReviewEvidenceObject = z.infer<typeof ReviewEvidenceObject>;

export const ReviewEvidenceRef = z
  .strictObject({
    kind: z.string().min(1).max(32),
    ref: z.string().min(1).max(4000),
    summary: Text,
  })
  .readonly();
export type ReviewEvidenceRef = z.infer<typeof ReviewEvidenceRef>;

export const ReviewMustEvidence = z
  .strictObject({
    mustId: Identifier,
    text: Text,
    source: z.string().min(1).max(64),
    status: ReviewMustStatus,
    confidence: z.enum(['high', 'medium', 'low']),
    objects: z.array(ReviewEvidenceObject).max(50).readonly(),
    evidence: z.array(ReviewEvidenceRef).max(50).readonly(),
    waiver: ReviewWaiver.nullable(),
    reason: Text.nullable(),
  })
  .readonly();
export type ReviewMustEvidence = z.infer<typeof ReviewMustEvidence>;

export const ReviewEvidenceFile = z
  .strictObject({
    schemaVersion: z.literal(2),
    tool: z.literal('conformance-evidence'),
    mode: z.literal('report-only'),
    generatedBy: z.string().min(1).max(64),
    /** heuristic 只能产生 unverified；verified 才允许 met。 */
    mapping: z.enum(['heuristic', 'verified']),
    spec: z
      .strictObject({
        schemeId: Identifier,
        schemeRevision: z.int().positive(),
        sha256: z.string().min(1).max(128),
      })
      .readonly(),
    archive: z
      .strictObject({
        sha256: z.string().min(1).max(128),
        bytes: z.int().nonnegative(),
      })
      .readonly(),
    datum: z
      .strictObject({
        slabTopY: z.int(),
        standingY: z.int(),
        gradeY: z.int(),
        entryTransition: z.enum(['flush', 'one-step', 'unknown']),
        floorThickness: z.int().positive(),
        source: z.enum(['build-sheet', 'build-spec', 'floor-datum']),
      })
      .readonly(),
    musts: z.array(ReviewMustEvidence).max(300).readonly(),
    /** must clause 证据；旧生产者缺省，resolver 保持原来的 must 级路径。 */
    clauses: z.array(MustClauseEvidence).max(2000).readonly().optional(),
    clauseGroups: z.array(MustClauseGroupEvidence).max(300).readonly().optional(),
    clauseSummary: MustClauseEvaluationSummary.optional(),
    clauseCompilerVersion: z.string().min(1).max(64).optional(),
    summary: z
      .strictObject({
        met: z.int().nonnegative(),
        notMet: z.int().nonnegative(),
        waived: z.int().nonnegative(),
        unverified: z.int().nonnegative(),
        acceptEligible: z.boolean(),
      })
      .readonly(),
  })
  .readonly();
export type ReviewEvidenceFile = z.infer<typeof ReviewEvidenceFile>;

export const ReviewEvidenceSummary = z
  .strictObject({
    total: z.int().nonnegative(),
    met: z.int().nonnegative(),
    notMet: z.int().nonnegative(),
    waived: z.int().nonnegative(),
    unverified: z.int().nonnegative(),
    acceptEligible: z.boolean(),
  })
  .readonly();
export type ReviewEvidenceSummary = z.infer<typeof ReviewEvidenceSummary>;

export type ReviewMustConfidence = ReviewMustEvidence['confidence'];

/** BuildSpec.musts 的最小结构；review-evidence 不反向 import build.ts。 */
export interface ReviewMustSource {
  readonly id: string;
  readonly text: string;
  readonly source: string;
}

/** 单条必须项在 ReviewReport 中的解析结果；review.ts 用同名字段落 schema。 */
export interface ResolvedReviewMust {
  readonly requirementId: string;
  readonly status: ReviewMustStatus;
  readonly note: string | null;
  readonly text: string;
  readonly source: string | null;
  readonly confidence: ReviewMustConfidence | null;
  readonly objects: readonly ReviewEvidenceObject[];
  readonly evidence: readonly ReviewEvidenceRef[];
  readonly waiver: ReviewWaiver | null;
  readonly reason: string | null;
  readonly clauses: readonly MustClauseEvidence[];
}

export interface ResolveReviewMustsInput {
  readonly schemeId: string;
  readonly designRevision: number;
  readonly musts: readonly ReviewMustSource[];
  /** 缺省 / null 表示没有 conformance-evidence.json（旧路径），全部 unverified。 */
  readonly evidence?: ReviewEvidenceFile | null;
  /** 显式用户豁免；即使证据文件缺失也可以把对应 must 标成 waived。 */
  readonly waivers?: readonly ReviewWaiver[];
  /** 当前 BuildSpec 原始字节的 sha256；提供时必须与证据文件完全一致。 */
  readonly specSha256?: string;
  /** 当前 building.pgar 原始字节的 sha256；提供时必须与证据文件完全一致。 */
  readonly archiveSha256?: string;
  /** 当前 BuildSheet 重新派生的 verified must id；缺省时 verified 证据不成立。 */
  readonly verifiedMustIds?: readonly string[];
}

/** 证据文件必须同时绑定到当前 spec / archive 字节；缺省字段表示不校验该项。 */
export interface ReviewEvidenceArtifacts {
  readonly specSha256?: string;
  readonly archiveSha256?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampText(value: string): string {
  return value.length <= TEXT_MAX ? value : value.slice(0, TEXT_MAX);
}

/**
 * 把 Build Lead 的 conformance-evidence.json 归一成共享契约。
 *
 * 生产者的当前版本省略可选的 waiver 字段，且旧 waiver 只有 conflictId / by / choice；
 * 这里只补齐契约要求、不补造判定：status / objects / evidence / reason 原样保留。
 */
export function parseReviewEvidenceFile(value: unknown): ReviewEvidenceFile {
  if (!isRecord(value) || !Array.isArray(value['musts'])) return ReviewEvidenceFile.parse(value);
  const spec = isRecord(value['spec']) ? value['spec'] : null;
  const revision = spec === null ? undefined : spec['schemeRevision'];
  const rawMusts = value['musts'] as unknown[];
  const musts: unknown[] = rawMusts.map((must) => {
    if (!isRecord(must)) return must;
    const mustId = typeof must['mustId'] === 'string' ? must['mustId'] : undefined;
    return { ...must, waiver: normalizeWaiver(must['waiver'], mustId, revision) };
  });
  return ReviewEvidenceFile.parse({ ...value, musts });
}

/** 读文件后的安全入口：结构不合法时返回 null，让评审走“全部 unverified”的旧路径。 */
export function safeParseReviewEvidenceFile(value: unknown): ReviewEvidenceFile | null {
  try {
    return parseReviewEvidenceFile(value);
  } catch {
    return null;
  }
}

function normalizeWaiver(value: unknown, mustId: string | undefined, revision: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return value;
  // 旧生产者 waiver 缺 mustId / designRevision / note；其余字段不补造。
  return {
    mustId: typeof value['mustId'] === 'string' ? value['mustId'] : mustId,
    designRevision: typeof value['designRevision'] === 'number' ? value['designRevision'] : revision,
    by: value['by'],
    choice: value['choice'],
    conflictId: value['conflictId'] ?? null,
    note: value['note'] ?? null,
    // 旧对象没有 clauseId：保留缺省，避免把 legacy 通配豁免变成显式 leaf 绑定。
    ...(value['clauseId'] === undefined ? {} : { clauseId: value['clauseId'] }),
  };
}

export function reviewEvidenceMatchesDesign(
  evidence: ReviewEvidenceFile,
  schemeId: string,
  designRevision: number,
): boolean {
  return evidence.spec.schemeId === schemeId && evidence.spec.schemeRevision === designRevision;
}

/**
 * 证据必须绑定到当前 spec / archive 的原始字节哈希。
 * 只校验调用方提供的字段；未提供哈希的旧路径保持兼容，但网页构建入口会强制提供两者。
 */
export function reviewEvidenceMatchesArtifacts(
  evidence: ReviewEvidenceFile,
  expected: ReviewEvidenceArtifacts,
): boolean {
  // 低层 helper 也 fail closed：缺任一项绑定都不能算匹配。
  if (expected.specSha256 === undefined || expected.archiveSha256 === undefined) return false;
  return evidence.spec.sha256 === expected.specSha256 && evidence.archive.sha256 === expected.archiveSha256;
}

/** 显式豁免必须同时绑定 must 与 design revision；新 revision 自动失效。 */
export function reviewWaiverApplies(waiver: ReviewWaiver, mustId: string, designRevision: number): boolean {
  return waiver.mustId === mustId && waiver.designRevision === designRevision;
}

/**
 * clause 级豁免：must / revision 仍须匹配；clauseId 缺省或 null 是旧版 must 级通配，
 * 只对 leaf 生效但永远不覆盖 met / not-met。
 */
export function reviewClauseWaiverApplies(
  waiver: ReviewWaiver,
  mustId: string,
  designRevision: number,
  clauseId: string,
): boolean {
  if (!reviewWaiverApplies(waiver, mustId, designRevision)) return false;
  return waiver.clauseId === null || waiver.clauseId === undefined || waiver.clauseId === clauseId;
}

function isHardFailure(object: ReviewEvidenceObject): boolean {
  return object.status === 'fail' && object.severity === 'hard';
}

function hasHardFailure(entry: ReviewMustEvidence): boolean {
  return entry.objects.some(isHardFailure);
}

type MustSubject = 'wall' | 'slab' | 'roof' | 'opening' | 'site' | 'furniture';

const SUBJECT_TOKENS: Readonly<Record<MustSubject, readonly string[]>> = {
  wall: ['墙', '柱', '立面', '基座', '石基'],
  slab: ['楼板', '地面', '地坪', '楼面', '基座', '石基'],
  roof: ['屋面', '屋顶', '瓦', '出檐', '檐', '坡屋', '脊'],
  opening: ['门', '窗', '洞口', '净空', '入口', '台阶', '坡道', '门槛'],
  site: ['场地', '道路', '铺装', '庭院', '室外', '院'],
  furniture: ['桌', '凳', '柜台', '椅', '沙发', '床', '衣柜', '书架', '柜'],
};

/** 家具类必须项只能由家具对象的直接失败证明；run-9 的墙 / 洞口失败不归因到长桌 / 柜台 / 长凳。 */
const FURNITURE_TOKENS = ['桌', '凳', '柜台', '椅', '沙发', '床', '衣柜', '书架', '柜'] as const;

/**
 * 否定 / 禁止型措辞：这类必须项要求“不要出现某个对象”，
 * 一个无关对象的 hard fail 不能证明禁止项被违反，启发式归因一律不成立。
 */
const NEGATIVE_MUST_TOKENS = [
  '不设',
  '不做',
  '不得',
  '禁止',
  '无',
  '没有',
  '不新设',
  '不摆放',
  '不保留',
  '取消',
] as const;

const POSITIVE_PRESERVE_TOKENS = ['保留', '保持', '提供', '至少', '不得少于'] as const;

function isNegativeMust(text: string): boolean {
  const negativeAt = NEGATIVE_MUST_TOKENS.map((token) => text.indexOf(token)).filter((index) => index >= 0);
  if (negativeAt.length === 0) return false;
  const firstNegative = Math.min(...negativeAt);
  // “保留 1m 净空，该处不摆放家具”是正向保留要求，后置的禁止分句不能把整条判成否定项。
  const positiveAt = POSITIVE_PRESERVE_TOKENS.map((token) => text.indexOf(token)).filter((index) => index >= 0);
  return positiveAt.length === 0 || firstNegative < Math.min(...positiveAt);
}

function objectSubject(expectedId: string): MustSubject | null {
  const head = expectedId.split(':', 1)[0]?.toLowerCase() ?? '';
  switch (head) {
    case 'wall':
    case 'slab':
    case 'roof':
    case 'opening':
    case 'site':
    case 'furniture':
      return head;
    default:
      return null;
  }
}

function mustSubjects(text: string): ReadonlySet<MustSubject> {
  const found = new Set<MustSubject>();
  for (const [subject, tokens] of Object.entries(SUBJECT_TOKENS) as readonly (readonly [
    MustSubject,
    readonly string[],
  ])[]) {
    if (tokens.some((token) => text.includes(token))) found.add(subject);
  }
  return found;
}

/**
 * 启发式 hard fail 只有在直接归属时才成立：
 * - 否定 / 禁止型 must 不能由无关对象的 hard fail 反证，一律保持 unverified；
 * - 该 must 只有一个关联对象且 hard fail，或所有关联对象都 hard fail；
 * - 失败对象类型必须与 must 文本主题一致；家具必须项不接受墙 / 洞口代偿。
 */
function heuristicHardFailureAttributable(mustText: string, entry: ReviewMustEvidence): boolean {
  if (isNegativeMust(mustText)) return false;
  if (entry.objects.length === 0) return false;
  const hardFailures = entry.objects.filter(isHardFailure);
  if (hardFailures.length === 0) return false;
  if (entry.objects.length !== 1 && hardFailures.length !== entry.objects.length) return false;
  if (FURNITURE_TOKENS.some((token) => mustText.includes(token))) {
    return hardFailures.some((object) => objectSubject(object.expectedId) === 'furniture');
  }
  const subjects = mustSubjects(mustText);
  if (subjects.size === 0) return true;
  return hardFailures.some((object) => {
    const subject = objectSubject(object.expectedId);
    return subject !== null && subjects.has(subject);
  });
}

function evidenceStatus(
  mustText: string,
  entry: ReviewMustEvidence | null,
  mapping: ReviewEvidenceFile['mapping'] | null,
): ReviewMustStatus {
  if (entry === null || mapping === null) return 'unverified';
  switch (entry.status) {
    case 'met':
      // 启发式 must→object 链接的 pass 不能证明必须项通过。
      return mapping === 'verified' ? 'met' : 'unverified';
    case 'not-met':
      // 失败结论必须有直接 hard fail 证据；verified 映射可信任生产者的显式判定。
      return mapping === 'verified' || heuristicHardFailureAttributable(mustText, entry) ? 'not-met' : 'unverified';
    case 'waived':
      // 证据文件自己写 waived 但缺结构化豁免时不能成立。
      return 'unverified';
    case 'unverified':
      return 'unverified';
  }
}

function effectiveStatus(
  mustText: string,
  entry: ReviewMustEvidence | null,
  mapping: ReviewEvidenceFile['mapping'] | null,
  waiver: ReviewWaiver | null,
): ReviewMustStatus {
  const status = evidenceStatus(mustText, entry, mapping);
  // 证据已经给出 met / not-met 时，用户豁免不能改写结论；豁免只覆盖 unverified。
  if (status === 'met' || status === 'not-met') return status;
  return waiver === null ? status : 'waived';
}

function reasonSummary(entry: ReviewMustEvidence): string {
  switch (entry.reason) {
    case 'no-object-mapping':
      return 'conformance 证据没有 must→object 映射';
    case 'heuristic-object-link-not-verified':
      return 'conformance 映射为启发式（heuristic），对象通过不能判定必须项通过';
    case 'linked-object-hard-fail':
      return 'conformance 关联对象存在 hard fail';
    case 'linked-object-soft-fail':
      return 'conformance 关联对象只有 soft fail，未达到必须项失败门槛';
    case 'linked-object-unverified':
      return 'conformance 关联对象仍未验证';
    case 'linked-object-unmatched':
      return 'conformance 未匹配到关联对象';
    case null:
      return '未提供足够的 conformance 证据';
    default:
      return entry.reason;
  }
}

function hardFailureSummary(entry: ReviewMustEvidence): string {
  const ids = entry.objects
    .filter((object) => object.status === 'fail' && object.severity === 'hard')
    .map((object) => object.expectedId)
    .slice(0, 5);
  return ids.length === 0 ? reasonSummary(entry) : `conformance 硬失败（hard fail）：${ids.join('、')}`;
}

function waiverNote(waiver: ReviewWaiver): string {
  const note = waiver.note === null ? '' : `；说明：${waiver.note}`;
  return clampText(`用户已豁免：${waiver.choice}${note}`);
}

type EvidenceMismatch = 'design' | 'artifacts' | 'provenance' | null;

function mismatchNote(mismatch: Exclude<EvidenceMismatch, null>): string {
  if (mismatch === 'design') return '未验证：conformance 证据与当前方案版本不一致';
  if (mismatch === 'provenance') return '未验证：conformance 证据的 mapping / met 状态与当前 BuildSheet 不一致';
  return '未验证：conformance 证据与当前 spec / archive 哈希不一致';
}

function noteFor(
  must: ReviewMustSource,
  entry: ReviewMustEvidence | null,
  status: ReviewMustStatus,
  mapping: ReviewEvidenceFile['mapping'] | null,
  mismatch: EvidenceMismatch,
  waiver: ReviewWaiver | null,
): string | null {
  if (status === 'waived') return waiver === null ? '用户已豁免' : waiverNote(waiver);
  if (entry === null) {
    if (mismatch !== null) return mismatchNote(mismatch);
    if (mapping === null) return `未验证：${must.id} 没有 conformance 证据`;
    return `未验证：conformance-evidence.json 中没有 ${must.id} 的证据`;
  }
  if (status === 'not-met') return clampText(`未通过：${hardFailureSummary(entry)}`);
  if (status === 'met') return null;
  if (entry.status === 'met' && mapping === 'heuristic') {
    return '未验证：conformance 映射为启发式（heuristic），对象通过不能判定必须项通过';
  }
  if (entry.status === 'not-met' && hasHardFailure(entry)) {
    return '未验证：启发式关联对象含 hard fail，但未形成对该必须项的直接证据（混合 pass/fail 或对象类型不匹配）';
  }
  if (entry.status === 'waived') return '未验证：证据标记 waived，但缺少用户豁免记录';
  return clampText(`未验证：${reasonSummary(entry)}`);
}

function waiverKey(mustId: string, clauseId: string | null | undefined): string {
  return `${mustId}\u0000${clauseId ?? '*'}`;
}

function collectWaivers(spec: ResolveReviewMustsInput, evidence: ReviewEvidenceFile | null): readonly ReviewWaiver[] {
  const found = new Map<string, ReviewWaiver>();
  if (evidence !== null) {
    for (const must of evidence.musts) {
      // 生产者当前可能省略 waiver 字段；这里按缺省 null 兼容，不假定对象已经过 parse。
      const waiver = (must as { readonly waiver?: ReviewWaiver | null }).waiver;
      if (waiver === null || waiver === undefined) continue;
      if (!reviewWaiverApplies(waiver, must.mustId, spec.designRevision)) continue;
      found.set(waiverKey(must.mustId, waiver.clauseId), waiver);
    }
  }
  for (const raw of spec.waivers ?? []) {
    // 调用方可能直接传 JSON 对象；缺省的可空字段按 null 归一后再走冻结 schema。
    const candidate = isRecord(raw) ? { ...raw, conflictId: raw.conflictId ?? null, note: raw.note ?? null } : raw;
    const parsed = ReviewWaiver.safeParse(candidate);
    if (!parsed.success || !reviewWaiverApplies(parsed.data, parsed.data.mustId, spec.designRevision)) continue;
    // 外部传入的显式用户豁免优先于证据文件里的副本（同 must + clause 键）。
    found.set(waiverKey(parsed.data.mustId, parsed.data.clauseId), parsed.data);
  }
  return [...found.values()];
}

function matchingClauseWaiver(
  waivers: readonly ReviewWaiver[],
  mustId: string,
  designRevision: number,
  clauseId: string,
): ReviewWaiver | null {
  let wildcard: ReviewWaiver | null = null;
  for (const waiver of waivers) {
    if (!reviewClauseWaiverApplies(waiver, mustId, designRevision, clauseId)) continue;
    // 显式 leaf 绑定优先于 legacy 通配；同键已由 collectWaivers 去重。
    if (waiver.clauseId === clauseId) return waiver;
    wildcard ??= waiver;
  }
  return wildcard;
}

function countClauseStatuses(clauses: readonly MustClauseEvidence[]): Readonly<Record<MustClauseStatus, number>> {
  const counts: Record<MustClauseStatus, number> = { met: 0, 'not-met': 0, unverified: 0, waived: 0 };
  for (const clause of clauses) counts[clause.status] += 1;
  return counts;
}

function clauseLeafIds(clauses: readonly MustClauseEvidence[], status: MustClauseStatus): string {
  return clauses
    .filter((clause) => clause.status === status)
    .map((clause) => clause.clauseId)
    .slice(0, 5)
    .join('、');
}

/**
 * clause 级 must 的备注：始终报告 leaf 数量与状态分布，避免 unverified leaf 被 parent 状态掩盖。
 * 只用中文逗号，不出现分号，便于 applyReviewWaivers 在豁免后替换这一段。
 */
export function reviewClauseNote(clauses: readonly MustClauseEvidence[]): string {
  const counts = countClauseStatuses(clauses);
  const details = [
    `met ${String(counts.met)}`,
    `not-met ${String(counts['not-met'])}`,
    `unverified ${String(counts.unverified)}`,
    `waived ${String(counts.waived)}`,
  ];
  if (counts['not-met'] > 0) details.push(`not-met leaf: ${clauseLeafIds(clauses, 'not-met')}`);
  if (counts.unverified > 0) details.push(`unverified leaf: ${clauseLeafIds(clauses, 'unverified')}`);
  if (counts.waived > 0) details.push(`waived leaf: ${clauseLeafIds(clauses, 'waived')}`);
  return clampText(`clause 证据：共 ${String(clauses.length)} 个 leaf（${details.join('，')}）`);
}

/** clause 级 parent 的机器 reason：hard fail 优先，其次未验证，最后豁免。 */
export function reviewClauseReason(
  status: MustClauseStatus,
  clauses: readonly MustClauseEvidence[],
  waiver: ReviewWaiver | null,
): string | null {
  if (status === 'met') return null;
  if (status === 'not-met') {
    const leaf = clauses.find((clause) => clause.status === 'not-met');
    return clampText(`clause-hard-fail: ${leaf?.reason ?? leaf?.clauseId ?? 'unknown'}`);
  }
  if (status === 'unverified') {
    const leaf = clauses.find((clause) => clause.status === 'unverified');
    return clampText(leaf?.reason ?? leaf?.clauseId ?? 'clause-unverified');
  }
  if (waiver === null) return 'clause-waived';
  const note = waiver.note === null ? '' : `（${waiver.note}）`;
  return clampText(`clause-waived: ${waiver.choice}${note}`);
}

function clauseObjects(clauses: readonly MustClauseEvidence[]): readonly ReviewEvidenceObject[] {
  const objects: ReviewEvidenceObject[] = [];
  const seen = new Set<string>();
  for (const clause of clauses) {
    for (const expectedId of clause.check.objectRefs) {
      // ReviewEvidenceObject.expectedId 是 Identifier（≤64），clause refs 允许更长；无法映射的跳过。
      if (expectedId.length > ID_MAX) continue;
      const key = `${expectedId}\u0000${clause.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      objects.push({
        expectedId,
        actualId: clause.status === 'met' || clause.status === 'not-met' ? expectedId : null,
        status: clause.status === 'met' ? 'pass' : clause.status === 'not-met' ? 'fail' : clause.status,
        severity: 'hard',
      });
      if (objects.length >= 50) return objects;
    }
  }
  return objects;
}

function clauseEvidenceRefs(clauses: readonly MustClauseEvidence[]): readonly ReviewEvidenceRef[] {
  const refs: ReviewEvidenceRef[] = [];
  for (const clause of clauses) {
    for (const ref of clause.evidence) {
      refs.push({ kind: ref.kind, ref: ref.ref, summary: ref.summary });
      if (refs.length >= 50) return refs;
    }
  }
  return refs;
}

function resolveClauseMust(
  must: ReviewMustSource,
  entry: ReviewMustEvidence | null,
  leaves: readonly MustClauseEvidence[],
  waivers: readonly ReviewWaiver[],
  designRevision: number,
): ResolvedReviewMust {
  let firstWaiver: ReviewWaiver | null = null;
  const clauses = leaves.map((leaf): MustClauseEvidence => {
    // 证据文件不能自证 waived；豁免只能来自本次用户输入。
    if (leaf.status === 'waived') {
      return {
        ...leaf,
        status: 'unverified' as const,
        reason: clampText('证据自称 waived，但没有用户豁免记录'),
      };
    }
    // conflict 是 spec 与 must 目标的硬冲突；不能被证据写成 met。
    if (leaf.status === 'met' && leaf.conflict !== null) {
      return {
        ...leaf,
        status: 'not-met' as const,
        reason: clampText(`conflict: ${leaf.conflict.message}`),
      };
    }
    if (leaf.status !== 'unverified') return leaf;
    const waiver = matchingClauseWaiver(waivers, must.id, designRevision, leaf.clauseId);
    if (waiver === null) return leaf;
    firstWaiver ??= waiver;
    // 保留原 reason 作为诊断，同时明确这是用户豁免而不是测量通过。
    const original = leaf.reason === null ? '' : `（原未验证原因：${leaf.reason}）`;
    return {
      ...leaf,
      status: 'waived' as const,
      reason: clampText(`用户已豁免 clause：${waiver.choice}${original}`),
    };
  });
  // 只保留生产者明确判 not-met 的父状态；unverified 父 entry 里残留的启发式 hard object
  // 不能越过 clause 实测把 parent 改写成 not-met。
  const entryHardFail = entry?.status === 'not-met';
  const status = entryHardFail ? 'not-met' : aggregateMustClauseStatus(clauses.map((clause) => clause.status));
  return {
    requirementId: must.id,
    status,
    note: reviewClauseNote(clauses),
    text: must.text,
    source: entry?.source ?? null,
    confidence: status === 'met' ? 'high' : 'medium',
    objects: clauseObjects(clauses),
    evidence: clauseEvidenceRefs(clauses),
    waiver: firstWaiver,
    reason: entryHardFail
      ? clampText(`must-entry-hard-fail: ${entry.reason ?? 'conformance hard fail'}`)
      : reviewClauseReason(status, clauses, firstWaiver),
    clauses,
  };
}

/**
 * 逐条 must 映射：只按 mustId 对齐，缺证据 / 版本不符 / 启发式 pass 都保持 unverified。
 * not-met 只在 verified 映射或存在 hard fail 对象时成立；waived 只在有显式用户豁免时成立。
 */
export function resolveReviewMusts(input: ResolveReviewMustsInput): readonly ResolvedReviewMust[] {
  const evidence = input.evidence ?? null;
  const expectedArtifacts: ReviewEvidenceArtifacts = {
    ...(input.specSha256 === undefined ? {} : { specSha256: input.specSha256 }),
    ...(input.archiveSha256 === undefined ? {} : { archiveSha256: input.archiveSha256 }),
  };
  const designMismatch =
    evidence !== null && !reviewEvidenceMatchesDesign(evidence, input.schemeId, input.designRevision);
  const artifactsMismatch =
    evidence !== null &&
    (input.specSha256 === undefined ||
      input.archiveSha256 === undefined ||
      !reviewEvidenceMatchesArtifacts(evidence, expectedArtifacts));
  const verifiedIds = new Set(input.verifiedMustIds ?? []);
  const knownMustIds = new Set(input.musts.map((must) => must.id));
  // clause 证据是 target-bound 实测；只对真正带 clause 的 must 放宽 verified-id 校验，
  // 不能让一条 clause 证据替其他 bare met entry 洗白。
  const clauseMustIds = new Set((evidence?.clauses ?? []).map((clause) => clause.mustId));
  const bareMetMusts = (evidence?.musts ?? []).filter(
    (must) => knownMustIds.has(must.mustId) && must.status === 'met' && !clauseMustIds.has(must.mustId),
  );
  const bareMetUnverified =
    bareMetMusts.length > 0 &&
    (input.verifiedMustIds === undefined || bareMetMusts.some((must) => !verifiedIds.has(must.mustId)));
  const provenanceMismatch =
    evidence !== null &&
    (evidence.musts.some((must) => {
      const waiver: unknown = must.waiver;
      return waiver !== null && waiver !== undefined;
    }) ||
      (evidence.mapping === 'verified' && bareMetUnverified));
  const mismatch: EvidenceMismatch = designMismatch
    ? 'design'
    : artifactsMismatch
      ? 'artifacts'
      : provenanceMismatch
        ? 'provenance'
        : null;
  const usable = mismatch === null ? evidence : null;
  const entries = new Map<string, ReviewMustEvidence>();
  if (usable !== null) {
    for (const entry of usable.musts) {
      if (!entries.has(entry.mustId)) entries.set(entry.mustId, entry);
    }
  }
  const clauseByMust = new Map<string, MustClauseEvidence[]>();
  if (usable !== null && (usable.clauses?.length ?? 0) > 0) {
    for (const clause of usable.clauses ?? []) {
      const leaves = clauseByMust.get(clause.mustId) ?? [];
      leaves.push(clause);
      clauseByMust.set(clause.mustId, leaves);
    }
  }
  const waivers = collectWaivers(input, usable);
  const mapping = usable?.mapping ?? null;

  return input.musts.map((must) => {
    const entry = entries.get(must.id) ?? null;
    const clauseLeaves = clauseByMust.get(must.id);
    if (clauseLeaves !== undefined) {
      return resolveClauseMust(must, entry, clauseLeaves, waivers, input.designRevision);
    }
    const waiver =
      waivers.find(
        (candidate) =>
          candidate.mustId === must.id && (candidate.clauseId === null || candidate.clauseId === undefined),
      ) ?? null;
    const status = effectiveStatus(must.text, entry, mapping, waiver);
    return {
      requirementId: must.id,
      status,
      note: noteFor(must, entry, status, mapping, mismatch, waiver),
      text: must.text,
      source: entry?.source ?? null,
      confidence: entry?.confidence ?? null,
      objects: entry?.objects ?? [],
      evidence: entry?.evidence ?? [],
      waiver,
      reason: entry?.reason ?? null,
      clauses: [],
    };
  });
}

export function summarizeReviewMusts(musts: readonly Pick<ResolvedReviewMust, 'status'>[]): ReviewEvidenceSummary {
  const count = (status: ReviewMustStatus): number => musts.filter((must) => must.status === status).length;
  const met = count('met');
  const notMet = count('not-met');
  const waived = count('waived');
  const unverified = count('unverified');
  return ReviewEvidenceSummary.parse({
    total: musts.length,
    met,
    notMet,
    waived,
    unverified,
    acceptEligible: notMet === 0 && unverified === 0,
  });
}

/** 接受门槛：每条 must 都 met 或被用户显式 waived；unverified / not-met 都阻断。 */
export function reviewMustsAcceptEligible(musts: readonly Pick<ResolvedReviewMust, 'status'>[]): boolean {
  return musts.every((must) => must.status === 'met' || must.status === 'waived');
}
