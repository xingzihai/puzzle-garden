/**
 * 半砖接口接触诊断：把 from→to 沿指定轴正方向相邻一格的接口，按方块形状的轴向占据区间
 * 计算「指定面的距离」与「另外两轴的交长（面积）」，分成 contact / gap / edge-only / missing / unsupported。
 *
 * 负责：只检查 specs 指定的 from/to 两格（不遍历全图），按 cube / slab 的半格区间计算；
 * 面积单位是格²，gap 与 area 对同侧都在且形状支持的接口一律给出数值。
 * 不负责：全图碰撞、悬空、可达；楼梯 / 栅栏等非 cube / slab 形状一律报告
 * unsupported，不当作整块；也不负责 schema 校验（interfaceSpecSchema 由调用方先 parse）。
 *
 * 边界：to 必须等于 from 沿 axis 正方向 +1，另外两轴坐标相同，由 interfaceSpecSchema 强制。
 * 只检查最终格，不看路径上是否有其他方块；formatInterfaces 只呈现事实，不给修复配方或提交门槛。
 */

import { z } from 'zod';

import type { BlockRegistry, Shape } from '@pg/blocks/registry';
import { formatState, isAir } from '@pg/core/block-state';
import type { BlockState } from '@pg/core/block-state';
import { XZ_MAX, XZ_MIN, Y_MAX, Y_MIN } from '@pg/core/coord';
import type { CallDef, Grid } from '@pg/core/grid';

export const AXES = ['x', 'y', 'z'] as const;

/** 坐标范围与 core 相同，在执行前拒绝不能读取的格坐标。 */
const coordsSchema = z
  .strictObject({
    x: z.number().int().min(XZ_MIN).max(XZ_MAX),
    y: z.number().int().min(Y_MIN).max(Y_MAX),
    z: z.number().int().min(XZ_MIN).max(XZ_MAX),
  })
  .readonly();

/** 单条接口规格：to 必须是 from 沿 axis 正方向相邻一格，其余坐标相同；name 仅作识别。 */
export const interfaceSpecSchema = z
  .strictObject({
    name: z.string().min(1),
    from: coordsSchema,
    to: coordsSchema,
    axis: z.enum(AXES),
  })
  .superRefine((spec, ctx) => {
    const adjacent =
      spec.axis === 'x'
        ? spec.to.x === spec.from.x + 1 && spec.to.y === spec.from.y && spec.to.z === spec.from.z
        : spec.axis === 'y'
          ? spec.to.y === spec.from.y + 1 && spec.to.x === spec.from.x && spec.to.z === spec.from.z
          : spec.to.z === spec.from.z + 1 && spec.to.x === spec.from.x && spec.to.y === spec.from.y;
    if (!adjacent) {
      ctx.addIssue({
        code: 'custom',
        message: `to 必须是从 from 沿 ${spec.axis} 正方向相邻一格：${spec.axis} 坐标 +1，另外两个坐标相同`,
      });
    }
  })
  .readonly();

export type InterfaceSpec = z.infer<typeof interfaceSpecSchema>;

/** 宿主的显式检查清单；32 项限制文本和逐次检查工作量，不限制建筑体量。 */
export const interfaceSpecsSchema = z.array(interfaceSpecSchema).max(32, '指定接口最多 32 项').readonly();

export const INTERFACE_STATUSES = ['contact', 'gap', 'edge-only', 'missing', 'unsupported'] as const;
export type InterfaceStatus = (typeof INTERFACE_STATUSES)[number];

/** 一条接口的诊断结果；missing / unsupported 时 gap 与 area 为 null，缺失一侧的 state 为 null。 */
export interface InterfaceResult extends InterfaceSpec {
  readonly status: InterfaceStatus;
  readonly gap: number | null;
  readonly area: number | null;
  readonly fromState: string | null;
  readonly toState: string | null;
  /** 最终实体格的写入来源；无格或未登记调用时为 null，不从参数猜测。 */
  readonly fromSource: Readonly<Pick<CallDef, 'id' | 'api' | 'line'>> | null;
  readonly toSource: Readonly<Pick<CallDef, 'id' | 'api' | 'line'>> | null;
}

interface Interval {
  readonly lo: number;
  readonly hi: number;
}

type CellCoords = InterfaceSpec['from'];

type AxisIndex = 0 | 1 | 2;

const AXIS_INDEX: Readonly<Record<InterfaceSpec['axis'], AxisIndex>> = { x: 0, y: 1, z: 2 };
/** 指定轴之外的两轴，用于算交长。 */
const OTHER_AXES: Readonly<Record<AxisIndex, readonly [AxisIndex, AxisIndex]>> = {
  0: [1, 2],
  1: [0, 2],
  2: [0, 1],
};

function fullIntervals(cell: CellCoords): readonly [Interval, Interval, Interval] {
  return [
    { lo: cell.x, hi: cell.x + 1 },
    { lo: cell.y, hi: cell.y + 1 },
    { lo: cell.z, hi: cell.z + 1 },
  ];
}

