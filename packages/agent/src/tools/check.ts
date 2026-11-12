/* eslint-disable max-lines -- check_code 的状态分支与模型文本同属一个入口，拆分另立任务。 */
/**
 * check_code 的执行（AGENT-SPEC §4.2、§5）：当前稿 → 预检 → 执行 → 测量 → 模型可见文本 + 宿主侧结果。
 *
 * 负责：调注入的预检与执行；执行成功时把存档读回网格、跑 analysis 的四项测量与可达目标；
 * 生成模型可见文本，并给出按 `@pg/store/events` 形状的 PrecheckSummary / RunSummary。
 * 不负责：当前稿与版本号（runner 维护）、存档 blob 与事件（runner）、截图（tools/view.ts）。
 * 所有外部依赖（prechecker、runCode、registry、clock）由参数注入，便于单元测试用假的。
 * 本文件是纯函数文件：只 import 纯入口（analysis / core / facts / guards），sandbox 与 store 只 import type。
 */

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import type { AsBuiltObjectGraph, WallObject } from '@pg/analysis/as-built';
import { diagnoseInterfaces, formatInterfaces, interfaceSpecsSchema } from '@pg/analysis/block-interface';
import type { InterfaceResult, InterfaceSpec } from '@pg/analysis/block-interface';
import { measureFloating } from '@pg/analysis/floating';
import { measureReach } from '@pg/analysis/reach';
import { reachTargetsByCall } from '@pg/analysis/reach-targets';
import { measureRoofProfile } from '@pg/analysis/roof-profile';
import { measureSeams } from '@pg/analysis/seams';
import { measureSymmetry } from '@pg/analysis/symmetry';
import { diffFurnitureObjects, diffObjects } from '@pg/analysis/object-diff';
import type { DiffItem, DiffReport, ExpectedFurniture, ExpectedObject, ExpectedWall } from '@pg/analysis/object-diff';
import type { MassingColorCandidate } from '@pg/blocks/color';
import type { BlockRegistry } from '@pg/blocks/registry';
import { readArchive } from '@pg/core/archive';
import type { CallDef, Cell, Grid } from '@pg/core/grid';
import type { MassingDocument } from '@pg/geometry';
import type { PrecheckResult } from '@pg/sandbox/precheck';
import type { RunInput, RunResult } from '@pg/sandbox/run';
import type { PrecheckSummary, RunSummary } from '@pg/store/events';

import { formatMeasures, formatOverlaps } from '@pg/agent/facts';
import type { MeasureInput } from '@pg/agent/facts';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- conformance-summary.ts 是纯格式化模块（无 I/O），尚未登记进 eslint pureFiles。
import { formatConformanceSummary } from '../conformance-summary.ts';
import { configuredGateCount, envelopeProvenanceWarnings, evaluateGates, gatesLines } from '../gates.ts';
import type { GateConfig, GateOutcome } from '../gates.ts';
import { frameAirSeams, roofSurfaceMaterials } from './presentation-facts.ts';

/** check_code 的输入：当前稿的代码与版本号，以及沙箱 rng 种子（AGENT-SPEC §2）。 */
export interface CheckInput {
  readonly code: string;
  readonly version: number;
  readonly seed: number;
  /** 本会话已登记的草模文档（M1c 默认空；M2 的 massing 工具写入），随 `assets` 透传给 runCode。 */
  readonly massingDocuments?: readonly MassingDocument[];
}

/** 注入的外部依赖；真实实现分别来自 `@pg/sandbox/precheck`、`@pg/sandbox/run` 与 `@pg/blocks/load`。 */
export interface CheckDeps {
  readonly prechecker: { readonly check: (code: string) => Promise<PrecheckResult> };
  readonly runCode: (input: RunInput) => Promise<RunResult>;
  readonly registry: BlockRegistry;
  /**
   * 草模默认材质的颜色候选（`@pg/blocks/color` 的 `colorCandidates`）；调用方每次 run 缓存一次。
   * 缺省或返回空表时，有文档的导入按宿主缺陷在 child 侧报 protocol-error（MASSING-CONVERSION-SPEC §5.2）。
   */
  readonly massingColorCandidates?: () => readonly MassingColorCandidate[];
  /** 骨架门槛配置（AGENT-SPEC §5.1）；不给时不做门槛判定，文本与结果都不含门槛项。 */
  readonly gates?: GateConfig;
  /** 显式相邻两格接口，最多 32 项；预检前严格校验，成功后仅报最终状态事实，不拒绝 submit。 */
  readonly interfaces?: readonly InterfaceSpec[];
  /**
   * 设计阶段派生的期望对象（BuildSheet 机器视图）。给定时 check_code 追加逐对象
   * expected / actual / delta 摘要；只报告，不改变 submit 行为。
   */
  readonly expectedObjects?: readonly ExpectedObject[];
  /**
   * 设计阶段派生的期望家具（BuildSheet 家具投影）。给定时 check_code 追加家具
   * pass / fail / missing / extra 摘要；只报告，不改变 submit / gates 行为。
   */
  readonly expectedFurniture?: readonly ExpectedFurniture[];
  /**
   * 已按生产 shadow 口径生成的逐对象一致性报告（含 grid-backed 洞口证据）。给定时直接用于
   * `result.conformance` 与模型可见摘要，优先于 `expectedObjects` 的对象图回退；
   * 只报告，不改变 submit / gates 行为。
   */
  readonly conformanceReport?: DiffReport;
  /**
   * 按本次执行存档惰性生成生产 shadow 报告的入口。给定且 `conformanceReport` 未给时，
   * check_code 在本次存档上调用它，让 live check 与 review 使用同一份 canonical 报告；
   * 抛错 / 返回 undefined / 返回空报告时回退 `expectedObjects` 的对象图摘要，并在摘要前加
   * `[fallback]` 标记说明 blocking 可能被低估。只报告，不改变 submit / gates。
   */
  readonly conformanceReportOf?: (archive: Uint8Array) => DiffReport | undefined;
  /**
   * report-only 影子钩子：执行成功拿到存档后调用。宿主用它写
   * conformance-diff.json / conformance-evidence.json；异常不得改变 check 状态。
   */
  readonly onCheckArchive?: (archive: Uint8Array) => void;
  readonly clock: () => number;
}

