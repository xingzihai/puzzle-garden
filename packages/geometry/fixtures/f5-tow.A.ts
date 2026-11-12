/** F5-A 重写：四层石木塔，完整楼板由楼梯自行开洞。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
/** 塔底（台基顶面）绝对 y；旧稿窗口的绝对 y 减它得到 opening 的相对 sill。 */
const WALL_BASE = 2;
/** 旧稿楼板绝对层位（v02 f5-tow.A.js:20）：首层 y12，没有 y2 底层板。 */
const FLOORS = [12, 22, 32, 42] as const;
/** 旧稿窗口绝对 y（v02 f5-tow.A.js:29）。 */
const WINDOWS = [6, 16, 26, 36] as const;
export default function build(w: World): void {
  const base = w.plinth({ footprint: rect(-7, -7, 7, 7), height: 1, project: 1, material: 'stone_bricks' });
  // 塔身旧稿 y2..42：显式 height41；木段绝对 y23..42 等价于 band 21..40（相对墙底 0）。
  const tower = w.walls({
    on: base,
    height: 41,
    material: 'stone_bricks',
    bands: [{ from: 21, to: 40, material: 'dark_oak_planks' }],
  });
  const plates = FLOORS.map((y) => w.floorPlate({ footprint: tower.inner.footprint, y, material: 'dark_oak_planks' }));
  const top = plates.at(-1);
  if (top === undefined) throw new Error('楼板缺失');
  const door = w.opening({ in: tower.facade('south'), kind: 'door', shape: 'arch', width: 5, height: 7, sill: 0 });
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
  // 从台基顶面站起，直到最高楼板顶面 y43；墙高（height41）没有 storeys，窗口按绝对 y 转相对 sill。
  w.stair({ from: base.top, to: top.top, kind: 'spiral', at: [0, 0], radius: 4, material: 'stone_brick_stairs' });
  for (const side of ['north', 'south', 'east', 'west'] as const)
    for (const fy of WINDOWS) {
      // 南面最低一排窗（y6..8）整个落在拱门洞（y2..8）里，跳过以免两洞重叠。
      if (side === 'south' && fy === WINDOWS[0]) continue;
      w.opening({ in: tower.facade(side), kind: 'window', width: 3, height: 3, sill: fy - WALL_BASE });
    }
  w.rail({ along: tower.top, material: 'dark_oak_fence' });
  // 旧稿攒尖顶从 y44 起，轮廓 ±7 不出檐；pitch1 使瓦尖落在 y51，顶饰三个金块 y52..54。
  w.roof({
    footprint: rect(-7, -7, 7, 7),
    y: 44,
    kind: 'pyramid',
    pitch: 1,
    overhang: 0,
    material: 'deepslate_tiles',
    finial: { height: 3, material: 'gold_block' },
  });
}
