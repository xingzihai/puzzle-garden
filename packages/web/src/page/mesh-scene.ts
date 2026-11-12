/**
 * 浏览器端：`/api/model` 响应窄化与函数草模的 three 几何纯函数（MODELING-SPEC §4）。
 *
 * 负责：把 ModelDocument 的未知 JSON 收窄成查看器读取的字段；按部件的平坦顶点 / 索引建
 * `BufferGeometry`（自行 `computeVertexNormals`）、整体包围盒、尺寸与 source 详情文案、
 * 剖切面应用与资源释放。
 * 不负责：DOM 与渲染循环（page/mesh-viewer.ts）、相机（page/controls.ts）、页面外壳（shell.ts）。
 *
 * 数据边界：服务端已用 `@pg/modeling` 的 zod schema 校验并只把数据（无函数）发给浏览器；
 * 这里只做查看器用得到的结构窄化，不重复完整 schema，也不接收任何可执行内容。
 * 变换已在建模输出时应用到世界坐标，查看器不再做局部变换。
 */
import * as THREE from 'three';

import type { Bounds, Vec3 } from '@pg/modeling/schema';

import { oneOf, requireArray, requireRecord, requireString } from './report-parser.ts';
import { clipPlaneFor, clipValueRange } from './scene.ts';
import type { ClipAxis } from './scene.ts';

export { clipPlaneFor, clipValueRange };
export type { ClipAxis };

/** 部件角色；与 `@pg/modeling/schema` 的 Role 同口径。 */
export type ModelRole = 'volume' | 'roof' | 'floor' | 'connection';
/** 建模操作；与 source 的判别字段同口径。 */
export type PartOperation = 'box' | 'revolve' | 'extrude' | 'surface';

const MODEL_ROLES: readonly ModelRole[] = ['volume', 'roof', 'floor', 'connection'];
const PART_OPERATIONS: readonly PartOperation[] = ['box', 'revolve', 'extrude', 'surface'];
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** surface 的 u/v 段数范围；与 `@pg/modeling/schema` 的 MIN_SEGMENTS / MAX_SEGMENTS 同口径。 */
const SURFACE_SEGMENT_MIN = 4;
const SURFACE_SEGMENT_MAX = 128;

/** 部件可选材质长度上限；与 `@pg/modeling/schema` 的 MATERIAL_MAX 同口径（决策 #113）。 */
const MATERIAL_MAX = 200;

/** source 已窄化成可辨识联合：operation 已知，parameters 作为只读记录原样展示。 */
export interface ViewerSource {
  readonly operation: PartOperation;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** 查看器读取的部件字段：是 Modeling Part 的显式子集，positions / indices 仍是平坦数组。 */
export interface ViewerPart {
  readonly id: string;
  readonly name: string;
  readonly role: ModelRole;
  readonly color: string;
  readonly material?: string;
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly bounds: Bounds;
  readonly source: ViewerSource;
}

/** 查看器读取的模型文档：version 1 或 2（v2 起部件可带 material），parts 顺序即建模记录顺序。 */
export interface ViewerModel {
  readonly version: 1 | 2;
  readonly parts: readonly ViewerPart[];
}

/** 建好的模型场景：入口按 id 找网格做选择与剖切。 */
export interface MeshScene {
  readonly scene: THREE.Scene;
  readonly partById: ReadonlyMap<string, THREE.Mesh>;
  readonly group: THREE.Group;
}

function requireFinite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} 必须是有限数`);
  return value;
}

function requireIndex(value: unknown, path: string): number {
  const number = requireFinite(value, path);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${path} 必须是非负整数`);
  return number;
}

function requireColor(value: unknown, path: string): string {
  const color = requireString(value, path);
  if (!COLOR_PATTERN.test(color)) throw new Error(`${path} 必须是 #rrggbb（6 位十六进制）`);
  return color;
}

/** 可选材质：非空字符串、长度 ≤ MATERIAL_MAX；只做查看器窄化，不查方块注册表。 */
function requireMaterial(value: unknown, path: string): string {
  const material = requireString(value, path);
  if (material.length === 0) throw new Error(`${path} 不能为空串`);
  if (material.length > MATERIAL_MAX) throw new Error(`${path} 长度不能超过 ${String(MATERIAL_MAX)}`);
  return material;
}

