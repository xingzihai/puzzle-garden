/**
 * 固定时刻的 Date 替身（SANDBOX-SPEC §2.2、§7.2、F1）。
 *
 * 负责：用真实 `Date` 构造一个替身函数——`Date()` 函数调用返回固定时刻字符串，`new Date()` 无参
 * 用固定时刻，带参照常构造；`now` / `UTC` / `parse` 与原 `Date` 一致；`prototype` 指向真实
 * `Date.prototype`（`instanceof Date` 成立）。
 * 不负责：把它挂到哪个全局对象（child-globals 替换 `globalThis.Date`；child-preload 在冻结前
 * 堵住 `Date.prototype.constructor` 后门）；也不负责删除其它全局。
 *
 * 为什么用普通函数而不是子类 / Proxy：子类覆盖不了 `Date()` 函数调用形式；Proxy 在
 * `--frozen-intrinsics` 下因 `Date.now` 不可配置而违反代理不变量（§2.2 实测）。
 */

/** 固定时刻：2000-01-01T00:00:00Z（§2.2）。 */
export const FIXED_TIME = 946684800000;

/** 用给定的真实 Date 构造固定时刻替身；返回值可安全 `new` 与直接调用。 */
export function createFixedDate(RealDate: DateConstructor): DateConstructor {
  function FixedDate(...args: unknown[]): unknown {
    // TS 把函数里的 new.target 视为 undefined（FixedDate 在类型层从不被 new），运行时模型会 new；
    // 经 unknown 转一手让条件判断与 Reflect.construct 都成立。
    const newTarget: unknown = new.target;
    if (newTarget === undefined) return new RealDate(FIXED_TIME).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [FIXED_TIME] : args, newTarget as typeof Date);
  }
  FixedDate.prototype = RealDate.prototype;
  Object.defineProperties(FixedDate, {
    now: { value: (): number => FIXED_TIME, configurable: true, writable: true },
    UTC: { value: RealDate.UTC, configurable: true, writable: true },
    parse: { value: RealDate.parse, configurable: true, writable: true },
  });
  return FixedDate as unknown as DateConstructor;
}

/**
 * child-preload 用：在 `--frozen-intrinsics` 冻结内置之前执行，把真实 `Date.prototype.constructor`
 * 指回替身、把真实 `Date.now` 换成固定值，堵住经 `Date.prototype.constructor` 取回真实时间的后门。
 * globalThis.Date 的替换由 child-globals 的 prepareGlobals 做。
 */
export function installFixedDate(): void {
  const RealDate = Date;
  (RealDate.prototype as { constructor: unknown }).constructor = createFixedDate(RealDate);
  RealDate.now = (): number => FIXED_TIME;
}
