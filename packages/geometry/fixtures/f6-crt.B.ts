/** F6-B 重写：L形两栋与东侧门楼，短连廊以原语保留并记录兜底比例。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
export default function build(w: World): void {
  const court = w.enclosure({
    // 旧稿院墙 x −15..15（v02 f6-crt.B.js:8-12）。
    outline: rect(-15, -13, 15, 13),
    height: 3,
    material: 'white_concrete',
    gate: {
      side: 'east',
      width: 3,
      height: 3,
      // 旧稿门楼 x 14..17 伸出东墙（x=15）两格（v02 f6-crt.B.js:26-27）。
      gatehouse: { width: 5, depth: 4, height: 5, material: 'white_concrete', outward: 2 },
    },
  });
  const gatehouse = court.gatehouse;
  if (gatehouse === undefined) throw new Error('门楼缺失');
  const hall = w.walls({ footprint: rect(-13, -11, -4, -3), y: 1, height: 9, material: 'white_concrete' });
  w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 3 });
  w.roof({ on: hall, kind: 'gable', pitch: 0.45, material: 'deepslate_tiles' });
  const wing = w.walls({ footprint: rect(-2, 5, 6, 12), y: 1, height: 8, material: 'white_concrete' });
  w.opening({ in: wing.facade('north'), kind: 'door', width: 3, height: 3 });
  w.roof({ on: wing, kind: 'gable', ridge: 'z', pitch: 0.6, material: 'deepslate_tiles' });
  w.box([-4, 4, -2], [-2, 4, 5], 'dark_oak_planks');
  for (const [x, z] of [
    [-4, -2],
    [-2, 5],
  ]) {
    if (x === undefined || z === undefined) throw new Error('柱坐标缺失');
    w.box([x, 1, z], [x, 3, z], 'oak_log');
  }
  // 旧稿门楼顶 y6、脊沿 z（v02 f6-crt.B.js:28）；挂门楼 top 自动封山墙。
  w.roof({ on: gatehouse.top, kind: 'gable', ridge: 'z', pitch: 1, material: 'deepslate_tiles' });
  // 旧稿满院铺装一整块（v02 f6-crt.B.js:5）：API 3 起 region 整片铺。
  w.paving({ region: rect(-14, -12, 14, 12), material: 'stone_bricks' });
}
