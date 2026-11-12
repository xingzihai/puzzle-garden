/**
 * @pg/analysis 基准：50 万格下四项测量的耗时。基准不能读文件：方块数据用一张手工构造的小表。
 */

import { createRegistry } from '@pg/blocks/registry';
import type { Bench } from '@pg/core/bench';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';

import { measureFloating } from './floating.ts';
import { measureReach } from './reach.ts';
import { measureRoofProfile } from './roof-profile.ts';
import { measureSeams } from './seams.ts';

const record = (id: string, shape: string, extra: object = {}) => ({
  id,
  zh: id,
  shape,
  family: 'stone',
  color: id === 'air' ? null : 0x808080,
  colorSource: id === 'air' ? 'none' : 'texture',
  colorConfidence: 'high',
  props: { luminance: 0, transparent: false, waterloggable: false, ...extra },
});
const registry = createRegistry(
  {
    blocks: [
      { name: 'air', properties: [] },
      { name: 'oak_planks', properties: [] },
      { name: 'stone', properties: [] },
      { name: 'stone_tiles', properties: [] },
    ],
  },
  [
    record('air', 'other', { transparent: true }),
    record('oak_planks', 'cube'),
    record('stone', 'cube'),
    record('stone_tiles', 'cube'),
  ],
);

/**
 * 约 50 万格：一座 100 × 100 占地、100 格高的"楼"：外墙、每 2 层一块楼板（留一格楼梯口），顶上两层屋面。
 * 这样四项测量都有事可做，而不是全实心或全空。
 */
function building(): ReturnType<typeof createGrid> {
  const g = createGrid(registry.table);
  const stone = parseState(registry.table, 'stone');
  const planks = parseState(registry.table, 'oak_planks');
  const tiles = parseState(registry.table, 'stone_tiles');
  for (let x = -60; x < 60; x += 1) for (let z = -60; z < 60; z += 1) g.set(x, 0, z, stone, 0, 0);
  for (let y = 1; y <= 100; y += 1) {
    for (let x = -50; x < 50; x += 1) {
      for (let z = -50; z < 50; z += 1) {
        const wall = x === -50 || x === 49 || z === -50 || z === 49;
        const plate = y % 2 === 0 && y % 20 !== 0 && !(x === 0 && z === 0);
        if (wall) g.set(x, y, z, stone, 0, 0);
        else if (plate) g.set(x, y, z, planks, 0, 0);
      }
    }
  }
  for (let y = 101; y <= 102; y += 1)
    for (let x = -51; x < 51; x += 1) for (let z = -51; z < 51; z += 1) g.set(x, y, z, tiles, 0, 0);
  return g;
}

const grid = building();

const benches: Bench[] = [
  {
    name: `analysis/floating ${String(grid.size)} 格`,
    run: () => measureFloating(grid).cells,
    warmup: 1,
    iterations: 3,
  },
  { name: `analysis/seams ${String(grid.size)} 格`, run: () => measureSeams(grid).cells, warmup: 1, iterations: 3 },
  {
    name: `analysis/reach ${String(grid.size)} 格`,
    run: () => measureReach(grid, registry).reached,
    warmup: 1,
    iterations: 3,
  },
  {
    name: `analysis/roof-profile ${String(grid.size)} 格`,
    run: () => measureRoofProfile(grid, (c) => c.state.name === 'stone_tiles').cells,
    warmup: 1,
    iterations: 3,
  },
];

export default benches;