/**
 * 工具结果的分类（工具自己的 status，不用布尔 ok，MODEL-SPEC §7.3）。
 * `internal-error` 表示宿主 / 沙箱缺陷，runner 应以 `internal-error` 停止；`sandbox-unsupported` 同理。
 */
export type CheckStatus =
  | 'ok'
  | 'precheck-failed'
  | 'precheck-too-large'
  | 'precheck-timeout'
  | 'precheck-out-of-memory'
  | 'build-error'
  | 'run-timeout'
  | 'run-out-of-memory'
  | 'run-output-too-large'
  | 'run-crashed'
  | 'run-too-large'
  | 'run-assets-too-large'
  | 'sandbox-unsupported'
  | 'internal-error';

/** check_code 的宿主侧结果：文本给模型，其余给 runner 写 `check.result`。 */
export interface CheckResult {
  readonly status: CheckStatus;
  readonly text: string;
  /** 预检摘要；预检阶段就发生宿主缺陷（internal-error）时为 null。 */
  readonly precheck: PrecheckSummary | null;
  /** 执行摘要；预检未过、`unsupported` 或宿主缺陷时为 null（`RunSummary` 没有这两种变体）。 */
  readonly run: RunSummary | null;
  /** 执行成功的存档字节；runner 存成 blob 后填进 `check.result.archive`。 */
  readonly archive: Uint8Array | undefined;
  /** 按存档调用表 API 名计数，给 `check.result.apiCalls`。 */
  readonly apiCalls: Readonly<Record<string, number>> | undefined;
  /** 与文本同源的测量结果，给 `facts` 事件的结构化 measures。 */
  readonly measures: MeasureInput | undefined;
  /** 配了 `--gates` 时的门槛判定结果；runner 据此在 submit 时拒绝未过门槛的版本。 */
  readonly gates?: GateOutcome;
  /** 仅配置 interfaces 且执行成功时存在；不并入 measures/facts，不作为提交门槛。 */
  readonly interfaces?: readonly InterfaceResult[];
  /** 逐对象一致性报告；仅传入 expectedObjects 且计算成功时存在。只报告，不参与 submit。 */
  readonly conformance?: DiffReport;
  /** 本次 check_code 的墙钟（宿主侧计时，给工具结果事件）。 */
  readonly wallMs: number;
}

type OkRun = Extract<RunResult, { kind: 'ok' }>;
type ChildReport = OkRun['report'];

const PRE = (version: number): string => `第 v${String(version)} 版：`;

/** 字节数写法：恰好整数 MiB / KiB 时用更大单位，否则写字节。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${String(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${String(bytes / 1024)} KiB`;
  return `${String(bytes)} 字节`;
}

/** 结构上识别 sandbox 的宿主错误，避免纯函数文件运行时 import 非纯入口（STANDARDS §2）。 */
function isSandboxError(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && error.name === 'SandboxError' && 'code' in error && typeof error.code === 'string';
}

