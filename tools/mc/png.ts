/**
 * 最小 PNG 解码器：把 Minecraft 方块贴图转成 RGBA8，供离线图集打包使用。
 *
 * 支持：非隔行、位深 1/2/4/8、灰度 / RGB / 调色板 / 灰度+α / RGBA、tRNS。
 * 不支持：16 位、Adam7 隔行（遇到时明确报错，导入工具会记入 manifest 的 skipped）。
 */

import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function readChunk(view: DataView, offset: number): { type: string; data: Uint8Array; next: number } {
  if (offset + 12 > view.byteLength) throw new Error('PNG 块越界');
  const length = view.getUint32(offset, false);
  const end = offset + 12 + length;
  if (end > view.byteLength) throw new Error('PNG 块长度越界');
  const type = new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + offset + 4, 4));
  const data = new Uint8Array(view.buffer, view.byteOffset + offset + 8, length);
  return { type, data, next: end };
}

function scale(value: number, bitDepth: number): number {
  if (bitDepth === 8) return value;
  return Math.round((value * 255) / ((1 << bitDepth) - 1));
}

function sample(row: Uint8Array, index: number, bitDepth: number): number {
  if (bitDepth === 8) return row[index] ?? 0;
  const bit = index * bitDepth;
  const byte = row[bit >> 3] ?? 0;
  const shift = 8 - bitDepth - (bit & 7);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

function unfilter(raw: Uint8Array, width: number, height: number, channels: number, bitDepth: number): Uint8Array {
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const out = new Uint8Array(stride * height);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    if (src >= raw.length) throw new Error('PNG 图像数据不足');
    const filter = raw[src] ?? 0;
    src += 1;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src] ?? 0;
      src += 1;
      const left = x >= bpp ? (out[rowStart + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (out[prevStart + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= bpp ? (out[prevStart + x - bpp] ?? 0) : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`PNG 行过滤类型 ${String(filter)} 不支持`);
      }
      out[rowStart + x] = restored & 0xff;
    }
  }
  if (src !== raw.length) throw new Error(`PNG 解压数据多出 ${String(raw.length - src)} 字节`);
  return out;
}

/** 解码 PNG；格式不支持时抛错（调用方决定跳过还是中断）。 */
export function decodePng(buffer: Uint8Array): DecodedPng {
  if (buffer.byteLength < 8) throw new Error('PNG 太短');
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error('PNG 签名不对');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];

  while (offset < buffer.byteLength) {
    const chunk = readChunk(view, offset);
    offset = chunk.next;
    if (chunk.type === 'IHDR') {
      if (chunk.data.length !== 13) throw new Error('PNG IHDR 长度不对');
      const header = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
      width = header.getUint32(0, false);
      height = header.getUint32(4, false);
      bitDepth = chunk.data[8] ?? 0;
      colorType = chunk.data[9] ?? 0;
      interlace = chunk.data[12] ?? 0;
    } else if (chunk.type === 'PLTE') {
      palette = chunk.data;
    } else if (chunk.type === 'tRNS') {
      transparency = chunk.data;
    } else if (chunk.type === 'IDAT') {
      idat.push(chunk.data);
    } else if (chunk.type === 'IEND') {
      break;
    }
  }

  if (width < 1 || height < 1) throw new Error('PNG 缺少有效 IHDR');
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`不支持的 PNG 颜色类型 ${String(colorType)}`);
  if (colorType !== 0 && colorType !== 3 && bitDepth !== 8) throw new Error('真彩色 PNG 只支持 8 位');
  if ((colorType === 0 || colorType === 3) && ![1, 2, 4, 8].includes(bitDepth))
    throw new Error(`不支持的 PNG 位深 ${String(bitDepth)}`);
  if (idat.length === 0) throw new Error('PNG 没有 IDAT');
  const compressed = Buffer.concat(idat.map((part) => Buffer.from(part)));
  const raw = new Uint8Array(inflateSync(compressed));
  const pixels = unfilter(raw, width, height, channels, bitDepth);
  const rgba = new Uint8Array(width * height * 4);
  const stride = Math.ceil((width * channels * bitDepth) / 8);

  for (let y = 0; y < height; y += 1) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      if (colorType === 3) {
        const index = sample(row, x, bitDepth);
        const p = index * 3;
        if (palette === undefined || p + 2 >= palette.length) throw new Error('PNG 调色板索引越界');
        rgba[out] = palette[p] ?? 0;
        rgba[out + 1] = palette[p + 1] ?? 0;
        rgba[out + 2] = palette[p + 2] ?? 0;
        rgba[out + 3] = transparency?.[index] ?? 255;
      } else if (colorType === 0) {
        const grey = scale(sample(row, x, bitDepth), bitDepth);
        rgba[out] = grey;
        rgba[out + 1] = grey;
        rgba[out + 2] = grey;
        rgba[out + 3] = 255;
      } else if (colorType === 4) {
        const grey = row[x * 2] ?? 0;
        rgba[out] = grey;
        rgba[out + 1] = grey;
        rgba[out + 2] = grey;
        rgba[out + 3] = row[x * 2 + 1] ?? 255;
      } else if (colorType === 2) {
        rgba[out] = row[x * 3] ?? 0;
        rgba[out + 1] = row[x * 3 + 1] ?? 0;
        rgba[out + 2] = row[x * 3 + 2] ?? 0;
        rgba[out + 3] = 255;
      } else {
        rgba[out] = row[x * 4] ?? 0;
        rgba[out + 1] = row[x * 4 + 1] ?? 0;
        rgba[out + 2] = row[x * 4 + 2] ?? 0;
        rgba[out + 3] = row[x * 4 + 3] ?? 255;
      }
    }
  }
  return { width, height, rgba };
}
