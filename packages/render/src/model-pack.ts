/**
 * 官方模型包（PGMP）：宿主与页面之间的只读二进制协议，携带预计算方块几何与纹理图集。
 *
 * 负责：编码 / 解码模型包、校验长度与版本；不负责读文件、解析 Minecraft JSON（tools/mc/）。
 * 本文件零 import，Node 与浏览器运行同一份源码。模型坐标单位是 1/16 格，UV 单位是图集像素。
 *
 * 面顺序与 mesh.ts 的 NORMALS 一致：+x(east)、−x(west)、+y(up)、−y(down)、+z(south)、−z(north)。
 * 每个面 12 字节：flags u8（bit0 存在、bit1 tint、bit2–3 UV 旋转 90° 的倍数）、reserved u8、
 * u0/v0/u1/v1 各 u16。盒子 24 字节（from/to 各 3 个 float32），加 6 个面共 96 字节。
 */

export const MODEL_PACK_MAGIC = 'PGMP';
export const MODEL_PACK_VERSION = 1;
export const MODEL_PACK_HEADER_BYTES = 24;
export const MODEL_PACK_BOX_BYTES = 96;
export const MODEL_FACE_COUNT = 6;

/** 与 NORMALS 相同顺序的面名，仅用于工具与测试的可读性。 */
export const MODEL_FACE_NAMES = ['east', 'west', 'up', 'down', 'south', 'north'] as const;

export interface PackFace {
  /** 图集像素坐标，左上原点：u0,v0,u1,v1。 */
  readonly uv: readonly [number, number, number, number];
  /** true 时用方块平均色给贴图着色（草、树叶等 tintindex≥0 的面）。 */
  readonly tint: boolean;
  /** 贴图在面内顺时针旋转 90° 的次数（0–3）。 */
  readonly rotation: 0 | 1 | 2 | 3;
}

export interface PackBox {
  /** 1/16 格单位，可为小数；允许 −0.5 之类的原版越界。 */
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  /** 长度 6，按 MODEL_FACE_NAMES 顺序；null 表示该面不存在。 */
  readonly faces: readonly (PackFace | null)[];
}

export interface PackModel {
  readonly boxes: readonly PackBox[];
}

export interface ModelPackAtlas {
  readonly width: number;
  readonly height: number;
  /** RGBA8，长度必须是 width·height·4。 */
  readonly rgba: Uint8Array;
}

export interface RenderModelPack {
  readonly models: readonly PackModel[];
  readonly atlas: ModelPackAtlas;
}

const WHITE_UV: readonly [number, number, number, number] = [0, 0, 0, 0];

/** 空模型包：页面没有纹理时仍可解析，geometry 的 UV 全部指向白像素。 */
export function emptyModelPack(): RenderModelPack {
  return { models: [], atlas: { width: 1, height: 1, rgba: Uint8Array.from([255, 255, 255, 255]) } };
}

function checkPack(pack: RenderModelPack): string | undefined {
  if (pack.models.length > 65535) return `模型数 ${String(pack.models.length)} 超过 65535`;
  const { width, height, rgba } = pack.atlas;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096)
    return `图集尺寸不合法：${String(width)}×${String(height)}`;
  if (rgba.length !== width * height * 4)
    return `图集字节数 ${String(rgba.length)} 与 ${String(width)}×${String(height)}×4 不符`;
  for (const model of pack.models) {
    if (model.boxes.length > 65535) return `单个模型盒子数 ${String(model.boxes.length)} 超过 65535`;
    if (model.boxes.length === 0) return '模型不能没有盒子';
    for (const box of model.boxes) {
      if (box.faces.length !== MODEL_FACE_COUNT) return `盒子面数 ${String(box.faces.length)}，期望 6`;
      for (const face of box.faces) {
        if (face === null) continue;
        if (face.rotation < 0 || face.rotation > 3 || !Number.isInteger(face.rotation))
          return `面旋转不合法：${String(face.rotation)}`;
        for (const value of face.uv) {
          if (!Number.isFinite(value) || value < 0 || value > 65535) return `UV ${String(value)} 越界`;
        }
      }
    }
  }
  return undefined;
}

