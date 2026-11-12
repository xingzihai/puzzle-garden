/**
 * 确定性伪随机数：mulberry32。
 *
 * 体素世界的 hash 必须跨运行时、跨机器逐字节一致，所以所有"随机"都从这里取，
 * 禁止 `Math.random()` 与 `Math.sin` 类哈希（v0.2beta PITFALLS：浮点实现差异会让 hash 漂移）。
 */

/** 返回 [0, 1) 均匀分布的生成器；同一 seed 产生同一序列。 */
export function mulberry32(seed: number): () => number {
  if (!Number.isInteger(seed)) {
    throw new TypeError(`seed 必须是整数，实际是 ${String(seed)}`);
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** randomInt 支持的最大区间宽度：生成器只有 32 位精度，更宽的区间会分布不均。 */
export const MAX_SPAN = 2 ** 32;

/** 在闭区间 [min, max] 内取整数。区间宽度（max − min + 1）不能超过 {@link MAX_SPAN}。 */
export function randomInt(next: () => number, min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new RangeError(`区间非法：[${String(min)}, ${String(max)}]`);
  }
  if (max - min + 1 > MAX_SPAN) {
    throw new RangeError(`区间宽度 ${String(max - min + 1)} 超过上限 2^32：生成器精度不够，结果会分布不均`);
  }
  return min + Math.floor(next() * (max - min + 1));
}