function requireVec3(value: unknown, path: string): Vec3 {
  const items = requireArray(value, path);
  if (items.length !== 3) throw new Error(`${path} 必须是长度 3 的坐标`);
  return [
    requireFinite(items[0], `${path}[0]`),
    requireFinite(items[1], `${path}[1]`),
    requireFinite(items[2], `${path}[2]`),
  ];
}

function requireBounds(value: unknown, path: string): Bounds {
  const record = requireRecord(value, path);
  const min = requireVec3(record['min'], `${path}.min`);
  const max = requireVec3(record['max'], `${path}.max`);
  for (let axis = 0; axis < 3; axis += 1) {
    const lo = min[axis];
    const hi = max[axis];
    if (lo !== undefined && hi !== undefined && !(hi >= lo)) {
      throw new Error(`${path} 每轴必须 max ≥ min，第 ${String(axis)} 轴 ${String(lo)} → ${String(hi)}`);
    }
  }
  return { min, max };
}

/** u/v 段数：4..128 的整数；非整数 / 越界给可读中文错误。 */
function requireSegmentCount(value: unknown, path: string): number {
  const number = requireIndex(value, path);
  if (number < SURFACE_SEGMENT_MIN || number > SURFACE_SEGMENT_MAX) {
    throw new Error(
      `${path} 必须是 ${String(SURFACE_SEGMENT_MIN)}..${String(SURFACE_SEGMENT_MAX)} 的整数，实际 ${String(number)}`,
    );
  }
  return number;
}

/**
 * surface 的已解析变换：与 `@pg/modeling/schema` 的 TransformDocument 同口径，
 * translate / rotate / scale 三分量齐全且为有限数（scale 正性由服务端 schema 保证，这里只做展示窄化）。
 */
function requireTransformDocument(value: unknown, path: string): void {
  const record = requireRecord(value, path);
  requireVec3(record['translate'], `${path}.translate`);
  requireVec3(record['rotate'], `${path}.rotate`);
  requireVec3(record['scale'], `${path}.scale`);
}

/**
 * surface 参数严格校验：uSegments / vSegments 为 4..128 整数、closedU 为 boolean、transform 三分量齐全。
 * 其它操作的 parameters 仍只要求是对象（服务端 schema 已校验，这里只做查看器展示窄化）。
 */
function parseSurfaceParameters(parameters: Readonly<Record<string, unknown>>, path: string): void {
  requireSegmentCount(parameters['uSegments'], `${path}.uSegments`);
  requireSegmentCount(parameters['vSegments'], `${path}.vSegments`);
  if (typeof parameters['closedU'] !== 'boolean') {
    throw new Error(`${path}.closedU 必须是布尔值`);
  }
  requireTransformDocument(parameters['transform'], `${path}.transform`);
}

function parseSource(value: unknown, path: string): ViewerSource {
  const record = requireRecord(value, path);
  const operation = oneOf(record['operation'], PART_OPERATIONS, `${path}.operation`);
  const parameters = requireRecord(record['parameters'], `${path}.parameters`);
  if (operation === 'surface') parseSurfaceParameters(parameters, `${path}.parameters`);
  return { operation, parameters };
}

function parsePart(value: unknown, path: string): ViewerPart {
  const record = requireRecord(value, path);
  return {
    id: requireString(record['id'], `${path}.id`),
    name: requireString(record['name'], `${path}.name`),
    role: oneOf(record['role'], MODEL_ROLES, `${path}.role`),
    color: requireColor(record['color'], `${path}.color`),
    ...(record['material'] === undefined ? {} : { material: requireMaterial(record['material'], `${path}.material`) }),
    positions: requireArray(record['positions'], `${path}.positions`).map((item, index) =>
      requireFinite(item, `${path}.positions[${String(index)}]`),
    ),
    indices: requireArray(record['indices'], `${path}.indices`).map((item, index) =>
      requireIndex(item, `${path}.indices[${String(index)}]`),
    ),
    bounds: requireBounds(record['bounds'], `${path}.bounds`),
    source: parseSource(record['source'], `${path}.source`),
  };
}

/**
 * 解析 `/api/model` 响应；缺字段或非法取值时抛出可读中文错误。
 * 读取兼容 version 1 与 2（决策 #113）：v1 文档带 material 一律拒绝，提示升级。
 */
