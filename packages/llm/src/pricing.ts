/**
 * DeepSeek 价格表（MODEL-SPEC §4.1）。
 *
 * 负责：把手抄自官方定价页的价格写成唯一常量，并给出内容哈希版本号。
 * 不负责：算一次请求的花费（cost.ts）、判断高峰/空闲（本项目一律按高峰价记账）。
 *
 * `PRICING_VERSION` 是写死的 12 位十六进制字面量，`pricing.test.ts` 用 node:crypto
 * 对 `JSON.stringify(PRICING)` 复算并比对；改价格忘了改版本号测试即红（C2）。
 * 产品代码不算 hash，所以本文件保持纯函数文件。
 */

export const PRICING = {
  currency: 'CNY',
  unit: 'per-1M-tokens',
  model: 'deepseek-flash',
  modelVersion: 'DeepSeek-V4.1-Flash',
  effectiveDate: '2026-10-03', // 查阅日；官方页不写生效日
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  // 高峰：缓存命中 / 未命中 / 输出，单位 元/百万 token。
  peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  // 空闲时段半价；只作参考，不用于记账（MODEL-SPEC §4.2，§13）。
  offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
} as const;

/** `sha256(JSON.stringify(PRICING))` 的前 12 位十六进制（声明顺序不变）。 */
export const PRICING_VERSION = '3e6f5738e3fc';
