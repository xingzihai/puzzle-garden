/** F2-A 重写：横长住宅；保留旧稿浅石基座、门窗与雨棚。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
export default function build(w: World): void {
  const base = w.plinth({ footprint: rect(-6, -4, 6, 4), height: 1, project: 1, material: 'cobblestone' });
  const hall = w.walls({ on: base, height: 4, material: 'oak_planks' });
  const door = w.opening({
    in: hall.facade('north'),
    kind: 'door',
    width: 3,
    height: 2,
    frame: { material: 'dark_oak_planks' },
    canopy: { depth: 2, material: 'dark_oak_planks' },
  });
  for (const at of [-4, 4]) w.opening({ in: hall.facade('north'), kind: 'window', at, width: 2, height: 2, sill: 1 });
  w.roof({ on: hall, kind: 'gable', ridge: 'x', overhang: 1, pitch: 0.5, material: 'deepslate_tiles' });
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
}
