/**
 * 夹层测量（docs/ANALYSIS-SPEC.md §4）：同一列里上下两块有水平延展的实体之间 1–2 格的空气缝。
 *
 * 负责：找出夹层格并按面邻接分组。
 * 不负责：3 层及以上的空气（那是有意的空间）；细柱、栏杆、踏面之间的空隙（用水平延展条件排除）。
 */

import type { Grid } from '@pg/core/grid';

import { FACE, boxOf, compareCells, packer, samplesOf } from './sample.ts';
import type { Box, Cell, Sample } from './sample.ts';

/** 超过这个层数的空气不算夹层。 */
export const MAX_SEAM_LAYERS = 2;
/** 上下两块实体各自在同一层至少要有这么多个面邻实体，才算"有水平延展"。 */
export const MIN_SPREAD = 2;

export interface SeamGroup {
  readonly cells: number;
  readonly layers: 1 | 2;
  readonly bounds: Box;
  readonly samples: readonly Sample[];
}

export interface SeamReport {
  readonly cells: number;
  readonly groups: readonly SeamGroup[];
}

const HORIZONTAL = FACE.filter(([, dy]) => dy === 0);

export function measureSeams(grid: Grid): SeamReport {
  const pk = packer(grid.bounds(), 1);
  const solid = new Set<number>();
  // 按列收集实体格的 y；列键用 y 固定为包围盒最低处的打包键，只为区分 (x, z)。
  const columns = new Map<number, { x: number; z: number; ys: number[] }>();
  const bounds = grid.bounds();
  if (bounds === undefined) return { cells: 0, groups: [] };
  const bottom = bounds.min[1];
  for (const { x, y, z } of grid.cells()) {
    solid.add(pk.key(x, y, z));
    const col = pk.key(x, bottom, z);
    const entry = columns.get(col);
    if (entry === undefined) columns.set(col, { x, z, ys: [y] });
    else entry.ys.push(y);
  }
  const spread = (x: number, y: number, z: number): boolean => {
    let n = 0;
    for (const [dx, , dz] of HORIZONTAL) if (solid.has(pk.key(x + dx, y, z + dz))) n += 1;
    return n >= MIN_SPREAD;
  };

  // 夹层格 → 它所在的空气缝层数
  const seam = new Map<number, { cell: Cell; layers: 1 | 2 }>();
  for (const { x, z, ys } of columns.values()) {
    ys.sort((a, b) => a - b);
    let lo = ys[0];
    for (const hi of ys.slice(1)) {
      if (lo === undefined) break;
      const below = lo;
      lo = hi;
      const gap = hi - below - 1;
      if (gap < 1 || gap > MAX_SEAM_LAYERS) continue;
      if (!spread(x, below, z) || !spread(x, hi, z)) continue;
      for (let y = below + 1; y < hi; y += 1)
        seam.set(pk.key(x, y, z), { cell: { x, y, z }, layers: gap === 1 ? 1 : 2 });
    }
  }

  const seen = new Set<number>();
  const groups: (SeamGroup & { first: Cell })[] = [];
  for (const [start, entry] of seam) {
    if (seen.has(start)) continue;
    seen.add(start);
    const members: Cell[] = [];
    let layers: 1 | 2 = entry.layers;
    const stack = [entry.cell];
    for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
      members.push(c);
      for (const [dx, dy, dz] of FACE) {
        const k = pk.key(c.x + dx, c.y + dy, c.z + dz);
        const next = seam.get(k);
        if (next === undefined || seen.has(k)) continue;
        seen.add(k);
        if (next.layers === 2) layers = 2;
        stack.push(next.cell);
      }
    }
    const box = boxOf(members);
    if (box === undefined) throw new Error('夹层组为空：不应发生');
    const first = members.reduce((m, c) => (compareCells(c, m) < 0 ? c : m));
    groups.push({ cells: members.length, layers, bounds: box, samples: samplesOf(grid, members), first });
  }
  groups.sort((a, b) => b.cells - a.cells || compareCells(a.first, b.first));
  return {
    cells: seam.size,
    groups: groups.map(({ cells, layers, bounds: b, samples }) => ({ cells, layers, bounds: b, samples })),
  };
}
