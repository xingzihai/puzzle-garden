/**
 * trace 派生（MODEL-SPEC §7.6）。
 *
 * 负责：把事件数组派生为 `trace.json`（轮数、花费、命中率、停止原因、交付物、组件版本，
 *       回放时与原 run 的版本差异）。统计只由事件决定，不存在两份事实。
 * 不负责：写 trace.json（agent 调用方落盘）、事件定义（events.ts）。
 * 本文件是纯函数：不做 I/O，不读全局可变状态、时间或 locale。
 */

import type { LlmFailure } from '@pg/llm/schema';

import type { Event, Ref, RenderVersion, StopReason, Versions } from './events.ts';

export const STOP_CATEGORIES = ['delivered', 'budget', 'model-behavior', 'provider', 'host', 'cancelled'] as const;
export type StopCategory = (typeof STOP_CATEGORIES)[number];

export interface TraceTotals {
  readonly turns: number;
  readonly requests: number;
  readonly attempts: number;
  readonly promptTokens: number;
  readonly hitTokens: number | null;
  readonly missTokens: number | null;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly costCny: number | null;
  readonly wallMs: number;
  readonly images: number;
  readonly imageBytes: number;
}

/** 父 run 的 trace 里每条 `subrun.result` 的摘要（SUBAGENT-LOOP-SPEC §7.3）。 */
export interface TraceSubrun {
  readonly runId: string;
  readonly dir: string;
  readonly callId: string;
  readonly status: 'success' | 'failed' | 'aborted' | 'rejected';
  readonly costCny: number;
  readonly turns: number;
}

export interface Trace {
  readonly runId: string;
  readonly mode: 'live' | 'script' | 'replay';
  readonly seed: number;
  readonly stopReason: StopReason | null;
  readonly stopCategory: StopCategory;
  readonly delivered: boolean;
  /** 非 live run 的花费是模拟值，不进真实花费统计（MODEL-SPEC §6.4）。 */
  readonly simulated: boolean;
  readonly hitRate: number | null;
  readonly accounting?: 'unmetered';
  readonly totals: TraceTotals;
  readonly versions: Versions;
  readonly render: RenderVersion | null;
  readonly versionDiff: readonly string[];
  readonly delivery?: { readonly codeVersion: number; readonly hash: string };
  readonly failure?: LlmFailure;
  readonly lastArchive?: Ref;
  readonly lastModel?: Ref;
  /** 子运行记录（来自 `run.start.parent`）；根运行为 undefined，旧记录同样缺省。 */
  readonly parent?: { readonly runId: string; readonly dir: string; readonly callId: string; readonly turn: number };
  /** 父运行按 seq 收集的子运行摘要；没有 `subrun.result` 时省略（旧记录兼容）。 */
  readonly subruns?: readonly TraceSubrun[];
}

function stopCategoryOf(delivered: boolean, stopReason: StopReason | null): StopCategory {
  if (delivered && stopReason === null) return 'delivered';
  if (stopReason === null) return 'delivered';
  if (stopReason === 'cost-budget' || stopReason === 'max-turns' || stopReason === 'wall') return 'budget';
  if (stopReason === 'context-limit' || stopReason === 'image-budget') return 'budget';
  if (stopReason === 'degenerate-loop' || stopReason === 'stuck' || stopReason === 'no-tool') return 'model-behavior';
  if (stopReason === 'llm-error') return 'provider';
  if (stopReason === 'sandbox-unsupported' || stopReason === 'internal-error') return 'host';
  return 'cancelled';
}

/** 没有 `run.end` 时的兜底统计：只由 `llm.*` 与 `turn.start` 事件累加。 */
function computeTotals(events: readonly Event[]): TraceTotals {
  let turns = 0;
  let requests = 0;
  let attempts = 0;
  let promptTokens = 0;
  let hitTokens: number | null = 0;
  let missTokens: number | null = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let costCny: number | null = events.some((e) => e.type === 'run.start' && e.body.accounting === 'unmetered')
    ? null
    : 0;
  let wallMs = 0;
  let images = 0;
  let imageBytes = 0;
  for (const event of events) {
    if (event.type === 'turn.start') {
      turns += 1;
      wallMs = event.body.elapsedMs;
    } else if (event.type === 'llm.request') {
      requests += 1;
      images = event.body.images;
      imageBytes = event.body.imageBytes;
    } else if (event.type === 'llm.attempt') {
      attempts += 1;
      costCny = costCny === null || event.body.settledCny === null ? null : costCny + event.body.settledCny;
    } else if (event.type === 'llm.response' && event.body.outcome === 'ok') {
      const { usage } = event.body;
      promptTokens += usage.prompt_tokens;
      hitTokens =
        hitTokens === null || usage.prompt_cache_hit_tokens === undefined
          ? null
          : hitTokens + usage.prompt_cache_hit_tokens;
      missTokens =
        missTokens === null || usage.prompt_cache_miss_tokens === undefined
          ? null
          : missTokens + usage.prompt_cache_miss_tokens;
      completionTokens += usage.completion_tokens;
      reasoningTokens += usage.completion_tokens_details?.reasoning_tokens ?? 0;
    } else if (event.type === 'subrun.result') {
      // 子运行花费也算父 run 的花费（有 run.end 时优先它，子花费已在父 totals 里，不双计）。
      if (costCny !== null) costCny += event.body.costCny;
    }
  }
  return {
    turns,
    requests,
    attempts,
    promptTokens,
    hitTokens,
    missTokens,
    completionTokens,
    reasoningTokens,
    costCny,
    wallMs,
    images,
    imageBytes,
  };
}

