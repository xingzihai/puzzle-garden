/**
 * 性能基准的定义格式。各包在 `src/**\/*.bench.ts` 里默认导出 `Bench[]`，由 `npm run bench`（tools/bench.ts）运行。
 * 放在 @pg/core（第 0 层）是为了让所有包都能 import；本文件只有类型，没有运行时代码。
 */

export interface Bench {
  readonly name: string;
  /** 每次迭代执行的工作；可以返回 Promise，计时会等它完成。返回值会被保留，防止被优化掉。 */
  readonly run: () => unknown;
  /** 正式计时前的预热次数，默认 3。 */
  readonly warmup?: number;
  /** 正式计时次数，默认 10。 */
  readonly iterations?: number;
}
