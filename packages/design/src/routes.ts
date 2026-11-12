/**
 * 路线站立面验证（MASSING-SPEC §2 的补充检查）。
 *
 * 负责：把手写的站立点 / 分段路线展开成逐格，核对
 *  (1) 每格脚下确有实体盒支承（marker / glazing / 非盒形不算踏面）；
 *  (2) 每格头顶 3 格净空不被非 marker 实体侵入；
 *  (3) 相邻格水平只走一格、升降不超过 1；不允许跳过未列出的格子（未验证空档）。
 * 不负责：schema 校验（schema.ts）、净空区求交（checks.ts）、自动寻路与路径规划。
 *
 * 为什么单独检查脚下：checks.ts 只证明所列 Clearance 未被几何侵入；一条路线完全可能落在
 * 空 Clearance 上方，却没有可站立的地面。这里补的是"查空不查脚下"的缺口。
 *
 * 坐标约定与 MASSING-SPEC / example 一致：格柱 (x, z) 的 y 为站立面顶面标高；
 * 实体盒覆盖半开区间 `[min, max)`，顶面为 max[1]；头顶净空取 `[x,x+1)×[y,y+3)×[z,z+1)`。
 * 全部导出结构由 zod 派生并 `.readonly()`（解析结果会被冻结），坐标必须是整数，浮点直接拒绝。
 */
import { z } from 'zod';
import type { Blueprint, Bounds, Element } from './schema.ts';

const ID_MAX = 64;
const NAME_MAX = 128;
const ROUTE_STEPS_MAX = 4000;
const COORD_MIN = -1_000_000;
const COORD_MAX = 1_000_000;
const ISSUE_MESSAGE_MAX = 2000;
/** 头顶净空高度；蓝图普通通路约定 3。 */
export const HEADROOM = 3;

const coord = z.int().min(COORD_MIN).max(COORD_MAX);
const id = z.string().min(1).max(ID_MAX);
const name = z.string().min(1).max(NAME_MAX);

/** 一个站立格：x、z 是格柱，y 是该格站立面顶面标高。 */
export const StandingPoint = z.strictObject({ x: coord, z: coord, y: coord }).readonly();
export type StandingPoint = z.infer<typeof StandingPoint>;

/** 一个显式站立点步骤。 */
export const RouteStand = z.strictObject({ kind: z.literal('stand'), x: coord, z: coord, y: coord }).readonly();
export type RouteStand = z.infer<typeof RouteStand>;

/**
 * 一段沿单轴的连续格：axis 方向 from→to（含两端），横向固定 cross，
 * y 在 from 处为 startY，每前进一格升降 step（只允许 −1 / 0 / 1）。
 */
export const RouteRun = z
  .strictObject({
    kind: z.literal('run'),
    axis: z.enum(['x', 'z']),
    from: coord,
    to: coord,
    cross: coord,
    startY: coord,
    step: z.int().min(-1).max(1),
  })
  .readonly();
export type RouteRun = z.infer<typeof RouteRun>;

/** 路线的一步：显式站立点或连续分段（可辨识联合，便于直接给出坐标与错误位置）。 */
export const RouteStep = z.discriminatedUnion('kind', [RouteStand, RouteRun]).readonly();
export type RouteStep = z.infer<typeof RouteStep>;

/** 手写路线：id、名称与至少一个步骤；坐标全部为整数（浮点解析失败）。 */
export const Route = z
  .strictObject({
    id,
    name,
    steps: z.array(RouteStep).min(1).max(ROUTE_STEPS_MAX).readonly(),
  })
  .readonly();
export type Route = z.infer<typeof Route>;

/** 路线问题代码。 */
export const RouteIssueCode = z.enum([
  'route-schema',
  'unsupported-stand',
  'headroom-intrusion',
  'unverified-gap',
  'step-too-tall',
]);
export type RouteIssueCode = z.infer<typeof RouteIssueCode>;

/** 一条可读问题；at 是出问题的格（schema 失败时为 null），elementIds 是相关实体。 */
export const RouteIssue = z
  .strictObject({
    code: RouteIssueCode,
    message: z.string().min(1).max(ISSUE_MESSAGE_MAX),
    at: StandingPoint.nullable(),
    elementIds: z.array(id).readonly(),
  })
  .readonly();
export type RouteIssue = z.infer<typeof RouteIssue>;