/** 编码模型包；结构不合法时抛错。生成器与测试共用。 */
export function encodeModelPack(pack: RenderModelPack): Uint8Array {
  const problem = checkPack(pack);
  if (problem !== undefined) throw new Error(`模型包不合法：${problem}`);
  const modelBytes = pack.models.reduce((sum, model) => sum + 2 + model.boxes.length * MODEL_PACK_BOX_BYTES, 0);
  const buffer = new Uint8Array(MODEL_PACK_HEADER_BYTES + modelBytes + pack.atlas.width * pack.atlas.height * 4);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < MODEL_PACK_MAGIC.length; i += 1) buffer[i] = MODEL_PACK_MAGIC.charCodeAt(i);
  view.setUint16(4, MODEL_PACK_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, pack.models.length, true);
  view.setUint16(12, pack.atlas.width, true);
  view.setUint16(14, pack.atlas.height, true);
  view.setUint32(16, pack.atlas.rgba.length, true);
  view.setUint32(20, 0, true);

  let offset = MODEL_PACK_HEADER_BYTES;
  for (const model of pack.models) {
    view.setUint16(offset, model.boxes.length, true);
    offset += 2;
    for (const box of model.boxes) {
      for (let axis = 0; axis < 3; axis += 1) {
        view.setFloat32(offset, box.from[axis] ?? 0, true);
        view.setFloat32(offset + 4, box.to[axis] ?? 0, true);
        offset += 8;
      }
      for (const face of box.faces) {
        if (face === null) {
          buffer.fill(0, offset, offset + 12);
        } else {
          buffer[offset] = 1 | (face.tint ? 2 : 0) | (face.rotation << 2);
          buffer[offset + 1] = 0;
          view.setUint16(offset + 2, Math.round(face.uv[0]), true);
          view.setUint16(offset + 4, Math.round(face.uv[1]), true);
          view.setUint16(offset + 6, Math.round(face.uv[2]), true);
          view.setUint16(offset + 8, Math.round(face.uv[3]), true);
          view.setUint16(offset + 10, 0, true);
        }
        offset += 12;
      }
    }
  }
  buffer.set(pack.atlas.rgba, offset);
  return buffer;
}

function need(condition: boolean, message: string): void {
  if (!condition) throw new Error(`模型包解码失败：${message}`);
}

/** 解码模型包；magic / 版本 / 长度不合法时抛错。 */
export function decodeModelPack(buffer: Uint8Array): RenderModelPack {
  need(buffer.byteLength >= MODEL_PACK_HEADER_BYTES, `长度 ${String(buffer.byteLength)} 不足头部`);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let i = 0; i < MODEL_PACK_MAGIC.length; i += 1) {
    need(buffer[i] === MODEL_PACK_MAGIC.charCodeAt(i), 'magic 不是 PGMP');
  }
  const version = view.getUint16(4, true);
  need(version === MODEL_PACK_VERSION, `版本 ${String(version)}，期望 ${String(MODEL_PACK_VERSION)}`);
  need(view.getUint16(6, true) === 0, '保留字段不为 0');
  const modelCount = view.getUint32(8, true);
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const atlasBytes = view.getUint32(16, true);
  need(width >= 1 && height >= 1, '图集尺寸为 0');
  need(atlasBytes === width * height * 4, `图集字节数 ${String(atlasBytes)} 与尺寸不符`);
  need(buffer.byteLength >= MODEL_PACK_HEADER_BYTES + atlasBytes, '缺少图集数据');

  let offset = MODEL_PACK_HEADER_BYTES;
  const models: PackModel[] = [];
  for (let m = 0; m < modelCount; m += 1) {
    need(offset + 2 <= buffer.byteLength, `第 ${String(m)} 个模型缺盒子数`);
    const boxCount = view.getUint16(offset, true);
    offset += 2;
    const boxes: PackBox[] = [];
    for (let b = 0; b < boxCount; b += 1) {
      need(offset + MODEL_PACK_BOX_BYTES <= buffer.byteLength, `第 ${String(m)} 个模型第 ${String(b)} 个盒子越界`);
      const from: [number, number, number] = [0, 0, 0];
      const to: [number, number, number] = [0, 0, 0];
      for (let axis = 0; axis < 3; axis += 1) {
        from[axis] = view.getFloat32(offset, true);
        to[axis] = view.getFloat32(offset + 4, true);
        offset += 8;
      }
      const faces: (PackFace | null)[] = [];
      for (let f = 0; f < MODEL_FACE_COUNT; f += 1) {
        const flags = buffer[offset] ?? 0;
        if ((flags & 1) === 0) {
          faces.push(null);
        } else {
          faces.push({
            uv: [
              view.getUint16(offset + 2, true),
              view.getUint16(offset + 4, true),
              view.getUint16(offset + 6, true),
              view.getUint16(offset + 8, true),
            ],
            tint: (flags & 2) !== 0,
            rotation: ((flags >> 2) & 3) as 0 | 1 | 2 | 3,
          });
        }
        offset += 12;
      }
      boxes.push({ from, to, faces });
    }
    models.push({ boxes });
  }
  need(
    offset + atlasBytes === buffer.byteLength,
    `尾部有 ${String(buffer.byteLength - offset - atlasBytes)} 字节多余数据`,
  );
  return { models, atlas: { width, height, rgba: buffer.subarray(offset, offset + atlasBytes) } };
}

/** 页面没有官方包时，UV 统一取值（0,0），与空图集白像素对应。 */
export const UNTEXTURED_UV: readonly [number, number, number, number] = WHITE_UV;
