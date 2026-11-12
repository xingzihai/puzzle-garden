/** F1-A 重写：低檐六柱亭，两层退台（下 stone_bricks 17×17、上 smooth_stone）、木柱、四坡屋面与南侧踏步。 */
import { rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
export default function build(w: World): void {
  // 旧稿两层台基（v02 f1-pav.A.js:8-9）：下层 -8..8（17×17）石砖，上层 -7..7 内收。
  const lower = w.plinth({ footprint: rect(-8, -8, 8, 8), height: 1, material: 'stone_bricks' });
  // 上层承托轮廓取旧稿柱网 -6..6 × -5..5；project 1 使十字柱臂（x±7、z±6）落在台面上，
  // 不再只靠柱身面邻接悬挑（旧稿上层外缘到 -7..7）。
  const base = w.plinth({ footprint: rect(-6, -5, 6, 5), y: 2, height: 1, project: 1, material: 'smooth_stone' });
  const columns = w.colonnade({
    on: base,
    count: 6,
    height: 3,
    column: { material: 'oak_log', shape: 'cross' },
    beam: { material: 'oak_planks' },
  });
  w.roof({ on: columns, kind: 'hip', pitch: 0.4, overhang: 1, material: 'deepslate_tiles' });
  // 旧稿踏步在 z9..11、落在下层台基外（v02 f1-pav.A.js:23-25）：十字柱南臂在 z6，踏步改挂下层台基边。
  w.steps({ to: lower.edge('south'), width: 5, material: 'stone_brick_stairs' });
  // 旧稿只留 z=±5 两道；南面留口接踏步，再把东西两边整边留空。
  w.rail({
    along: base,
    material: 'oak_fence',
    gaps: [
      { side: 'east', width: 11 },
      { side: 'west', width: 11 },
      { side: 'south', width: 5 },
    ],
  });
}
