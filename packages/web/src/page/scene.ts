/**
 * 浏览器端：方案数据校验、three 草模几何与楼层显示纯函数（MASSING-SPEC §2、§3）。
 *
 * 负责：把 `/api/blueprints` 的 JSON 窄化成查看器读取的字段；轴对齐盒与楔体几何、
 * 楼层垂直区间与裁剪面、包围盒、修改高亮。
 * 不负责：`/api/report` 响应（page/report-parser.ts）、DOM 与渲染（page/main.ts）、相机（page/controls.ts）。
 * 数据边界：服务端已用 @pg/design 的 schema 校验；这里只做查看器用得到的响应校验，不重复完整 schema。
 */
import * as THREE from 'three';

import type { BlueprintDiff } from '@pg/design/diff';
import type { Blueprint, Bounds, Direction, Element, ElementShape, Level, Space, Vec3 } from '@pg/design/schema';

import { latheGeometry } from './lathe.ts';
import { parseLatheProfile } from './profile-parser.ts';
import { oneOf, requireArray, requireInt, requireRecord, requireString } from './report-parser.ts';

/**
 * 查看器实际读取的方案字段：是 `Blueprint` 的显式子集（`Pick<>`），不是另一份“看起来像完整方案”的类型。
 * 未列出的 revision / clearances 等不在前端解析；这里解析的每个字段都按 schema 语义校验。
 */
export type ViewerBlueprint = Pick<
  Blueprint,
  'id' | 'title' | 'description' | 'levels' | 'spaces' | 'elements' | 'notes'
>;

/** 建好的草模场景：主入口按 id 找网格做选择、可见性与高亮。 */
export interface MassingScene {
  readonly scene: THREE.Scene;
  readonly elementById: ReadonlyMap<string, THREE.Mesh>;
  readonly spaceGroup: THREE.Group;
  /** 空间范围的线框，显式持有以便剖切 / 释放（`Group.children` 上的 instanceof 收窄会丢类型）。 */
  readonly spaceLines: readonly THREE.LineSegments[];
  /** 空间体量的半透明盒（可点击），按 space.id 索引。 */
  readonly spaceById: ReadonlyMap<string, THREE.Mesh>;
}

/** 楼层 / 地表 / 空间范围的可见性选项。 */
export interface VisibilityOptions {
  /** `all` 或某个楼层 id（surface / b1 / b2 / b3）。 */
  readonly level: string;
  /** 是否显示地表实体；默认隐藏，切到 surface 楼层时强制显示。 */
  readonly showSurface: boolean;
}

/** 剖切轴：none 表示不剖切。 */
export type ClipAxis = 'none' | 'x' | 'y' | 'z';

/** 楼层垂直区间 `[floor, top)`：floor 为本层楼面标高，top 为上一层标高（最高层到 maxY）。 */
export interface LevelRange {
  readonly floor: number;
  readonly top: number;
}

/** 楼层选择解析出的显示范围与楼板规则；`all` + 显示地表时为无界（不裁剪）。 */
export interface LevelDisplay {
  readonly range: LevelRange;
  /** 本层楼板顶面标高：该楼板即使在 range 之下也保留，用于看平面；非具体楼层为 null。 */
  readonly planFloor: number | null;
  /** 是否隐藏“顶面正好在 range.top”的楼板（属于上一层）。 */
  readonly excludeTopSlab: boolean;
  /** 是否属于地表视图（选 surface 楼层，或 `all` 且显示地表）；false 时隐藏 level=surface 的空间盒。 */
  readonly includeSurface: boolean;
}

const ELEMENT_KINDS = ['wall', 'slab', 'stair', 'furnishing', 'glazing', 'landscape', 'marker'] as const;
const ELEMENT_SHAPES = ['box', 'wedge-x', 'wedge-z', 'lathe'] as const;
const SPACE_ROLES = ['room', 'circulation', 'void'] as const;

type Point3 = readonly [number, number, number];

// ---------------------------------------------------------------------------
// 蓝图窄化（unknown → ViewerBlueprint）；通用 require* / oneOf 见 report-parser.ts
// ---------------------------------------------------------------------------

/** 色值：与 @pg/design schema 同口径的 6 位十六进制。 */
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function requireColor(value: unknown, path: string): string {
  const color = requireString(value, path);
  if (!COLOR_PATTERN.test(color)) throw new Error(`${path} 必须是 #rrggbb（6 位十六进制）`);
  return color;
}

