/** F1-B 重写：两层退台（15×15 → 13×13）、四角柱与攒尖，顶饰 2 格，铺装贴南侧。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
export default function build(w: World): void {
  // 旧稿两层台基（v02 f1-pav.B.js:6-7）：下层 -7..7（15×15）、上层 -6..6（13×13）。
  w.plinth({ footprint: rect(-6, -6, 6, 6), height: 1, project: 1, material: 'stone_bricks' });
  const base = w.plinth({ footprint: rect(-5, -5, 5, 5), y: 2, height: 1, project: 1, material: 'stone_bricks' });
  const columns = w.colonnade({
    on: base,
    count: 4,
    height: 4,
    column: { material: 'dark_oak_log', shape: 'cross' },
    beam: { material: 'dark_oak_planks' },
  });
  w.roof({
    on: columns,
    kind: 'pyramid',
    pitch: 0.4,
    material: 'deepslate_tiles',
    finial: { height: 2, material: 'gold_block' },
  });
  w.steps({ to: base.edge('south'), width: 5, material: 'stone_brick_stairs' });
  // 旧稿亭前贴地铺装（v02 f1-pav.B.js:22-23）在 z=11..13；API 3 起 region 可整片铺。
  w.paving({ region: rect(-2, 11, 2, 13), material: 'stone_bricks' });
}