export function parseModelDocument(value: unknown): ViewerModel {
  const record = requireRecord(value, '模型文档');
  const version = requireFinite(record['version'], '模型文档.version');
  if (version !== 1 && version !== 2) {
    throw new Error(`模型文档.version 必须是 1 或 2，实际 ${String(version)}`);
  }
  const parts = requireArray(record['parts'], '模型文档.parts').map((item, index) =>
    parsePart(item, `模型文档.parts[${String(index)}]`),
  );
  if (version === 1) {
    parts.forEach((part, index) => {
      if (part.material !== undefined) {
        throw new Error(`模型文档.parts[${String(index)}].material: version 1 不支持 material，请升级为 2`);
      }
    });
  }
  return { version, parts };
}

// ---------------------------------------------------------------------------
// 几何与显示纯函数
// ---------------------------------------------------------------------------

function unionBounds(boxes: readonly Bounds[]): Bounds {
  const first = boxes[0];
  if (first === undefined) return { min: [0, 0, 0], max: [1, 1, 1] };
  const min: [number, number, number] = [first.min[0], first.min[1], first.min[2]];
  const max: [number, number, number] = [first.max[0], first.max[1], first.max[2]];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis += 1) {
      const lo = box.min[axis];
      const hi = box.max[axis];
      if (lo !== undefined && lo < (min[axis] ?? 0)) min[axis] = lo;
      if (hi !== undefined && hi > (max[axis] ?? 0)) max[axis] = hi;
    }
  }
  return { min, max };
}

/** 整份模型的并集包围盒；空模型回退到 1×1×1，避免相机取景退化。 */
export function modelBounds(model: ViewerModel): Bounds {
  return unionBounds(model.parts.map((part) => part.bounds));
}

/** 部件三个轴的长度。 */
export function partSize(part: ViewerPart): Vec3 {
  return [
    part.bounds.max[0] - part.bounds.min[0],
    part.bounds.max[1] - part.bounds.min[1],
    part.bounds.max[2] - part.bounds.min[2],
  ];
}

/**
 * 部件的浮点原点（包围盒 min）：几何先减它再转 float32，mesh.position 再还原世界坐标。
 *
 * 为什么必须这么做：世界坐标可达 ±100000，float32 在该量级的 ULP ≈ 0.0078；
 * 直接把世界坐标塞进 Float32 会把 `size [0.001,1,1]`、`translate [99999,0,0]` 这类薄部件压扁。
 * 减掉 origin 后局部坐标由部件自身跨度决定，薄部件得以保留；取景仍用世界包围盒（modelBounds）。
 */
export function partOrigin(part: ViewerPart): Vec3 {
  return [part.bounds.min[0], part.bounds.min[1], part.bounds.min[2]];
}

function component(values: Float32Array, index: number): number {
  // 索引由 schema 校验过范围；`?? 0` 只为满足 noUncheckedIndexedAccess。
  return values[index] ?? 0;
}

/**
 * 量化后退化检查：source 三角非退化由 @pg/modeling 的 schema 保证；
 * 转成 float32（已减 origin）后若某个三角塌成零面积，说明单部件跨度太大、内部细特征被浮点精度抹掉。
 * 这种情况直接抛出可读错误，绝不静默交给浏览器画出破面。
 */
function assertQuantizedNonDegenerate(part: ViewerPart, positions: Float32Array, indices: readonly number[]): void {
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t];
    const i1 = indices[t + 1];
    const i2 = indices[t + 2];
    if (i0 === undefined || i1 === undefined || i2 === undefined) return;
    const ax = component(positions, i0 * 3);
    const ay = component(positions, i0 * 3 + 1);
    const az = component(positions, i0 * 3 + 2);
    const bx = component(positions, i1 * 3);
    const by = component(positions, i1 * 3 + 1);
    const bz = component(positions, i1 * 3 + 2);
    const cx = component(positions, i2 * 3);
    const cy = component(positions, i2 * 3 + 1);
    const cz = component(positions, i2 * 3 + 2);
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx === 0 && ny === 0 && nz === 0) {
      const span = Math.max(partSize(part)[0], partSize(part)[1], partSize(part)[2]);
      throw new Error(
        `部件 ${part.id} 的第 ${String(t / 3)} 个三角在 float32 量化后退化：` +
          `部件跨度约 ${formatNumber(span)}，内部细特征被浮点精度抹掉；请拆分部件或缩小坐标跨度。`,
      );
    }
  }
}

