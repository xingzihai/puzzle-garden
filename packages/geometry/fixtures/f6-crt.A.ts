/** F6-A 重写：轴向院落、可进入的两栋房屋和贯通门楼。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
export default function build(w: World): void {
  const court = w.enclosure({
    outline: rect(-16, -13, 16, 13),
    height: 3,
    material: 'white_concrete',
    gate: {
      side: 'south',
      width: 5,
      height: 3,
      // 旧稿门楼 z 12..15 伸出南墙（z=13）两格（v02 f6-crt.A.js:24-25）。
      gatehouse: { width: 7, depth: 4, height: 5, material: 'white_concrete', outward: 2 },
    },
  });
  const gatehouse = court.gatehouse;
  if (gatehouse === undefined) throw new Error('门楼缺失');
  const hall = w.walls({
    footprint: rect(-6, -12, 6, -4),
    y: 1,
    height: 8,
    material: 'white_concrete',
    bands: [{ from: 5, to: 7, material: 'dark_oak_planks' }],
  });
  w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 3 });
  w.roof({ on: hall, kind: 'gable', pitch: 0.6, material: 'deepslate_tiles' });
  const wing = w.walls({ footprint: rect(8, -10, 15, -3), y: 1, height: 7, material: 'white_concrete' });
  w.opening({ in: wing.facade('south'), kind: 'door', width: 3, height: 3 });
  w.roof({ on: wing, kind: 'gable', pitch: 0.6, material: 'deepslate_tiles' });
  // 旧稿门楼顶 y6（v02 f6-crt.A.js:27）；挂门楼 top 自动封山墙。门楼进深 4、脊沿 x，
  // 本 API 的整数内缩在这个深度下 pitch 0.5 升不起一格，沿用原稿的 pitch 1（偏离 §8.4，见 README）。
  w.roof({ on: gatehouse.top, kind: 'gable', pitch: 1, material: 'deepslate_tiles' });
  // 旧稿满院铺装一整块（v02 f6-crt.A.js:6）：API 3 起 region 整片铺。
  w.paving({ region: rect(-14, -12, 14, 12), material: 'stone_bricks' });
}