/** precheck 的非 ok 结果转模型可见文本（AGENT-SPEC §4.2：诊断用 TypeScript 英文原文）。 */
function precheckText(version: number, result: Exclude<PrecheckResult, { kind: 'ok' }>): string {
  switch (result.kind) {
    case 'failed': {
      const lines = [
        `${PRE(version)}类型预检未通过（${String(result.total)} 处，显示前 ${String(result.diagnostics.length)} 处）：`,
      ];
      for (const d of result.diagnostics) {
        lines.push(`building.ts:${String(d.line)}:${String(d.column)} ${d.code} ${d.message}\n    ${d.source}`);
      }
      return lines.join('\n');
    }
    case 'too-large':
      return `${PRE(version)}代码 ${String(result.bytes)} 字节，超过上限 ${String(result.limit)} 字节，没有执行。请精简代码后重试。`;
    case 'timeout':
      return `${PRE(version)}类型预检超过 ${String(result.limitMs)} ms 未完成。请简化类型写法后重试。`;
    case 'out-of-memory':
      return `${PRE(version)}类型预检用尽 ${String(result.limitMiB)} MiB 内存。请简化类型写法后重试。`;
  }
}

function precheckStatus(result: Exclude<PrecheckResult, { kind: 'ok' }>): CheckStatus {
  switch (result.kind) {
    case 'failed':
      return 'precheck-failed';
    case 'too-large':
      return 'precheck-too-large';
    case 'timeout':
      return 'precheck-timeout';
    case 'out-of-memory':
      return 'precheck-out-of-memory';
  }
}

function summarizePrecheck(result: PrecheckResult): PrecheckSummary {
  switch (result.kind) {
    case 'ok':
      return { kind: 'ok' };
    case 'failed':
      return {
        kind: 'failed',
        total: result.total,
        diagnostics: result.diagnostics.map((d) => ({
          line: d.line,
          column: d.column,
          code: d.code,
          message: d.message,
        })),
      };
    case 'too-large':
      return { kind: 'too-large', bytes: result.bytes, limit: result.limit };
    case 'timeout':
      return { kind: 'timeout', limitMs: result.limitMs };
    case 'out-of-memory':
      return { kind: 'out-of-memory', limitMiB: result.limitMiB };
  }
}

/** 执行失败（非 ok）的模型可见文本与状态（AGENT-SPEC §4.2：一行说明 + 建议）。 */
function runFailureText(version: number, result: Exclude<RunResult, { kind: 'ok' }>): string {
  switch (result.kind) {
    case 'build-error': {
      const error = result.report.error;
      const name = error?.name ?? 'Error';
      const message = error?.message ?? '(无法读取 message)';
      const where =
        error === undefined || error.line <= 0 ? '' : `building.ts:${String(error.line)}:${String(error.column)} `;
      return `${PRE(version)}执行出错 ${where}${name}：${message}\n（出错时不合成，没有测量。）`;
    }
    case 'timeout':
      return `${PRE(version)}执行超时。检查有没有死循环，或减少逐格 set 的次数。`;
    case 'out-of-memory':
      return `${PRE(version)}执行内存不足。减少一次写入的格数，或改用更省内存的写法。`;
    case 'output-too-large':
      return `${PRE(version)}存档或报告超过大小上限。减少写入的格数。`;
    case 'crashed': {
      const detail = result.detail;
      if (detail !== undefined) {
        const counts =
          detail.calls === undefined
            ? ''
            : `；报告里有 ${String(detail.calls)} 次调用` +
              (detail.overlaps === undefined ? '' : `、${String(detail.overlaps)} 处重叠`);
        return (
          `${PRE(version)}本次执行结果无法返回：调用记录数据 ${formatBytes(detail.reportBytes)}，` +
          `超过 ${formatBytes(detail.limitBytes)} 上限${counts}。` +
          `请减少逐格 set/box 手写、改用构件（walls / floorPlate / roof 等），或把重复的逐格调用合并到循环里后重试。`
        );
      }
      return `${PRE(version)}执行进程异常退出。请检查代码（例如栈溢出、死循环）后重试。`;
    }
    case 'too-large':
      return `${PRE(version)}代码 ${String(result.bytes)} 字节，超过上限 ${String(result.limit)} 字节，没有执行。请精简代码后重试。`;
    case 'assets-too-large': {
      const what =
        result.reason === 'documents-count'
          ? `${String(result.documents)} 份草模文档，超过 ${String(result.limit)} 份上限`
          : result.reason === 'document-bytes'
            ? `单份草模文档 ${formatBytes(result.bytes)}，超过 ${formatBytes(result.limit)} 上限`
            : `草模文档合计 ${formatBytes(result.bytes)}，超过 ${formatBytes(result.limit)} 上限`;
      return `${PRE(version)}${what}，没有执行。请减少登记或导入的草模文档后重试。`;
    }
    case 'unsupported':
      return `${PRE(version)}本机没有可用的 bwrap，无法执行：${result.reason}`;
  }
}

function runFailureStatus(result: Exclude<RunResult, { kind: 'ok' }>): CheckStatus {
  switch (result.kind) {
    case 'build-error':
      return 'build-error';
    case 'timeout':
      return 'run-timeout';
    case 'out-of-memory':
      return 'run-out-of-memory';
    case 'output-too-large':
      return 'run-output-too-large';
    case 'crashed':
      return 'run-crashed';
    case 'too-large':
      return 'run-too-large';
    case 'assets-too-large':
      return 'run-assets-too-large';
    case 'unsupported':
      return 'sandbox-unsupported';
  }
}