/**
 * 部件几何：顶点先减部件 origin 再转 float32，三角索引照旧；法线由浏览器算法线。
 * 量化后退化（单部件跨度巨大抹掉内部细特征）会抛出可读错误，而不是画出破面。
 */
export function partGeometry(part: ViewerPart): THREE.BufferGeometry {
  const origin = partOrigin(part);
  const world = part.positions;
  const local = new Float32Array(world.length);
  for (let i = 0; i < world.length; i += 3) {
    local[i] = (world[i] ?? 0) - origin[0];
    local[i + 1] = (world[i + 1] ?? 0) - origin[1];
    local[i + 2] = (world[i + 2] ?? 0) - origin[2];
  }
  assertQuantizedNonDegenerate(part, local, part.indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(local, 3));
  geometry.setIndex([...part.indices]);
  geometry.computeVertexNormals();
  return geometry;
}

/** 为一个部件建 Mesh；几何相对 origin 本地化，`mesh.position` 还原世界位置。mesh.name 记 partId。 */
export function createPartMesh(part: ViewerPart): THREE.Mesh {
  const material = new THREE.MeshLambertMaterial({
    color: new THREE.Color(part.color),
    side: THREE.DoubleSide,
  });
  const origin = partOrigin(part);
  const mesh = new THREE.Mesh(partGeometry(part), material);
  mesh.position.set(origin[0], origin[1], origin[2]);
  mesh.name = part.id;
  return mesh;
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

/** 从 ViewerModel 建完整场景：灯光 + 每个部件一个 Mesh，默认全部可见。 */
export function buildMeshScene(model: ViewerModel): MeshScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe5ec);
  addLights(scene);
  const group = new THREE.Group();
  const partById = new Map<string, THREE.Mesh>();
  for (const part of model.parts) {
    const mesh = createPartMesh(part);
    partById.set(part.id, mesh);
    group.add(mesh);
  }
  scene.add(group);
  return { scene, partById, group };
}

/** 把剖切面套到全部部件；传空数组清除。剖切只影响显示，不改模型数据。 */
export function setClipPlanes(meshScene: MeshScene, planes: readonly THREE.Plane[]): void {
  for (const mesh of meshScene.partById.values()) {
    const material = mesh.material;
    for (const entry of Array.isArray(material) ? material : [material]) entry.clippingPlanes = [...planes];
  }
}

/** 释放几何与材质，避免反复加载泄漏 GPU 资源。 */
export function disposeMeshScene(meshScene: MeshScene): void {
  for (const mesh of meshScene.partById.values()) {
    mesh.geometry.dispose();
    const material = mesh.material;
    for (const entry of Array.isArray(material) ? material : [material]) entry.dispose();
  }
}

// ---------------------------------------------------------------------------
// 详情文案（选中部件）
// ---------------------------------------------------------------------------

const ROLE_LABELS: Readonly<Record<ModelRole, string>> = {
  volume: '体量',
  roof: '屋顶',
  floor: '楼板',
  connection: '连接',
};

const OPERATION_LABELS: Readonly<Record<PartOperation, string>> = {
  box: 'box（盒）',
  revolve: 'revolve（旋转）',
  extrude: 'extrude（拉伸）',
  surface: 'surface（曲面）',
};

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 从 unknown 读定长有限数字数组；非数组 / 长度不符 / 含非有限数时返回 undefined。
 * `Array.isArray` 会把 unknown 窄成 `any[]`，这里显式按 `readonly unknown[]` 读，避免把 any 带进后续计算。
 */
function numberArrayOf(value: unknown, length: number): readonly number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value as readonly unknown[];
  if (items.length !== length) return undefined;
  const out: number[] = [];
  for (const item of items) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return undefined;
    out.push(item);
  }
  return out;
}

/** 旋转采样轮廓：读成 `[radius, height]` 对；结构不符返回 null。 */
function samplePairs(value: unknown): readonly (readonly [number, number])[] | null {
  if (!Array.isArray(value)) return null;
  const items = value as readonly unknown[];
  const out: (readonly [number, number])[] = [];
  for (const item of items) {
    const pair = numberArrayOf(item, 2);
    if (pair === undefined) return null;
    const radius = pair[0];
    const height = pair[1];
    if (radius === undefined || height === undefined) return null;
    out.push([radius, height]);
  }
  return out;
}

