/**
 * S1 六角亭屋面夹具（SURFACE-SHELL-SPEC §9）：多边形六角台基 + 曲面六坡凹曲屋面 + 旋转宝顶。
 * 两种 kind 各一次调用：屋面用 surface（closedU、v 端收成尖），宝顶用 revolve（端部吸附成尖）。
 * 尺寸为格数设计值；公式允许浮点，体素化后按整数格测量（本文件不是逐格等价旧稿）。
 */
import type { World } from '@pg/geometry';

const TAU = Math.PI * 2;
const SECTOR = TAU / 6;

/** 正六边形在角度 a 处的半径（apothem 为边心距）：边法线在 0°、60°…，顶点在 30°、90°…。 */
function hexRadius(a: number, apothem: number): number {
  const m = ((a % SECTOR) + SECTOR) % SECTOR;
  const dEdge = m <= SECTOR / 2 ? m : SECTOR - m;
  return apothem / Math.cos(dEdge);
}

/** 角部权重：顶点方向 1、边中 0；指数 4 让起翘紧贴角部。 */
function cornerWeight(a: number): number {
  const m = ((a % SECTOR) + SECTOR) % SECTOR;
  const dVertex = Math.abs(m - SECTOR / 2);
  const s = 1 - dVertex / (SECTOR / 2);
  return Math.pow(Math.max(0, s), 4);
}

/** 三次贝塞尔采样单个分量。 */
function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

const EAVE_APOTHEM = 4.8;
const EAVE_Y = 1.1;
const RIDGE_Y = 6.5;
/** 角部起翘必须使檐口仍落在底层格（EAVE_Y + CORNER_UP < 2），否则角柱列会悬空。 */
const CORNER_UP = 0.8;

/** 屋面在 (角度 a, 径向参数 v) 处的点：径向与高度同用一条凹曲母线，近脊陡、近檐缓。 */
function roofPoint(a: number, v: number): readonly [number, number, number] {
  const cw = cornerWeight(a);
  const eaveR = hexRadius(a, EAVE_APOTHEM);
  const r = bezier(0, 0.08 * eaveR, 0.52 * eaveR, eaveR, v);
  const span = RIDGE_Y - EAVE_Y;
  let y = bezier(RIDGE_Y, RIDGE_Y - 0.12 * span, RIDGE_Y - 0.48 * span, EAVE_Y, v);
  const s = Math.max(0, (v - 0.62) / 0.38);
  const bump = 0.5 - 0.5 * Math.cos(s * Math.PI);
  y += CORNER_UP * cw * (bump + 0.3 * s * s * s);
  return [r * Math.cos(a), y, r * Math.sin(a)];
}

export default function build(w: World): void {
  // 整数顶点六角台基（格点多边形只收整数坐标）；外接半径 7，最小边心距 5.82 > 屋面檐口最大半径 5.54。
  w.plinth({
    footprint: {
      points: [
        [0, 7],
        [6, 4],
        [6, -4],
        [0, -7],
        [-6, -4],
        [-6, 4],
      ],
    },
    height: 1,
    material: 'stone_bricks',
  });
  w.surfaceShell({
    kind: 'surface',
    position: (u, v) => roofPoint(u * TAU, v),
    uSegments: 96,
    vSegments: 24,
    closedU: true,
    material: 'deepslate_tiles',
    name: '六坡凹曲屋面',
  });
  w.surfaceShell({
    kind: 'revolve',
    profile: (t) => [0.55 * Math.pow(1 - t, 1.4), RIDGE_Y + 0.1 + 2.1 * t],
    profileSegments: 24,
    radialSegments: 16,
    material: 'gold_block',
    name: '宝顶',
  });
}
