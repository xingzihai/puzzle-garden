/**
 * 最小 ZIP 读取器：只支持 Minecraft client jar 用到的 store / deflate。
 *
 * 负责：解析中央目录、按需解压单个条目、路径与长度校验；不负责下载或写文件。
 * 只支持非 ZIP64、单盘；22 MB 的 1.20.1 jar 远低于这些边界。
 */

import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}
function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= min; offset -= 1) {
    if (u32(view, offset) === EOCD) return offset;
  }
  throw new Error('ZIP 缺少中央目录结尾记录（不是 zip 或已损坏）');
}

/** 读取中央目录；zip64 / 加密 / 多盘直接报错。 */
export function readZipDirectory(buffer: Uint8Array): ZipEntry[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const eocd = findEocd(view);
  const count = u16(view, eocd + 10);
  const offset = u32(view, eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('不支持 ZIP64');
  const entries: ZipEntry[] = [];
  let cursor = offset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > view.byteLength) throw new Error(`中央目录第 ${String(i)} 项越界`);
    if (u32(view, cursor) !== CENTRAL) throw new Error(`中央目录第 ${String(i)} 项签名不对`);
    const flags = u16(view, cursor + 8);
    if ((flags & 1) !== 0) throw new Error(`条目加密，拒绝处理：${String(i)}`);
    const method = u16(view, cursor + 10);
    const crc = u32(view, cursor + 16);
    const compressed = u32(view, cursor + 20);
    const uncompressed = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localHeaderOffset = u32(view, cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > view.byteLength) throw new Error('中央目录文件名越界');
    const name = new TextDecoder().decode(buffer.subarray(nameStart, nameEnd));
    entries.push({
      name,
      method,
      compressedSize: compressed,
      uncompressedSize: uncompressed,
      crc32: crc,
      localHeaderOffset,
    });
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/** 解压一个条目并校验 CRC；不支持的压缩方法直接报错。 */
export function readZipEntry(buffer: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const local = entry.localHeaderOffset;
  if (local + 30 > view.byteLength) throw new Error(`条目 ${entry.name} 的本地头越界`);
  if (u32(view, local) !== LOCAL) throw new Error(`条目 ${entry.name} 的本地头签名不对`);
  const nameLength = u16(view, local + 26);
  const extraLength = u16(view, local + 28);
  const start = local + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.byteLength) throw new Error(`条目 ${entry.name} 的数据越界`);
  const raw = buffer.subarray(start, end);
  let data: Uint8Array;
  if (entry.method === 0) data = new Uint8Array(raw);
  else if (entry.method === 8) data = new Uint8Array(inflateRawSync(raw));
  else throw new Error(`条目 ${entry.name} 使用不支持的压缩方法 ${String(entry.method)}`);
  if (data.byteLength !== entry.uncompressedSize)
    throw new Error(
      `条目 ${entry.name} 解压后 ${String(data.byteLength)} 字节，期望 ${String(entry.uncompressedSize)}`,
    );
  if (crc32(data) !== entry.crc32) throw new Error(`条目 ${entry.name} CRC 校验失败`);
  return data;
}

/** 按前缀筛选中央目录条目。 */
export function zipEntriesUnder(entries: readonly ZipEntry[], prefix: string): ZipEntry[] {
  return entries.filter((entry) => entry.name.startsWith(prefix) && !entry.name.endsWith('/'));
}
