/**
 * 测量共用的小工具：格键、问题格样例、包围盒（docs/ANALYSIS-SPEC.md §2）。
 *
 * 负责：把问题格变成确定性的、可定位的样例（坐标 + 规范方块状态 + 调用编号）。
 * 不负责：任何具体测量。
 */

import { formatState } from '@pg/core/block-state';
import type { Grid } from '@pg/core/grid';

/** 每项测量最多给出的样例数。 */
export const MAX_SAMPLES = 20;

export interface Cell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 一个问题格：坐标、规范方块状态（空气格为 `air`）、写入它的调用编号（0 = 未知）。 */
export interface Sample extends Cell {
  readonly block: string;
  readonly call: number;
}

export interface Box {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** 格键：字符串，只在测量内部当 Map / Set 的键用。热路径用 {@link packer} 的数字键。 */
export function cellKey(x: number, y: number, z: number): string {
  return `${String(x)},${String(y)},${String(z)}`;
}

export interface Packer {
  /** 包围盒外扩 margin 格以内的格 → 唯一的非负安全整数；范围外的格也返回整数，但可能与范围内的冲突，调用方用 inside 先判断。 */
  readonly key: (x: number, y: number, z: number) => number;
  readonly inside: (x: number, y: number, z: number) => boolean;
}

/**
 * 按网格包围盒把坐标打包成数字键。字符串键在 50 万格时是主要开销（2026-09-30 基准：夹层 2.5s）。
 * 包围盒外扩 margin 格后，三个轴的跨度相乘不超过 2^53 就能打包；实际建筑远小于这个量级，超出时报错而不是静默冲突。
 */
export function packer(bounds: Box | undefined, margin: number): Packer {
  const min = bounds?.min ?? [0, 0, 0];
  const max = bounds?.max ?? [0, 0, 0];
  const [x0, y0, z0] = [min[0] - margin, min[1] - margin, min[2] - margin];
  const sx = max[0] - min[0] + 1 + 2 * margin;
  const sy = max[1] - min[1] + 1 + 2 * margin;
  const sz = max[2] - min[2] + 1 + 2 * margin;
  if (sx * sy * sz > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`网格跨度 ${String(sx)}×${String(sy)}×${String(sz)} 太大，无法打包成数字键`);
  }
  return {
    key: (x, y, z) => ((x - x0) * sy + (y - y0)) * sz + (z - z0),
    inside: (x, y, z) => x >= x0 && x < x0 + sx && y >= y0 && y < y0 + sy && z >= z0 && z < z0 + sz,
  };
}

/** 按 (y, z, x) 升序比较，所有样例都按这个顺序取，保证确定性。 */
export function compareCells(a: Cell, b: Cell): number {
  return a.y - b.y || a.z - b.z || a.x - b.x;
}

/** 取前 MAX_SAMPLES 个（按 (y, z, x) 升序），并补上方块与调用编号。 */
export function samplesOf(grid: Grid, cells: Iterable<Cell>): readonly Sample[] {
  const sorted = [...cells].sort(compareCells).slice(0, MAX_SAMPLES);
  return sorted.map(({ x, y, z }) => {
    const c = grid.get(x, y, z);
    return { x, y, z, block: c === undefined ? 'air' : formatState(c.state), call: c?.call ?? 0 };
  });
}

/** 一组格的包围盒；空集合时为 undefined。 */
export function boxOf(cells: Iterable<Cell>): Box | undefined {
  let min: [number, number, number] | undefined;
  let max: [number, number, number] | undefined;
  for (const { x, y, z } of cells) {
    if (min === undefined || max === undefined) {
      min = [x, y, z];
      max = [x, y, z];
      continue;
    }
    min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
    max = [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)];
  }
  return min === undefined || max === undefined ? undefined : { min, max };
}

/** 面邻接（6）的偏移。 */
export const FACE: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** 26 邻接的偏移（面 + 棱 + 角）。 */
export const ALL26: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) if (dx !== 0 || dy !== 0 || dz !== 0) out.push([dx, dy, dz]);
    }
  }
  return out;
})();
