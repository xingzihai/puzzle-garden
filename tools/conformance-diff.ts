/**
 * 离线 design-vs-build diff CLI（CONF-NEXT-03 第一刀）。
 *
 * 输入：BuildSpec JSON（期望）+ building.pgar（实际）。
 * 流程：BuildSpec → projectExpectedObjects → extractAsBuiltObjects → diffObjects（wall / slab / roof）
 *       + design-conformance.evaluateOpenings（有 grid 的洞口证据）→ ConformanceDiffReport。
 * 不联网、不启动 Chrome、不调用模型、不构建、不接 submit。
 *
 * 退出码：0 无 blocking；1 有 blocking；2 参数 / 读取 / 完整性错误。
 * blocking 只看 hard fail + hard missing + hard unverified；soft extra / soft unverified 不阻断。
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import type { AsBuiltObjectGraph } from '@pg/analysis/as-built';
import { compareDiffItems, diffObjects, summarizeDiffItems } from '@pg/analysis/object-diff';
import type {
  ActualOpeningContext,
  DiffBounds,
  DiffDeltaEntry,
  DiffItem,
  DiffSeverity,
  DiffStatus,
  DiffSummary,
  ExpectedOpening,
  NotComparedSummary,
} from '@pg/analysis/object-diff';
import { loadRegistry } from '@pg/blocks/load';
import { readArchive } from '@pg/core/archive';
import type { Grid } from '@pg/core/grid';
import { BuildSpec } from '@pg/interaction/schema';
import type { z } from 'zod';

import { expectedObjectCounts, projectExpectedObjects } from './conformance-expect.ts';
import type { ExpectedProjectionCounts } from './conformance-expect.ts';
import { evaluateOpenings } from './design-conformance.ts';
import type { ConformanceCheck, OpeningsEvaluation } from './design-conformance.ts';

type Spec = z.infer<typeof BuildSpec>;

const USAGE = `用法：
  node tools/conformance-diff.ts --spec <build-spec.json> --archive <building.pgar> [--out <report.json>]

选项：
  --spec <path>     已确认的 BuildSpec JSON
  --archive <path>  building.pgar 交付存档
  --out <path>      另存报告（stdout 始终输出）
  --help            显示本说明

退出码：0 无 blocking；1 有 blocking；2 参数 / 读取 / 完整性错误。`;

export interface ConformanceDiffOptions {
  readonly specPath: string | null;
  readonly archivePath: string | null;
  readonly outPath: string | null;
  readonly help: boolean;
}

export interface ConformanceDiffReport {
  readonly schemaVersion: 1;
  readonly tool: 'conformance-diff';
  readonly spec: {
    readonly path: string;
    readonly sha256: string;
    readonly schemeId: string;
    readonly schemeRevision: number;
  };
  readonly archive: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly expected: {
    readonly count: number;
    readonly counts: ExpectedProjectionCounts;
  };
  readonly actual: {
    readonly bounds: AsBuiltObjectGraph['bounds'];
    readonly summary: AsBuiltObjectGraph['summary'];
    readonly coverage: AsBuiltObjectGraph['coverage'];
    readonly diagnostics: AsBuiltObjectGraph['diagnostics'];
  };
  readonly notCompared: NotComparedSummary;
  readonly context: {
    readonly openings: readonly ActualOpeningContext[];
  };
  readonly summary: DiffSummary;
  readonly items: readonly DiffItem[];
  readonly notes: readonly string[];
}

export interface ConformanceDiffIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export class ConformanceDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceDiffError';
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readBytes(path: string, what: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new ConformanceDiffError(
      `读不到${what}：${path}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

function readJson(path: string): unknown {
  const bytes = readBytes(path, '文件');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ConformanceDiffError(`${path} 不是合法 UTF-8`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConformanceDiffError(`${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadSpec(path: string): { readonly spec: Spec; readonly sha256: string; readonly bytes: number } {
  const absolute = resolve(path);
  const bytes = readBytes(absolute, 'BuildSpec');
  const parsed = BuildSpec.safeParse(readJson(absolute));
  if (!parsed.success) {
    throw new ConformanceDiffError(`${absolute} 不是合法 BuildSpec：${parsed.error.message}`);
  }
  return { spec: parsed.data, sha256: sha256(bytes), bytes: bytes.length };
}

export function loadArchive(
  path: string,
  registry: ReturnType<typeof loadRegistry>,
): { readonly grid: Grid; readonly sha256: string; readonly bytes: number } {
  const absolute = resolve(path);
  const bytes = readBytes(absolute, 'building.pgar');
  try {
    return {
      grid: readArchive(registry.table, bytes).grid,
      sha256: sha256(bytes),
      bytes: bytes.length,
    };
  } catch (error) {
    throw new ConformanceDiffError(`无法解码 ${absolute}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numericDelta(expected: unknown, actual: unknown): Readonly<Record<string, number>> | null {
  const expectedRecord = asRecord(expected);
  const actualRecord = asRecord(actual);
  if (expectedRecord === null || actualRecord === null) return null;
  const out: Record<string, number> = {};
  for (const [key, expectedValue] of Object.entries(expectedRecord)) {
    const actualValue = actualRecord[key];
    if (typeof expectedValue === 'number' && typeof actualValue === 'number') {
      out[key] = actualValue - expectedValue;
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

function checkAspect(check: ConformanceCheck, openingId: string): string {
  const suffix = `.${openingId}`;
  const prefix = check.id.endsWith(suffix) ? check.id.slice(0, -suffix.length) : check.id;
  return prefix.split('.').at(-1) ?? check.id;
}

function checkDelta(check: ConformanceCheck, openingId: string): DiffDeltaEntry {
  const aspect = checkAspect(check, openingId);
  const expectedRecord = asRecord(check.expected);
  const actualRecord = asRecord(check.actual);
  const expectedValue = expectedRecord?.[aspect];
  const actualValue = actualRecord?.[aspect];
  if (typeof expectedValue === 'number' && typeof actualValue === 'number') {
    return { expected: expectedValue, actual: actualValue, delta: actualValue - expectedValue };
  }
  return {
    expected: check.expected,
    actual: check.actual,
    delta: numericDelta(check.expected, check.actual),
  };
}

function aggregateOpeningChecks(checks: readonly ConformanceCheck[]): {
  readonly status: DiffStatus;
  readonly severity: DiffSeverity;
} {
  if (checks.some((check) => check.status === 'fail' && check.severity === 'hard')) {
    return { status: 'fail', severity: 'hard' };
  }
  if (checks.some((check) => check.status === 'unverified' && check.severity === 'hard')) {
    return { status: 'unverified', severity: 'hard' };
  }
  if (checks.some((check) => check.status === 'fail')) {
    return { status: 'fail', severity: 'soft' };
  }
  if (checks.some((check) => check.status === 'unverified')) {
    return { status: 'unverified', severity: 'soft' };
  }
  return { status: 'pass', severity: checks.some((check) => check.severity === 'hard') ? 'hard' : 'soft' };
}

function expectedOpeningSnapshot(expected: ExpectedOpening): Readonly<Record<string, unknown>> {
  return {
    id: expected.id,
    kind: 'opening',
    bounds: expected.bounds,
    subtype: expected.subtype,
    side: expected.side,
    width: expected.width,
    height: expected.height,
    sillY: expected.sillY,
    headY: expected.headY,
    hostId: expected.hostId,
  };
}

/**
 * 复用 design-conformance 的通用洞口测量：一个 expected opening 聚合 width / height /
 * threshold / clearance / occlusion / geometry checks，任一 hard fail 即 fail；否则任一
 * hard unverified 即 unverified；全部 pass 才 pass。delta / actual.checks 保留每个 check
 * 的 id、detail、expected / actual 与样例坐标，供 M4 定位修复。
 */
