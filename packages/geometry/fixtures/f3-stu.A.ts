/** F3-A 重写：水平窗带、金属框、平屋面女儿墙和入口雨棚。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
export default function build(w: World): void {
  const base = w.plinth({ footprint: rect(-7, -5, 7, 5), height: 1, project: 1, material: 'light_gray_concrete' });
  const hall = w.walls({ on: base, height: 6, material: 'white_concrete' });
  // 旧稿街角两面连续玻璃带 + 每 2 格铁竖框（v02 f3-stu.A.js:12-17）：北面 13 宽、东面 9 宽。
  w.opening({
    in: hall.facade('north'),
    kind: 'window',
    width: 13,
    height: 2,
    sill: 2,
    fill: 'glass',
    mullion: { material: 'iron_block' },
  });
  w.opening({
    in: hall.facade('east'),
    kind: 'window',
    width: 9,
    height: 2,
    sill: 2,
    fill: 'glass',
    mullion: { material: 'iron_block' },
  });
  const door = w.opening({
    in: hall.facade('north'),
    kind: 'door',
    width: 3,
    height: 2,
    frame: { material: 'iron_block' },
    canopy: { depth: 2, material: 'gray_concrete' },
  });
  w.roof({ on: hall, kind: 'flat', material: 'gray_concrete', parapet: { height: 1, material: 'gray_concrete' } });
  // 门洞底在台明顶 y2 > 地表 1，踏步是可达所需，保留。
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
}
