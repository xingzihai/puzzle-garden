/**
 * 官方方块模型 JSON 解析：parent 继承、纹理变量、elements、面 UV、元素旋转。
 *
 * 只用于离线生成模型包；渲染器不读 Minecraft JSON。输出面顺序与 mesh.ts 一致。
 * 45° 等非 90° 元素旋转会取旋转后 AABB（视觉近似），在 docs/MC-ASSETS.md 的边界里写明。
 */

export type Vec3 = [number, number, number];
export type UvRect = [number, number, number, number];

export interface ModelFace {
  readonly texture: string;
  /** 0–16 的模型 UV（不是像素），与 Minecraft 模型一致。 */
  readonly uv: UvRect;
  readonly rotation: 0 | 1 | 2 | 3;
  readonly tint: boolean;
}

export interface ModelBox {
  readonly from: Vec3;
  readonly to: Vec3;
  /** 顺序：east、west、up、down、south、north。 */
  readonly faces: readonly (ModelFace | null)[];
}

export interface ResolvedModel {
  readonly boxes: readonly ModelBox[];
  readonly ambientocclusion: boolean;
}

interface InternalModel extends ResolvedModel {
  readonly textures: Readonly<Record<string, string>>;
  readonly elements: unknown;
}

export const FACE_ORDER = ['east', 'west', 'up', 'down', 'south', 'north'] as const;
export type FaceName = (typeof FACE_ORDER)[number];

interface RawElement {
  from?: unknown;
  to?: unknown;
  rotation?: { origin?: unknown; axis?: unknown; angle?: unknown };
  faces?: Record<string, { uv?: unknown; texture?: unknown; rotation?: unknown; tintindex?: unknown }>;
}

interface RawModel {
  parent?: unknown;
  textures?: Record<string, unknown>;
  elements?: unknown;
  ambientocclusion?: unknown;
}

export type ModelReader = (path: string) => string | undefined;

const cache = new WeakMap<ModelReader, Map<string, InternalModel | null>>();

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 不是数字`);
  return value;
}

function asVec3(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} 不是三元数组`);
  return [asNumber(value[0], label), asNumber(value[1], label), asNumber(value[2], label)];
}

export function normalizeRef(ref: string): string {
  return ref.startsWith('minecraft:') ? ref.slice('minecraft:'.length) : ref;
}

function modelPath(ref: string): string {
  return `assets/minecraft/models/${normalizeRef(ref)}.json`;
}

function defaultUv(face: FaceName, from: Vec3, to: Vec3): UvRect {
  const [x0, y0, z0] = from;
  const [x1, y1, z1] = to;
  if (face === 'up' || face === 'down') return [x0, z0, x1, z1];
  if (face === 'east' || face === 'west') return [z0, 16 - y1, z1, 16 - y0];
  return [x0, 16 - y1, x1, 16 - y0];
}

function rotatePoint(point: Vec3, origin: Vec3, axis: string, degrees: number): Vec3 {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const x = point[0] - origin[0];
  const y = point[1] - origin[1];
  const z = point[2] - origin[2];
  if (axis === 'x') return [x + origin[0], y * cos - z * sin + origin[1], y * sin + z * cos + origin[2]];
  if (axis === 'z') return [x * cos - y * sin + origin[0], x * sin + y * cos + origin[1], z + origin[2]];
  return [x * cos + z * sin + origin[0], y + origin[1], -x * sin + z * cos + origin[2]];
}

/** 旋转元素后取 AABB；90° 倍数精确，其他角度近似。 */
function rotateBox(box: ModelBox, origin: Vec3, axis: string, degrees: number): ModelBox {
  if (degrees === 0 || degrees === 360) return box;
  const corners: Vec3[] = [];
  for (const x of [box.from[0], box.to[0]]) {
    for (const y of [box.from[1], box.to[1]]) {
      for (const z of [box.from[2], box.to[2]]) corners.push(rotatePoint([x, y, z], origin, axis, degrees));
    }
  }
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const zs = corners.map((p) => p[2]);
  const clean = (value: number): number => {
    const rounded = Math.round(value * 10000) / 10000;
    return Math.abs(rounded) < 0.0001 ? 0 : rounded;
  };
  return {
    from: [clean(Math.min(...xs)), clean(Math.min(...ys)), clean(Math.min(...zs))],
    to: [clean(Math.max(...xs)), clean(Math.max(...ys)), clean(Math.max(...zs))],
    faces: box.faces,
  };
}