/** 一个方块在 x / y / z 上占据的绝对区间。cube 占满整格；slab 沿 y 取半格（type 缺省为 bottom）。 */
function intervalsOf(shape: Shape, state: BlockState, cell: CellCoords): readonly [Interval, Interval, Interval] {
  const full = fullIntervals(cell);
  if (shape !== 'slab') return full;
  const y = full[1];
  const type = state.props['type'] ?? 'bottom';
  if (type === 'top') return [full[0], { lo: y.lo + 0.5, hi: y.hi }, full[2]];
  if (type === 'double') return full;
  return [full[0], { lo: y.lo, hi: y.lo + 0.5 }, full[2]];
}

/** 两区间重叠长度；不相交时为 0。 */
function overlap(a: Interval, b: Interval): number {
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  return hi > lo ? hi - lo : 0;
}

function isSupported(shape: Shape): boolean {
  return shape === 'cube' || shape === 'slab';
}

function diagnoseOne(
  grid: Grid,
  registry: BlockRegistry,
  spec: InterfaceSpec,
  calls: ReadonlyMap<number, CallDef>,
): InterfaceResult {
  const fromCell = grid.get(spec.from.x, spec.from.y, spec.from.z);
  const toCell = grid.get(spec.to.x, spec.to.y, spec.to.z);
  const fromEmpty = fromCell === undefined || isAir(fromCell.state);
  const toEmpty = toCell === undefined || isAir(toCell.state);
  const fromState = fromCell === undefined || fromEmpty ? null : formatState(fromCell.state);
  const toState = toCell === undefined || toEmpty ? null : formatState(toCell.state);
  const source = (id: number | undefined): InterfaceResult['fromSource'] => {
    const call = id === undefined ? undefined : calls.get(id);
    return call === undefined ? null : { id: call.id, api: call.api, line: call.line };
  };
  const detail = { ...spec, fromState, toState, fromSource: source(fromCell?.call), toSource: source(toCell?.call) };
  if (fromEmpty || toEmpty) {
    return { ...detail, status: 'missing', gap: null, area: null };
  }
  // 到这里 fromCell / toCell 一定存在且非空气。
  const fromShape = registry.info(fromCell.state).shape;
  const toShape = registry.info(toCell.state).shape;
  if (!isSupported(fromShape) || !isSupported(toShape)) {
    return { ...detail, status: 'unsupported', gap: null, area: null };
  }
  const axis = AXIS_INDEX[spec.axis];
  const [first, second] = OTHER_AXES[axis];
  const fromIvs = intervalsOf(fromShape, fromCell.state, spec.from);
  const toIvs = intervalsOf(toShape, toCell.state, spec.to);
  // from 在负方向、to 在正方向，两个区间都落在各自格内，所以轴向距离不会为负。
  const gap = Math.max(0, toIvs[axis].lo - fromIvs[axis].hi);
  const area = overlap(fromIvs[first], toIvs[first]) * overlap(fromIvs[second], toIvs[second]);
  const status: InterfaceStatus = gap > 0 ? 'gap' : area > 0 ? 'contact' : 'edge-only';
  return { ...detail, status, gap, area };
}

/** 逐条诊断；specs 必须已经过 interfaceSpecSchema 校验。缺格优先于不支持形状。 */
export function diagnoseInterfaces(
  grid: Grid,
  registry: BlockRegistry,
  specs: readonly InterfaceSpec[],
): readonly InterfaceResult[] {
  const calls = new Map(grid.calls().map((call) => [call.id, call]));
  return specs.map((spec) => diagnoseOne(grid, registry, spec, calls));
}

/** 仅显式配置时由宿主追加到工具文本；全部计数，问题明细最多 4 项，不作提交门槛。 */
export function formatInterfaces(results: readonly InterfaceResult[]): readonly string[] {
  const counts = INTERFACE_STATUSES.map(
    (status) => `${status} ${String(results.filter((result) => result.status === status).length)}`,
  ).join(' / ');
  const problems = results.filter((result) => result.status !== 'contact');
  const point = (p: InterfaceSpec['from']): string => `(${String(p.x)},${String(p.y)},${String(p.z)})`;
  const source = (s: InterfaceResult['fromSource']): string =>
    s === null ? '来源未知' : `${s.api}#${String(s.id)} ${s.line > 0 ? `building.ts:${String(s.line)}` : '行号未知'}`;
  const lines = [`指定接口（事实，不判合格）：共 ${String(results.length)} 项，${counts}。`];
  if (problems.length === 0 && results.length > 0) lines.push(`指定的 ${String(results.length)} 项全部 contact。`);
  for (const result of problems.slice(0, 4)) {
    lines.push(
      `  ${JSON.stringify(result.name)} ${result.status}，axis=${result.axis}，` +
        `${point(result.from)} ${result.fromState ?? '缺格'}（${source(result.fromSource)}） → ` +
        `${point(result.to)} ${result.toState ?? '缺格'}（${source(result.toSource)}）；` +
        `gap=${result.gap === null ? '不可测' : `${String(result.gap)} 格`}，` +
        `投影 area=${result.area === null ? '不可测' : `${String(result.area)} 格²`}。`,
    );
  }
  if (problems.length > 4) lines.push(`  …另有 ${String(problems.length - 4)} 项问题未展开（最多显示 4 项）。`);
  lines.push(
    '仅检查清单指定两格的最终 cube/slab 形状；unsupported 未判定接触，contact 不代表整建筑无缺陷或结构承载成立；未列节点未检查。',
  );
  return lines;
}