/** 路线报告：status 由是否有问题决定，firstIssue 是首个问题，issues 是全部问题。 */
export const RouteReport = z
  .strictObject({
    routeId: z.string(),
    routeName: z.string(),
    status: z.enum(['pass', 'issues']),
    cellsChecked: z.int().nonnegative(),
    issues: z.array(RouteIssue).readonly(),
    firstIssue: RouteIssue.nullable(),
  })
  .readonly();
export type RouteReport = z.infer<typeof RouteReport>;

/** 展开后的一个格。 */
interface Cell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** id 的显式排序：不用 localeCompare（docs/STANDARDS.md §5）。 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 半开区间 [min, max) 的轴对齐包围盒求交；任一轴分离即不相交，面贴面不算相交。 */
function intersects(a: Bounds, b: Bounds): boolean {
  return (
    a.min[0] < b.max[0] &&
    b.min[0] < a.max[0] &&
    a.min[1] < b.max[1] &&
    b.min[1] < a.max[1] &&
    a.min[2] < b.max[2] &&
    b.min[2] < a.max[2]
  );
}

/** 盒的水平投影是否完整覆盖格柱 (x, z)：`x <= X < max`。 */
function covers(bounds: Bounds, x: number, z: number): boolean {
  return bounds.min[0] <= x && x + 1 <= bounds.max[0] && bounds.min[2] <= z && z + 1 <= bounds.max[2];
}

/**
 * 是否算脚下踏面：必须是实体盒（shape=box），且顶面正落在站立标高 y。
 * marker 是标注点、glazing 是玻璃，都不提供可站立地面，不计为支承。
 */
function isFootSupport(element: Element, x: number, z: number, y: number): boolean {
  if (element.kind === 'marker' || element.kind === 'glazing') return false;
  if (element.shape !== 'box') return false;
  return element.bounds.max[1] === y && covers(element.bounds, x, z);
}

/** 顶面同样在 y、水平覆盖该格，但不算踏面的实体（marker / glazing / 非盒形），用于诊断。 */
function isExcludedCover(element: Element, x: number, z: number, y: number): boolean {
  return element.bounds.max[1] === y && covers(element.bounds, x, z) && !isFootSupport(element, x, z, y);
}

/** 把分段展开成格；from→to 可为任意方向，y 随格号线性变化。 */
function expandRun(run: RouteRun): Cell[] {
  const sign = run.to >= run.from ? 1 : -1;
  const count = Math.abs(run.to - run.from) + 1;
  const cells: Cell[] = [];
  for (let index = 0; index < count; index += 1) {
    const along = run.from + sign * index;
    const y = run.startY + index * run.step;
    cells.push(run.axis === 'x' ? { x: along, y, z: run.cross } : { x: run.cross, y, z: along });
  }
  return cells;
}

/** 展开整条路线，顺手去掉相邻的完全重复格；超过上限时提前返回并标记 overflow。 */
function expandRoute(route: Route): { readonly cells: readonly Cell[]; readonly overflow: boolean } {
  const cells: Cell[] = [];
  for (const step of route.steps) {
    const expanded = step.kind === 'stand' ? [{ x: step.x, y: step.y, z: step.z }] : expandRun(step);
    for (const cell of expanded) {
      const last = cells[cells.length - 1];
      if (last?.x === cell.x && last.y === cell.y && last.z === cell.z) continue;
      cells.push(cell);
      if (cells.length > ROUTE_STEPS_MAX) return { cells, overflow: true };
    }
  }
  return { cells, overflow: false };
}

/** zod 问题转成一行可读中文前缀；路径用点连接。 */
function readableZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '(根)';
      return `${path}: ${issue.message}`;
    })
    .join('；');
}

/** 只展示前若干个 id，其余折叠成计数，避免消息过长。 */
function formatIds(ids: readonly string[]): string {
  const shown = ids.slice(0, 8);
  const rest = ids.length - shown.length;
  return rest > 0 ? `${shown.join('、')} 等 ${String(ids.length)} 个` : shown.join('、');
}

function makeIssue(code: RouteIssueCode, message: string, at: Cell | null, elementIds: readonly string[]): RouteIssue {
  return RouteIssue.parse({
    code,
    message: message.slice(0, ISSUE_MESSAGE_MAX),
    at: at === null ? null : { x: at.x, z: at.z, y: at.y },
    elementIds: [...elementIds].sort(compareIds),
  });
}