function consoleCount(report: ChildReport): number {
  // consoleTruncated 是被丢弃的条数；模型看到的"条数"按尝试写入的总数算，避免漏报。
  return report.console.length + report.consoleTruncated;
}

function runSummaryOfOk(result: OkRun, grid: Grid): RunSummary {
  const bounds = grid.bounds();
  const box: [number, number, number, number, number, number] =
    bounds === undefined
      ? [0, 0, 0, 0, 0, 0]
      : [bounds.min[0], bounds.min[1], bounds.min[2], bounds.max[0], bounds.max[1], bounds.max[2]];
  // 新报告按完整概览分类；旧截断报告仅记保留项的已知分类，未知项数量在工具文本说明。
  const same =
    result.report.overlapSummary?.sameLayer ?? result.report.overlaps.filter((o) => o.kind === 'same-layer').length;
  const cross =
    result.report.overlapSummary?.crossLayer ?? result.report.overlaps.filter((o) => o.kind === 'cross-layer').length;
  return {
    kind: 'ok',
    hash: result.hash,
    cells: grid.size,
    bounds: box,
    calls: result.report.calls,
    overlaps: { sameLayer: same, crossLayer: cross },
    console: consoleCount(result.report),
    // sandbox 用 performance.now() 计时，是小数；store 的 RunSummary.wallMs 要整数（MODEL-SPEC §7.3）。
    wallMs: Math.round(result.wallMs),
  };
}

function runSummaryOfFailure(result: Exclude<RunResult, { kind: 'ok' }>): RunSummary | null {
  switch (result.kind) {
    case 'build-error': {
      const error = result.report.error;
      return {
        kind: 'build-error',
        error: {
          name: error?.name ?? 'Error',
          message: error?.message ?? '(无法读取 message)',
          line: error?.line ?? 0,
          column: error?.column ?? 0,
        },
        console: consoleCount(result.report),
        wallMs: Math.round(result.wallMs),
      };
    }
    case 'timeout':
    case 'out-of-memory':
    case 'output-too-large':
    case 'crashed':
      return {
        kind: result.kind,
        stderrHead: result.stderrHead.slice(0, 2000),
        wallMs: Math.round(result.wallMs),
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      };
    case 'too-large':
      return { kind: 'too-large', bytes: result.bytes, limit: result.limit };
    case 'assets-too-large':
      return {
        kind: 'assets-too-large',
        reason: result.reason,
        documents: result.documents,
        bytes: result.bytes,
        limit: result.limit,
      };
    case 'unsupported':
      return null;
  }
}

/** 按 API 名计数（次数降序由 facts 的 usedLine 负责，这里只要计数）。 */
function countApiCalls(calls: readonly CallDef[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const call of calls) out[call.api] = (out[call.api] ?? 0) + 1;
  return out;
}

