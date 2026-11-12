/**
 * 悬空测量（docs/ANALYSIS-SPEC.md §3）：沿面邻接连不到地面的实体格。
 *
 * 负责：数出悬空格、按 26 邻接分组、区分"只靠棱角相连"的组。
 * 不负责：判定合格；楼梯能不能走（那是 reach.ts，edgeOnly 不能说明能走）。
 */

import type { Cell as GridCell, Grid } from '@pg/core/grid';

import { ALL26, FACE, boxOf, compareCells, packer, samplesOf } from './sample.ts';
import type { Box, Cell, Sample } from './sample.ts';

/** y ≤ 1 的实体格视为落在地面上（y = 0 是地表层，y = 1 压在地表上表面）。 */
export const GROUND_MAX_Y = 1;

export interface FloatingGroup {
  readonly cells: number;
  /** 这组有格与有支承部分共棱或共角（但没有共面）。 */
  readonly edgeOnly: boolean;
  /** 组内满足 `options.tag` 的格数；没给 tag 时为 0。样例最多 20 个，判断整组性质要用这个数。 */
  readonly tagged: number;
  readonly bounds: Box;
  readonly samples: readonly Sample[];
}

export interface FloatingOptions {
  /** 给格打标签（如"是屋面格"），只用于统计每组里有多少标签格，不改变悬空的判定。 */
  readonly tag?: (cell: GridCell) => boolean;
}

export interface FloatingReport {
  readonly cells: number;
  /** 属于 edgeOnly 组的悬空格数。 */
  readonly edgeOnly: number;
  /** 按格数降序；同格数时按最小 (y, z, x)。 */
  readonly groups: readonly FloatingGroup[];
}

export function measureFloating(grid: Grid, options: FloatingOptions = {}): FloatingReport {
  // 外扩 1 格：邻格查询不会越出打包范围。
  const pk = packer(grid.bounds(), 1);
  const solid = new Set<number>();
  const supported = new Set<number>();
  const tagged = new Set<number>();
  const queue: Cell[] = [];
  for (const cell of grid.cells()) {
    const { x, y, z } = cell;
    const k = pk.key(x, y, z);
    solid.add(k);
    if (options.tag?.(cell) === true) tagged.add(k);
    if (y <= GROUND_MAX_Y) {
      supported.add(k);
      queue.push({ x, y, z });
    }
  }
  // 从地面沿面邻接扩散。
  for (let c = queue.pop(); c !== undefined; c = queue.pop()) {
    for (const [dx, dy, dz] of FACE) {
      const k = pk.key(c.x + dx, c.y + dy, c.z + dz);
      if (solid.has(k) && !supported.has(k)) {
        supported.add(k);
        queue.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz });
      }
    }
  }

  const floating: Cell[] = [];
  for (const c of grid.cells()) if (!supported.has(pk.key(c.x, c.y, c.z))) floating.push({ x: c.x, y: c.y, z: c.z });
  const seen = new Set<number>();
  const groups: { cells: Cell[]; edgeOnly: boolean }[] = [];
  for (const start of floating) {
    const sk = pk.key(start.x, start.y, start.z);
    if (seen.has(sk)) continue;
    seen.add(sk);
    const members: Cell[] = [];
    let edgeOnly = false;
    const stack = [start];
    for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
      members.push(c);
      for (const [dx, dy, dz] of ALL26) {
        const k = pk.key(c.x + dx, c.y + dy, c.z + dz);
        if (!solid.has(k)) continue;
        // 与有支承格相邻：悬空格定义上不与有支承格共面，所以这里一定是共棱或共角。
        if (supported.has(k)) edgeOnly = true;
        else if (!seen.has(k)) {
          seen.add(k);
          stack.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz });
        }
      }
    }
    groups.push({ cells: members, edgeOnly });
  }

  const out = groups.map((g) => {
    const bounds = boxOf(g.cells);
    // 组至少有一个格，包围盒一定存在；判断只为收窄类型。
    if (bounds === undefined) throw new Error('悬空组为空：不应发生');
    // 组内最小 (y, z, x) 的格：用于同格数时的排序，与样例的第一个一致。
    const first = g.cells.reduce((m, c) => (compareCells(c, m) < 0 ? c : m));
    const count = g.cells.filter((c) => tagged.has(pk.key(c.x, c.y, c.z))).length;
    return {
      cells: g.cells.length,
      edgeOnly: g.edgeOnly,
      tagged: count,
      bounds,
      samples: samplesOf(grid, g.cells),
      first,
    };
  });
  out.sort((a, b) => b.cells - a.cells || compareCells(a.first, b.first));
  return {
    cells: floating.length,
    edgeOnly: out.filter((g) => g.edgeOnly).reduce((n, g) => n + g.cells, 0),
    groups: out.map(({ cells, edgeOnly, tagged: t, bounds, samples }) => ({
      cells,
      edgeOnly,
      tagged: t,
      bounds,
      samples,
    })),
  };
}
