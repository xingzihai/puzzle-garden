/**
 * S2 圆角美术馆穹顶夹具（SURFACE-SHELL-SPEC §9）：多边形圆角台基 + 旋转壳穹顶。
 * 母线用指数型收分（半径随高度收到 0，端部吸附成精确尖），对应草模题的穹顶轮廓。
 */
import type { World } from '@pg/geometry';

const DOME_RADIUS = 6.5;
const DOME_BASE_Y = 1.1;
const DOME_HEIGHT = 5.5;

export default function build(w: World): void {
  // 整数顶点 12 边形近似圆角台基；最小边心距 7.76 > 穹顶底半径 6.5，底圈全部落在台基上。
  w.plinth({
    footprint: {
      points: [
        [8, 0],
        [7, 4],
        [4, 7],
        [0, 8],
        [-4, 7],
        [-7, 4],
        [-8, 0],
        [-7, -4],
        [-4, -7],
        [0, -8],
        [4, -7],
        [7, -4],
      ],
    },
    height: 1,
    material: 'smooth_stone',
  });
  w.surfaceShell({
    kind: 'revolve',
    profile: (t) => [DOME_RADIUS * Math.pow(1 - t, 0.6), DOME_BASE_Y + DOME_HEIGHT * t],
    profileSegments: 24,
    radialSegments: 48,
    material: 'light_gray_concrete',
    name: '穹顶壳',
  });
}
