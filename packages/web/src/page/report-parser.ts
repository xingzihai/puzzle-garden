/**
 * 浏览器端：`/api/report` 响应窄化，以及蓝图 / 报告解析共用的 JSON 窄化助手。
 *
 * 负责：把未知 JSON 收窄成 `ViewerReport`（CheckReport + BlueprintDiff + 代表路线条数）；
 * 导出 `require*` / `oneOf` 给 `scene.ts` 复用，避免两份窄化实现。
 * 不负责：蓝图元素的几何与楼层显示（scene.ts）、DOM 与渲染（main.ts）。
 *
 * 数据边界：服务端已用 @pg/design 的 schema 校验；这里只读查看器用得到的字段，
 * 不重复完整 schema；服务端附加的未知字段（如 routeReports 的条目内容）不解析。
 */
import type { CheckReport } from '@pg/design/checks';
import type { BlueprintDiff } from '@pg/design/diff';

/** 概念草模评审标识：存在时前端不把空报告当“绿色通过”。 */
export interface ConceptReview {
  readonly kind: 'concept';
  readonly message: string;
}

/** `/api/report` 的查看器视图：报告相对 base、差异也相对 base，并给出概念评审与代表路线条数。 */
export interface ViewerReport {
  readonly report: CheckReport;
  readonly diff: BlueprintDiff;
  /** 概念评审；服务端未给出 review 时为 null（兼容旧响应）。 */
  readonly review: ConceptReview | null;
  /** 代表路线条数；服务端未返回 `routeReports` 时为 0（新老响应都可读）。 */
  readonly checkedRoutes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} 必须是对象`);
  return value;
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} 必须是非空字符串`);
  return value;
}

export function requireInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${path} 必须是整数`);
  return value;
}

export function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
  const items: readonly unknown[] = value;
  return items;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  for (const item of allowed) {
    if (value === item) return item;
  }
  throw new Error(`${path} 取值非法：${String(value)}；允许 ${allowed.join('、')}`);
}

function parseCheckReport(value: unknown): CheckReport {
  const record = requireRecord(value, '报告');
  const issues = requireArray(record['issues'], '报告.issues').map((item, index) => {
    const issue = requireRecord(item, `报告.issues[${String(index)}]`);
    return {
      code: requireString(issue['code'], `报告.issues[${String(index)}].code`),
      message: requireString(issue['message'], `报告.issues[${String(index)}].message`),
      elementIds: requireArray(issue['elementIds'], `报告.issues[${String(index)}].elementIds`).map((id, idIndex) =>
        requireString(id, `报告.issues[${String(index)}].elementIds[${String(idIndex)}]`),
      ),
    };
  });
  return {
    issues,
    checkedClearances: requireInt(record['checkedClearances'], '报告.checkedClearances'),
    status: oneOf(record['status'], ['pass', 'issues'], '报告.status'),
  };
}

function parseDiff(value: unknown): BlueprintDiff {
  const record = requireRecord(value, '版本差异');
  const ids = (field: string): readonly string[] =>
    requireArray(record[field], `版本差异.${field}`).map((id, index) =>
      requireString(id, `版本差异.${field}[${String(index)}]`),
    );
  return { added: ids('added'), removed: ids('removed'), changed: ids('changed'), spacesChanged: ids('spacesChanged') };
}

/** 同级 `routeReports` 的条数；字段缺失按 0（兼容尚未带路线报告的响应），存在则必须是数组。 */
function routeCount(record: Record<string, unknown>): number {
  const routes = record['routeReports'];
  if (routes === undefined) return 0;
  return requireArray(routes, '报告响应.routeReports').length;
}

/** 概念评审：kind 必须是 `concept`，message 必须是非空字符串；字段缺失返回 null。 */
function parseReview(value: unknown): ConceptReview | null {
  if (value === undefined) return null;
  const record = requireRecord(value, '报告响应.review');
  return {
    kind: oneOf(record['kind'], ['concept'], '报告响应.review.kind'),
    message: requireString(record['message'], '报告响应.review.message'),
  };
}

/** 解析 `/api/report` 响应：{ review?, report, diff, routeReports? }。 */
export function parseReportPayload(value: unknown): ViewerReport {
  const record = requireRecord(value, '报告响应');
  return {
    report: parseCheckReport(record['report']),
    diff: parseDiff(record['diff']),
    review: parseReview(record['review']),
    checkedRoutes: routeCount(record),
  };
}
