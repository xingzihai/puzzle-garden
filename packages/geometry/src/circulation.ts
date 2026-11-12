/** 楼梯与踏步的路线和写入计划；不登记世界调用，不替代场地整体可达测量。 */
import type { z } from 'zod';
import { parseState } from '@pg/core/block-state';
import type { BlockState, BlockTable } from '@pg/core/block-state';
import type { Bounds } from '@pg/core/grid';
import { checkCoord } from '@pg/core/coord';
import type { stairSchema, stepsSchema, Surface, Point, Side } from './schema.ts';
import type { Write } from './writer.ts';
import type { WriteRole } from './collision.ts';
import { contains } from './footprint.ts';

interface Tread {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  /** 平台无朝向，使用楼梯方块的上半砖作完整站立顶面。 */
  readonly facing?: Side;
}
export interface CirculationPlan {
  readonly bounds: Bounds;
  /** 每级中线上的站立格，包含入口与出口平台。 */
  readonly path: readonly Point[];
  readonly writes: readonly Write[];
}

/** 已存在、未填充的门 / 院门记录，供 R6 楼梯堵门检查对称使用。 */
export interface DoorRecord {
  readonly bounds: Bounds;
  readonly side: Side;
  readonly thickness: number;
  readonly index: number;
}
export type StairSolid = 'tread' | 'back';
export interface ThresholdScan {
  readonly blocked: number;
  readonly total: number;
  readonly sample?: { readonly x: number; readonly y: number; readonly z: number; readonly role: StairSolid };
}
/**
 * R6：沿门宽逐列取门槛内侧一格（墙内侧面再往里一格）的站立高度与头顶两格，
 * 只要该列两格之一是 stair 写的梯级 / 背板就算这一列被挡。全部列被挡才算进门无路。
 */
export function thresholdScan(
  door: DoorRecord,
  solid: (x: number, y: number, z: number) => StairSolid | undefined,
): ThresholdScan {
  const b = door.bounds;
  const ns = door.side === 'north' || door.side === 'south';
  const stand = b.min[1];
  const inward =
    door.side === 'north'
      ? b.max[2] + 1
      : door.side === 'south'
        ? b.min[2] - 1
        : door.side === 'west'
          ? b.max[0] + 1
          : b.min[0] - 1;
  const lo = ns ? b.min[0] : b.min[2];
  const hi = ns ? b.max[0] : b.max[2];
  let blocked = 0;
  let total = 0;
  let sample: ThresholdScan['sample'];
  for (let u = lo; u <= hi; u += 1) {
    total += 1;
    const x = ns ? u : inward;
    const z = ns ? inward : u;
    const lower = solid(x, stand, z);
    const upper = solid(x, stand + 1, z);
    const role = lower ?? upper;
    if (role !== undefined) {
      blocked += 1;
      sample ??= { x, y: lower === undefined ? stand + 1 : stand, z, role };
    }
  }
  return { blocked, total, ...(sample === undefined ? {} : { sample }) };
}

export function doorBlockedError(door: DoorRecord, sample: NonNullable<ThresholdScan['sample']>): string {
  return (
    `stair 挡住了门 ${door.side}#${String(door.index)}：门内 (${String(sample.x)}, ${String(sample.y)}, ${String(sample.z)}) ` +
    `是梯${sample.role === 'tread' ? '级' : '背板'}，进门后无路可走。请把 at 移开 ≥ 2 格，或换 facing。`
  );
}

function rotate(x: number, z: number, facing: Side): readonly [number, number] {
  switch (facing) {
    case 'east':
      return [x, z];
    case 'south':
      return [-z, x];
    case 'west':
      return [-x, -z];
    case 'north':
      return [z, -x];
  }
}

function direction(dx: number, dz: number): Side {
  return dx > 0 ? 'east' : dx < 0 ? 'west' : dz > 0 ? 'south' : 'north';
}

function inside(s: Surface, t: Tread): boolean {
  return contains(s.footprint, t.x, t.z);
}

/** 朝向由路线决定；用户已指定且不同的朝向或上半砖不能被静默覆盖。 */
function material(table: BlockTable, text: string): BlockState {
  const state = parseState(table, text);
  const props = table.blocks.get(state.name)?.props;
  if (!state.name.endsWith('_stairs') || props?.has('facing') !== true || !props.has('half')) {
    throw new Error(`material=${text} 不合法：楼梯与踏步必须使用楼梯类方块`);
  }
  if (text.includes('facing=') || text.includes('half=') || text.includes('shape=')) {
    throw new Error(`material=${text} 不合法：facing、half、shape 由楼梯路线自动设置，请只指定方块名与 waterlogged`);
  }
  return state;
}