/** 执行成功后的全部测量（AGENT-SPEC §5）：与 facts.formatMeasures 的输入同源。 */
function measureAll(grid: Grid, registry: BlockRegistry): MeasureInput {
  const cells = [...grid.cells()];
  const calls = grid.calls();
  const callById = new Map(calls.map((c) => [c.id, c]));
  const roofIds = calls.filter((c) => c.api === 'roof').map((c) => c.id);
  const roofIdSet = new Set(roofIds);
  const cellsByCall = new Map<number, Cell[]>();
  for (const c of cells) {
    const list = cellsByCall.get(c.call);
    if (list === undefined) cellsByCall.set(c.call, [c]);
    else list.push(c);
  }
  const rawSeams = measureSeams(grid);
  const frameAir = frameAirSeams(grid, rawSeams, calls, registry.table);
  const reachTargets = reachTargetsByCall(grid, registry);
  const apiById = new Map(calls.map((c) => [c.id, c.api]));

  // 呈现层事实 1：存档里 y ≤ 0 的实体格（决策 #21 约定 y=0 是地表，构件不应写到这里）。
  const belowByCall = new Map<number, number>();
  for (const c of cells) if (c.y <= 0) belowByCall.set(c.call, (belowByCall.get(c.call) ?? 0) + 1);
  const belowGround = {
    cells: [...belowByCall.values()].reduce((a, b) => a + b, 0),
    sources: [...belowByCall]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 3)
      .map(([id]) => `${apiById.get(id) ?? '?'}#${String(id)}`),
  };

  // 呈现层事实 2：每个 walls 调用的围合内部，墙顶以上被 roof / floorPlate 覆盖的列占比。
  // 用调用自身格子的包围盒内缩一格近似 inner footprint；不改 analysis 的屋面定义。
  const coveredByColumn = new Map<string, number>();
  for (const c of cells) {
    const api = apiById.get(c.call);
    if (api !== 'roof' && api !== 'floorPlate') continue;
    const k = `${String(c.x)},${String(c.z)}`;
    const previous = coveredByColumn.get(k);
    if (previous === undefined || c.y > previous) coveredByColumn.set(k, c.y);
  }
  const wallCoverage: {
    callId: number;
    line: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    covered: number;
    total: number;
  }[] = [];
  for (const call of calls) {
    if (call.api !== 'walls') continue;
    const wc = cellsByCall.get(call.id) ?? [];
    if (wc.length === 0) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let wallTop = -Infinity;
    for (const c of wc) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.z < minZ) minZ = c.z;
      if (c.z > maxZ) maxZ = c.z;
      if (c.y > wallTop) wallTop = c.y;
    }
    const innerX0 = minX + 1;
    const innerX1 = maxX - 1;
    const innerZ0 = minZ + 1;
    const innerZ1 = maxZ - 1;
    if (innerX0 > innerX1 || innerZ0 > innerZ1) continue;
    let total = 0;
    let covered = 0;
    for (let x = innerX0; x <= innerX1; x += 1)
      for (let z = innerZ0; z <= innerZ1; z += 1) {
        total += 1;
        const top = coveredByColumn.get(`${String(x)},${String(z)}`);
        if (top !== undefined && top > wallTop) covered += 1;
      }
    wallCoverage.push({
      callId: call.id,
      line: call.line,
      minX: innerX0,
      maxX: innerX1,
      minZ: innerZ0,
      maxZ: innerZ1,
      covered,
      total,
    });
  }

  return {
    calls,
    floating: measureFloating(grid, { tag: (c) => roofIdSet.has(c.call) }),
    seams: { cells: rawSeams.cells - frameAir.cells, groups: rawSeams.groups.filter((g) => !frameAir.removed.has(g)) },
    seamFrameAir: { cells: frameAir.cells, groups: frameAir.removed.size },
    reachTargets,
    reach: measureReach(grid, registry, { targets: reachTargets.targets.map((t) => t.cell) }),
    roofs: roofIds.map((id) => {
      const call = callById.get(id);
      const materials =
        call === undefined ? new Set<string>() : roofSurfaceMaterials(call, cellsByCall.get(id) ?? [], registry.table);
      return {
        callId: id,
        profile: measureRoofProfile(grid, (c) => c.call === id && materials.has(c.state.canonical)),
      };
    }),
    belowGround,
    symmetry: measureSymmetry(grid, { glass: (c) => c.state.name.includes('glass') }),
    wallCoverage,
  };
}

function boundsText(grid: Grid): string {
  const bounds = grid.bounds();
  if (bounds === undefined) return '无';
  const point = (p: readonly [number, number, number]): string => `(${String(p[0])},${String(p[1])},${String(p[2])})`;
  return `${point(bounds.min)}–${point(bounds.max)}`;
}

function consoleSection(report: ChildReport): string {
  const shown = report.console.length;
  const dropped = report.consoleTruncated;
  if (shown === 0 && dropped === 0) return 'console（0 条）。';
  const lines = report.console.map((entry) => `  [${entry.level}] ${entry.text}`);
  if (dropped > 0) lines.push(`  …另有 ${String(dropped)} 条被丢弃`);
  return [`console（${String(consoleCount(report))} 条）：`, ...lines].join('\n');
}

const FURNITURE_REASON_MAX = 120;
/** check 文本里的逐对象明细上限；blocking / 未验证对象另有一行短摘要，避免大报告挤占上下文。 */
const CONFORMANCE_DETAIL_MAX_CHARS = 1600;
/** 短摘要最多点名的未关闭对象数。 */
const CONFORMANCE_PENDING_MAX_ITEMS = 6;
/** 墙材摘要最多列出的方块种类数。 */
const WALL_MATERIAL_MAX_BLOCKS = 4;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function percentText(part: number, total: number): string {
  return `${String(Number(((part / total) * 100).toFixed(1)))}%`;
}

/**
 * check 文本的短摘要：先给 blocking 数与未关闭对象 id，再跟 formatConformanceSummary 的逐项明细。
 * 只读 DiffReport，report-only；不参与 submit / gates。
 */
function isEmptyConformanceReport(report: DiffReport): boolean {
  const { pass, fail, missing, extra, unverified } = report.summary;
  return report.items.length === 0 && pass + fail + missing + extra + unverified === 0;
}

function conformanceFallbackLine(reason: string): string {
  const detail = reason.replace(/\s*\n\s*/g, ' ').trim();
  const suffix = detail === '' ? '' : `（${detail}）`;
  return `[fallback] 一致性：本次未拿到 canonical shadow 报告${suffix}，已回退对象图摘要；blocking 可能被低估，不要据此判断完成度。`;
}

