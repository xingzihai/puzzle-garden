/** F4-A 重写：落地中殿、半圆后殿（旧稿进深）与单塔；连接路径用楼梯而非手算梯孔。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
export default function build(w: World): void {
  const base = w.plinth({ footprint: rect(-6, -10, 6, 10), height: 1, material: 'stone_bricks' });
  const nave = w.walls({ on: base, height: 13, material: 'stone_bricks' });
  const entry = w.opening({
    in: nave.facade('south'),
    kind: 'door',
    shape: 'pointed',
    width: 5,
    height: 6,
    frame: { material: 'chiseled_stone_bricks' },
  });
  w.opening({
    in: nave.facade('south'),
    kind: 'window',
    shape: 'round',
    width: 5,
    height: 5,
    sill: 7,
    fill: 'red_stained_glass',
  });
  for (const side of ['east', 'west'] as const)
    w.opening({
      in: nave.facade(side),
      kind: 'window',
      shape: 'arch',
      width: 3,
      height: 3,
      sill: 4,
      repeat: { every: 6 },
      fill: 'blue_stained_glass',
    });
  w.roof({ on: nave, kind: 'gable', ridge: 'z', pitch: 0.7, material: 'deepslate_tiles' });
  // 后殿进深按旧稿矮弧墙 z -13..-11、屋面 y7 升到 y12（v02 f4-chu.A.js:14-16）；后殿屋面只支持 hip / pyramid / flat，取 hip。
  const apse = w.walls({
    footprint: rect(-4, -13, 4, -11),
    y: 1,
    height: 6,
    outline: 'apse',
    material: 'stone_bricks',
  });
  w.roof({ on: apse, kind: 'hip', peakY: 12, material: 'deepslate_tiles' });
  w.steps({ to: entry, width: 3, material: 'stone_brick_stairs' });
  const tower = w.walls({
    footprint: rect(-13, -3, -7, 3),
    y: 1,
    storeys: { count: 3, height: 7 },
    material: 'stone_bricks',
  });
  const plates = [0, 1, 2].map((i) => w.floorPlate({ in: tower.storey(i), material: 'stone_bricks' }));
  const bottom = plates[0];
  const top = plates[2];
  if (bottom === undefined || top === undefined) throw new Error('楼板缺失');
  const door = w.opening({ in: tower.facade('south'), kind: 'door', width: 3, height: 3, storey: 0 });
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
  // 旧稿梯径 2（v02 f4-chu.A.js:20）；入口平台落在环内相邻格，5×5 塔心放得下。
  w.stair({ from: bottom, to: top, kind: 'spiral', at: [-10, 0], radius: 2, material: 'stone_brick_stairs' });
  w.roof({ on: tower, kind: 'pyramid', pitch: 0.75, material: 'deepslate_tiles' });
}
