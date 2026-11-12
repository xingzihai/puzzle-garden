/**
 * 浏览器端：相机视角与尺寸适配（MASSING-SPEC §3）。
 *
 * 负责：整体 / 俯视 / 侧视三个预设位姿、把位姿应用到透视相机与 orbit 控制器、随容器尺寸更新相机与渲染器。
 * 不负责：OrbitControls 的创建与事件（page/main.ts）、几何与可见性（page/scene.ts）、DOM。
 *
 * 本模块不碰 DOM，也不依赖 WebGL，因此在 Node 里可对纯函数与相机状态做单元测试。
 */
import * as THREE from 'three';

import type { Bounds } from '@pg/design/schema';

/** 相机位姿：位置、注视点与 up 向量。 */
export interface ViewPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly up: readonly [number, number, number];
}

/** orbit 控制器的最小接口：只需要 target 与 update()，便于单测替换。 */
export interface OrbitLike {
  readonly target: THREE.Vector3;
  update(): void;
}

/** 渲染器的最小接口：只需要 setSize，便于单测替换。 */
export interface ResizableRenderer {
  setSize(width: number, height: number): void;
}

/** 查看器统一使用的垂直视场角（度）。主入口建相机与取景都用它，避免两处口径不一致。 */
export const VIEW_FOV_DEG = 50;
/** 取景留白系数：在“刚好装下”的距离上再退一点，避免边缘紧贴画布。 */
const FRAMING_MARGIN = 1.06;
/**
 * 侧视的极小仰角（单位方向向量的 y 分量）：约 4.6°，让檐口 / 起翘略高于视线，保持“近似水平”。
 * 取 0 也能装下模型，但完全平视会让屋面两侧投影重合、凹曲与起翘更难看。
 */
const SIDE_ELEVATION = 0.08;

type Point3 = readonly [number, number, number];

function centerOf(bounds: Bounds): Point3 {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

function cornersOf(bounds: Bounds): readonly Point3[] {
  const xs = [bounds.min[0], bounds.max[0]] as const;
  const ys = [bounds.min[1], bounds.max[1]] as const;
  const zs = [bounds.min[2], bounds.max[2]] as const;
  const corners: Point3[] = [];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) corners.push([x, y, z]);
    }
  }
  return corners;
}

function subtract(a: Point3, b: Point3): Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Point3, b: Point3): Point3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * 让包围盒 8 个角点都落进视锥的最小相机距离（含小幅留白）。
 * `direction` 是 target→camera 的单位向量，`up` 是相机 up；按透视投影逐角解不等式，
 * 因此宽扁的模型不会被球半径过度推远。
 */
export function framingDistance(bounds: Bounds, aspect: number, fovDeg: number, direction: Point3, up: Point3): number {
  if (!(aspect > 0)) throw new Error(`相机宽高比必须为正：收到 ${String(aspect)}`);
  const back = normalize(direction);
  if (back[0] === 0 && back[1] === 0 && back[2] === 0) throw new Error('取景方向不能为零向量');
  const forward: Point3 = [-back[0], -back[1], -back[2]];
  const right = normalize(cross(forward, up));
  const camUp = cross(right, forward);
  const tanVertical = Math.tan((fovDeg * Math.PI) / 360);
  const tanHorizontal = tanVertical * aspect;
  const center = centerOf(bounds);
  let needed = 0;
  for (const corner of cornersOf(bounds)) {
    const offset = subtract(corner, center);
    const along = dot(offset, back);
    const x = Math.abs(dot(offset, right));
    const y = Math.abs(dot(offset, camUp));
    const distance = Math.max(x / tanHorizontal, y / tanVertical) + along;
    if (distance > needed) needed = distance;
  }
  // 退化包围盒（所有角点重合）会得到 0 距离；给一个最小正距离，避免相机落在目标点上。
  return Math.max(needed, 1) * FRAMING_MARGIN;
}

/** 整体视角：从东南上方斜看包围盒中心，按视锥装下整个可见包围盒。 */
export function overallPose(bounds: Bounds, aspect: number): ViewPose {
  const direction = normalize([1, 0.9, 1]);
  const distance = framingDistance(bounds, aspect, VIEW_FOV_DEG, direction, [0, 1, 0]);
  const center = centerOf(bounds);
  return {
    position: [
      center[0] + direction[0] * distance,
      center[1] + direction[1] * distance,
      center[2] + direction[2] * distance,
    ],
    target: center,
    up: [0, 1, 0],
  };
}

/** 俯视：相机在中心正上方垂直向下看，屏幕上 -z（南）在上方，同样按视锥装下。 */
export function topPose(bounds: Bounds, aspect: number): ViewPose {
  const center = centerOf(bounds);
  const distance = framingDistance(bounds, aspect, VIEW_FOV_DEG, [0, 1, 0], [0, 0, -1]);
  return {
    position: [center[0], center[1] + distance, center[2]],
    target: center,
    up: [0, 0, -1],
  };
}

/**
 * 侧视：相机在 +z 方向、略高于中心，沿 -z 看向包围盒中心（俯仰近似 0），同样按视锥装下。
 * 屏幕右侧为 +x（东西）、上方为 +y（标高），适合看凹曲屋面与檐口 / 起翘的侧向轮廓。
 */
export function sidePose(bounds: Bounds, aspect: number): ViewPose {
  const direction = normalize([0, SIDE_ELEVATION, 1]);
  const distance = framingDistance(bounds, aspect, VIEW_FOV_DEG, direction, [0, 1, 0]);
  const center = centerOf(bounds);
  return {
    position: [
      center[0] + direction[0] * distance,
      center[1] + direction[1] * distance,
      center[2] + direction[2] * distance,
    ],
    target: center,
    up: [0, 1, 0],
  };
}

/** 把位姿写到相机与 orbit 控制器，并同步投影矩阵。 */
export function applyPose(camera: THREE.PerspectiveCamera, orbit: OrbitLike, pose: ViewPose): void {
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  camera.up.set(pose.up[0], pose.up[1], pose.up[2]);
  camera.lookAt(new THREE.Vector3(pose.target[0], pose.target[1], pose.target[2]));
  camera.updateProjectionMatrix();
  orbit.target.set(pose.target[0], pose.target[1], pose.target[2]);
  orbit.update();
}

/** 容器尺寸变化时更新渲染器与相机宽高比；非正尺寸是调用方缺陷，直接报错。 */
export function resizeView(
  renderer: ResizableRenderer,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
): void {
  if (!(width > 0) || !(height > 0)) throw new Error(`视口尺寸必须为正：收到 ${String(width)}×${String(height)}`);
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function normalize(vector: readonly [number, number, number]): readonly [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length === 0) return [0, 0, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
