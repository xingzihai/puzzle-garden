/**
 * 中性评审构建：从 runDir 的事件与证据重建 ReviewReport。
 *
 * 负责：读 run 事件 / 重算 conformance 证据 / 组装 ReviewRunFacts / 原子读写 review.json。
 * 不负责：HTTP 路由、会话状态、构建跟踪（interaction-server-*.ts）；不依赖网页 server，供 design-build 复用。
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import { loadRegistry } from '@pg/blocks/load';
import { ReviewReport } from '@pg/interaction/review';
import type { ReviewEvidenceArtifacts, ReviewEvidenceFile } from '@pg/interaction/review-evidence';
import {
  parseReviewEvidenceFile,
  reviewEvidenceMatchesArtifacts,
  safeParseReviewEvidenceFile,
} from '@pg/interaction/review-evidence';
import { buildReviewReport } from '@pg/interaction/review-generate';
import type { ReviewRunFacts } from '@pg/interaction/review-generate';
import type { BuildSpec } from '@pg/interaction/schema';
import type { Event } from '@pg/store/events';
import { openRunDir } from '@pg/store/run-dir';

import { buildBuildSheet, buildVerifiedMustMapping } from './build-sheet.ts';
import { buildConformanceDiffReport, loadArchive, loadSpec } from './conformance-diff.ts';
import { buildConformanceEvidence } from './conformance-shadow.ts';
import type { VerifiedMustMapping } from './conformance-shadow.ts';
import { evaluateCoverage } from './coverage-evidence.ts';
import type { DesignBuildRunResult } from './design-build-runner.ts';
import { evaluateMustClauses } from './must-clause-evidence.ts';

export interface BuildRunReviewInput {
  readonly spec: BuildSpec;
  readonly specPath: string;
  readonly runDir: string;
  readonly verifiedMustObjects?: Readonly<Record<string, readonly string[]>>;
  /** 已由 BuildSheet / planner 验证的 must id；缺省时从 verifiedMustObjects 重新派生。 */
  readonly verifiedMustIds?: readonly string[];
  /** 已 adopt 的 verified mapping；CLI 复用 session 的确定性 planner 结果。 */
  readonly verifiedMapping?: VerifiedMustMapping;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRunEvents(runDir: string): readonly Event[] {
  try {
    const events = openRunDir(runDir).events();
    const runId = basename(runDir);
    const foreign = events.find((event) => event.runId !== runId);
    if (foreign !== undefined) {
      throw new Error(`events.jsonl 的 runId=${foreign.runId} 与目录 ${runId} 不一致`);
    }
    return events;
  } catch (error) {
    throw new Error(`读取构建事件失败（${runDir}）：${errorMessage(error)}`, { cause: error });
  }
}

async function sha256File(path: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    return null;
  }
}

/**
 * 从 run 的 spec / archive 工件计算证据绑定哈希；任一缺失或不可读则返回 null。
 * archive 优先取 delivery/building.pgar，兼容合成 fixture 直接放在 runDir 的 building.pgar。
 */
async function runEvidenceHashes(
  runDir: string,
  specPath: string | undefined,
): Promise<ReviewEvidenceArtifacts | null> {
  const specSha256 = await sha256File(specPath ?? join(runDir, 'build-spec.json'));
  const archiveSha256 =
    (await sha256File(join(runDir, 'delivery', 'building.pgar'))) ?? (await sha256File(join(runDir, 'building.pgar')));
  if (specSha256 === null || archiveSha256 === null) return null;
  return { specSha256, archiveSha256 };
}

