/** F3-B 重写：一层高 5、二层高 4（旧稿体块），二层错位盒显式定位；窗加铁框。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
export default function build(w: World): void {
  // 旧稿台明 x -8..8、z -6..5（v02 f3-stu.B.js:5）：承托轮廓 z 到 4，均匀外挑 1 后 z 止于 5。
  const base = w.plinth({ footprint: rect(-7, -5, 7, 4), height: 1, project: 1, material: 'light_gray_concrete' });
  // 旧稿一层墙 y2..6（高 5）；墙身 z -5..5 显式给出，避免随台基承托轮廓缩到 z=4。
  const hall = w.walls({ footprint: rect(-7, -5, 7, 5), y: base.top.y, height: 5, material: 'white_concrete' });
  // 旧稿一层两面连续玻璃带 + 每 2 格铁框（v02 f3-stu.B.js:12-16）：东面 9 宽、sill 1、高 3 可恢复；
  // 北面 sill 1 会在 y3 与门洞（y2..3）重叠，保持 sill 2、height 2。
  w.opening({
    in: hall.facade('east'),
    kind: 'window',
    width: 9,
    height: 3,
    sill: 1,
    fill: 'glass',
    mullion: { material: 'iron_block' },
  });
  w.opening({
    in: hall.facade('north'),
    kind: 'window',
    width: 13,
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
  // 一层平顶旧在 y6，女儿墙 y7（v02 f3-stu.B.js:22-23）。
  w.roof({
    footprint: rect(-7, -5, 7, 5),
    y: 6,
    kind: 'flat',
    material: 'gray_concrete',
    parapet: { height: 1, material: 'gray_concrete' },
  });
  // 二层旧体块 y7..10（v02 f3-stu.B.js:18）。
  const upper = w.walls({ footprint: rect(-3, -2, 4, 4), y: 7, height: 4, material: 'white_concrete' });
  // 二层旧稿窗 x −3..4 占转角，A6 只能开 x −2..3；P4 要求窗带 width = k·every + 1（两端竖框），
  // every 2 时取 width 5（x −2..2）。
  w.opening({
    in: upper.facade('north'),
    kind: 'window',
    width: 5,
    height: 2,
    sill: 1,
    fill: 'glass',
    mullion: { material: 'iron_block' },
  });
  // 二层平顶旧在 y10，女儿墙 y11（v02 f3-stu.B.js:25-26）。
  w.roof({
    footprint: rect(-3, -2, 4, 4),
    y: 10,
    kind: 'flat',
    material: 'gray_concrete',
    parapet: { height: 1, material: 'gray_concrete' },
  });
  // 门洞底在台明顶 y2 > 地表 1，踏步是可达所需，保留。
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
}