/** 比较两组组件版本，按 versions 声明顺序列出内容不同的顶层项（如 `git`、`pricing`）。 */
function diffVersions(current: Versions, baseline: Versions): string[] {
  // 旧 run 没有 promptVariant 键（决策 #84），等价于 base；不归一化会把缺键与 'base' 误报成一项差异。
  const valueOf = (v: Versions, key: string): unknown =>
    key === 'promptVariant' ? (v.promptVariant ?? 'base') : Object.entries(v).find(([k]) => k === key)?.[1];
  // Object.keys 的顺序 = Versions 的声明顺序；当前值与基线值都按同一键取。
  return [...new Set([...Object.keys(current), ...Object.keys(baseline)])].filter(
    (key) => JSON.stringify(valueOf(current, key)) !== JSON.stringify(valueOf(baseline, key)),
  );
}

/**
 * 事件数组 → trace。`baseline` 只在回放 run 里给原 run 的事件，用来列版本差异；
 * 给了 `baseline` 但它没有 `run.start` 时抛错，避免静默得出「无差异」。
 */
export function deriveTrace(events: readonly Event[], baseline?: readonly Event[]): Trace {
  const start = events.find((event) => event.type === 'run.start');
  if (start === undefined) throw new Error('deriveTrace 需要一条 run.start 事件');
  const runStart = start.body;

  const end = events.find((event) => event.type === 'run.end');
  const renderEvent = events.find((event) => event.type === 'versions.render');
  const delivery = events.find((event) => event.type === 'delivery' || event.type === 'model.delivery');

  const totals = end?.body.totals ?? computeTotals(events);
  const stopReason = end?.body.stopReason ?? null;
  const failure = end?.body.failure ?? null;
  const lastArchive = end?.body.lastArchive ?? null;
  const delivered = delivery !== undefined;

  const parent = runStart.parent;
  const subruns: TraceSubrun[] = events
    .filter((event): event is Extract<Event, { type: 'subrun.result' }> => event.type === 'subrun.result')
    .map((event) => ({
      runId: event.body.runId,
      dir: event.body.dir,
      callId: event.body.callId,
      status: event.body.status,
      costCny: event.body.costCny,
      turns: event.body.turns,
    }));

  let versionDiff: readonly string[] = [];
  if (baseline !== undefined) {
    const baseStart = baseline.find((event) => event.type === 'run.start');
    if (baseStart === undefined) throw new Error('deriveTrace 的 baseline 缺 run.start，无法比版本');
    versionDiff = diffVersions(runStart.versions, baseStart.body.versions);
  }

  return {
    runId: start.runId,
    mode: runStart.mode,
    seed: runStart.seed,
    stopReason,
    stopCategory: stopCategoryOf(delivered, stopReason),
    delivered,
    simulated: runStart.mode !== 'live',
    hitRate: totals.hitTokens === null ? null : totals.promptTokens > 0 ? totals.hitTokens / totals.promptTokens : 0,
    ...(runStart.accounting === 'unmetered' ? { accounting: 'unmetered' as const } : {}),
    totals,
    versions: runStart.versions,
    render: renderEvent?.body.render ?? null,
    versionDiff,
    ...(delivery !== undefined
      ? { delivery: { codeVersion: delivery.body.codeVersion, hash: delivery.body.hash } }
      : {}),
    ...(failure !== null ? { failure } : {}),
    ...(lastArchive !== null ? { lastArchive } : {}),
    ...(end?.body.lastModel === undefined ? {} : { lastModel: end.body.lastModel }),
    ...(parent === undefined ? {} : { parent }),
    ...(subruns.length === 0 ? {} : { subruns }),
  };
}
