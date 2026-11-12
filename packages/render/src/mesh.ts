/**
 * 紧凑格表 → 面数 / 面缓冲（RENDER-SPEC §4.2、§6.2、§7）。
 *
 * 负责：解析宿主给的二进制紧凑格表；隐藏面剔除；方块盒子（单位 1/16 格）；面亮度与 AO；
 *   输出不透明 / 半透明两组面缓冲。Node 与浏览器运行同一份源码；旧版简化几何在
 *   mesh-parts.ts（零 import），本文件只保留协议、公共类型与网格化。
 * 不负责：生成紧凑格表（scene-buffer.ts）、three 对象（page/scene.ts）、相机（camera.ts）。
 */

import { CONNECT_PAINTS, faceTint, legacyBoxes, PAINT as PAINT_VALUES } from './mesh-parts.ts';

export const PAINT = PAINT_VALUES;

/**
 * 协议版本 2：调色板项从 8 字节扩到 12 字节，新增 u16 模型 id，指向页面单独请求的官方模型包。
 * 版本 1 的 8 字节旧格表仍可解析（model 视为 0），旧场景不会因为升级而读不了。
 * 画法编号与参数布局保持不变，新增画法继续复用同一个 u8。
 */
export const PROTOCOL_VERSION = 2;
export const PROTOCOL_VERSION_V1 = 1;
export const MAGIC = 'PGRS';
export const HEADER_BYTES = 34;
/** v1 每项：paint u8、params[0..3] u8×4、rgb u8×3。 */
export const PALETTE_ITEM_BYTES = 8;
/** v2 每项：v1 的 8 字节 + model u16 + flags u8 + reserved u8。 */
export const PALETTE_ITEM_BYTES_V2 = 12;
export const CELL_BYTES = 8;
/** 平铺表的体积上限（RENDER-SPEC §7.1）：sx·sy·sz 超过时不建表，直接在宿主侧返回 too-large。 */
export const MAX_TABLE_VOLUME = 64_000_000;

/** 页面与宿主共用的结构；与 model-pack.ts 的 RenderModelPack 结构一致，避免 mesh.ts 产生 import。 */
export interface MeshPackFace {
  readonly uv: readonly [number, number, number, number];
  readonly tint: boolean;
  readonly rotation: 0 | 1 | 2 | 3;
}
export interface MeshPackBox {
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  readonly faces: readonly (MeshPackFace | null)[];
}
export interface MeshModelPack {
  readonly models: readonly { readonly boxes: readonly MeshPackBox[] }[];
  readonly atlas: { readonly width: number; readonly height: number; readonly rgba: Uint8Array };
}

export interface PaletteEntry {
  readonly paint: number;
  readonly params: readonly [number, number, number, number];
  readonly rgb: readonly [number, number, number];
  /** v2：官方模型 id；0 表示走旧的简化几何。v1 解析结果恒为 0。 */
  readonly model: number;
}

export interface SceneCell {
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly palette: number;
}

export interface ParsedScene {
  readonly origin: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly palette: readonly PaletteEntry[];
  readonly cells: readonly SceneCell[];
  readonly cellCount: number;
  readonly paletteCount: number;
  readonly version: number;
}

export interface FaceGroup {
  readonly positions: Float32Array;
  readonly colors: Uint8Array;
  readonly indices: Uint32Array;
  /** 每顶点 UV；没有官方纹理时全 0，材质不会启用贴图。 */
  readonly uvs: Float32Array;
}

export interface MeshResult {
  readonly faces: number;
  readonly opaque: FaceGroup;
  readonly transparent: FaceGroup;
}

const decoder = new TextDecoder();

