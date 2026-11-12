/**
 * 视角 → 正交相机参数与取景（RENDER-SPEC §5）。
 *
 * 负责：9 个固定视角的相机位置 / 朝向 / 正交半宽高、pixelsPerCell、可见包围盒的像素框与 frameFill。
 * 不负责：three 相机对象（page/main.ts 照抄这里的数值）、渲染。
 * 纯函数：同输入同输出，不依赖时间或随机数（STANDARDS §5）。
 *
 * 新增的两个诊断视角（Phase 3C）：
 * - `interior`：相机在室内站立高度，沿主空间长轴横看，用来检查家具与净空。
 * - `cutaway`：东南斜上的剖视，水平面切掉屋面上部、并切掉南 / 东近侧墙，让室内可见。
 *   裁剪面随相机参数传给页面（`CameraSpec.clippingPlanes`），由 page/main.ts 照抄给 three。
 */

export const VIEW_NAMES = ['south', 'east', 'north', 'west', 'top', 'iso-se', 'iso-nw', 'interior', 'cutaway'] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

/** 世界坐标裁剪面：normal·p + constant ≥ 0 的一侧保留（three.Plane 同口径）。 */
export interface ClipPlane {
  readonly normal: readonly [number, number, number];
  readonly constant: number;
}

/** 可见包围盒，闭区间格坐标（RENDER-SPEC §5.1）。 */
export interface BBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface CameraSpec {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly near: number;
  readonly far: number;
  /** 诊断视角的全局裁剪面；缺省不裁剪，页面按顺序设给 three。 */
  readonly clippingPlanes?: readonly ClipPlane[];
}

export interface ViewFrame {
  readonly camera: CameraSpec;
  readonly pixelsPerCell: number;
  /** 8 角投影后的像素框（原点左上，x 右、y 下）。 */
  readonly bbox: readonly [number, number, number, number];
  readonly frameFill: number;
}

type Vec = readonly [number, number, number];

function add(a: Vec, b: Vec): Vec {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec, s: number): Vec {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: Vec, b: Vec): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Vec): Vec {
  const len = Math.hypot(a[0], a[1], a[2]);
  return len === 0 ? [0, 0, 0] : scale(a, 1 / len);
}

const DEG = Math.PI / 180;

/** 视线方向 d 与画面上方 up（RENDER-SPEC §5.2）。 */
function viewBasis(view: ViewName): { d: Vec; up: Vec } {
  switch (view) {
    case 'south':
      return { d: [0, 0, 1], up: [0, 1, 0] };
    case 'east':
      return { d: [1, 0, 0], up: [0, 1, 0] };
    case 'north':
      return { d: [0, 0, -1], up: [0, 1, 0] };
    case 'west':
      return { d: [-1, 0, 0], up: [0, 1, 0] };
    case 'top':
      return { d: [0, 1, 0], up: [0, 0, -1] };
    case 'iso-se': {
      const ce = Math.cos(30 * DEG);
      const se = Math.sin(30 * DEG);
      return { d: [ce * Math.SQRT1_2, se, ce * Math.SQRT1_2], up: [0, 1, 0] };
    }
    case 'iso-nw': {
      const ce = Math.cos(30 * DEG);
      const se = Math.sin(30 * DEG);
      return { d: [-ce * Math.SQRT1_2, se, -ce * Math.SQRT1_2], up: [0, 1, 0] };
    }
    case 'interior':
      // 实际机位在 interiorFrame 里按长轴算；这里只提供默认值。
      return { d: [1, 0, 0], up: [0, 1, 0] };
    case 'cutaway':
      // 与 iso-se 同一方位，靠 clippingPlanes 去掉屋面与近侧墙。
      return {
        d: [Math.cos(30 * DEG) * Math.SQRT1_2, Math.sin(30 * DEG), Math.cos(30 * DEG) * Math.SQRT1_2],
        up: [0, 1, 0],
      };
  }
}

function isAligned(view: ViewName): boolean {
  return view === 'south' || view === 'east' || view === 'north' || view === 'west' || view === 'top';
}