function conformanceBriefLines(report: DiffReport): string[] {
  const pending = report.items.filter(
    (item) => item.status === 'fail' || item.status === 'missing' || item.status === 'unverified',
  );
  if (pending.length === 0) return [];
  const shown = pending.slice(0, CONFORMANCE_PENDING_MAX_ITEMS).map((item) => {
    const id = item.expectedId ?? item.actualId ?? item.id;
    const blocking =
      item.severity === 'hard' && (item.status === 'fail' || item.status === 'missing' || item.status === 'unverified');
    return `${item.status.toUpperCase()} ${id}${blocking ? '（blocking）' : ''}`;
  });
  const more = pending.length > shown.length ? `、…另 ${String(pending.length - shown.length)} 项` : '';
  return [
    `未验证 / 未关闭对象（仅报告）：blocking ${String(report.summary.blockingCount)}；${shown.join('、')}${more}。`,
  ];
}

/** 运行期校验期望墙 bounds；坏投影只跳过墙材摘要，不改变一致性 / check 状态。 */
function isWallBounds(value: unknown): value is ExpectedWall['bounds'] {
  if (typeof value !== 'object' || value === null) return false;
  const bounds = value as { readonly min?: unknown; readonly max?: unknown };
  const valid = (tuple: unknown): tuple is readonly [number, number, number] =>
    Array.isArray(tuple) && tuple.length === 3 && tuple.every((entry) => typeof entry === 'number');
  return valid(bounds.min) && valid(bounds.max);
}

/** wall 所在平面是否落在期望墙包络的外侧边上（半开 bounds 的 max 转成最外实体坐标）。 */
function wallOnEnvelope(wall: WallObject, bounds: ExpectedWall['bounds']): boolean {
  if (wall.wall.axis === 'x') {
    return wall.wall.plane === bounds.min[2] || wall.wall.plane === bounds.max[2] - 1;
  }
  return wall.wall.plane === bounds.min[0] || wall.wall.plane === bounds.max[0] - 1;
}

/**
 * 墙面材质摘要（report-only）：复用 as-built 墙对象的 materials 口径，按格数汇总前 4 种方块。
 * 调用方只在有期望墙时调用；这里只统计落在期望墙包络外侧边上的墙段，bounds 不可读时省略。
 * 不判 90% / 不参与 submit；只把“整面墙各材质多少格”亮给模型。
 */
function wallMaterialLines(
  graph: AsBuiltObjectGraph,
  expectedObjects: readonly ExpectedObject[] | undefined,
): string[] {
  const expectedWalls =
    expectedObjects?.filter(
      (object): object is ExpectedWall => object.kind === 'wall' && isWallBounds(object.bounds),
    ) ?? [];
  if (expectedWalls.length === 0) return [];
  const walls = graph.objects.filter((object): object is WallObject => object.kind === 'wall');
  const selected = walls.filter((wall) => expectedWalls.some((expected) => wallOnEnvelope(wall, expected.bounds)));
  if (selected.length === 0) return [];

  const counts = new Map<string, number>();
  let total = 0;
  for (const wall of selected) {
    for (const material of wall.materials) {
      counts.set(material.block, (counts.get(material.block) ?? 0) + material.cells);
      total += material.cells;
    }
  }
  if (total === 0) return [];

  const sorted = [...counts].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));
  const top = sorted.slice(0, WALL_MATERIAL_MAX_BLOCKS);
  const parts = top.map(
    ([block, cells], index) =>
      `${block} ${String(cells)}/${String(total)}（${percentText(cells, total)}${index === 0 ? '，占比最高' : ''}）`,
  );
  const more = sorted.length > top.length ? `；另 ${String(sorted.length - top.length)} 种` : '';
  return [`墙面材质（仅报告，不影响 submit）：${parts.join('、')}${more}。`];
}

function furnitureId(item: DiffItem): string {
  const raw = item.expectedId ?? item.actualId ?? item.id;
  return raw.startsWith('furniture:') ? raw.slice('furniture:'.length) : raw;
}

function furnitureReason(item: DiffItem): string {
  if (item.reason === null || (item.status !== 'fail' && item.status !== 'unverified')) return '';
  const reason =
    item.reason.length > FURNITURE_REASON_MAX ? `${item.reason.slice(0, FURNITURE_REASON_MAX - 1)}…` : item.reason;
  return `：${reason.replace(/\s*\n\s*/g, ' ')}`;
}

/** 家具核对摘要：仅报告，不进入 submit / gates；非 pass 项最多列 8 行。 */
function formatFurnitureCheck(items: readonly DiffItem[]): string {
  const counts = { pass: 0, fail: 0, missing: 0, extra: 0, unverified: 0 };
  for (const item of items) counts[item.status] += 1;
  const header =
    `家具核对（仅报告）：pass ${String(counts.pass)} / fail ${String(counts.fail)} / ` +
    `missing ${String(counts.missing)} / extra ${String(counts.extra)}` +
    (counts.unverified > 0 ? ` / unverified ${String(counts.unverified)}` : '');
  const details = items
    .filter((item) => item.status !== 'pass')
    .slice(0, 8)
    .map((item) => `- ${item.status.toUpperCase()} furniture ${furnitureId(item)}${furnitureReason(item)}`);
  return [header, ...details].join('\n');
}