function buildOpeningItem(
  opening: Spec['openings'][number],
  expected: ExpectedOpening,
  checks: readonly ConformanceCheck[],
  evaluation: OpeningsEvaluation,
): DiffItem {
  const expectedSnapshot = expectedOpeningSnapshot(expected);
  if (checks.length === 0) {
    return {
      id: `expected:${expected.id}`,
      kind: 'opening',
      expectedId: expected.id,
      actualId: null,
      status: 'unverified',
      severity: 'hard',
      expected: expectedSnapshot,
      actual: { id: opening.id, kind: opening.kind, side: opening.side, checks: [] },
      delta: {},
      evidence: [],
      reason: 'evaluateOpenings produced no checks for this expected opening',
    };
  }
  const aggregated = aggregateOpeningChecks(checks);
  const delta: Record<string, DiffDeltaEntry> = {};
  for (const check of checks) {
    if (check.status === 'pass') continue;
    delta[checkAspect(check, opening.id)] = checkDelta(check, opening.id);
  }
  const failed = checks.filter((check) => check.status === 'fail').map((check) => check.id);
  const unverified = checks.filter((check) => check.status === 'unverified').map((check) => check.id);
  const samples = checks
    .flatMap((check) =>
      check.evidence.map((sample) => `${String(sample.x)},${String(sample.y)},${String(sample.z)}=${sample.block}`),
    )
    .sort()
    .filter((sample, index, all) => all.indexOf(sample) === index)
    .slice(0, 8);
  const measurement = evaluation.actual.find((entry) => entry.id === opening.id) ?? null;
  return {
    id: `expected:${expected.id}`,
    kind: 'opening',
    expectedId: expected.id,
    actualId: `evaluateOpenings:${opening.id}`,
    status: aggregated.status,
    severity: aggregated.severity,
    expected: expectedSnapshot,
    actual: {
      id: opening.id,
      kind: opening.kind,
      side: opening.side,
      measurement,
      checks: checks.map((check) => ({
        id: check.id,
        status: check.status,
        severity: check.severity,
        detail: check.detail,
        expected: check.expected,
        actual: check.actual,
        evidence: check.evidence,
      })),
    },
    delta,
    evidence: [...checks.map((check) => check.id), ...samples],
    reason:
      failed.length > 0
        ? `opening checks failed: ${failed.join(', ')}`
        : unverified.length > 0
          ? `opening checks unverified: ${unverified.join(', ')}`
          : null,
  };
}