/** 坐标为整数（schema 的 `z.int()`），不接受浮点或非有限数。 */
function requireVec3(value: unknown, path: string): Vec3 {
  const items = requireArray(value, path);
  if (items.length !== 3) throw new Error(`${path} 必须是长度 3 的坐标`);
  return [requireInt(items[0], `${path}[0]`), requireInt(items[1], `${path}[1]`), requireInt(items[2], `${path}[2]`)];
}

function requireBounds(value: unknown, path: string): Bounds {
  const record = requireRecord(value, path);
  const min = requireVec3(record['min'], `${path}.min`);
  const max = requireVec3(record['max'], `${path}.max`);
  if (max[0] <= min[0] || max[1] <= min[1] || max[2] <= min[2]) {
    throw new Error(`${path} 每轴必须 max 严格大于 min`);
  }
  return { min, max };
}

function requireDirection(value: unknown, path: string): Direction {
  if (value === 1 || value === -1) return value;
  throw new Error(`${path} 必须是 1 或 -1`);
}

function parseLevel(value: unknown, path: string): Level {
  const record = requireRecord(value, path);
  return {
    id: requireString(record['id'], `${path}.id`),
    name: requireString(record['name'], `${path}.name`),
    elevation: requireInt(record['elevation'], `${path}.elevation`),
  };
}

function parseSpace(value: unknown, path: string): Space {
  const record = requireRecord(value, path);
  return {
    id: requireString(record['id'], `${path}.id`),
    name: requireString(record['name'], `${path}.name`),
    level: requireString(record['level'], `${path}.level`),
    bounds: requireBounds(record['bounds'], `${path}.bounds`),
    role: oneOf(record['role'], SPACE_ROLES, `${path}.role`),
    color: requireColor(record['color'], `${path}.color`),
  };
}

function parseElement(value: unknown, path: string): Element {
  const record = requireRecord(value, path);
  const shape = oneOf(record['shape'], ELEMENT_SHAPES, `${path}.shape`);
  const base: Element = {
    id: requireString(record['id'], `${path}.id`),
    name: requireString(record['name'], `${path}.name`),
    level: requireString(record['level'], `${path}.level`),
    kind: oneOf(record['kind'], ELEMENT_KINDS, `${path}.kind`),
    bounds: requireBounds(record['bounds'], `${path}.bounds`),
    color: requireColor(record['color'], `${path}.color`),
    shape,
    direction: requireDirection(record['direction'], `${path}.direction`),
  };
  const withSpace =
    record['spaceId'] === undefined ? base : { ...base, spaceId: requireString(record['spaceId'], `${path}.spaceId`) };
  // 只有 lathe 带 profile；未知 shape 已被 oneOf 拒绝，不会静默回退到 box/wedge。
  if (shape !== 'lathe') return withSpace;
  return { ...withSpace, profile: parseLatheProfile(record['profile'], `${path}.profile`) };
}

/** 解析单个 Blueprint；缺字段或非法取值时抛出可读中文错误。 */
export function parseBlueprint(value: unknown): ViewerBlueprint {
  const record = requireRecord(value, '蓝图');
  return {
    id: requireString(record['id'], '蓝图.id'),
    title: requireString(record['title'], '蓝图.title'),
    description: requireString(record['description'], '蓝图.description'),
    levels: requireArray(record['levels'], '蓝图.levels').map((item, index) =>
      parseLevel(item, `蓝图.levels[${String(index)}]`),
    ),
    spaces: requireArray(record['spaces'], '蓝图.spaces').map((item, index) =>
      parseSpace(item, `蓝图.spaces[${String(index)}]`),
    ),
    elements: requireArray(record['elements'], '蓝图.elements').map((item, index) =>
      parseElement(item, `蓝图.elements[${String(index)}]`),
    ),
    notes: requireArray(record['notes'], '蓝图.notes').map((item, index) =>
      requireString(item, `蓝图.notes[${String(index)}]`),
    ),
  };
}

/** 解析 Blueprint 数组（`/api/blueprints`）。 */
export function parseBlueprints(value: unknown): readonly ViewerBlueprint[] {
  return requireArray(value, '蓝图列表').map((item) => parseBlueprint(item));
}

// ---------------------------------------------------------------------------
// 几何与可见性纯函数
// ---------------------------------------------------------------------------