function evidenceCore(evidence: ReviewEvidenceFile): string {
  return JSON.stringify({
    mapping: evidence.mapping,
    spec: evidence.spec,
    archive: evidence.archive,
    // datum.source 是生产来源标签（build-sheet / build-spec），不是判定值；重算时不因来源标签不同而拒绝。
    datum: {
      slabTopY: evidence.datum.slabTopY,
      standingY: evidence.datum.standingY,
      gradeY: evidence.datum.gradeY,
      entryTransition: evidence.datum.entryTransition,
      floorThickness: evidence.datum.floorThickness,
    },
    musts: evidence.musts.map((must) => ({
      mustId: must.mustId,
      status: must.status,
      confidence: must.confidence,
      objects: must.objects,
      evidence: must.evidence,
      waiver: must.waiver,
      reason: must.reason,
    })),
    clauses: evidence.clauses,
    clauseGroups: evidence.clauseGroups,
    clauseSummary: evidence.clauseSummary,
    clauseCompilerVersion: evidence.clauseCompilerVersion,
    summary: evidence.summary,
  });
}

/**
 * 从当前 spec + archive 重新生成证据，拒绝任何与当前 BuildSheet / diff 不一致的文件。
 * 这是证据 provenance 的唯一可信来源；旧生产者、手写 41-met、同 revision 旧文件都会失败。
 */
function recomputeEvidence(
  runDir: string,
  expected: ReviewEvidenceArtifacts,
  specPath: string,
  verifiedMustObjects: Readonly<Record<string, readonly string[]>>,
  verifiedMapping?: VerifiedMustMapping,
): ReviewEvidenceFile | null {
  try {
    if (!existsSync(specPath)) return null;
    const archivePath = existsSync(join(runDir, 'delivery', 'building.pgar'))
      ? join(runDir, 'delivery', 'building.pgar')
      : existsSync(join(runDir, 'building.pgar'))
        ? join(runDir, 'building.pgar')
        : null;
    if (archivePath === null) return null;
    const { spec, sha256: specSha256 } = loadSpec(specPath);
    if (specSha256 !== expected.specSha256) return null;
    const registry = loadRegistry();
    const { grid, sha256: archiveSha256, bytes } = loadArchive(archivePath, registry);
    if (archiveSha256 !== expected.archiveSha256) return null;
    const graph = extractAsBuiltObjects(grid, registry);
    const report = buildConformanceDiffReport({
      spec,
      grid,
      registry,
      graph,
      specPath,
      specSha256,
      archivePath,
      archiveSha256,
      archiveBytes: bytes,
    });
    const sheet = buildBuildSheet(spec, verifiedMustObjects);
    const coverage = evaluateCoverage(spec, graph, grid, registry);
    const clauseEvaluation = evaluateMustClauses({
      spec,
      graph,
      grid,
      registry,
      report,
      coverage,
    });
    return parseReviewEvidenceFile(
      buildConformanceEvidence(
        spec,
        sheet,
        report,
        specSha256,
        archiveSha256,
        bytes,
        verifiedMapping ?? buildVerifiedMustMapping(spec, verifiedMustObjects),
        undefined,
        coverage,
        clauseEvaluation,
      ),
    );
  } catch {
    return null;
  }
}

/**
 * 读取并重新验证 Build Lead 的影子证据；缺文件、缺 hash、结构不合法或与当前产物不一致
 * 一律返回 null（fail closed）。without expected 是旧调用，明确不生产使用。
 */
