/**
 * 屋面剖面（docs/ANALYSIS-SPEC.md §6）：逐层轮廓与按列的竖向厚度。
 *
 * 负责：给出屋面格的每层格数与包围盒、正下方有无实体、每列竖向连续段的最大长度（发现叠层）。
 * 不负责：挑出哪些格是屋面（由调用方给出：按调用编号或方块名）。屋面正下方是空气不算问题（薄壳）。
 */

import type { Cell as GridCell, Grid } from '@pg/core/grid';

import { MAX_SAMPLES, boxOf, cellKey, compareCells, samplesOf } from './sample.ts';
import type { Box, Cell, Sample } from './sample.ts';

export interface RoofLayer {
  readonly y: number;
  readonly cells: number;
  readonly bounds: Box;
  /** 正下方是实体格（屋面或其他）的格数。 */
  readonly faceBelow: number;
}

export interface RoofProfile {
  readonly cells: number;
  /** 按 y 升序。 */
  readonly layers: readonly RoofLayer[];
  /** 按 (x, z) 列统计屋面格竖向连续的最大段长：1、2、3 及以上各有多少列。 */
  readonly thickness: { readonly 1: number; readonly 2: number; readonly '3+': number };
  /** 厚度 ≥ 2 的列里最低一格的样例，最多 MAX_SAMPLES 个。 */
  readonly thickSamples: readonly Sample[];
  /**
   * 超出连接所需的格（叠层）。连接所需 = 本列顶与面邻屋面列里最低的列顶之差，至少 1：
   * 陡坡上相邻列高差大，竖向补到比最低邻列高 1 格才能连成一片，这部分不算叠层。
   */
  readonly excess: { readonly columns: number; readonly cells: number };
  /** 有超出的列里最低一格的样例，最多 MAX_SAMPLES 个。 */
  readonly excessSamples: readonly Sample[];
}

export function measureRoofProfile(grid: Grid, isRoof: (cell: GridCell) => boolean): RoofProfile {
  const solid = new Set<string>();
  const roof: Cell[] = [];
  for (const c of grid.cells()) {
    solid.add(cellKey(c.x, c.y, c.z));
    if (isRoof(c)) roof.push({ x: c.x, y: c.y, z: c.z });
  }

  const byY = new Map<number, Cell[]>();
  const byColumn = new Map<string, number[]>();
  for (const c of roof) {
    const layer = byY.get(c.y);
    if (layer === undefined) byY.set(c.y, [c]);
    else layer.push(c);
    const col = `${String(c.x)},${String(c.z)}`;
    const ys = byColumn.get(col);
    if (ys === undefined) byColumn.set(col, [c.y]);
    else ys.push(c.y);
  }

  const layers: RoofLayer[] = [...byY.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, cells]) => {
      const bounds = boxOf(cells);
      if (bounds === undefined) throw new Error('屋面层为空：不应发生');
      const faceBelow = cells.filter((c) => solid.has(cellKey(c.x, c.y - 1, c.z))).length;
      return { y, cells: cells.length, bounds, faceBelow };
    });

  const thickness = { 1: 0, 2: 0, '3+': 0 };
  const thick: Cell[] = [];
  /** 每列最长竖向连续段：长度与起点。 */
  const runs = new Map<
    string,
    { readonly len: number; readonly start: number; readonly x: number; readonly z: number }
  >();
  for (const [col, ys] of byColumn) {
    ys.sort((a, b) => a - b);
    let best = { len: 0, start: 0 };
    let run = { len: 0, start: 0 };
    let prev: number | undefined;
    for (const y of ys) {
      run = prev !== undefined && y === prev + 1 ? { len: run.len + 1, start: run.start } : { len: 1, start: y };
      if (run.len > best.len) best = run;
      prev = y;
    }
    const [x, z] = col.split(',').map(Number) as [number, number];
    runs.set(col, { ...best, x, z });
    if (best.len === 1) thickness[1] += 1;
    else if (best.len === 2) thickness[2] += 1;
    else thickness['3+'] += 1;
    if (best.len >= 2) thick.push({ x, y: best.start, z });
  }
  thick.sort(compareCells);

  const excess = { columns: 0, cells: 0 };
  const over: Cell[] = [];
  for (const r of runs.values()) {
    const top = r.start + r.len - 1;
    let low = top;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const n = runs.get(`${String(r.x + dx)},${String(r.z + dz)}`);
      if (n !== undefined) low = Math.min(low, n.start + n.len - 1);
    }
    const extra = r.len - Math.max(1, top - low);
    if (extra > 0) {
      excess.columns += 1;
      excess.cells += extra;
      over.push({ x: r.x, y: r.start, z: r.z });
    }
  }
  over.sort(compareCells);
  return {
    cells: roof.length,
    layers,
    thickness,
    thickSamples: samplesOf(grid, thick.slice(0, MAX_SAMPLES)),
    excess,
    excessSamples: samplesOf(grid, over.slice(0, MAX_SAMPLES)),
  };
}