interface PlanRoles {
  readonly tread: WriteRole;
  readonly support: WriteRole;
  readonly head: WriteRole;
}

function plan(
  table: BlockTable,
  text: string,
  treads: readonly Tread[],
  path: readonly Point[],
  roles: PlanRoles,
): CirculationPlan {
  const source = material(table, text);
  const air = parseState(table, 'air');
  const states = new Map<string, BlockState>();
  const writes = new Map<string, Write>();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const id = (x: number, y: number, z: number): string => `${String(x)},${String(y)},${String(z)}`;
  function state(facing?: Side): BlockState {
    const key = facing ?? 'platform';
    const previous = states.get(key);
    if (previous !== undefined) return previous;
    const waterlogged = source.props['waterlogged'] ?? table.blocks.get(source.name)?.props.get('waterlogged')?.default;
    const result = parseState(
      table,
      `${source.name}[facing=${facing ?? 'east'},half=${facing === undefined ? 'top' : 'bottom'},shape=straight${waterlogged === undefined ? '' : `,waterlogged=${waterlogged}`}]`,
    );
    states.set(key, result);
    return result;
  }
  // 先保留所有踏面；随后净空若碰到另一段楼梯，必须拒绝而非挖掉自己的踏面。
  for (const t of treads) {
    checkCoord(t.x, t.y - 1, t.z);
    checkCoord(t.x, t.y + 3, t.z);
    // y = 0 是地表（决策 #21）：地表那一级不写方块（站在地面即可），只写 y ≥ 1 的级。
    if (t.y >= 1)
      writes.set(id(t.x, t.y, t.z), { ...t, state: state(t.facing), writeLayer: 'opening', role: roles.tread });
    min[0] = Math.min(min[0], t.x);
    min[1] = Math.min(min[1], t.y - 1);
    min[2] = Math.min(min[2], t.z);
    max[0] = Math.max(max[0], t.x);
    max[1] = Math.max(max[1], t.y);
    max[2] = Math.max(max[2], t.z);
  }
  const support: Write[] = [];
  for (const t of treads) {
    if (t.y < 1) continue; // 地表那一级既无踏面也无背板 / 净空。
    // 一格厚背板使相邻级面连接，且不会像落地实心柱那样堵住螺旋梯的下圈；y=0 是地面，不写。
    if (t.y - 1 >= 1)
      support.push({ x: t.x, y: t.y - 1, z: t.z, state: state(), writeLayer: 'structure', role: roles.support });
    for (let y = t.y + 1; y <= t.y + 3; y += 1) {
      const key = id(t.x, y, t.z);
      const previous = writes.get(key);
      if (previous !== undefined && previous.state.name !== 'air') {
        throw new Error(`stair 净空不足：踏面 (${String(t.x)}, ${String(y)}, ${String(t.z)}) 与另一段路线相碰`);
      }
      writes.set(key, { x: t.x, y, z: t.z, state: air, writeLayer: 'opening', role: roles.head });
    }
  }
  // 背板也不能插入另一段路线的头顶净空。
  for (const w of support) {
    if (writes.get(id(w.x, w.y, w.z))?.state.name === 'air') throw new Error('stair 背板侵入另一段路线的头顶净空');
  }
  return {
    bounds: Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) }),
    path: Object.freeze(path.map((p) => Object.freeze(p))),
    writes: [...support, ...writes.values()],
  };
}

interface RoutedTread {
  readonly tread: Tread;
  /** 报错时指认越界的是入口平台 / 第 k 级 / 转向平台 / 第二跑 / 出口平台。 */
  readonly label: string;
}
interface StairRoute {
  readonly treads: readonly RoutedTread[];
  readonly path: readonly Point[];
}

/**
 * 按 kind / facing / width / radius / 起止高度生成整条路线（含平台），坐标已按 at 落到世界。
 * 不做占地校验：stairPlan 先拿完整路线算偏移包围盒，才能一次给出合法 at 范围与可行朝向（R11）。
 */
