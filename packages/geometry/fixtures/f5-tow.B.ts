/** F5-B 重写：保留五层方案与石角柱，未把五层冒充题面四层。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
/** 塔底（台基顶面）绝对 y；旧稿窗口的绝对 y 减它得到 opening 的相对 sill。 */
const WALL_BASE = 2;
/** 旧稿楼板绝对层位（v02 f5-tow.B.js:25）：首层 y10，没有 y2 底层板。 */
const FLOORS = [10, 18, 26, 34, 42] as const;
/** 旧稿窗口绝对 y（v02 f5-tow.B.js:34）。 */
const WINDOWS = [7, 15, 23, 31, 39] as const;
export default function build(w: World): void {
  const base = w.plinth({ footprint: rect(-7, -7, 7, 7), height: 1, project: 1, material: 'stone_bricks' });
  // 塔身旧稿 y2..42：显式 height41；石带 y2..3 等价于 band 0..1（相对墙底 0）。
  const tower = w.walls({
    on: base,
    height: 41,
    material: 'oak_planks',
    bands: [{ from: 0, to: 1, material: 'stone_bricks' }],
  });
  // 角柱旧稿 y2..42（v02 f5-tow.B.js:18），height41；旧稿 radius 1 是 5 格十字截面。
  w.colonnade({ on: base, count: 4, height: 41, column: { material: 'stone_bricks', shape: 'cross' }, beam: false });
  const plates = FLOORS.map((y) => w.floorPlate({ footprint: tower.inner.footprint, y, material: 'oak_planks' }));
  const top = plates.at(-1);
  if (top === undefined) throw new Error('楼板缺失');
  const door = w.opening({
    in: tower.facade('south'),
    kind: 'door',
    shape: 'arch',
    width: 3,
    height: 4,
    sill: 0,
    frame: { material: 'chiseled_stone_bricks' },
  });
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
  w.stair({ from: base.top, to: top.top, kind: 'spiral', at: [0, 0], radius: 4, material: 'oak_stairs' });
  for (const side of ['north', 'south', 'east', 'west'] as const)
    for (const fy of WINDOWS)
      w.opening({ in: tower.facade(side), kind: 'window', width: 2, height: 3, sill: fy - WALL_BASE });
  w.rail({ along: tower.top, material: 'oak_fence' });
  // 旧方案：墙宽 15 的陡尖顶，不出檐，峰顶 y56，顶上两个金块 y57..58（v02 f5-tow.B.js:46-47）。
  w.roof({
    footprint: rect(-7, -7, 7, 7),
    y: 44,
    kind: 'pyramid',
    peakY: 56,
    overhang: 0,
    material: 'deepslate_tiles',
    finial: { height: 2, material: 'gold_block' },
  });
}
