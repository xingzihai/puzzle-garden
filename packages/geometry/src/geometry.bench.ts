/** 分层写入大体量基准；只返回格数，避免基准保留多份大网格影响内存。 */
import { createBlockTable } from '@pg/core/block-state';
import type { Bench } from '@pg/core/bench';
import { createWorld } from './index.ts';
const table = createBlockTable({
  blocks: [
    { name: 'air', properties: [] },
    { name: 'stone', properties: [] },
  ],
});
const benches: Bench[] = [
  {
    name: 'geometry 50万格写入与合成',
    warmup: 1,
    iterations: 3,
    run: (): number => {
      const h = createWorld(table);
      h.world.box([0, 1, 0], [99, 50, 99], 'stone');
      h.world.box([0, 25, 0], [99, 25, 99], 'air');
      return h.compose().grid.size;
    },
  },
];
export default benches;
