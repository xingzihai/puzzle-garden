/**
 * 花费计算与预留（MODEL-SPEC §4.2、§4.3）。
 *
 * 负责：`costOf` 按高峰价算一次请求的花费；`reserveFor` 按「全部未命中 + 输出上限」算预留。
 * 不负责：判断一次 run 的上限、进入提交窗口、以及 limit=0 时是否关闭护栏——这些在 agent 的护栏里（§4.3）。
 *
 * 金额一律用整数（元 × 1e8）累加，避免浮点误差（§4.2）。`reserveFor` 的 `spentCny` / `limitCny`
 * 因此应当来自 `costOf` 的整数累加结果，即 1e-8 元的整数倍。
 * 本文件是纯函数：不做 I/O。
 */

import { PRICING } from './pricing.ts';

/** 1 元 = 1e8 个记账单位（MODEL-SPEC §4.2）。 */
const OCTA = 100_000_000;
/** 高峰未命中输入价，元/百万 token → 每 1e8 元单位的权重 = 价格 × 1e8 / 1e6 = 价格 × 100。 */
const MISS_WEIGHT = PRICING.peak.cacheMiss * 100;
const HIT_WEIGHT = PRICING.peak.cacheHit * 100;
const OUTPUT_WEIGHT = PRICING.peak.output * 100;

/** `costOf` 只读的三个 usage 字段；字段名必须与官方一致（v0.2 对不上导致成本算成 0）。 */
export interface CostUsage {
  readonly prompt_cache_hit_tokens?: number | undefined;
  readonly prompt_cache_miss_tokens?: number | undefined;
  readonly completion_tokens: number;
}

function requireToken(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    throw new Error(`usage.${name} 缺失或不是非负整数：${String(value)}（应为官方 usage 的 token 数）`);
  }
  return value;
}

/** 一次请求的花费（元），一律按高峰价（上界）。 */
export function costOf(usage: CostUsage): number {
  const hit = requireToken(usage.prompt_cache_hit_tokens, 'prompt_cache_hit_tokens');
  const miss = requireToken(usage.prompt_cache_miss_tokens, 'prompt_cache_miss_tokens');
  const output = requireToken(usage.completion_tokens, 'completion_tokens');
  const octa = hit * HIT_WEIGHT + miss * MISS_WEIGHT + output * OUTPUT_WEIGHT;
  return octa / OCTA;
}

/** 常规单次请求的最小输出预留（MODEL-SPEC §4.3）。 */
export const MIN_REQUEST_MAX_TOKENS = 2000;
/** 提交窗口最后一口气允许的最小输出预留；低于它仍停。 */
export const LAST_GASP_MIN_OUTPUT_TOKENS = 256;
/** 提交窗口最后一口气的输出上限；只够一次 submit / 小编辑，不放宽到常规 40k。 */
export const LAST_GASP_MAX_OUTPUT_TOKENS = 1024;

export interface ReserveInput {
  /** 上一轮请求的 `prompt_tokens`；首次请求为 0。 */
  readonly prevPromptTokens: number;
  /** 是否本次 run 的第一次请求：额外 +2048 覆盖模板与工具包装（C5）。 */
  readonly first: boolean;
  /** 新增字节数（含 system 与工具定义）；字节数是 BPE token 数的上界。 */
  readonly newBytes: number;
  readonly newMessages: number;
  readonly newImages: number;
  readonly spentCny: number;
  readonly limitCny: number;
  /**
   * 提交窗口的最后一口气：常规预留已低于 2000 时，若剩余预算仍大于最近一次真实
   * 请求花费，允许把输出上限压到 256–1024 再发一次。硬约束不变：
   * `spent + reserved ≤ limit`。缺省时保持原行为。
   */
  readonly submitLastGasp?: SubmitLastGasp;
}

export interface SubmitLastGasp {
  /** 最近请求的实际花费（元），新的在后；用最大值作为“一次真实请求”的保守估计。 */
  readonly recentCostsCny: readonly number[];
}

export type ReserveResult =
  | {
      readonly maxTokens: number;
      readonly reservedCny: number;
      readonly inputUpper: number;
      /** true 表示这是低于常规 2000 的提交窗口最后一口气。 */
      readonly lastGasp?: true;
    }
  | { readonly stop: true };

function requireCount(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`reserveFor.${name} 应是非负整数，实际是 ${String(value)}`);
  }
  return value;
}

/**
 * 单次请求前的预留（MODEL-SPEC §4.3 第 1 步）。
 * 硬约束：`spentCny + reservedCny ≤ limitCny`（在 spent/limit 为 1e-8 整数倍时精确成立）。
 * 常规 `maxTokens < 2000` 时不发请求，返回 `{ stop: true }`；提交窗口传入
 * `submitLastGasp` 时，只有在剩余仍大于最近真实花费、且能覆盖最坏输入 + 256 token 时，
 * 才放行一次 256–1024 的小输出请求。工具选择在响应前不可知，所以这是“提交窗口最后一口气”，
 * 不是按 submit 名字预判的硬门。
 */
export function reserveFor(input: ReserveInput): ReserveResult {
  requireCount(input.prevPromptTokens, 'prevPromptTokens');
  requireCount(input.newBytes, 'newBytes');
  requireCount(input.newMessages, 'newMessages');
  requireCount(input.newImages, 'newImages');

  const inputUpper =
    input.prevPromptTokens +
    input.newBytes +
    32 * input.newMessages +
    1024 * input.newImages +
    (input.first ? 2048 : 0);

  const limit = Math.round(input.limitCny * OCTA);
  const spent = Math.round(input.spentCny * OCTA);
  const inputOcta = inputUpper * MISS_WEIGHT;
  const room = limit - spent - inputOcta;
  // 40k 是成本预留的项目上限，不是 deepseek-flash 的模型输出上限（官方单次 API completion 上限 384K = 393,216）。
  const maxTokens = Math.min(40_000, Math.floor(room / OUTPUT_WEIGHT));
  if (maxTokens >= MIN_REQUEST_MAX_TOKENS) {
    return { maxTokens, reservedCny: (inputOcta + maxTokens * OUTPUT_WEIGHT) / OCTA, inputUpper };
  }
  // 提交窗口最后一口气：剩余预算大于最近一次真实请求，且仍能覆盖最坏输入 + 小输出。
  // 不降低输入预留、不伪造成本；maxTokens 仍是硬上限，所以实际花费不会超过 limit。
  const recent = input.submitLastGasp?.recentCostsCny.filter((cny) => Number.isFinite(cny) && cny >= 0) ?? [];
  if (recent.length === 0) return { stop: true };
  const estimateOcta = Math.round(Math.max(...recent) * OCTA);
  if (estimateOcta <= 0) return { stop: true };
  if (limit - spent <= estimateOcta) return { stop: true };
  const lastGaspTokens = Math.min(LAST_GASP_MAX_OUTPUT_TOKENS, Math.floor(room / OUTPUT_WEIGHT));
  if (lastGaspTokens < LAST_GASP_MIN_OUTPUT_TOKENS) return { stop: true };
  return {
    maxTokens: lastGaspTokens,
    reservedCny: (inputOcta + lastGaspTokens * OUTPUT_WEIGHT) / OCTA,
    inputUpper,
    lastGasp: true,
  };
}