/** revolve 的采样轮廓半径 / 高度范围；结构不符时返回 null（服务端已校验，这里只做展示降级）。 */
function profileStats(parameters: Readonly<Record<string, unknown>>): {
  readonly maxRadius: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly samples: number;
} | null {
  const samples = samplePairs(parameters['sampledProfile']);
  if (samples === null || samples.length === 0) return null;
  let maxRadius = Number.NEGATIVE_INFINITY;
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  for (const [radius, height] of samples) {
    if (radius > maxRadius) maxRadius = radius;
    if (height < minHeight) minHeight = height;
    if (height > maxHeight) maxHeight = height;
  }
  return { maxRadius, minHeight, maxHeight, samples: samples.length };
}

/**
 * 选中部件的说明字段：名称、编号、用途、操作、尺寸、包围盒，以及每种操作的 source 摘要。
 * `source` 本身不在这里展开成全量 JSON（由 `sourceJson` 交给 `<pre>` 的 textContent 展示）。
 */
export function partDetailEntries(part: ViewerPart): readonly (readonly [string, string])[] {
  const size = partSize(part);
  const entries: (readonly [string, string])[] = [
    ['名称', part.name],
    ['编号', part.id],
    ['用途', ROLE_LABELS[part.role]],
    ['操作', OPERATION_LABELS[part.source.operation]],
    ['尺寸', `${formatNumber(size[0])} × ${formatNumber(size[1])} × ${formatNumber(size[2])}`],
    [
      '包围盒',
      `[${formatNumber(part.bounds.min[0])}, ${formatNumber(part.bounds.min[1])}, ${formatNumber(part.bounds.min[2])}] → ` +
        `[${formatNumber(part.bounds.max[0])}, ${formatNumber(part.bounds.max[1])}, ${formatNumber(part.bounds.max[2])}]`,
    ],
  ];
  const parameters = part.source.parameters;
  if (part.source.operation === 'box') {
    const boxSize = numberArrayOf(parameters['size'], 3);
    if (boxSize !== undefined) {
      const [x, y, z] = boxSize;
      if (x !== undefined && y !== undefined && z !== undefined) {
        entries.push(['box 尺寸', `${formatNumber(x)} × ${formatNumber(y)} × ${formatNumber(z)}`]);
      }
    }
  } else if (part.source.operation === 'revolve') {
    const profileSegments = readNumber(parameters, 'profileSegments');
    const radialSegments = readNumber(parameters, 'radialSegments');
    const stats = profileStats(parameters);
    if (profileSegments !== undefined && radialSegments !== undefined) {
      entries.push(['采样', `${String(profileSegments)} × ${String(radialSegments)}`]);
    }
    if (stats !== null) {
      entries.push(['半径', `0 → ${formatNumber(stats.maxRadius)}`]);
      entries.push([
        '母线高',
        `${formatNumber(stats.minHeight)} → ${formatNumber(stats.maxHeight)}（${String(stats.samples)} 点）`,
      ]);
    }
  } else if (part.source.operation === 'surface') {
    const uSegments = readNumber(parameters, 'uSegments');
    const vSegments = readNumber(parameters, 'vSegments');
    if (uSegments !== undefined && vSegments !== undefined) {
      entries.push(['采样', `${String(uSegments)} × ${String(vSegments)}`]);
    }
    const closedU = parameters['closedU'];
    if (typeof closedU === 'boolean') entries.push(['closedU', closedU ? '是' : '否']);
  } else {
    const height = readNumber(parameters, 'height');
    const outline = parameters['outline'];
    if (height !== undefined) entries.push(['拉伸高度', formatNumber(height)]);
    if (Array.isArray(outline)) entries.push(['轮廓点数', String(outline.length)]);
  }
  return entries;
}

/** source 的 JSON 文本；调用方必须放进 `textContent`，不得拼 HTML。 */
export function sourceJson(part: ViewerPart): string {
  return JSON.stringify({ operation: part.source.operation, parameters: part.source.parameters }, null, 2);
}