function resolveTexture(value: string, textures: Readonly<Record<string, string>>, seen: Set<string>): string {
  let current = value;
  for (let depth = 0; depth < 16; depth += 1) {
    if (!current.startsWith('#')) return normalizeRef(current);
    const key = current.slice(1);
    if (seen.has(key)) return 'missing';
    seen.add(key);
    const next = textures[key];
    if (next === undefined) return 'missing';
    current = next;
  }
  return 'missing';
}

function parseElements(raw: unknown, textures: Readonly<Record<string, string>>): ModelBox[] {
  if (!Array.isArray(raw)) return [];
  const boxes: ModelBox[] = [];
  for (const item of raw) {
    const element = item as RawElement;
    if (element.from === undefined || element.to === undefined) continue;
    const from = asVec3(element.from, 'element.from');
    const to = asVec3(element.to, 'element.to');
    const faces: (ModelFace | null)[] = [];
    for (const name of FACE_ORDER) {
      const face = element.faces?.[name];
      if (face === undefined) {
        faces.push(null);
        continue;
      }
      const texture = typeof face.texture === 'string' ? resolveTexture(face.texture, textures, new Set()) : 'missing';
      const uv =
        Array.isArray(face.uv) && face.uv.length === 4
          ? (face.uv.map((v) => asNumber(v, 'uv')) as UvRect)
          : defaultUv(name, from, to);
      const degrees = typeof face.rotation === 'number' ? face.rotation : 0;
      const rotation = Math.max(0, Math.min(3, Math.round(degrees / 90))) as 0 | 1 | 2 | 3;
      const tint = typeof face.tintindex === 'number' && face.tintindex >= 0;
      faces.push({ texture, uv, rotation, tint });
    }
    let box: ModelBox = { from, to, faces };
    const rotation = element.rotation;
    if (rotation?.axis !== undefined && rotation.angle !== undefined) {
      const origin = Array.isArray(rotation.origin) ? asVec3(rotation.origin, 'rotation.origin') : ([8, 8, 8] as Vec3);
      const axis = typeof rotation.axis === 'string' ? rotation.axis : '';
      const degrees = asNumber(rotation.angle, 'rotation.angle');
      if (axis === 'x' || axis === 'y' || axis === 'z') box = rotateBox(box, origin, axis, degrees);
    }
    boxes.push(box);
  }
  return boxes;
}

/** 旋转一组盒子（方块状态 x/y 旋转用）；90° 倍数精确，其他角度取 AABB。 */
export function rotateModelBoxes(boxes: readonly ModelBox[], axis: string, degrees: number): ModelBox[] {
  if (degrees === 0 || degrees === 360) return [...boxes];
  return boxes.map((box) => rotateBox(box, [8, 8, 8], axis, degrees));
}

function resolve(ref: string, read: ModelReader, stack: readonly string[]): InternalModel | null {
  const path = modelPath(ref);
  if (stack.includes(path)) throw new Error(`模型 parent 循环：${[...stack, path].join(' -> ')}`);
  const entry = cache.get(read) ?? new Map<string, InternalModel | null>();
  cache.set(read, entry);
  const cached = entry.get(path);
  if (cached !== undefined) return cached;
  const text = read(path);
  if (text === undefined) {
    entry.set(path, null);
    return null;
  }
  const raw = JSON.parse(text) as RawModel;
  const parentRef = typeof raw.parent === 'string' ? raw.parent : undefined;
  const parent = parentRef === undefined ? null : resolve(parentRef, read, [...stack, path]);
  const textures: Record<string, string> = { ...(parent?.textures ?? {}) };
  if (raw.textures !== undefined) {
    for (const [key, value] of Object.entries(raw.textures)) {
      if (typeof value === 'string') textures[key] = value;
    }
  }
  const elements = raw.elements !== undefined ? raw.elements : parent?.elements;
  const boxes = parseElements(elements, textures);
  const ambientocclusion =
    typeof raw.ambientocclusion === 'boolean' ? raw.ambientocclusion : (parent?.ambientocclusion ?? true);
  const resolved: InternalModel = { boxes, ambientocclusion, textures, elements };
  entry.set(path, resolved);
  return resolved;
}

/** 解析一个模型引用（含 parent 链）；模型文件不存在返回 null。 */
export function resolveModel(ref: string, read: ModelReader): ResolvedModel | null {
  const resolved = resolve(normalizeRef(ref), read, []);
  return resolved === null ? null : { boxes: resolved.boxes, ambientocclusion: resolved.ambientocclusion };
}