/** 8 个角（B 的半开区间端点）。 */
function corners(lo: Vec, hi: Vec): readonly Vec[] {
  const out: Vec[] = [];
  for (const x of [lo[0], hi[0]]) {
    for (const y of [lo[1], hi[1]]) {
      for (const z of [lo[2], hi[2]]) out.push([x, y, z]);
    }
  }
  return out;
}

const INTERIOR_EYE_HEIGHT = 1.6;
const INTERIOR_MIN_HALF_HEIGHT = 1.6;
const INTERIOR_MAX_HALF_HEIGHT = 2.5;
const FRAME_MARGIN = 1.05;
/** 剖视保留的高度（从最低可见格算起）：够看一层家具，又切掉典型屋面。 */
const CUTAWAY_KEEP_HEIGHT = 4;
const CUTAWAY_MIN_HEIGHT = 2;

/** 通用外部视角取景（RENDER-SPEC §5.3）。 */
function framed(view: ViewName, lo: Vec, hi: Vec, width: number, height: number): ViewFrame {
  const size: Vec = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const c: Vec = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const R = Math.hypot(size[0], size[1], size[2]);
  const { d, up } = viewBasis(view);

  // 相机坐标基：zAxis 指向相机（= d），xAxis 屏幕向右，yAxis 屏幕向上。
  const zAxis = normalize(d);
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);

  const cs = corners(lo, hi);
  let maxU = -Infinity;
  let minU = Infinity;
  let maxV = -Infinity;
  let minV = Infinity;
  for (const p of cs) {
    const rel = add(p, scale(c, -1));
    const u = dot(rel, xAxis);
    const v = dot(rel, yAxis);
    if (u > maxU) maxU = u;
    if (u < minU) minU = u;
    if (v > maxV) maxV = v;
    if (v < minV) minV = v;
  }
  const U = Math.max(Math.abs(maxU), Math.abs(minU));
  const V = Math.max(Math.abs(maxV), Math.abs(minV));

  let h = Math.max(V, (U * height) / width) * 1.1;
  let target: Vec = c;
  let p = height / (2 * h);

  if (isAligned(view)) {
    const a = maxU - minU;
    const b = maxV - minV;
    if (a > 0 && b > 0) {
      const pInt = Math.floor(Math.min(width / a, height / b) * 0.92);
      if (pInt >= 2) {
        h = height / (2 * pInt);
        p = pInt;
        const cx = dot(c, xAxis);
        const cy = dot(c, yAxis);
        const cx2 = (Math.round(cx * pInt - width / 2) + width / 2) / pInt;
        const cy2 = (Math.round(cy * pInt - height / 2) + height / 2) / pInt;
        target = add(c, add(scale(xAxis, cx2 - cx), scale(yAxis, cy2 - cy)));
      }
    }
  }

  const position = add(target, scale(d, 2 * R));
  const camera: CameraSpec = {
    position,
    target,
    up,
    left: (-h * width) / height,
    right: (h * width) / height,
    top: h,
    bottom: -h,
    near: 0.1,
    far: 4 * R,
  };

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of cs) {
    const rel = add(q, scale(target, -1));
    const u = dot(rel, xAxis);
    const v = dot(rel, yAxis);
    const px = width / 2 + u * p;
    const py = height / 2 - v * p;
    if (px < x0) x0 = px;
    if (py < y0) y0 = py;
    if (px > x1) x1 = px;
    if (py > y1) y1 = py;
  }
  const bx0 = Math.floor(x0);
  const by0 = Math.floor(y0);
  const bx1 = Math.ceil(x1);
  const by1 = Math.ceil(y1);
  return {
    camera,
    pixelsPerCell: p,
    bbox: [bx0, by0, bx1, by1],
    frameFill: ((bx1 - bx0) * (by1 - by0)) / (width * height),
  };
}

