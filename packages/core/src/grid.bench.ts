/**
 * @pg/core 体素网格基准：合成 50 万体素，测写入、遍历、hash、存档读写。
 * 基准不是测试，不能读文件：用一张手工构造的小方块表。
 */

import { readArchive, writeArchive } from './archive.ts';
import type { Bench } from './bench.ts';
import { createBlockTable, parseState } from './block-state.ts';
import { createGrid } from './grid.ts';
import type { Grid } from './grid.ts';
import { hashGrid } from './hash.ts';

const table = createBlockTable({
  blocks: [
    { name: 'air', properties: [] },
    { name: 'stone', properties: [] },
    { name: 'oak_planks', properties: [] },
    { name: 'glass', properties: [] },
    {
      name: 'oak_stairs',
      properties: [
        { name: 'facing', type: 'enum', values: ['north', 'south', 'west', 'east'], default: 'north' },
        { name: 'half', type: 'enum', values: ['top', 'bottom'], default: 'bottom' },
      ],
    },
  ],
});

const STATES = ['stone', 'oak_planks', 'glass', 'oak_stairs[facing=east]', 'oak_stairs[half=top]'].map((s) =>
  parseState(table, s),
);

/** 100 × 50 × 100 = 50 万格，跨越负坐标与多个区块。 */
const SIDE_X = 100;
const SIDE_Y = 50;
const SIDE_Z = 100;

function fill(): Grid {
  const g = createGrid(table);
  const part = g.definePart('体');
  const call = g.defineCall('fill', 1, {});
  for (let y = 0; y < SIDE_Y; y += 1) {
    for (let z = -50; z < SIDE_Z - 50; z += 1) {
      for (let x = -50; x < SIDE_X - 50; x += 1) {
        const state = STATES[(x + y + z) & 3];
        if (state !== undefined) g.set(x, y, z, state, part, call);
      }
    }
  }
  return g;
}

const filled = fill();
const bytes = writeArchive(filled, 1);

const benches: Bench[] = [
  { name: 'core/grid 写入 50 万格', run: fill, warmup: 1, iterations: 5 },
  {
    name: 'core/grid 遍历 50 万格',
    run: (): number => {
      let n = 0;
      for (const c of filled.cells()) n += c.x;
      return n;
    },
    warmup: 1,
    iterations: 5,
  },
  { name: 'core/hash 50 万格', run: () => hashGrid(filled), warmup: 1, iterations: 5 },
  { name: 'core/archive 写出 50 万格', run: () => writeArchive(filled, 1), warmup: 1, iterations: 5 },
  { name: 'core/archive 读回 50 万格', run: () => readArchive(table, bytes).grid.size, warmup: 1, iterations: 5 },
];

export default benches;