function stairRoute(p: z.output<typeof stairSchema>, at: readonly [number, number], facing: Side): StairRoute {
  const rise = p.to.y - p.from.y;
  const treads: RoutedTread[] = [];
  const path: Point[] = [];
  const width = p.kind === 'spiral' ? 1 : p.width;
  // 东西跑（east/west）的横向世界轴是 z，南北跑（north/south）是 x。宽度以该跑中线的世界坐标为基准展开。
  const lateralIsZ = facing === 'east' || facing === 'west';
  function place(x: number, z: number, y: number, label: string, face?: Side): void {
    treads.push({ tread: { x, z, y, ...(face === undefined ? {} : { facing: face }) }, label });
  }
  /**
   * x 为沿行进方向的局部格数；lateral 为该级中线沿横向世界轴相对 at 的偏移。
   * 宽度向中线两侧展开，偶数宽多出的一格在世界坐标较小一侧（与开洞居中同规则）。
   */
  function add(x: number, lateral: number, y: number, label: string, dx?: number, dz = 0): void {
    const [rx, rz] = rotate(x, 0, facing);
    const face = dx === undefined ? undefined : direction(...rotate(dx, dz, facing));
    const baseX = at[0] + rx;
    const baseZ = at[1] + rz;
    for (let w = 0; w < width; w += 1) {
      const offset = lateral + w - Math.floor(width / 2);
      place(lateralIsZ ? baseX : baseX + offset, lateralIsZ ? baseZ + offset : baseZ, y, label, face);
    }
    path.push([baseX + (lateralIsZ ? 0 : lateral), y + 1, baseZ + (lateralIsZ ? lateral : 0)]);
  }
  /** 螺旋的方形环按局部坐标定位；width 固定为 1，只用于保持与 add 同一套朝向计算。 */
  function addLocal(x: number, z: number, y: number, label: string, dx?: number, dz = 0): void {
    const [cx, cz] = rotate(x, z, facing);
    const face = dx === undefined ? undefined : direction(...rotate(dx, dz, facing));
    const centerX = at[0] + cx;
    const centerZ = at[1] + cz;
    for (let w = 0; w < width; w += 1) {
      const offset = w - Math.floor(width / 2);
      place(lateralIsZ ? centerX : centerX + offset, lateralIsZ ? centerZ + offset : centerZ, y, label, face);
    }
    path.push([centerX, y + 1, centerZ]);
  }
  /** 转向平台：从 lateralFrom 到 lateralTo 逐格铺满（宽一格，无朝向），横跨两跑与中间一格。 */
  function addSpan(x: number, lateralFrom: number, lateralTo: number, y: number, label: string): void {
    const [rx, rz] = rotate(x, 0, facing);
    const baseX = at[0] + rx;
    const baseZ = at[1] + rz;
    const step = lateralFrom <= lateralTo ? 1 : -1;
    for (let lateral = lateralFrom; step > 0 ? lateral <= lateralTo : lateral >= lateralTo; lateral += step)
      place(lateralIsZ ? baseX : baseX + lateral, lateralIsZ ? baseZ + lateral : baseZ, y, label);
  }
  /** 转向平台的可走中线：从第一跑中线横向走到第二跑中线。 */
  function spanPath(x: number, from: number, to: number, y: number): void {
    const [rx, rz] = rotate(x, 0, facing);
    const step = from <= to ? 1 : -1;
    for (let lateral = from; step > 0 ? lateral <= to : lateral >= to; lateral += step)
      path.push([at[0] + rx + (lateralIsZ ? 0 : lateral), y + 1, at[1] + rz + (lateralIsZ ? lateral : 0)]);
  }
  if (p.kind === 'straight') {
    add(-1, 0, p.from.y - 1, '入口平台');
    for (let i = 0; i < rise; i += 1) add(i, 0, p.from.y + i, `第 ${String(i + 1)} 级`, 1);
    add(rise, 0, p.to.y - 1, '出口平台');
  } else if (p.kind === 'switchback') {
    const first = Math.ceil(rise / 2);
    // at 是第一跑中线：第一跑占中线两侧，第二跑中线偏移 width+1，两跑之间空一格。
    const firstMin = -Math.floor(width / 2);
    const second = width + 1;
    const secondMax = second + width - 1 - Math.floor(width / 2);
    const turnY = p.from.y + first - 1;
    add(-1, 0, p.from.y - 1, '入口平台');
    for (let i = 0; i < first; i += 1) add(i, 0, p.from.y + i, `第 ${String(i + 1)} 级`, 1);
    addSpan(first, firstMin, secondMax, turnY, '转向平台');
    spanPath(first, 0, second, turnY);
    for (let i = 0; i < rise - first; i += 1) add(first - i - 1, second, p.from.y + first + i, '第二跑', -1);
    add(first - (rise - first) - 1, second, p.to.y - 1, '出口平台');
  } else {
    // 方形螺旋，每圈 8r 个相邻格，转角不跨对角线；at 是中心。
    const r = p.radius;
    const ring: (readonly [number, number])[] = [];
    for (let x = -r; x < r; x += 1) ring.push([x, -r]);
    for (let z = -r; z < r; z += 1) ring.push([r, z]);
    for (let x = r; x > -r; x -= 1) ring.push([x, r]);
    for (let z = r; z > -r; z -= 1) ring.push([-r, z]);
    /** P1：入口平台候选是否同时落在 from / to 的共同占地内（世界坐标按 facing 旋转）。 */
    const entryInside = (lx: number, lz: number): boolean => {
      const [cx, cz] = rotate(lx, lz, facing);
      const x = at[0] + cx;
      const z = at[1] + cz;
      return inside(p.from, { x, z, y: 0 }) && inside(p.to, { x, z, y: 0 });
    };
    // 首级在 (-r,-r)；环外一格放不下时，改放环上首级前一圈的相邻格（仍在半径内且与首级面邻接）。
    const outsideEntry: readonly [number, number] = [-r - 1, -r];
    const insideEntry: readonly [number, number] = [-r, -r + 1];
    const entry = entryInside(outsideEntry[0], outsideEntry[1]) ? outsideEntry : insideEntry;
    addLocal(entry[0], entry[1], p.from.y - 1, '入口平台');
    let previous: readonly [number, number] = entry;
    for (let i = 0; i <= rise; i += 1) {
      const current = ring[i % ring.length];
      if (current === undefined) throw new Error('spiral 路线为空：radius 必须为正整数');
      addLocal(
        current[0],
        current[1],
        Math.min(p.from.y + i, p.to.y - 1),
        i === rise ? '出口平台' : `第 ${String(i + 1)} 级`,
        i === rise ? undefined : current[0] - previous[0],
        current[1] - previous[1],
      );
      previous = current;
    }
  }
  return { treads, path };
}

