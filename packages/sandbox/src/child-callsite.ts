/**
 * 从堆栈字符串里取模型代码位置（SANDBOX-SPEC §4）。
 *
 * 负责：按锚定正则匹配 `pg:building:<line>:<column>` 帧，取第一处；找不到返回 0。
 * 不负责：堆栈生成与调用点注入（createCallSite 只包一层 `new Error().stack`）。
 *
 * 为什么不用 Error.prepareStackTrace：`--frozen-intrinsics` 下它不可赋值（§4 实测）。
 * 正则锚定整行：模型可以把计算属性名写成 `'pg:building:999:1'`，不锚定会取到假行号。
 */

/** 只匹配整行末尾的 pg:building 帧；`at Object.pg:building:999:1 (pg:building:3:5)` 取 3。 */
const FRAME = /^\s+at (?:.*\()?pg:building:(\d+):(\d+)\)?$/;

export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

/** 取第一个属于模型代码的帧；没有返回 { line: 0, column: 0 }。 */
export function lineFromStack(stack: string | undefined): SourceLocation {
  if (stack === undefined) return { line: 0, column: 0 };
  for (const row of stack.split('\n')) {
    const match = FRAME.exec(row);
    if (match !== null) {
      const line = match[1];
      const column = match[2];
      if (line !== undefined && column !== undefined) return { line: Number(line), column: Number(column) };
    }
  }
  return { line: 0, column: 0 };
}

/** geometry 的 `callSite`：每次成功登记调用时取一次堆栈行号。 */
export function createCallSite(): () => number {
  return () => lineFromStack(new Error().stack).line;
}