function makeReport(
  routeId: string,
  routeName: string,
  cellsChecked: number,
  issues: readonly RouteIssue[],
): RouteReport {
  return RouteReport.parse({
    routeId,
    routeName,
    status: issues.length > 0 ? 'issues' : 'pass',
    cellsChecked,
    issues: [...issues],
    firstIssue: issues[0] ?? null,
  });
}

/**
 * 校验一条手工路线在蓝图上是否可以逐格站立、行进。
 *
 * 逐格检查脚下支承与头顶净空；相邻格要求水平相邻一格且升降 ≤1，跳过格子即报未验证空档。
 * route 传未解析的原始数据；不符合 Route schema（含浮点坐标）时返回 code=route-schema 的报告，
 * 而不是抛错或伪通过。返回的报告由 zod 派生并冻结，firstIssue / issues 都带可读消息。
 */
export function validateRoute(blueprint: Blueprint, route: unknown): RouteReport {
  const parsed = Route.safeParse(route);
  if (!parsed.success) {
    const issue = makeIssue('route-schema', `路线不符合 schema：${readableZodError(parsed.error)}`, null, []);
    return makeReport('', '', 0, [issue]);
  }

  const { cells, overflow } = expandRoute(parsed.data);
  if (overflow) {
    const issue = makeIssue(
      'route-schema',
      `路线展开超过 ${String(ROUTE_STEPS_MAX)} 格上限；请拆分为多条路线后重试`,
      null,
      [],
    );
    return makeReport(parsed.data.id, parsed.data.name, cells.length, [issue]);
  }

  const issues: RouteIssue[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell === undefined) continue;

    if (index > 0) {
      const previous = cells[index - 1];
      if (previous !== undefined) {
        const horizontal = Math.abs(cell.x - previous.x) + Math.abs(cell.z - previous.z);
        const vertical = Math.abs(cell.y - previous.y);
        if (horizontal !== 1) {
          const gap = `格 (${String(cell.x)},${String(cell.y)},${String(cell.z)}) 与前格 (${String(previous.x)},${String(previous.y)},${String(previous.z)}) 水平间距 ${String(horizontal)}`;
          issues.push(makeIssue('unverified-gap', `${gap}；只允许相邻一格，跳过的格子视为未验证空档`, cell, []));
        }
        if (vertical > 1) {
          const jump = `格 (${String(cell.x)},${String(cell.y)},${String(cell.z)}) 与前格 (${String(previous.x)},${String(previous.y)},${String(previous.z)}) 升降 ${String(vertical)}`;
          issues.push(makeIssue('step-too-tall', `${jump}；每步升降不能超过 1`, cell, []));
        }
      }
    }

    const headroom: Bounds = { min: [cell.x, cell.y, cell.z], max: [cell.x + 1, cell.y + HEADROOM, cell.z + 1] };
    const supportIds: string[] = [];
    const excludedIds: string[] = [];
    const headIds: string[] = [];
    for (const element of blueprint.elements) {
      if (isFootSupport(element, cell.x, cell.z, cell.y)) {
        supportIds.push(element.id);
        continue;
      }
      // 顶面相同但不算踏面：列出 marker / glazing / 非盒形，帮助定位为什么没有支承。
      if (isExcludedCover(element, cell.x, cell.z, cell.y)) excludedIds.push(element.id);
      // marker 是标注点，既不支承也不构成头顶侵入；其余非 marker 实体参与净空判定。
      if (element.kind !== 'marker' && intersects(headroom, element.bounds)) headIds.push(element.id);
    }

    if (supportIds.length === 0) {
      const excluded = [...new Set(excludedIds)].sort(compareIds);
      const why =
        excluded.length > 0 ? `；顶面相同的 ${formatIds(excluded)} 是 marker / glazing / 非盒形，不计为踏面` : '';
      issues.push(
        makeIssue(
          'unsupported-stand',
          `格 (${String(cell.x)},${String(cell.y)},${String(cell.z)}) 脚下没有实体盒支承${why}`,
          cell,
          excluded,
        ),
      );
    }

    const head = [...new Set(headIds)].sort(compareIds);
    if (head.length > 0) {
      issues.push(
        makeIssue(
          'headroom-intrusion',
          `格 (${String(cell.x)},${String(cell.y)},${String(cell.z)}) 头顶 ${String(HEADROOM)} 格净空被 ${formatIds(head)} 侵入`,
          cell,
          head,
        ),
      );
    }
  }

  return makeReport(parsed.data.id, parsed.data.name, cells.length, issues);
}