interface OffsetBounds {
  readonly dx0: number;
  readonly dx1: number;
  readonly dz0: number;
  readonly dz1: number;
}
/** 整条路线（相对 at）在 x、z 两轴上的偏移包围盒。 */
function offsetBounds(route: StairRoute, at: readonly [number, number]): OffsetBounds {
  let dx0 = Infinity;
  let dx1 = -Infinity;
  let dz0 = Infinity;
  let dz1 = -Infinity;
  for (const { tread } of route.treads) {
    dx0 = Math.min(dx0, tread.x - at[0]);
    dx1 = Math.max(dx1, tread.x - at[0]);
    dz0 = Math.min(dz0, tread.z - at[1]);
    dz1 = Math.max(dz1, tread.z - at[1]);
  }
  return { dx0, dx1, dz0, dz1 };
}

interface FitRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}
interface AtRange {
  readonly x: readonly [number, number];
  readonly z: readonly [number, number];
}
/** at 的合法区间：共同占地上每个偏移格都要落在两个占地内（R11）。 */
function legalAt(rect: FitRect, o: OffsetBounds): AtRange {
  return { x: [rect.minX - o.dx0, rect.maxX - o.dx1], z: [rect.minZ - o.dz0, rect.maxZ - o.dz1] };
}
function rangeEmpty(range: AtRange): boolean {
  return range.x[0] > range.x[1] || range.z[0] > range.z[1];
}
export function commonFootprint(from: Surface, to: Surface): FitRect {
  return {
    minX: Math.max(from.footprint.minX, to.footprint.minX),
    minZ: Math.max(from.footprint.minZ, to.footprint.minZ),
    maxX: Math.min(from.footprint.maxX, to.footprint.maxX),
    maxZ: Math.min(from.footprint.maxZ, to.footprint.maxZ),
  };
}

const FACINGS: readonly Side[] = ['east', 'south', 'west', 'north'];
/** 楼梯放不下：给出所需尺寸、越界段、共同占地、该朝向合法 at 范围与可行朝向（R11）。 */
function stairFitError(p: z.output<typeof stairSchema>, at: readonly [number, number], bad: RoutedTread): Error {
  const rect = commonFootprint(p.from, p.to);
  const o = offsetBounds(stairRoute(p, at, p.facing), at);
  const fit = legalAt(rect, o);
  const width = p.kind === 'spiral' ? 1 : p.width;
  const feasible = FACINGS.filter(
    (facing) => !rangeEmpty(legalAt(rect, offsetBounds(stairRoute(p, [0, 0], facing), [0, 0]))),
  );
  const hint = rangeEmpty(fit) || feasible.length === 0 ? '请减小高度差或改用 spiral。' : '';
  return new Error(
    `stair 放不下：${p.kind}/${p.facing}/宽${String(width)} 需要 ${String(o.dx1 - o.dx0 + 1)}×${String(o.dz1 - o.dz0 + 1)} 格（含平台）。` +
      `越界的是${bad.label} (${String(bad.tread.x)}, ${String(bad.tread.z)})；` +
      `共同占地为 x∈[${String(rect.minX)}, ${String(rect.maxX)}]、z∈[${String(rect.minZ)}, ${String(rect.maxZ)}]。` +
      `这个朝向下 at 可取 x∈[${String(fit.x[0])}, ${String(fit.x[1])}]、z∈[${String(fit.z[0])}, ${String(fit.z[1])}]；` +
      `可行朝向：${feasible.length === 0 ? '无' : feasible.join('、')}。${hint}`,
  );
}