function successText(
  version: number,
  grid: Grid,
  report: ChildReport,
  measures: MeasureInput,
  gateLines: readonly string[],
  conformanceLines: readonly string[],
  furnitureLines: readonly string[],
  wallMaterialEvidence: readonly string[],
  extraLines: readonly string[],
  provenanceLines: readonly string[],
): string {
  // 概览独立于裁剪后的明细；旧报告缺概览时明确省略数与未知分类，不补猜。
  const first =
    `${PRE(version)}执行成功，${String(grid.size)} 格，包围盒 ${boundsText(grid)}，调用 ${String(report.calls)} 次。` +
    formatOverlaps(report.overlaps, grid.calls(), {
      summary: report.overlapSummary,
      overlapsTruncated: report.overlapsTruncated,
    });
  return [
    first,
    ...gateLines,
    ...conformanceLines,
    ...furnitureLines,
    ...wallMaterialEvidence,
    ...extraLines,
    ...provenanceLines,
    formatMeasures(measures),
    consoleSection(report),
  ].join('\n');
}

/**
 * 执行一次 check_code。预检与执行的宿主缺陷（SandboxError）都归 `internal-error`，
 * runner 据此停止；非 SandboxError 的异常不可预期，直接抛出由入口统一记录。
 */
export async function checkCode(input: CheckInput, deps: CheckDeps): Promise<CheckResult> {
  const started = deps.clock();
  const parsed = deps.interfaces === undefined ? undefined : interfaceSpecsSchema.safeParse(deps.interfaces);
  if (parsed !== undefined && !parsed.success) {
    return {
      status: 'internal-error',
      text: `${PRE(input.version)}指定接口配置无效，没有执行：${parsed.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`).join('；')}`,
      precheck: null,
      run: null,
      archive: undefined,
      apiCalls: undefined,
      measures: undefined,
      wallMs: deps.clock() - started,
    };
  }

  let checked: PrecheckResult;
  try {
    checked = await deps.prechecker.check(input.code);
  } catch (error) {
    if (isSandboxError(error)) {
      return {
        status: 'internal-error',
        text: `${PRE(input.version)}类型预检内部错误：${error.message}`,
        precheck: null,
        run: null,
        archive: undefined,
        apiCalls: undefined,
        measures: undefined,
        wallMs: deps.clock() - started,
      };
    }
    throw error;
  }

  const precheck = summarizePrecheck(checked);
  if (checked.kind !== 'ok') {
    return {
      status: precheckStatus(checked),
      text: precheckText(input.version, checked),
      precheck,
      run: null,
      archive: undefined,
      apiCalls: undefined,
      measures: undefined,
      wallMs: deps.clock() - started,
    };
  }

  let result: RunResult;
  try {
    // M1c 资产通道：会话里登记的草模文档 + 宿主颜色候选（调用方每次 run 缓存一次）随输入透传。
    // 没有文档时不发 assets，child 输入与协议 v1 的既有形状一致。
    const documents = input.massingDocuments ?? [];
    const assets: RunInput['assets'] | undefined =
      documents.length === 0 ? undefined : { documents, colorCandidates: deps.massingColorCandidates?.() ?? [] };
    result = await deps.runCode({ code: input.code, seed: input.seed, ...(assets === undefined ? {} : { assets }) });
  } catch (error) {
    if (isSandboxError(error)) {
      return {
        status: 'internal-error',
        text: `${PRE(input.version)}沙箱内部错误：${error.message}`,
        precheck,
        run: null,
        archive: undefined,
        apiCalls: undefined,
        measures: undefined,
        wallMs: deps.clock() - started,
      };
    }
    throw error;
  }

  if (result.kind !== 'ok') {
    return {
      status: runFailureStatus(result),
      text: runFailureText(input.version, result),
      precheck,
      run: runSummaryOfFailure(result),
      archive: undefined,
      apiCalls: undefined,
      measures: undefined,
      wallMs: deps.clock() - started,
    };
  }

  const grid = readArchive(deps.registry.table, result.archive).grid;
  const interfaces = parsed === undefined ? undefined : diagnoseInterfaces(grid, deps.registry, parsed.data);
  const measures = measureAll(grid, deps.registry);
  // as-built 对象图同时服务一致性回退、家具核对与墙材摘要；提取失败只降级对应段落，不影响 check 状态。
  let asBuilt: AsBuiltObjectGraph | undefined;
  const needsAsBuilt = (deps.expectedObjects?.length ?? 0) > 0 || (deps.expectedFurniture?.length ?? 0) > 0;
  if (needsAsBuilt) {
    try {
      asBuilt = extractAsBuiltObjects(grid, deps.registry);
    } catch {
      asBuilt = undefined;
    }
  }
  const gateConfig = deps.gates;
  let gates: GateOutcome | undefined;
  let gateLines: readonly string[] = [];
  if (gateConfig !== undefined) {
    gates = evaluateGates(gateConfig, {
      grid,
      calls: measures.calls,
      symmetry: measures.symmetry,
      reach: measures.reach,
      reachTargets: measures.reachTargets,
      registry: deps.registry,
    });
    gateLines = gatesLines(gateConfig, gates, configuredGateCount(gateConfig));
  }
  let conformance: DiffReport | undefined;
  let conformanceLines: readonly string[] = [];
  let furnitureLines: readonly string[] = [];
  let canonicalReport = deps.conformanceReport;
  let canonicalFallbackReason: string | null = null;
  if (canonicalReport === undefined && deps.conformanceReportOf !== undefined) {
    // live 交接：shadow 报告依赖本次存档，只能在 run 成功后才生成。失败时保持旧的对象图回退，
    // 但必须在模型可见文本里标记降级，避免把可能低估的 blocking 当成 canonical 结论。
    try {
      canonicalReport = deps.conformanceReportOf(result.archive);
      if (canonicalReport === undefined) {
        canonicalFallbackReason = 'provider 未返回报告';
      } else if ((deps.expectedObjects?.length ?? 0) > 0 && isEmptyConformanceReport(canonicalReport)) {
        canonicalFallbackReason = 'provider 返回了空报告';
        canonicalReport = undefined;
      }
    } catch (error) {
      canonicalFallbackReason = error instanceof Error ? error.message : String(error);
      canonicalReport = undefined;
    }
  }
  if (canonicalReport !== undefined) {
    conformance = canonicalReport;
    conformanceLines = [
      ...conformanceBriefLines(canonicalReport),
      formatConformanceSummary(canonicalReport, CONFORMANCE_DETAIL_MAX_CHARS),
    ];
  } else if (deps.expectedObjects !== undefined && deps.expectedObjects.length > 0) {
    try {
      conformance = diffObjects(deps.expectedObjects, asBuilt ?? extractAsBuiltObjects(grid, deps.registry));
      conformanceLines = [
        ...(canonicalFallbackReason === null ? [] : [conformanceFallbackLine(canonicalFallbackReason)]),
        ...conformanceBriefLines(conformance),
        formatConformanceSummary(conformance, CONFORMANCE_DETAIL_MAX_CHARS),
      ];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      conformanceLines = [
        ...(canonicalFallbackReason === null ? [] : [conformanceFallbackLine(canonicalFallbackReason)]),
        `一致性检查不可用：${message.replace(/\s*\n\s*/g, ' ')}`,
      ];
    }
  }
  // 家具核对与一致性同口径：report-only，异常只降级为一行提示，不改变 check 状态。
  if (deps.expectedFurniture !== undefined && deps.expectedFurniture.length > 0) {
    try {
      const items = diffFurnitureObjects(deps.expectedFurniture, asBuilt ?? extractAsBuiltObjects(grid, deps.registry));
      furnitureLines = [formatFurnitureCheck(items)];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      furnitureLines = [`家具核对不可用：${message.replace(/\s*\n\s*/g, ' ')}`];
    }
  }
  // 墙材窗口只在设计交接（有期望墙）时出现，复用已提取的 as-built 对象图；
  // 提取失败或没有期望墙时静默省略，不新增 check 失败分支，也不改无期望对象时的旧文本。
  const hasExpectedWall = deps.expectedObjects?.some((object) => object.kind === 'wall') ?? false;
  const wallMaterialEvidence =
    asBuilt === undefined || !hasExpectedWall ? [] : wallMaterialLines(asBuilt, deps.expectedObjects);
  // 包络来源 lint：只加模型可见 warning，不并入 gates / measures / submit；顺序在门槛与一致性之后、测量之前。
  const provenanceLines = envelopeProvenanceWarnings(measures.calls);
  // 影子自证是 report-only：回调异常必须吞掉，不能改变 check 状态或文本。
  try {
    deps.onCheckArchive?.(result.archive);
  } catch {
    // 影子失败只由宿主日志记录；check_code 继续成功。
  }
  return {
    status: 'ok',
    text: successText(
      input.version,
      grid,
      result.report,
      measures,
      gateLines,
      conformanceLines,
      furnitureLines,
      wallMaterialEvidence,
      interfaces === undefined ? [] : formatInterfaces(interfaces),
      provenanceLines,
    ),
    precheck,
    run: runSummaryOfOk(result, grid),
    archive: result.archive,
    apiCalls: countApiCalls(grid.calls()),
    measures,
    ...(gates === undefined ? {} : { gates }),
    ...(interfaces === undefined ? {} : { interfaces }),
    ...(conformance === undefined ? {} : { conformance }),
    wallMs: deps.clock() - started,
  };
}
