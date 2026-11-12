/**
 * 左右对称测量（docs/ANALYSIS-SPEC.md §6a）：把实体格沿水平镜面映射，数镜像位置也是实体的比例。
 *
 * 负责：为 x、z 两个水平轴各选一个"基本对称"的镜面位置，报实体 / 玻璃的对上数与不对称格的分组。
 * 不负责：判定合格；比较方块朝向与材质（同材质换色、楼梯朝向翻转都不算不对称）；挑选哪些组是缺陷（呈现层的事）。
 */

import type { Cell as GridCell, Grid } from '@pg/core/grid';

import { FACE, boxOf, compareCells, packer, samplesOf } from './sample.ts';
import type { Box, Cell, Packer, Sample } from './sample.ts';

/** matched / cells 达到这个比例才算"基本对称"，该轴才进 axes。 */
export const MIN_SYMMETRY = 0.8;

/** 镜像位置不是实体 / 不是玻璃的格，按面邻接分成一组。 */
export interface AsymGroup {
  readonly cells: number;
  readonly bounds: Box;
  readonly samples: readonly Sample[];
}

export interface SymmetryAxis {
  readonly axis: 'x' | 'z';
  /** 镜面位置，整数或 .5；与 world.mirror 的 at 同义。 */
  readonly at: number;
  /** 实体格总数。 */
  readonly cells: number;
  /** 镜像位置也是实体的格数。 */
  readonly matched: number;
  /** glass 谓词为真的格数。 */
  readonly glass: number;
  /** 镜像位置也是 glass 的玻璃格数。 */
  readonly glassMatched: number;
  /** 玻璃格中 2·v < 2·at 的一侧格数；落在镜面上的不计。 */
  readonly glassBelow: number;
  /** 玻璃格中 2·v > 2·at 的一侧格数；落在镜面上的不计。 */
  readonly glassAbove: number;
  /** 镜像位置不是实体的格，按面邻接分组，格数降序。 */
  readonly lonely: readonly AsymGroup[];
  /** 镜像位置不是玻璃的玻璃格，按面邻接分组，格数降序。 */
  readonly lonelyGlass: readonly AsymGroup[];
}

export interface SymmetryReport {
  /** 先 x 后 z；只含 matched / cells ≥ MIN_SYMMETRY 的轴。 */
  readonly axes: readonly SymmetryAxis[];
}

export interface SymmetryOptions {
  /** 哪些格算玻璃（呈现层按方块名含 `glass`）；缺省为永不为真。 */
  readonly glass?: (cell: GridCell) => boolean;
}

const AXES: readonly { readonly axis: 'x' | 'z'; readonly index: 0 | 2 }[] = [
  { axis: 'x', index: 0 },
  { axis: 'z', index: 2 },
];

/**
 * 一组不对称格按面邻接分组。`pk` 的打包范围覆盖镜像坐标（见 measureSymmetry 的 margin）。
 */
function groupAsym(grid: Grid, pk: Packer, cells: readonly Cell[]): AsymGroup[] {
  const members = new Set(cells.map((c) => pk.key(c.x, c.y, c.z)));
  const seen = new Set<number>();
  const groups: (AsymGroup & { readonly first: Cell })[] = [];
  for (const start of cells) {
    const sk = pk.key(start.x, start.y, start.z);
    if (seen.has(sk)) continue;
    seen.add(sk);
    const group: Cell[] = [];
    const stack: Cell[] = [start];
    for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
      group.push(c);
      for (const [dx, dy, dz] of FACE) {
        const k = pk.key(c.x + dx, c.y + dy, c.z + dz);
        if (!members.has(k) || seen.has(k)) continue;
        seen.add(k);
        stack.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz });
      }
    }
    const bounds = boxOf(group);
    if (bounds === undefined) throw new Error('不对称组为空：不应发生');
    // 组内最小 (y, z, x) 的格：同格数时排序用，与样例的第一个一致。
    const first = group.reduce((m, c) => (compareCells(c, m) < 0 ? c : m));
    groups.push({ cells: group.length, bounds, samples: samplesOf(grid, group), first });
  }
  groups.sort((a, b) => b.cells - a.cells || compareCells(a.first, b.first));
  return groups.map(({ cells, bounds, samples }) => ({ cells, bounds, samples }));
}

export function measureSymmetry(grid: Grid, options: SymmetryOptions = {}): SymmetryReport {
  const bounds = grid.bounds();
  if (bounds === undefined) return { axes: [] };
  // 镜面候选 s = min + max ± 2 时镜像坐标最多落到 [min−2, max+2]；外扩足够就能直接用数字键，
  // 不必逐格判越界（packer.key 对越界值可能冲突，见 sample.ts）。
  const margin = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]) + 5;
  const pk = packer(bounds, margin);
  const cells: Cell[] = [];
  const glassCells: Cell[] = [];
  const solid = new Set<number>();
  const glass = new Set<number>();
  for (const c of grid.cells()) {
    const cell = { x: c.x, y: c.y, z: c.z };
    cells.push(cell);
    const k = pk.key(c.x, c.y, c.z);
    solid.add(k);
    if (options.glass?.(c) === true) {
      glass.add(k);
      glassCells.push(cell);
    }
  }
  if (cells.length === 0) return { axes: [] };

  const axes: SymmetryAxis[] = [];
  for (const { axis, index } of AXES) {
    const min = bounds.min[index];
    const max = bounds.max[index];
    const mid2 = min + max;
    const candidates = [mid2 - 2, mid2 - 1, mid2, mid2 + 1, mid2 + 2];
    let best = candidates[0] ?? mid2;
    let bestMatched = -1;
    for (const s of candidates) {
      let matched = 0;
      for (const c of cells) {
        const p = [c.x, c.y, c.z];
        p[index] = s - (p[index] ?? 0);
        if (solid.has(pk.key(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0))) matched += 1;
      }
      const gap = Math.abs(s - mid2);
      const bestGap = Math.abs(best - mid2);
      if (matched > bestMatched || (matched === bestMatched && (gap < bestGap || (gap === bestGap && s < best)))) {
        best = s;
        bestMatched = matched;
      }
    }
    if (bestMatched / cells.length < MIN_SYMMETRY) continue;

    const lonely: Cell[] = [];
    const lonelyGlass: Cell[] = [];
    let glassMatched = 0;
    let glassBelow = 0;
    let glassAbove = 0;
    for (const c of cells) {
      const p = [c.x, c.y, c.z];
      p[index] = best - (p[index] ?? 0);
      if (!solid.has(pk.key(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0))) lonely.push(c);
    }
    for (const c of glassCells) {
      const p = [c.x, c.y, c.z];
      const v = p[index] ?? 0;
      p[index] = best - v;
      if (glass.has(pk.key(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0))) glassMatched += 1;
      else lonelyGlass.push(c);
      if (v * 2 < best) glassBelow += 1;
      else if (v * 2 > best) glassAbove += 1;
    }
    axes.push({
      axis,
      at: best / 2,
      cells: cells.length,
      matched: bestMatched,
      glass: glassCells.length,
      glassMatched,
      glassBelow,
      glassAbove,
      lonely: groupAsym(grid, pk, lonely),
      lonelyGlass: groupAsym(grid, pk, lonelyGlass),
    });
  }
  return { axes };
}