export function stairPlan(table: BlockTable, p: z.output<typeof stairSchema>): CirculationPlan {
  // R11 校验顺序：先材质，再路线能否放进共同占地。
  material(table, p.material);
  const rise = p.to.y - p.from.y;
  if (rise < 1) throw new Error(`stair.to.y=${String(p.to.y)} 必须高于 from.y=${String(p.from.y)}`);
  if (p.kind === 'switchback' && rise < 2)
    throw new Error(
      `switchback 起止高度差=${String(rise)}（from.y=${String(p.from.y)}，to.y=${String(p.to.y)}）至少为 2，才能分成两跑`,
    );
  const route = stairRoute(p, p.at, p.facing);
  const bad = route.treads.find(({ tread }) => !inside(p.from, tread) || !inside(p.to, tread));
  if (bad !== undefined) throw stairFitError(p, p.at, bad);
  return plan(
    table,
    p.material,
    route.treads.map(({ tread }) => tread),
    route.path,
    { tread: 'tread', support: 'back', head: 'head' },
  );
}

export function stepsPlan(table: BlockTable, p: z.output<typeof stepsSchema>): CirculationPlan {
  const b = p.to.bounds;
  const northSouth = p.to.side === 'north' || p.to.side === 'south';
  const start = northSouth ? b.min[0] : b.min[2];
  const end = northSouth ? b.max[0] : b.max[2];
  if (p.width > end - start + 1)
    throw new Error(`steps.width=${String(p.width)} 超出入口净宽 ${String(end - start + 1)}`);
  const y = b.min[1];
  if (y <= 1)
    throw new Error(
      `steps 不需要：门洞底 y=${String(y)} 已与地表齐平，可以直接进入。请删除这次调用；要铺路请用 paving({ from: 门洞, to: 长度 })。`,
    );
  // 中线与楼梯同规则：偶数宽多出的一格在较小坐标侧，path 取该中线格（R10）。
  const lo = start + Math.floor((end - start + 1 - p.width) / 2);
  const center = lo + Math.floor(p.width / 2);
  const [dx, dz] =
    p.to.side === 'north' ? [0, -1] : p.to.side === 'south' ? [0, 1] : p.to.side === 'east' ? [1, 0] : [-1, 0];
  const outer =
    p.to.side === 'north' ? b.min[2] : p.to.side === 'south' ? b.max[2] : p.to.side === 'east' ? b.max[0] : b.min[0];
  const treads: Tread[] = [];
  const path: Point[] = [];
  for (let i = 0; i < y; i += 1) {
    const distance = y - i;
    const cx = northSouth ? lo : outer + dx * distance;
    const cz = northSouth ? outer + dz * distance : lo;
    for (let w = 0; w < p.width; w += 1) {
      treads.push({
        x: cx + (northSouth ? w : 0),
        z: cz + (northSouth ? 0 : w),
        y: i,
        ...(i === 0 ? {} : { facing: direction(-dx, -dz) }),
      });
    }
    path.push([northSouth ? center : cx, i + 1, northSouth ? cz : center]);
  }
  const result = plan(table, p.material, treads, path, { tread: 'tread', support: 'support', head: 'tread' });
  // 落点净空：最高一级的正上方要能站人（头顶两格）。只清落点这一列以外的格：
  // - 门洞：落点是门洞本身（`to.bounds` 已由开洞挖空），这里不另写，避免把门挖高（审查 A4）；
  // - 台基边：落点在台基顶面上，站立高度 y 处是台基上方的空气，不写净空，避免挖进台基上的墙（审查 A3）。
  // 栏杆等装饰层不会封住落点：栏杆按踏步宽度在入口边留缺口（railPlan 读取 entranceGaps）。
  return result;
}