function readHeader(buffer: Uint8Array): {
  version: number;
  origin: [number, number, number];
  size: [number, number, number];
  cellCount: number;
  paletteCount: number;
} {
  if (buffer.byteLength < HEADER_BYTES) throw new Error(`紧凑格表太短：${String(buffer.byteLength)} 字节`);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = decoder.decode(buffer.subarray(0, 4));
  if (magic !== MAGIC) throw new Error(`紧凑格表 magic 不是 ${MAGIC}，实际是 ${JSON.stringify(magic)}`);
  const version = view.getUint16(4, true);
  if (version !== PROTOCOL_VERSION && version !== PROTOCOL_VERSION_V1)
    throw new Error(
      `紧凑格表版本 ${String(version)}，只支持 ${String(PROTOCOL_VERSION_V1)} 与 ${String(PROTOCOL_VERSION)}`,
    );
  if (view.getUint16(6, true) !== 0) throw new Error('紧凑格表保留字段不为 0');
  return {
    version,
    origin: [view.getInt32(8, true), view.getInt32(12, true), view.getInt32(16, true)],
    size: [view.getUint16(20, true), view.getUint16(22, true), view.getUint16(24, true)],
    cellCount: view.getUint32(26, true),
    paletteCount: view.getUint32(30, true),
  };
}

