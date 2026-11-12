/**
 * 可达测量（docs/ANALYSIS-SPEC.md §5）：按 MC 1.20.1 的近似行走规则，从场地外能走到哪些站立点。
 *
 * 负责：站立点、可达集合、最高可达高度、指定目标能否到达、"差一步"的阻挡原因与挡路方块。
 * 不负责：楼梯朝向、台阶上下半、梯子与藤蔓（近似只会高估可达，不会低估）。
 */

import type { BlockRegistry, Shape } from '@pg/blocks/registry';
import type { Grid } from '@pg/core/grid';

import { MAX_SAMPLES, packer, samplesOf } from './sample.ts';
import type { Cell, Sample } from './sample.ts';

/** 下落不超过这么多格（MC 摔落 3 格以内不掉血）。 */
export const MAX_DROP = 3;

type Kind = 'pass' | 'tall' | 'solid';

const PASS_SHAPES: ReadonlySet<Shape> = new Set([
  'plant',
  'carpet',
  'button',
  'pressure_plate',
  'sheet',
  'door',
  'fluid',
]);
const TALL_SHAPES: ReadonlySet<Shape> = new Set(['fence', 'fence_gate', 'wall']);
/** 脚下是这些形态时，上一格不用跳。 */
const STEP_SHAPES: ReadonlySet<Shape> = new Set(['stairs', 'slab']);

export type BlockerReason = 'too-high' | 'no-headroom' | 'too-far-down';

export interface Blocker {
  readonly from: Cell;
  readonly to: Cell;
  readonly reason: BlockerReason;
  /** 挡路的方块（no-headroom 时有）。 */
  readonly block?: Sample;
}

export interface ReachReport {
  readonly standable: number;
  readonly reached: number;
  /** 没有任何可达站立点时为 undefined。 */
  readonly maxReachedY: number | undefined;
  readonly maxStandableY: number | undefined;
  readonly targets: readonly { readonly cell: Cell; readonly reached: boolean }[];
  /** 按目标高度降序，最多 MAX_SAMPLES 个。 */
  readonly blockers: readonly Blocker[];
}

export interface ReachOptions {
  readonly targets?: readonly Cell[];
}

const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

interface WalkModel {
  readonly pk: ReturnType<typeof packer>;
  readonly step: ReadonlySet<number>;
  readonly blocks: (x: number, y: number, z: number) => boolean;
  readonly standable: (x: number, y: number, z: number) => boolean;
}

/** 按 §5.1 给每个实体格分类，得到"挡不挡人""能不能站"。measureReach 与 standableTester 共用这一份规则。 */
function walkModel(grid: Grid, registry: BlockRegistry): WalkModel {
  // 外扩 3 格：包围盒外一圈的站立点、它们头顶两格与邻列都在打包范围内。
  const pk = packer(grid.bounds(), 3);
  const kind = new Map<number, Kind>();
  const step = new Set<number>();
  for (const c of grid.cells()) {
    const info = registry.info(c.state);
    const k = pk.key(c.x, c.y, c.z);
    const passLight = info.shape === 'light' && info.transparent;
    kind.set(k, PASS_SHAPES.has(info.shape) || passLight ? 'pass' : TALL_SHAPES.has(info.shape) ? 'tall' : 'solid');
    if (STEP_SHAPES.has(info.shape)) step.add(k);
  }
  const at = (x: number, y: number, z: number): Kind | undefined =>
    pk.inside(x, y, z) ? kind.get(pk.key(x, y, z)) : undefined;
  /** 这一格挡人：本身不可穿过，或者正下方是高障碍（高 1.5，占住上一格）。 */
  const blocks = (x: number, y: number, z: number): boolean => {
    const k = at(x, y, z);
    return (k !== undefined && k !== 'pass') || at(x, y - 1, z) === 'tall';
  };
  const floor = (x: number, y: number, z: number): boolean => y === 1 || at(x, y - 1, z) === 'solid';
  const standable = (x: number, y: number, z: number): boolean =>
    y >= 1 && !blocks(x, y, z) && !blocks(x, y + 1, z) && floor(x, y, z);
  return { pk, step, blocks, standable };
}

/** 判断任意格是不是站立点（§5.1 的同一规则），供可达目标推导使用。 */
export function standableTester(grid: Grid, registry: BlockRegistry): (cell: Cell) => boolean {
  const { standable } = walkModel(grid, registry);
  return (c) => standable(c.x, c.y, c.z);
}

