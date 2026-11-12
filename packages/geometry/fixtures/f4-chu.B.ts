/** F4-B 重写：宽殿、两侧廊与矮塔；西侧入口改接塔门避免通向实心侧廊。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
export default function build(w: World): void {
  const base = w.plinth({ footprint: rect(-7, -10, 7, 10), height: 1, material: 'stone_bricks' });
  const nave = w.walls({ on: base, height: 10, material: 'stone_bricks' });
  const entry = w.opening({
    in: nave.facade('south'),
    kind: 'door',
    shape: 'pointed',
    width: 5,
    height: 4,
    frame: { material: 'chiseled_stone_bricks' },
  });
  w.opening({
    in: nave.facade('south'),
    kind: 'window',
    shape: 'round',
    width: 5,
    height: 5,
    sill: 5,
    fill: 'blue_stained_glass',
  });
  w.roof({ on: nave, kind: 'gable', ridge: 'z', pitch: 0.65, material: 'deepslate_tiles' });
  w.mirror({ axis: 'x', at: 0 }, () => {
    const aisle = w.walls({ footprint: rect(7, -9, 10, 9), y: 1, height: 6, material: 'stone_bricks' });
    w.opening({
      in: aisle.facade('east'),
      kind: 'window',
      width: 3,
      height: 2,
      sill: 3,
      repeat: { every: 6 },
      fill: 'blue_stained_glass',
    });
    // 旧稿侧廊单坡向外（v02 f4-chu.B.js:17-18，slopeDir east）：高侧朝中殿，向东下探。
    // 低侧出檐会伸到镜像西侧廊、压到塔内螺旋梯头顶；本 API 用 overhang 0 让低侧止于墙外缘（偏离 §8.1，见 README）。
    w.roof({ on: aisle, kind: 'shed', high: 'west', overhang: 0, pitch: 0.5, material: 'deepslate_tiles' });
  });
  w.steps({ to: entry, width: 3, material: 'stone_brick_stairs' });
  const tower = w.walls({
    footprint: rect(-15, -3, -9, 3),
    y: 1,
    storeys: { count: 2, height: 8 },
    material: 'stone_bricks',
  });
  const bottom = w.floorPlate({ in: tower.storey(0), material: 'stone_bricks' });
  const top = w.floorPlate({ in: tower.storey(1), material: 'stone_bricks' });
  const door = w.opening({ in: tower.facade('west'), kind: 'door', width: 3, height: 3, storey: 0 });
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
  // 旧稿梯径 2，但塔心 x=-14..-10 与镜像侧廊西墙 x=-10 重叠：radius 2 的东侧环格会挖穿侧廊墙
  // （碰撞检查会拦）。保留 radius 1，塔墙与侧廊都不被挖。
  w.stair({ from: bottom, to: top, kind: 'spiral', at: [-12, 0], radius: 1, material: 'stone_brick_stairs' });
  w.roof({
    on: tower,
    kind: 'pyramid',
    pitch: 1,
    finial: { height: 3, material: 'stone_bricks' },
    material: 'deepslate_tiles',
  });
}