function centerOf(bounds: Bounds): Point3 {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

/** 元素三个轴的长度（整数差）。 */
export function elementSize(element: Element): Vec3 {
  return [
    element.bounds.max[0] - element.bounds.min[0],
    element.bounds.max[1] - element.bounds.min[1],
    element.bounds.max[2] - element.bounds.min[2],
  ];
}

/** 一组包围盒的并集；空数组回退到 1×1×1（避免 0 尺寸导致相机取景退化）。 */
function unionBounds(boxes: readonly Bounds[]): Bounds {
  const first = boxes[0];
  if (first === undefined) return { min: [0, 0, 0], max: [1, 1, 1] };
  const min: [number, number, number] = [first.min[0], first.min[1], first.min[2]];
  const max: [number, number, number] = [first.max[0], first.max[1], first.max[2]];
  for (const box of boxes) {
    if (box.min[0] < min[0]) min[0] = box.min[0];
    if (box.min[1] < min[1]) min[1] = box.min[1];
    if (box.min[2] < min[2]) min[2] = box.min[2];
    if (box.max[0] > max[0]) max[0] = box.max[0];
    if (box.max[1] > max[1]) max[1] = box.max[1];
    if (box.max[2] > max[2]) max[2] = box.max[2];
  }
  return { min, max };
}

/** 整份方案（元素 + 空间）的并集包围盒；空方案回退到 1×1×1。 */
export function blueprintBounds(blueprint: ViewerBlueprint): Bounds {
  return unionBounds([
    ...blueprint.elements.map((element) => element.bounds),
    ...blueprint.spaces.map((space) => space.bounds),
  ]);
}

function highestElevation(levels: readonly Level[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const level of levels) {
    if (level.elevation > max) max = level.elevation;
  }
  return max === Number.NEGATIVE_INFINITY ? 0 : max;
}

/**
 * 把楼层选择解析成垂直区间：具体楼层为 `[floor, 上一层标高)`（最高层到 maxY，楼板顶面 = floor）；
 * `all` + 显示地表无界；`all` + 隐藏地表只留地表标高以下（保留地下入口梯，但不含地表顶盖）。
 */
export function levelDisplay(levels: readonly Level[], options: VisibilityOptions, maxY: number): LevelDisplay {
  if (options.level === 'all') {
    if (options.showSurface) {
      return {
        range: { floor: Number.NEGATIVE_INFINITY, top: Number.POSITIVE_INFINITY },
        planFloor: null,
        excludeTopSlab: false,
        includeSurface: true,
      };
    }
    const surface = levels.find((level) => level.id === 'surface');
    const threshold = surface === undefined ? highestElevation(levels) : surface.elevation;
    return {
      range: { floor: Number.NEGATIVE_INFINITY, top: threshold },
      planFloor: null,
      excludeTopSlab: true,
      includeSurface: false,
    };
  }
  const level = levels.find((entry) => entry.id === options.level);
  if (level === undefined)
    throw new Error(`未知楼层：${options.level}；可用 ${levels.map((entry) => entry.id).join('、')}`);
  const above = levels
    .map((entry) => entry.elevation)
    .filter((elevation) => elevation > level.elevation)
    .sort((a, b) => a - b)[0];
  const floor = level.elevation;
  const top = above ?? Math.max(maxY, floor + 1);
  return {
    range: { floor, top: top > floor ? top : floor + 1 },
    planFloor: floor,
    excludeTopSlab: true,
    includeSurface: level.id === 'surface',
  };
}

/** 楼板类（水平板）：`slab` 或地表景观 `landscape`，用于“保留本层楼板 / 排除上层楼板”。 */
function isFloorPlate(element: Element): boolean {
  return element.shape === 'box' && (element.kind === 'slab' || element.kind === 'landscape');
}

/** 元素是否属于当前显示：与区间重叠，或它是本层楼板（顶面 = planFloor）。 */
export function elementInLevelRange(element: Element, display: LevelDisplay): boolean {
  const { floor, top } = display.range;
  if (element.bounds.max[1] > floor && element.bounds.min[1] < top) {
    // 顶面正好在本层区间顶端的水平板属于上一层，交给上一层显示，避免“上一层楼板挡住本层”。
    if (display.excludeTopSlab && isFloorPlate(element) && element.bounds.max[1] === top) return false;
    return true;
  }
  return display.planFloor !== null && isFloorPlate(element) && element.bounds.max[1] === display.planFloor;
}

/** 空间盒是否属于当前显示：不在地表视图时隐藏 level=surface 的空间；否则按区间重叠（含顶面=planFloor）。 */
export function spaceInLevelRange(space: Space, display: LevelDisplay): boolean {
  if (!display.includeSurface && space.level === 'surface') return false;
  const { floor, top } = display.range;
  if (space.bounds.max[1] > floor && space.bounds.min[1] < top) return true;
  return display.planFloor !== null && space.bounds.max[1] === display.planFloor;
}

function keepAbovePlane(y: number): THREE.Plane {
  // normal·p + constant >= 0 ⇒ y >= y0
  return new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
}

function keepBelowPlane(y: number): THREE.Plane {
  // normal·p + constant >= 0 ⇒ y <= y0
  return new THREE.Plane(new THREE.Vector3(0, -1, 0), y);
}

function rangePlanes(range: LevelRange): THREE.Plane[] {
  const planes: THREE.Plane[] = [];
  if (Number.isFinite(range.floor)) planes.push(keepAbovePlane(range.floor));
  if (Number.isFinite(range.top)) planes.push(keepBelowPlane(range.top));
  return planes;
}

/** 显示范围的裁剪面（不含楼板豁免），用于空间框与射线过滤；无界方向不产生平面。 */
export function displayPlanes(display: LevelDisplay): readonly THREE.Plane[] {
  return rangePlanes(display.range);
}

/** 单个元素的裁剪面：本层楼板（顶面 = planFloor）不加下边界；其余按区间上下裁剪，b1 只留挑高墙的 b1 段。 */
export function elementLevelPlanes(element: Element, display: LevelDisplay): readonly THREE.Plane[] {
  const planes: THREE.Plane[] = [];
  const planPlate = isFloorPlate(element) && display.planFloor !== null && element.bounds.max[1] === display.planFloor;
  if (Number.isFinite(display.range.floor) && !planPlate) planes.push(keepAbovePlane(display.range.floor));
  if (Number.isFinite(display.range.top)) planes.push(keepBelowPlane(display.range.top));
  return planes;
}

function clampToRange(bounds: Bounds, range: LevelRange): Bounds {
  const minY = Number.isFinite(range.floor) ? Math.max(bounds.min[1], range.floor) : bounds.min[1];
  const maxY = Number.isFinite(range.top) ? Math.min(bounds.max[1], range.top) : bounds.max[1];
  if (maxY <= minY) return bounds;
  return { min: [bounds.min[0], minY, bounds.min[2]], max: [bounds.max[0], maxY, bounds.max[2]] };
}

/** 当前显示内容（过滤 / 裁剪后的元素 + 开启时的空间范围）的包围盒；全空回退整份方案。 */
export function visibleBounds(blueprint: ViewerBlueprint, display: LevelDisplay, includeSpaces: boolean): Bounds {
  const boxes: Bounds[] = [];
  for (const element of blueprint.elements) {
    if (!elementInLevelRange(element, display)) continue;
    const planPlate =
      isFloorPlate(element) && display.planFloor !== null && element.bounds.max[1] === display.planFloor;
    boxes.push(planPlate ? element.bounds : clampToRange(element.bounds, display.range));
  }
  if (includeSpaces) {
    for (const space of blueprint.spaces) {
      if (spaceInLevelRange(space, display)) boxes.push(clampToRange(space.bounds, display.range));
    }
  }
  return boxes.length === 0 ? blueprintBounds(blueprint) : unionBounds(boxes);
}

/**
 * 命中里挑第一个可选项：跳过隐藏网格，以及落在该网格材质实际剖切面外侧的点。
 * 每个对象用各自的 `clippingPlanes`（本层楼板豁免下边界、叠加用户轴向），与渲染完全一致；
 * 保留 `distanceToPoint >= 0` 的一侧。
 */
export function firstSelectable(
  intersections: readonly THREE.Intersection[],
  isVisible: (object: THREE.Object3D) => boolean,
  planesFor: (object: THREE.Object3D) => readonly THREE.Plane[],
): THREE.Intersection | null {
  for (const hit of intersections) {
    if (!isVisible(hit.object)) continue;
    if (planesFor(hit.object).some((plane) => plane.distanceToPoint(hit.point) < 0)) continue;
    return hit;
  }
  return null;
}

/** 剖切轴对应的取值区间，用于滑杆 min/max；none 返回占位 [0, 1] 并由调用方禁用。 */
export function clipValueRange(bounds: Bounds, axis: ClipAxis): readonly [number, number] {
  if (axis === 'none') return [0, 1];
  if (axis === 'x') return [bounds.min[0], bounds.max[0]];
  if (axis === 'y') return [bounds.min[1], bounds.max[1]];
  return [bounds.min[2], bounds.max[2]];
}

/**
 * 构造 three 剖切面：保留坐标 ≤ value 的一侧（丢弃另一侧）。
 * 平面方程为 normal·p + constant = 0，法线取负轴方向，constant = value。
 */
export function clipPlaneFor(axis: ClipAxis, value: number): THREE.Plane | null {
  if (axis === 'none') return null;
  const normal =
    axis === 'x'
      ? new THREE.Vector3(-1, 0, 0)
      : axis === 'y'
        ? new THREE.Vector3(0, -1, 0)
        : new THREE.Vector3(0, 0, -1);
  return new THREE.Plane(normal, value);
}

/** 需要高亮的元素 id 集合（启用时 = 修改 ∪ 新增）。关闭时为空集。 */
export function highlightedIds(diff: BlueprintDiff, enabled: boolean): ReadonlySet<string> {
  if (!enabled) return new Set<string>();
  return new Set<string>([...diff.changed, ...diff.added]);
}

/**
 * 楔体的 6 个世界坐标顶点：轴对齐盒内一个直角三角形截面沿第三轴拉伸。
 * direction=1 表示高端在正方向（wedge-x 的 +x / wedge-z 的 +z），−1 反之。
 * 顺序：[cap0 三点, cap1 三点]，cap 在拉伸轴的 min / max 端。
 */
export function wedgeVertices(bounds: Bounds, shape: ElementShape, direction: Direction): readonly Point3[] {
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  const highFirst = direction === 1;
  if (shape === 'wedge-z') {
    const a: Point3 = highFirst ? [x0, y0, z0] : [x0, y0, z1];
    const b: Point3 = highFirst ? [x0, y0, z1] : [x0, y0, z0];
    const c: Point3 = highFirst ? [x0, y1, z1] : [x0, y1, z0];
    return [a, b, c, [x1, a[1], a[2]], [x1, b[1], b[2]], [x1, c[1], c[2]]];
  }
  const a: Point3 = highFirst ? [x0, y0, z0] : [x1, y0, z0];
  const b: Point3 = highFirst ? [x1, y0, z0] : [x0, y0, z0];
  const c: Point3 = highFirst ? [x1, y1, z0] : [x0, y1, z0];
  return [a, b, c, [a[0], a[1], z1], [b[0], b[1], z1], [c[0], c[1], z1]];
}

/** 按元素形体生成几何：box 用轴对齐盒，lathe 用旋转薄壳，楔体用手写三角棱柱（无精确曲面）。 */
export function elementGeometry(element: Element): THREE.BufferGeometry {
  switch (element.shape) {
    case 'box': {
      const size = elementSize(element);
      const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
      const center = centerOf(element.bounds);
      geometry.translate(center[0], center[1], center[2]);
      return geometry;
    }
    case 'lathe':
      return latheGeometry(element);
    case 'wedge-x':
    case 'wedge-z': {
      const vertices = wedgeVertices(element.bounds, element.shape, element.direction);
      const positions = new Float32Array(vertices.length * 3);
      vertices.forEach((vertex, index) => {
        positions[index * 3] = vertex[0];
        positions[index * 3 + 1] = vertex[1];
        positions[index * 3 + 2] = vertex[2];
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex([0, 1, 2, 3, 4, 5, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 3, 2, 3, 0]);
      geometry.computeVertexNormals();
      return geometry;
    }
  }
}

/** 为一个元素建 Mesh；玻璃半透明，其余不透明。mesh.name 记 elementId 供射线选择。 */
export function createElementMesh(element: Element): THREE.Mesh {
  const material = new THREE.MeshLambertMaterial({
    color: new THREE.Color(element.color),
    side: THREE.DoubleSide,
    transparent: element.kind === 'glazing',
    opacity: element.kind === 'glazing' ? 0.4 : 1,
  });
  const mesh = new THREE.Mesh(elementGeometry(element), material);
  mesh.name = element.id;
  return mesh;
}

/** 高亮色（橙）：用于“修改高亮”开关。 */
export const HIGHLIGHT_COLOR = 0xff7a1a;

function setMaterialPlanes(material: THREE.Material | THREE.Material[], planes: readonly THREE.Plane[]): void {
  for (const entry of materialsOf(material)) entry.clippingPlanes = [...planes];
}

/**
 * 把楼层显示套到场景：按显示范围过滤元素与空间框，并设置各自剖切面。
 * 元素用 `elementLevelPlanes`（本层楼板豁免下边界），空间框用整段 `displayPlanes`；
 * 两者都再叠加用户轴向剖切面，因此楼层剖层与手动剖切可以同时生效。
 */
export function applyLevelDisplay(
  massing: MassingScene,
  blueprint: ViewerBlueprint,
  display: LevelDisplay,
  axisPlane: THREE.Plane | null,
): void {
  const axis = axisPlane === null ? [] : [axisPlane];
  for (const element of blueprint.elements) {
    const mesh = massing.elementById.get(element.id);
    if (mesh === undefined) continue;
    const visible = elementInLevelRange(element, display);
    mesh.visible = visible;
    if (visible) setMaterialPlanes(mesh.material, [...elementLevelPlanes(element, display), ...axis]);
  }
  const spacePlanes = [...displayPlanes(display), ...axis];
  blueprint.spaces.forEach((space, index) => {
    const visible = spaceInLevelRange(space, display);
    const lines = massing.spaceLines[index];
    if (lines !== undefined) {
      lines.visible = visible;
      setMaterialPlanes(lines.material, spacePlanes);
    }
    const solid = massing.spaceById.get(space.id);
    if (solid !== undefined) {
      solid.visible = visible;
      setMaterialPlanes(solid.material, spacePlanes);
    }
  });
}

/** 按 id 集合切换元素自发光：命中高亮色，其余恢复黑色。 */
export function setHighlighted(massing: MassingScene, ids: ReadonlySet<string>): void {
  for (const [id, mesh] of massing.elementById) {
    for (const material of materialsOf(mesh.material)) {
      if (material instanceof THREE.MeshLambertMaterial)
        material.emissive.setHex(ids.has(id) ? HIGHLIGHT_COLOR : 0x000000);
    }
  }
}

function materialsOf(material: THREE.Material | THREE.Material[]): readonly THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function addLights(scene: THREE.Scene): void {
  scene.add(new THREE.AmbientLight(0xffffff, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(1, 2, 1);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-1, 1, -1);
  scene.add(fill);
}

function spaceSize(space: Space): readonly [number, number, number] {
  return [
    space.bounds.max[0] - space.bounds.min[0],
    space.bounds.max[1] - space.bounds.min[1],
    space.bounds.max[2] - space.bounds.min[2],
  ];
}

function placeAtCenter(object: THREE.Object3D, space: Space): void {
  const center = centerOf(space.bounds);
  object.position.set(center[0], center[1], center[2]);
}

/** 空间体量：轻质半透明盒（可点击），用 space.color 按功能区分。 */
function spaceSolid(space: Space): THREE.Mesh {
  const size = spaceSize(space);
  const material = new THREE.MeshLambertMaterial({
    color: new THREE.Color(space.color),
    transparent: true,
    opacity: space.role === 'void' ? 0.1 : 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  placeAtCenter(mesh, space);
  mesh.name = space.id;
  return mesh;
}

/** 空间轮廓：只画盒子的 12 条边，表达范围而不是实体墙。 */
function spaceOutline(space: Space): THREE.LineSegments {
  const size = spaceSize(space);
  const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(size[0], size[1], size[2]));
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(space.color),
    transparent: true,
    opacity: 0.85,
  });
  const lines = new THREE.LineSegments(geometry, material);
  placeAtCenter(lines, space);
  return lines;
}

/** 从 ViewerBlueprint 建完整草模场景：灯光、体量网格、默认显示的空间体量与轮廓。 */
export function buildMassingScene(blueprint: ViewerBlueprint): MassingScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe5ec);
  addLights(scene);

  const spaceGroup = new THREE.Group();
  const spaceLines: THREE.LineSegments[] = [];
  const spaceById = new Map<string, THREE.Mesh>();
  for (const space of blueprint.spaces) {
    const solid = spaceSolid(space);
    const outline = spaceOutline(space);
    spaceById.set(space.id, solid);
    spaceLines.push(outline);
    spaceGroup.add(solid);
    spaceGroup.add(outline);
  }
  scene.add(spaceGroup);

  const elementById = new Map<string, THREE.Mesh>();
  for (const element of blueprint.elements) {
    const mesh = createElementMesh(element);
    elementById.set(element.id, mesh);
    scene.add(mesh);
  }
  return { scene, elementById, spaceGroup, spaceLines, spaceById };
}