function buildOpeningItems(
  spec: Spec,
  evaluation: OpeningsEvaluation,
  expectedObjects: readonly ExpectedOpening[],
): DiffItem[] {
  const expectedById = new Map<string, ExpectedOpening>();
  for (const expected of expectedObjects) {
    const id = expected.id.startsWith('opening:') ? expected.id.slice('opening:'.length) : expected.id;
    expectedById.set(id, expected);
  }
  const items: DiffItem[] = [];
  for (const opening of spec.openings) {
    const expected = expectedById.get(opening.id);
    if (expected === undefined) continue;
    const checks = evaluation.checks.filter((check) => check.id.endsWith(`.${opening.id}`));
    items.push(buildOpeningItem(opening, expected, checks, evaluation));
  }
  return items;
}

function openingFamilyFromSubtype(subtype: ActualOpeningContext['subtype']): 'window' | 'door' | null {
  if (subtype === 'window') return 'window';
  if (subtype === 'door' || subtype === 'passage') return 'door';
  return null;
}

function openingFamilyFromSpec(opening: Spec['openings'][number]): 'window' | 'door' {
  return opening.kind === 'window' ? 'window' : 'door';
}

function thinAxis(bounds: DiffBounds): 'x' | 'z' | null {
  const dx = bounds.max[0] - bounds.min[0];
  const dz = bounds.max[2] - bounds.min[2];
  if (dx === 1 && dz > 1) return 'x';
  if (dz === 1 && dx > 1) return 'z';
  return null;
}

function expectedAxis(opening: Spec['openings'][number]): 'x' | 'z' {
  return opening.side === 'east' || opening.side === 'west' ? 'x' : 'z';
}

function overlapVolume(a: DiffBounds, b: DiffBounds): number {
  const dx = Math.max(0, Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]));
  const dy = Math.max(0, Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]));
  const dz = Math.max(0, Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]));
  return dx * dy * dz;
}

function center(bounds: DiffBounds, axis: 0 | 2): number {
  return (bounds.min[axis] + bounds.max[axis]) / 2;
}

function matchesSpecOpening(actual: ActualOpeningContext, spec: Spec): boolean {
  const family = openingFamilyFromSubtype(actual.subtype);
  if (family === null) return false;
  const actualAxis = thinAxis(actual.bounds);
  return spec.openings.some((opening) => {
    if (openingFamilyFromSpec(opening) !== family) return false;
    if (actualAxis !== null && actualAxis !== expectedAxis(opening)) return false;
    if (overlapVolume(opening.bounds, actual.bounds) > 0) return true;
    const verticalOverlap =
      Math.min(opening.bounds.max[1], actual.bounds.max[1]) - Math.max(opening.bounds.min[1], actual.bounds.min[1]);
    return (
      verticalOverlap > 0 &&
      Math.abs(center(opening.bounds, 0) - center(actual.bounds, 0)) <= 2 &&
      Math.abs(center(opening.bounds, 2) - center(actual.bounds, 2)) <= 2
    );
  });
}

/** 没有 spec 对应的高置信 actual opening → soft extra；low / medium 只留在 context。 */
function buildUnmatchedOpeningItems(spec: Spec, openings: readonly ActualOpeningContext[]): DiffItem[] {
  const items: DiffItem[] = [];
  for (const opening of openings) {
    if (opening.confidence !== 'high') continue;
    if (openingFamilyFromSubtype(opening.subtype) === null) continue;
    if (matchesSpecOpening(opening, spec)) continue;
    items.push({
      id: `extra:opening:${opening.id}`,
      kind: 'opening',
      expectedId: null,
      actualId: opening.id,
      status: 'extra',
      severity: 'soft',
      expected: null,
      actual: {
        id: opening.id,
        kind: 'opening',
        bounds: opening.bounds,
        subtype: opening.subtype,
        fill: opening.fill,
        confidence: opening.confidence,
      },
      delta: {},
      evidence: [`actual:${opening.id}`],
      reason: 'actual high-confidence opening has no matching BuildSpec opening',
    });
  }
  return items;
}