export function measureReach(grid: Grid, registry: BlockRegistry, options: ReachOptions = {}): ReachReport {
  const { pk, step, blocks, standable } = walkModel(grid, registry);

  const bounds = grid.bounds();
  const empty: ReachReport = {
    standable: 0,
    reached: 0,
    maxReachedY: undefined,
    maxStandableY: undefined,
    targets: (options.targets ?? []).map((cell) => ({ cell, reached: false })),
    blockers: [],
  };
  if (bounds === undefined) return empty;
  const [x0, , z0] = [bounds.min[0] - 1, 0, bounds.min[2] - 1];
  const [x1, y1, z1] = [bounds.max[0] + 1, bounds.max[1] + 1, bounds.max[2] + 1];
  const inside = (x: number, y: number, z: number): boolean =>
    x >= x0 && x <= x1 && z >= z0 && z <= z1 && y >= 1 && y <= y1;

  // 全部站立点：只可能在实体格正上方，或 y = 1。
  const stands = new Map<number, Cell>();
  const consider = (x: number, y: number, z: number): void => {
    if (inside(x, y, z) && standable(x, y, z)) stands.set(pk.key(x, y, z), { x, y, z });
  };
  for (let x = x0; x <= x1; x += 1) for (let z = z0; z <= z1; z += 1) consider(x, 1, z);
  for (const c of grid.cells()) consider(c.x, c.y + 1, c.z);

  /** 从 a 能否一步走到水平相邻的站立点 b；不能时给出原因。 */
  const move = (a: Cell, b: Cell): { ok: true } | { ok: false; reason: BlockerReason; block?: Cell } => {
    const dy = b.y - a.y;
    if (dy === 0) return { ok: true };
    if (dy === 1) {
      if (step.has(pk.key(b.x, b.y - 1, b.z))) return { ok: true };
      return blocks(a.x, a.y + 2, a.z)
        ? { ok: false, reason: 'no-headroom', block: { x: a.x, y: a.y + 2, z: a.z } }
        : { ok: true };
    }
    if (dy > 1) return { ok: false, reason: 'too-high' };
    if (-dy > MAX_DROP) return { ok: false, reason: 'too-far-down' };
    // 下落时要先走到目标上方，那一列在起点头顶以下都不能挡人。
    for (let y = b.y + 1; y <= a.y + 1; y += 1) {
      if (blocks(b.x, y, b.z)) return { ok: false, reason: 'no-headroom', block: { x: b.x, y, z: b.z } };
    }
    return { ok: true };
  };

  /** 按列索引站立点，找邻格时不用逐个高度试。 */
  const byColumn = new Map<number, number[]>();
  for (const c of stands.values()) {
    const col = pk.key(c.x, 1, c.z);
    const ys = byColumn.get(col);
    if (ys === undefined) byColumn.set(col, [c.y]);
    else ys.push(c.y);
  }
  /**
   * 水平相邻列里、高度差在 [−∞, +2] 内的站立点。行走只用到 [−MAX_DROP, +1]；
   * +2 和更深的下落只用来报阻挡原因（太高、落差太大）。
   */
  const neighbours = (c: Cell): Cell[] => {
    const out: Cell[] = [];
    for (const [dx, dz] of DIRS) {
      for (const y of byColumn.get(pk.key(c.x + dx, 1, c.z + dz)) ?? []) {
        if (y - c.y <= 2) out.push({ x: c.x + dx, y, z: c.z + dz });
      }
    }
    return out;
  };

  const reached = new Set<number>();
  const queue: Cell[] = [];
  for (const [k, c] of stands) {
    if (c.y === 1 && (c.x === x0 || c.x === x1 || c.z === z0 || c.z === z1)) {
      reached.add(k);
      queue.push(c);
    }
  }
  for (let c = queue.pop(); c !== undefined; c = queue.pop()) {
    for (const n of neighbours(c)) {
      const k = pk.key(n.x, n.y, n.z);
      if (reached.has(k) || !move(c, n).ok) continue;
      reached.add(k);
      queue.push(n);
    }
  }

  const blockers: { from: Cell; to: Cell; reason: BlockerReason; block?: Cell }[] = [];
  const blocked = new Set<number>();
  for (const k of reached) {
    const c = stands.get(k);
    if (c === undefined) continue;
    for (const n of neighbours(c)) {
      const nk = pk.key(n.x, n.y, n.z);
      if (reached.has(nk) || blocked.has(nk)) continue;
      const m = move(c, n);
      if (m.ok) continue;
      blocked.add(nk);
      blockers.push({ from: c, to: n, reason: m.reason, ...(m.block === undefined ? {} : { block: m.block }) });
    }
  }
  blockers.sort((a, b) => b.to.y - a.to.y || a.to.z - b.to.z || a.to.x - b.to.x || a.from.y - b.from.y);

  let maxReachedY: number | undefined;
  let maxStandableY: number | undefined;
  for (const [k, c] of stands) {
    if (maxStandableY === undefined || c.y > maxStandableY) maxStandableY = c.y;
    if (reached.has(k) && (maxReachedY === undefined || c.y > maxReachedY)) maxReachedY = c.y;
  }
  return {
    standable: stands.size,
    reached: reached.size,
    maxReachedY,
    maxStandableY,
    targets: (options.targets ?? []).map((cell) => ({
      cell,
      reached: pk.inside(cell.x, cell.y, cell.z) && reached.has(pk.key(cell.x, cell.y, cell.z)),
    })),
    blockers: blockers.slice(0, MAX_SAMPLES).map((b) => {
      const sample = b.block === undefined ? undefined : samplesOf(grid, [b.block])[0];
      return { from: b.from, to: b.to, reason: b.reason, ...(sample === undefined ? {} : { block: sample }) };
    }),
  };
}