/** 解析紧凑格表；格式不合法时抛错（宿主与页面共用同一份源码，正常不会发生）。 */
export function parseScene(buffer: Uint8Array): ParsedScene {
  const header = readHeader(buffer);
  const stride = header.version === PROTOCOL_VERSION_V1 ? PALETTE_ITEM_BYTES : PALETTE_ITEM_BYTES_V2;
  const expected = HEADER_BYTES + header.paletteCount * stride + header.cellCount * CELL_BYTES;
  if (buffer.byteLength !== expected) {
    throw new Error(`紧凑格表长度 ${String(buffer.byteLength)} 与头部声明的 ${String(expected)} 不符`);
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const palette: PaletteEntry[] = [];
  let offset = HEADER_BYTES;
  for (let i = 0; i < header.paletteCount; i += 1) {
    const model = header.version === PROTOCOL_VERSION_V1 ? 0 : view.getUint16(offset + 8, true);
    palette.push({
      paint: buffer[offset] ?? 0,
      params: [buffer[offset + 1] ?? 0, buffer[offset + 2] ?? 0, buffer[offset + 3] ?? 0, buffer[offset + 7] ?? 0],
      rgb: [buffer[offset + 4] ?? 0, buffer[offset + 5] ?? 0, buffer[offset + 6] ?? 0],
      model,
    });
    offset += stride;
  }
  const cells: SceneCell[] = [];
  for (let i = 0; i < header.cellCount; i += 1) {
    cells.push({
      dx: view.getUint16(offset, true),
      dy: view.getUint16(offset + 2, true),
      dz: view.getUint16(offset + 4, true),
      palette: view.getUint16(offset + 6, true),
    });
    offset += CELL_BYTES;
  }
  return {
    origin: header.origin,
    size: header.size,
    palette,
    cells,
    cellCount: header.cellCount,
    paletteCount: header.paletteCount,
    version: header.version,
  };
}

/** 面法线，顺序固定为 +x、−x、+y、−y、+z、−z（RENDER-SPEC §7.1）。 */
const NORMALS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
/** 面亮度：+y 1.00；±x 0.80；±z 0.65；−y 0.50。 */
const BRIGHTNESS = [0.8, 0.8, 1.0, 0.5, 0.65, 0.65] as const;
/** 面内两轴：uDir、vDir 是世界单位向量，盒子角点按 u/v 从小到大排列。 */
const FACE_PLANE: readonly { readonly uAxis: 0 | 1 | 2; readonly vAxis: 0 | 1 | 2 }[] = [
  { uAxis: 2, vAxis: 1 },
  { uAxis: 2, vAxis: 1 },
  { uAxis: 0, vAxis: 2 },
  { uAxis: 0, vAxis: 2 },
  { uAxis: 0, vAxis: 1 },
  { uAxis: 0, vAxis: 1 },
];
/** AO 等级 → 亮度。 */
const AO_LEVELS = [1.0, 0.85, 0.7, 0.55] as const;

function isTransparent(paint: number): boolean {
  return paint === PAINT.glass || paint === PAINT.pane || paint === PAINT.fluid;
}

/** cube / axis_cube 都占满整格：用于遮挡、剔除与 AO；其它画法不算遮挡。 */
function isOpaqueCube(paint: number): boolean {
  return paint === PAINT.cube || paint === PAINT.axis_cube;
}

interface Builder {
  faces: number;
  positions: number[];
  colors: number[];
  uvs: number[];
  indices: number[];
  transparentPositions: number[];
  transparentColors: number[];
  transparentUvs: number[];
  transparentIndices: number[];
}

function atlasUv(
  pack: MeshModelPack,
  face: MeshPackFace,
  faceIndex: number,
  box: MeshPackBox,
  corner: readonly [number, number, number],
): readonly [number, number] {
  const [x0, y0, z0] = box.from;
  const [x1, y1, z1] = box.to;
  const dx = x1 - x0 || 1;
  const dy = y1 - y0 || 1;
  const dz = z1 - z0 || 1;
  const [cx, cy, cz] = corner;
  let tu: number;
  let tv: number;
  // 按面索引选映射，不能用角点坐标判断：顶面四个角也会满足 cx===x0/x1。
  switch (faceIndex) {
    case 0:
      tu = (z1 - cz) / dz;
      tv = (y1 - cy) / dy;
      break;
    case 1:
      tu = (cz - z0) / dz;
      tv = (y1 - cy) / dy;
      break;
    case 2:
      tu = (cx - x0) / dx;
      tv = (cz - z0) / dz;
      break;
    case 3:
      tu = (cx - x0) / dx;
      tv = (z1 - cz) / dz;
      break;
    case 4:
      tu = (x1 - cx) / dx;
      tv = (y1 - cy) / dy;
      break;
    default:
      tu = (cx - x0) / dx;
      tv = (y1 - cy) / dy;
      break;
  }
  const turns = face.rotation;
  for (let turn = 0; turn < turns; turn += 1) {
    const nextU = 1 - tv;
    tv = tu;
    tu = nextU;
  }
  const u = face.uv[0] + tu * (face.uv[2] - face.uv[0]);
  const v = face.uv[1] + tv * (face.uv[3] - face.uv[1]);
  return [u / pack.atlas.width, v / pack.atlas.height];
}

function buildMesh(scene: ParsedScene, emit: boolean, pack?: MeshModelPack): MeshResult {
  const [sx, sy, sz] = scene.size;
  const [ox, oy, oz] = scene.origin;
  const table = new Uint16Array(sx * sy * sz);
  for (const cell of scene.cells) table[(cell.dy * sz + cell.dz) * sx + cell.dx] = cell.palette + 1;

  /** 返回世界坐标 (x,y,z) 处邻格的画法；y ≤ 0 视为 cube（地面，RENDER-SPEC §7.1）；越界是空气。 */
  function paintAt(x: number, y: number, z: number): number {
    if (y <= 0) return PAINT.cube;
    const dx = x - ox;
    const dy = y - oy;
    const dz = z - oz;
    if (dx < 0 || dy < 0 || dz < 0 || dx >= sx || dy >= sy || dz >= sz) return PAINT.skip;
    const slot = table[(dy * sz + dz) * sx + dx] ?? 0;
    if (slot === 0) return PAINT.skip;
    return scene.palette[slot - 1]?.paint ?? PAINT.skip;
  }

  function occludes(x: number, y: number, z: number): boolean {
    return isOpaqueCube(paintAt(x, y, z));
  }

  function cull(paint: number, nx: number, ny: number, nz: number): boolean {
    const nb = paintAt(nx, ny, nz);
    if (isOpaqueCube(nb)) return true;
    if (paint === PAINT.glass && nb === PAINT.glass) return true;
    return paint === PAINT.fluid && nb === PAINT.fluid;
  }

  /**
   * 计算一个顶点的 AO 等级：s1、s2 都遮挡 → 3；否则 s1+s2+c（RENDER-SPEC §7.3）。
   * s1 / s2 是面外侧那一层里与该顶点相邻的两个边邻格，c 是角邻格。
   */
  function aoFor(
    uAxis: 0 | 1 | 2,
    vAxis: 0 | 1 | 2,
    su: number,
    sv: number,
    wx: number,
    wy: number,
    wz: number,
    nx: number,
    ny: number,
    nz: number,
  ): number {
    const bx = wx + nx;
    const by = wy + ny;
    const bz = wz + nz;
    const uStep: [number, number, number] = [0, 0, 0];
    uStep[uAxis] = su;
    const vStep: [number, number, number] = [0, 0, 0];
    vStep[vAxis] = sv;
    const s1 = occludes(bx + uStep[0], by + uStep[1], bz + uStep[2]) ? 1 : 0;
    const s2 = occludes(bx + vStep[0], by + vStep[1], bz + vStep[2]) ? 1 : 0;
    const c = occludes(bx + uStep[0] + vStep[0], by + uStep[1] + vStep[1], bz + uStep[2] + vStep[2]) ? 1 : 0;
    if (s1 === 1 && s2 === 1) return 3;
    return s1 + s2 + c;
  }

  const builder: Builder = {
    faces: 0,
    positions: [],
    colors: [],
    uvs: [],
    indices: [],
    transparentPositions: [],
    transparentColors: [],
    transparentUvs: [],
    transparentIndices: [],
  };

  const whiteU = pack === undefined ? 0 : 0.5 / pack.atlas.width;
  const whiteV = pack === undefined ? 0 : 0.5 / pack.atlas.height;

  function emitFace(
    entry: PaletteEntry,
    paint: number,
    wx: number,
    wy: number,
    wz: number,
    box: MeshPackBox,
    face: number,
    textured: MeshPackFace | undefined,
  ): void {
    const [x0, y0, z0] = box.from;
    const [x1, y1, z1] = box.to;
    const normal = NORMALS[face];
    if (normal === undefined) return;
    const [nx, ny, nz] = normal;
    const boundary =
      (face === 0 && x1 === 16) ||
      (face === 1 && x0 === 0) ||
      (face === 2 && y1 === 16) ||
      (face === 3 && y0 === 0) ||
      (face === 4 && z1 === 16) ||
      (face === 5 && z0 === 0);
    if (boundary && cull(paint, wx + nx, wy + ny, wz + nz)) return;
    const plane = FACE_PLANE[face];
    if (plane === undefined) return;
    const uAxis = plane.uAxis;
    const vAxis = plane.vAxis;
    const dims: [number, number, number] = [x1 - x0, y1 - y0, z1 - z0];
    const du = dims[uAxis];
    const dv = dims[vAxis];
    // 面基点（u、v 都取盒子最小端）。
    const base: [number, number, number] =
      face === 0
        ? [x1, y0, z0]
        : face === 1
          ? [x0, y0, z0]
          : face === 2
            ? [x0, y1, z0]
            : face === 3
              ? [x0, y0, z0]
              : face === 4
                ? [x0, y0, z1]
                : [x0, y0, z0];
    // 四个角：a00、a10、a11、a01（RENDER-SPEC §7.3）。
    const a00 = base;
    const a10: [number, number, number] = [...base];
    a10[uAxis] += du;
    const a11: [number, number, number] = [...a10];
    a11[vAxis] += dv;
    const a01: [number, number, number] = [...base];
    a01[vAxis] += dv;

    const ao: [number, number, number, number] = isOpaqueCube(paint)
      ? [
          aoFor(uAxis, vAxis, -1, -1, wx, wy, wz, nx, ny, nz),
          aoFor(uAxis, vAxis, 1, -1, wx, wy, wz, nx, ny, nz),
          aoFor(uAxis, vAxis, 1, 1, wx, wy, wz, nx, ny, nz),
          aoFor(uAxis, vAxis, -1, 1, wx, wy, wz, nx, ny, nz),
        ]
      : [0, 0, 0, 0];
    const brightness = BRIGHTNESS[face] ?? 1;
    const tint = faceTint(paint, entry.params, face);

    builder.faces += 1;
    if (!emit) return;
    const transparent = isTransparent(paint);
    const positions = transparent ? builder.transparentPositions : builder.positions;
    const colors = transparent ? builder.transparentColors : builder.colors;
    const uvs = transparent ? builder.transparentUvs : builder.uvs;
    const indices = transparent ? builder.transparentIndices : builder.indices;
    const baseIndex = positions.length / 3;
    const corners = [a00, a10, a11, a01];
    for (const corner of corners) {
      const local = [wx + corner[0] / 16, wy + corner[1] / 16, wz + corner[2] / 16];
      positions.push(local[0] ?? 0, local[1] ?? 0, local[2] ?? 0);
      if (textured !== undefined && pack !== undefined) {
        const [u, v] = atlasUv(pack, textured, face, box, corner);
        uvs.push(u, v);
      } else {
        uvs.push(whiteU, whiteV);
      }
    }
    const tinted = textured?.tint === true;
    for (let k = 0; k < 4; k += 1) {
      const level = ao[k] ?? 0;
      const aoValue = AO_LEVELS[level] ?? 1;
      const shade = (ch: number): number => {
        const component = tinted || textured === undefined ? (entry.rgb[ch] ?? 0) : 255;
        const value = Math.round(component * tint * brightness * aoValue);
        return value < 0 ? 0 : value > 255 ? 255 : value;
      };
      colors.push(shade(0), shade(1), shade(2));
    }
    // 默认对角线 (00,10,11)、(00,11,01)；a00+a11 < a01+a10 时换 (00,10,01)、(10,11,01)。
    const [l00, l10, l11, l01] = ao;
    if (l00 + l11 < l01 + l10) {
      indices.push(baseIndex, baseIndex + 1, baseIndex + 3, baseIndex + 1, baseIndex + 2, baseIndex + 3);
    } else {
      indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
    }
  }

  for (const cell of scene.cells) {
    const entry = scene.palette[cell.palette];
    if (entry === undefined) continue;
    const paint = entry.paint;
    const wx = ox + cell.dx;
    const wy = oy + cell.dy;
    const wz = oz + cell.dz;
    const official = entry.model > 0 ? pack?.models[entry.model - 1] : undefined;
    if (official !== undefined) {
      for (const box of official.boxes) {
        for (let face = 0; face < 6; face += 1) {
          const textured = box.faces[face];
          if (textured === null || textured === undefined) continue;
          emitFace(entry, paint, wx, wy, wz, box, face, textured);
        }
      }
      continue;
    }
    const connected: [boolean, boolean, boolean, boolean] = [
      CONNECT_PAINTS.has(paintAt(wx - 1, wy, wz)),
      CONNECT_PAINTS.has(paintAt(wx + 1, wy, wz)),
      CONNECT_PAINTS.has(paintAt(wx, wy, wz + 1)),
      CONNECT_PAINTS.has(paintAt(wx, wy, wz - 1)),
    ];
    const boxes = legacyBoxes(paint, entry.params, connected);
    for (const legacy of boxes) {
      const [x0, y0, z0, x1, y1, z1] = legacy;
      const box: MeshPackBox = { from: [x0, y0, z0], to: [x1, y1, z1], faces: [] };
      for (let face = 0; face < 6; face += 1) emitFace(entry, paint, wx, wy, wz, box, face, undefined);
    }
  }

  return {
    faces: builder.faces,
    opaque: {
      positions: new Float32Array(builder.positions),
      colors: new Uint8Array(builder.colors),
      uvs: new Float32Array(builder.uvs),
      indices: new Uint32Array(builder.indices),
    },
    transparent: {
      positions: new Float32Array(builder.transparentPositions),
      colors: new Uint8Array(builder.transparentColors),
      uvs: new Float32Array(builder.transparentUvs),
      indices: new Uint32Array(builder.transparentIndices),
    },
  };
}

/** 只数面、不生成顶点（宿主侧上限检查与面数核对用）。 */
export function countFaces(buffer: Uint8Array, pack?: MeshModelPack): number {
  return buildMesh(parseScene(buffer), false, pack).faces;
}

/** 生成面缓冲（页面侧建几何用）。 */
export function meshScene(scene: ParsedScene, pack?: MeshModelPack): MeshResult {
  return buildMesh(scene, true, pack);
}
