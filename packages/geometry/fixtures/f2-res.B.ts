/** F2-B 重写：高基座住宅，两层台基（下 13×11、上 11×9）；门廊保留四柱柱廊。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
export default function build(w: World): void {
  // 旧稿两层基座（v02 f2-res.B.js:6-7）：下层 -6..6 × -5..5，上层 -5..5 × -4..4。
  w.plinth({ footprint: rect(-5, -4, 5, 4), height: 1, project: 1, material: 'stone_bricks' });
  const base = w.plinth({ footprint: rect(-5, -4, 5, 4), y: 2, height: 1, material: 'stone_bricks' });
  const hall = w.walls({ on: base, height: 4, material: 'dark_oak_planks' });
  const door = w.opening({
    in: hall.facade('north'),
    kind: 'door',
    width: 3,
    height: 2,
  });
  for (const at of [-3, 3]) w.opening({ in: hall.facade('north'), kind: 'window', at, width: 1, height: 1, sill: 2 });
  // 旧稿门廊为双柱（v02 f2-res.B.js:19）；新 API colonnade 四角起柱，保留四柱并记录差异。
  w.colonnade({
    footprint: rect(-3, -7, 3, -5),
    y: 1,
    count: 4,
    height: 5,
    column: { material: 'oak_log' },
    beam: { height: 1, material: 'dark_oak_planks' },
  });
  w.roof({ on: hall, kind: 'gable', ridge: 'x', pitch: 0.55, material: 'deepslate_tiles' });
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
}