/** 室内人眼视角：站在长轴一端、眼高 1.6，水平望向主空间中心。 */
function interiorFrame(lo: Vec, hi: Vec, width: number, height: number): ViewFrame {
  const size: Vec = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const c: Vec = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const alongX = size[0] >= size[2];
  const length = alongX ? size[0] : size[2];
  const across = alongX ? size[2] : size[0];
  const inset = Math.min(1, length / 4);
  const eyeY = Math.max(lo[1] + 0.1, Math.min(lo[1] + INTERIOR_EYE_HEIGHT, hi[1] - 0.1));
  const target: Vec = [c[0], eyeY, c[2]];
  const position: Vec = alongX ? [lo[0] + inset, eyeY, c[2]] : [c[0], eyeY, lo[2] + inset];

  const zAxis = normalize([position[0] - target[0], 0, position[2] - target[2]]);
  const up: Vec = [0, 1, 0];
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);

  // 垂直方向固定看约 5 格高（地面到眼高 1.6 一定包含），水平方向按房间横向跨度适配画幅。
  const h = Math.max(
    Math.max(INTERIOR_MIN_HALF_HEIGHT, Math.min(INTERIOR_MAX_HALF_HEIGHT, size[1] / 2)) * FRAME_MARGIN,
    (across * height * FRAME_MARGIN) / (2 * width),
  );
  const p = height / (2 * h);
  const R = Math.hypot(size[0], size[1], size[2]);
  const camera: CameraSpec = {
    position,
    target,
    up,
    left: (-h * width) / height,
    right: (h * width) / height,
    top: h,
    bottom: -h,
    near: 0.1,
    far: 4 * R,
  };

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of corners(lo, hi)) {
    const rel = add(q, scale(target, -1));
    const u = dot(rel, xAxis);
    const v = dot(rel, yAxis);
    const px = width / 2 + u * p;
    const py = height / 2 - v * p;
    if (px < x0) x0 = px;
    if (py < y0) y0 = py;
    if (px > x1) x1 = px;
    if (py > y1) y1 = py;
  }
  const bx0 = Math.max(0, Math.floor(x0));
  const by0 = Math.max(0, Math.floor(y0));
  const bx1 = Math.min(width, Math.ceil(x1));
  const by1 = Math.min(height, Math.ceil(y1));
  return {
    camera,
    pixelsPerCell: p,
    bbox: [bx0, by0, bx1, by1],
    frameFill: ((bx1 - bx0) * (by1 - by0)) / (width * height),
  };
}

/** 剖视高度：保留最低可见面以上最多 4 格，至少 2 格，且不超过包围盒顶。 */
function cutawayHeight(lo: Vec, hi: Vec): number {
  const height = hi[1] - lo[1];
  return Math.min(hi[1], lo[1] + Math.max(CUTAWAY_MIN_HEIGHT, Math.min(CUTAWAY_KEEP_HEIGHT, height - 1)));
}

/** 算一个视角的相机与取景（RENDER-SPEC §5.3）。 */
export function viewFrame(view: ViewName, bbox: BBox, width: number, height: number): ViewFrame {
  const lo: Vec = [bbox.min[0], bbox.min[1], bbox.min[2]];
  const hi: Vec = [bbox.max[0] + 1, bbox.max[1] + 1, bbox.max[2] + 1];

  if (view === 'interior') return interiorFrame(lo, hi, width, height);
  if (view === 'cutaway') {
    const cutY = cutawayHeight(lo, hi);
    // 取景用被裁剪后的可见体积：水平面以上不再算入画幅。
    const visibleHi: Vec = [hi[0], cutY, hi[2]];
    const frame = framed('cutaway', lo, visibleHi, width, height);
    const clippingPlanes: ClipPlane[] = [{ normal: [0, -1, 0], constant: cutY }];
    // 东南斜视的近侧两面墙是主要遮挡：房间够深时一并切掉，露出家具。
    if (hi[0] - lo[0] >= 3) clippingPlanes.push({ normal: [-1, 0, 0], constant: hi[0] - 1 });
    if (hi[2] - lo[2] >= 3) clippingPlanes.push({ normal: [0, 0, -1], constant: hi[2] - 1 });
    return { ...frame, camera: { ...frame.camera, clippingPlanes } };
  }
  return framed(view, lo, hi, width, height);
}