export function buildConformanceDiffReport(input: {
  readonly spec: Spec;
  readonly grid: Grid;
  readonly registry: ReturnType<typeof loadRegistry>;
  /** 可选：调用方已提取对象图时直接复用；测试 / 预提取路径使用。 */
  readonly graph?: AsBuiltObjectGraph;
  readonly specPath: string;
  readonly specSha256: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
}): ConformanceDiffReport {
  const projection = projectExpectedObjects(input.spec);
  const graph = input.graph ?? extractAsBuiltObjects(input.grid, input.registry);
  const objectDiff = diffObjects(projection.objects, graph, { compareOpenings: false });
  const openingEvaluation = evaluateOpenings(input.spec, input.grid);
  const expectedOpenings = projection.objects.filter((object): object is ExpectedOpening => object.kind === 'opening');
  const openingItems = buildOpeningItems(input.spec, openingEvaluation, expectedOpenings);
  const extraOpeningItems = buildUnmatchedOpeningItems(input.spec, objectDiff.context.openings);
  const items = [
    ...objectDiff.items.filter((item) => item.kind !== 'opening'),
    ...openingItems,
    ...extraOpeningItems,
  ].sort(compareDiffItems);
  const summary = summarizeDiffItems(items);
  const notes = [...projection.notes, ...objectDiff.notes];
  if (projection.counts.opening > 0) {
    notes.push('opening items use grid-backed evaluateOpenings; object-graph openings are context only');
  }
  if (extraOpeningItems.length > 0) {
    notes.push(
      `${String(extraOpeningItems.length)} high-confidence actual opening(s) have no matching BuildSpec opening; reported as soft extra`,
    );
  }
  return {
    schemaVersion: 1,
    tool: 'conformance-diff',
    spec: {
      path: input.specPath,
      sha256: input.specSha256,
      schemeId: input.spec.schemeId,
      schemeRevision: input.spec.schemeRevision,
    },
    archive: {
      path: input.archivePath,
      sha256: input.archiveSha256,
      bytes: input.archiveBytes,
    },
    expected: {
      count: projection.objects.length,
      counts: expectedObjectCounts(projection.objects),
    },
    actual: {
      bounds: graph.bounds,
      summary: graph.summary,
      coverage: graph.coverage,
      diagnostics: graph.diagnostics,
    },
    notCompared: objectDiff.notCompared,
    context: objectDiff.context,
    summary,
    items,
    notes,
  };
}

function takeValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new ConformanceDiffError(`${option} 缺参数`);
  }
  return value;
}

export function parseConformanceDiffArgs(argv: readonly string[]): ConformanceDiffOptions {
  let specPath: string | null = null;
  let archivePath: string | null = null;
  let outPath: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--spec') {
      specPath = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === '--archive') {
      archivePath = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === '--out') {
      outPath = takeValue(argv, i, arg);
      i += 1;
    } else {
      throw new ConformanceDiffError(`未知参数：${arg ?? ''}`);
    }
  }
  return { specPath, archivePath, outPath, help };
}

export function runConformanceDiff(argv: readonly string[], deps: { readonly io?: ConformanceDiffIo } = {}): number {
  const io: ConformanceDiffIo = deps.io ?? {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
  try {
    const options = parseConformanceDiffArgs(argv);
    if (options.help) {
      io.stdout(USAGE);
      return 0;
    }
    if (options.specPath === null) throw new ConformanceDiffError('缺少 --spec');
    if (options.archivePath === null) throw new ConformanceDiffError('缺少 --archive');
    const registry = loadRegistry();
    const spec = loadSpec(options.specPath);
    const archive = loadArchive(options.archivePath, registry);
    const report = buildConformanceDiffReport({
      spec: spec.spec,
      grid: archive.grid,
      registry,
      specPath: resolve(options.specPath),
      specSha256: spec.sha256,
      archivePath: resolve(options.archivePath),
      archiveSha256: archive.sha256,
      archiveBytes: archive.bytes,
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outPath !== null) {
      try {
        writeFileSync(resolve(options.outPath), json, 'utf8');
      } catch (error) {
        throw new ConformanceDiffError(
          `写不到 ${options.outPath}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    io.stdout(json.trimEnd());
    return report.summary.blocking ? 1 : 0;
  } catch (error) {
    io.stderr(`conformance-diff: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

export function main(argv: readonly string[], deps: { readonly io?: ConformanceDiffIo } = {}): number {
  return runConformanceDiff(argv, deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
