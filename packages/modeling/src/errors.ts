/**
 * 建模包的可预期失败：参数非法、轮廓非法、网格非法、越界与 finish 后继续添加。
 *
 * 负责：ModelError 类与 zod 问题列表的格式化（路径 + 中文消息），供调用方直接抛给模型作者。
 * 不负责：内部不变量错误（那些按 STANDARDS 直接抛出，由入口记录）、I/O。
 */

/** 可预期的建模输入 / 使用错误；消息面向模型作者，说清哪个参数、实际值、合法范围。 */
export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

/** zod 问题的最小结构，避免 errors.ts 依赖 zod 运行时。 */
export interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** 把 zod 的问题格式化成一行「路径: 消息」，用「；」分隔，路径为空时写「(根)」。 */
export function formatIssues(issues: readonly IssueLike[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(根)';
      return `${path}: ${issue.message}`;
    })
    .join('；');
}