export async function readRunReviewEvidence(
  runDir: string,
  expected?: ReviewEvidenceArtifacts,
  specPath?: string,
  verifiedMustObjects: Readonly<Record<string, readonly string[]>> = {},
  verifiedMapping?: VerifiedMustMapping,
): Promise<ReviewEvidenceFile | null> {
  if (expected === undefined) return null;
  let text: string;
  try {
    text = await readFile(join(runDir, 'conformance-evidence.json'), 'utf8');
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const evidence = safeParseReviewEvidenceFile(value);
  if (evidence === null) return null;
  if (!reviewEvidenceMatchesArtifacts(evidence, expected)) return null;
  const authoritative = recomputeEvidence(
    runDir,
    expected,
    specPath ?? join(runDir, 'build-spec.json'),
    verifiedMustObjects,
    verifiedMapping,
  );
  if (authoritative === null) return null;
  return evidenceCore(evidence) === evidenceCore(authoritative) ? evidence : null;
}

function runStatus(result: DesignBuildRunResult): ReviewRunFacts['status'] {
  const { stopReason } = result.outcome;
  if (stopReason === null) return result.delivery === null ? 'failed' : 'succeeded';
  return stopReason === 'cancelled' ? 'cancelled' : 'failed';
}

interface ReviewInputs {
  readonly expected: ReviewEvidenceArtifacts | null;
  readonly evidence: ReviewEvidenceFile | null;
  readonly verifiedMustIds: readonly string[];
}

/** defaultWebReviewBuilder 与 buildRunReview 共用的证据入口；缺工件时全部 fail closed。 */
async function loadReviewInputs(
  spec: BuildSpec,
  specPath: string | undefined,
  runDir: string,
  verifiedMustObjects: Readonly<Record<string, readonly string[]>>,
  trustedMustIds?: readonly string[],
  verifiedMapping?: VerifiedMustMapping,
): Promise<ReviewInputs> {
  if (specPath !== undefined && existsSync(specPath)) {
    try {
      if (!isDeepStrictEqual(loadSpec(specPath).spec, spec)) {
        return { expected: null, evidence: null, verifiedMustIds: [] };
      }
    } catch {
      return { expected: null, evidence: null, verifiedMustIds: [] };
    }
  }
  const expected = await runEvidenceHashes(runDir, specPath);
  // 缺 spec / archive 工件或哈希不可读时 fail closed：不引用任何证据。
  const evidence =
    expected === null
      ? null
      : await readRunReviewEvidence(runDir, expected, specPath, verifiedMustObjects, verifiedMapping);
  const verifiedMustIds =
    trustedMustIds ??
    Object.keys((verifiedMapping ?? buildVerifiedMustMapping(spec, verifiedMustObjects)).schemes[spec.schemeId] ?? {});
  return { expected, evidence, verifiedMustIds };
}

/**
 * 默认评审 builder：从 run 的 events.jsonl 取最后一条 check.result 的执行摘要，
 * 结合交付事件 / result.delivery 与渲染图数量组装 ReviewRunFacts；
 * 若 runDir 有 conformance-evidence.json 则逐 must 引用证据，缺文件回退为全部 unverified。
 */
export async function defaultWebReviewBuilder(input: {
  readonly spec: BuildSpec;
  readonly result: DesignBuildRunResult;
  readonly specPath?: string;
  readonly verifiedMustObjects?: Readonly<Record<string, readonly string[]>>;
}): Promise<ReviewReport> {
  const events = readRunEvents(input.result.runDir);
  const verifiedMustObjects = input.verifiedMustObjects ?? {};
  const { expected, evidence, verifiedMustIds } = await loadReviewInputs(
    input.spec,
    input.specPath,
    input.result.runDir,
    verifiedMustObjects,
  );
  let lastCheck: Extract<Event, { readonly type: 'check.result' }> | null = null;
  let hasDeliveryEvent = false;
  for (const event of events) {
    if (event.type === 'check.result') lastCheck = event;
    else if (event.type === 'delivery') hasDeliveryEvent = true;
  }

  const run = lastCheck?.body.run ?? null;
  const okRun = run?.kind === 'ok' ? run : null;
  const runId = input.result.outcome.runId.trim() === '' ? basename(input.result.runDir) : input.result.outcome.runId;
  const facts: ReviewRunFacts = {
    runId,
    designId: input.spec.schemeId,
    designRevision: input.spec.schemeRevision,
    status: runStatus(input.result),
    failure: input.result.outcome.failure?.message ?? null,
    delivered: input.result.delivery !== null || hasDeliveryEvent,
    stopReason: input.result.outcome.stopReason,
    checkPassed: lastCheck === null ? null : run?.kind === 'ok',
    cells: okRun?.cells ?? null,
    bounds: okRun?.bounds ?? null,
    renders: input.result.renders.length,
  };
  return buildReviewReport({
    spec: input.spec,
    run: facts,
    ...(evidence === null ? {} : { evidence }),
    ...(expected === null ? {} : { evidenceBinding: expected }),
    verifiedMustIds,
  });
}

/** 没有 outcome 对象时从事件重建 run facts；runId 一律取 runDir basename。 */
function runFactsFromEvents(events: readonly Event[], runDir: string, spec: BuildSpec): ReviewRunFacts {
  let lastCheck: Extract<Event, { readonly type: 'check.result' }> | null = null;
  let lastEnd: Extract<Event, { readonly type: 'run.end' }> | null = null;
  let hasDeliveryEvent = false;
  let deliveredRenders = 0;
  for (const event of events) {
    if (event.type === 'check.result') lastCheck = event;
    else if (event.type === 'delivery') {
      hasDeliveryEvent = true;
      deliveredRenders = event.body.renders.length;
    } else if (event.type === 'run.end') lastEnd = event;
    else if (event.type === 'render.result' && event.body.purpose === 'deliver') {
      // 兼容只有交付渲染、没有 delivery 事件的合成 fixture；delivery 事件随后会覆盖为权威值。
      deliveredRenders = event.body.images.length;
    }
  }

  const run = lastCheck?.body.run ?? null;
  const okRun = run?.kind === 'ok' ? run : null;
  const stopReason = lastEnd?.body.stopReason ?? null;
  // runner 只在 delivery 非 null 时把 run.end.stopReason 写成 null；两者任一即可判定已交付。
  const delivered = hasDeliveryEvent || (lastEnd !== null && stopReason === null);
  const status: ReviewRunFacts['status'] =
    stopReason === null ? (delivered ? 'succeeded' : 'failed') : stopReason === 'cancelled' ? 'cancelled' : 'failed';
  return {
    runId: basename(runDir),
    designId: spec.schemeId,
    designRevision: spec.schemeRevision,
    status,
    failure: lastEnd?.body.failure?.message ?? null,
    delivered,
    stopReason,
    checkPassed: lastCheck === null ? null : run?.kind === 'ok',
    cells: okRun?.cells ?? null,
    bounds: okRun?.bounds ?? null,
    renders: deliveredRenders,
  };
}

/**
 * 不依赖 outcome 对象的评审入口：从 runDir 的事件 / 工件重建同一份 ReviewReport。
 * runId 取 basename(runDir)；缺 spec / archive / 证据时保持全部 must unverified。
 */
export async function buildRunReview(input: BuildRunReviewInput): Promise<ReviewReport> {
  // 防止把 spec A 与 specPath B 的 evidence 拼成一份报告。
  if (!isDeepStrictEqual(loadSpec(input.specPath).spec, input.spec)) {
    throw new Error(`BuildSpec 与 ${input.specPath} 不一致，拒绝生成评审`);
  }
  const events = readRunEvents(input.runDir);
  const verifiedMustObjects = input.verifiedMustObjects ?? {};
  const { expected, evidence, verifiedMustIds } = await loadReviewInputs(
    input.spec,
    input.specPath,
    input.runDir,
    verifiedMustObjects,
    input.verifiedMustIds,
    input.verifiedMapping,
  );
  return buildReviewReport({
    spec: input.spec,
    run: runFactsFromEvents(events, input.runDir, input.spec),
    ...(evidence === null ? {} : { evidence }),
    ...(expected === null ? {} : { evidenceBinding: expected }),
    verifiedMustIds,
  });
}

/** 原子写 runDir/review.json（同目录临时文件 + rename）；写入失败清理临时文件后抛出。 */
export async function writeRunReview(runDir: string, report: ReviewReport): Promise<void> {
  await mkdir(runDir, { recursive: true });
  const file = join(runDir, 'review.json');
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** 读回已落盘的评审；缺文件、JSON 损坏或 schema 不合法一律返回 null。 */
export async function readPersistedRunReview(runDir: string): Promise<ReviewReport | null> {
  let text: string;
  try {
    text = await readFile(join(runDir, 'review.json'), 'utf8');
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ReviewReport.safeParse(value);
  return parsed.success ? parsed.data : null;
}
