/**
 * 存档格式 v1：网格 ⇄ 字节（docs/CORE-SPEC.md §6）。
 *
 * 负责：写出唯一的规范字节形式（剔除未用项、排序），读取时只接受规范形式，其余一律报错。
 * 不负责：API 版本的含义（原样读出，交给调用方判断）、文件读写。
 */

import { formatState, parseState } from './block-state.ts';
import type { BlockState, BlockTable } from './block-state.ts';
import { CoreError, checkCoord, chunkCoord } from './coord.ts';
import { createGrid } from './grid.ts';
import type { CallDef, CallId, Cell, Grid, PartDef, PartId } from './grid.ts';

const MAGIC = [0x50, 0x47, 0x41, 0x52]; // "PGAR"
const FORMAT_VERSION = 1;
const FLAG_EMPTY = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function cmp(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 字符串按码点比较（不用 localeCompare）。 */
function cmpText(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) ?? 0;
    const cb = b.codePointAt(j) ?? 0;
    if (ca !== cb) return cmp(ca, cb);
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return cmp(a.length - i, b.length - j);
}

class Writer {
  #buf = new Uint8Array(1024);
  #view = new DataView(this.#buf.buffer);
  #len = 0;

  #reserve(n: number): void {
    if (this.#len + n <= this.#buf.length) return;
    let cap = this.#buf.length * 2;
    while (cap < this.#len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
    this.#view = new DataView(next.buffer);
  }

  u16(v: number): void {
    this.#reserve(2);
    this.#view.setUint16(this.#len, v, true);
    this.#len += 2;
  }

  u32(v: number): void {
    this.#reserve(4);
    this.#view.setUint32(this.#len, v, true);
    this.#len += 4;
  }

  i32(v: number): void {
    this.#reserve(4);
    this.#view.setInt32(this.#len, v, true);
    this.#len += 4;
  }

  bytes(b: Uint8Array | readonly number[]): void {
    this.#reserve(b.length);
    this.#buf.set(b, this.#len);
    this.#len += b.length;
  }

  str(s: string): void {
    const b = encoder.encode(s);
    this.u32(b.length);
    this.bytes(b);
  }

  finish(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }
}

function bad(reason: string): CoreError {
  return new CoreError('invalid-archive', `存档不合法：${reason}`);
}

class Reader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #pos = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  #need(n: number, what: string): void {
    if (this.#pos + n > this.#bytes.length) {
      throw bad(
        `读 ${what} 时数据截断（偏移 ${String(this.#pos)}，还需 ${String(n)} 字节，总长 ${String(this.#bytes.length)}）`,
      );
    }
  }

  u16(what: string): number {
    this.#need(2, what);
    const v = this.#view.getUint16(this.#pos, true);
    this.#pos += 2;
    return v;
  }

  u32(what: string): number {
    this.#need(4, what);
    const v = this.#view.getUint32(this.#pos, true);
    this.#pos += 4;
    return v;
  }

  i32(what: string): number {
    this.#need(4, what);
    const v = this.#view.getInt32(this.#pos, true);
    this.#pos += 4;
    return v;
  }

  bytes(n: number, what: string): Uint8Array {
    this.#need(n, what);
    const b = this.#bytes.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return b;
  }

  str(what: string): string {
    const n = this.u32(`${what}长度`);
    const b = this.bytes(n, what);
    try {
      return decoder.decode(b);
    } catch {
      throw bad(`${what}不是合法的 UTF-8`);
    }
  }

  /** 表项数量：每项至少 minBytes 字节，数量明显超过剩余长度时直接判截断，避免按坏数量分配大数组。 */
  count(what: string, minBytes: number): number {
    const n = this.u32(`${what}数量`);
    this.#need(n * minBytes, `${what}（${String(n)} 项）`);
    return n;
  }

  end(): void {
    if (this.#pos !== this.#bytes.length) {
      throw bad(`读完后还有 ${String(this.#bytes.length - this.#pos)} 字节多余数据`);
    }
  }
}

interface ChunkCells {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly cells: { readonly i: number; readonly cell: Cell }[];
}

/** 写出规范字节（CORE-SPEC §6.1）。apiVersion 是 0–65535 的整数。 */
export function writeArchive(grid: Grid, apiVersion: number): Uint8Array {
  if (!Number.isInteger(apiVersion) || apiVersion < 0 || apiVersion > 0xffff) {
    throw new CoreError('invalid-argument', `apiVersion 必须是 0–65535 的整数，实际是 ${String(apiVersion)}`);
  }

  // 按区块归组，同时收集用到的状态、部件、调用。
  const chunks = new Map<string, ChunkCells>();
  const usedStates = new Map<string, BlockState>();
  const usedParts = new Set<PartId>();
  const usedCalls = new Set<CallId>();
  for (const cell of grid.cells()) {
    const cx = chunkCoord(cell.x);
    const cy = chunkCoord(cell.y);
    const cz = chunkCoord(cell.z);
    const k = `${String(cx)},${String(cy)},${String(cz)}`;
    let c = chunks.get(k);
    if (c === undefined) {
      c = { cx, cy, cz, cells: [] };
      chunks.set(k, c);
    }
    c.cells.push({ i: ((cell.y - cy * 16) << 8) | ((cell.z - cz * 16) << 4) | (cell.x - cx * 16), cell });
    usedStates.set(formatState(cell.state), cell.state);
    if (cell.part !== 0) usedParts.add(cell.part);
    if (cell.call !== 0) usedCalls.add(cell.call);
  }
  const carved = [...grid.carved()];
  for (const c of carved) usedCalls.add(c.call);

  const allParts = new Map(grid.parts().map((p) => [p.id, p]));
  for (const id of [...usedParts]) {
    let p = allParts.get(id)?.parent ?? 0;
    while (p !== 0 && !usedParts.has(p)) {
      usedParts.add(p);
      p = allParts.get(p)?.parent ?? 0;
    }
  }
  const parts = grid.parts().filter((p) => usedParts.has(p.id));
  const calls = grid.calls().filter((c) => usedCalls.has(c.id));

  const palette = [...usedStates.keys()].sort(cmpText);
  const paletteIndex = new Map(palette.map((s, i) => [s, i]));

  const w = new Writer();
  w.bytes(MAGIC);
  w.u16(FORMAT_VERSION);
  w.u16(apiVersion);
  w.u16(grid.size === 0 ? FLAG_EMPTY : 0);
  w.u16(0);
  const b = grid.bounds();
  for (const v of b === undefined ? [0, 0, 0, 0, 0, 0] : [...b.min, ...b.max]) w.i32(v);
  w.u32(grid.size);

  w.u32(palette.length);
  for (const s of palette) w.str(s);

  w.u32(parts.length);
  for (const p of parts) {
    w.u32(p.id);
    w.u32(p.parent);
    w.str(p.name);
  }

  w.u32(calls.length);
  for (const c of calls) {
    w.u32(c.id);
    w.u32(c.line);
    w.str(c.api);
    w.str(c.args);
  }

  const sortedChunks = [...chunks.values()].sort((a, b2) => cmp(a.cy, b2.cy) || cmp(a.cz, b2.cz) || cmp(a.cx, b2.cx));
  w.u32(sortedChunks.length);
  for (const c of sortedChunks) {
    w.i32(c.cx);
    w.i32(c.cy);
    w.i32(c.cz);
    c.cells.sort((a, b2) => a.i - b2.i);
    w.u16(c.cells.length);
    for (const { i, cell } of c.cells) {
      w.u16(i);
      w.u32(paletteIndex.get(formatState(cell.state)) ?? 0);
      w.u32(cell.part);
      w.u32(cell.call);
    }
  }

  carved.sort((a, b2) => cmp(a.y, b2.y) || cmp(a.z, b2.z) || cmp(a.x, b2.x));
  w.u32(carved.length);
  for (const c of carved) {
    w.i32(c.x);
    w.i32(c.y);
    w.i32(c.z);
    w.u32(c.call);
  }
  return w.finish();
}

/** 读出的网格与 API 版本。 */
export interface ArchiveContents {
  readonly grid: Grid;
  readonly apiVersion: number;
}

/**
 * 读取规范形式的存档（CORE-SPEC §6.2），任何偏离都抛 `invalid-archive`。
 * 返回网格与原样读出的 API 版本。
 */
export function readArchive(table: BlockTable, bytes: Uint8Array): ArchiveContents {
  try {
    return decode(table, bytes);
  } catch (e) {
    if (e instanceof CoreError && e.code !== 'invalid-archive') throw bad(e.message);
    throw e;
  }
}

function decode(table: BlockTable, bytes: Uint8Array): ArchiveContents {
  const r = new Reader(bytes);
  const magic = r.bytes(4, 'magic');
  if (!MAGIC.every((m, i) => magic[i] === m)) throw bad('magic 不是 PGAR');
  const version = r.u16('格式版本');
  if (version !== FORMAT_VERSION) throw bad(`格式版本是 ${String(version)}，只支持 ${String(FORMAT_VERSION)}`);
  const apiVersion = r.u16('API 版本');
  const flags = r.u16('标志');
  if ((flags & ~FLAG_EMPTY) !== 0) throw bad(`标志有未定义的位（0x${flags.toString(16)}）`);
  if (r.u16('保留字段') !== 0) throw bad('保留字段不为 0');
  const box = [0, 1, 2, 3, 4, 5].map(() => r.i32('包围盒'));
  const total = r.u32('实体格数');
  if (((flags & FLAG_EMPTY) !== 0) !== (total === 0)) throw bad(`标志 bit0 与实体格数 ${String(total)} 不一致`);

  // 调色板
  const palette: BlockState[] = [];
  const nPalette = r.count('调色板', 4);
  for (let i = 0; i < nPalette; i += 1) {
    const text = r.str(`调色板第 ${String(i)} 项`);
    const prev = palette[i - 1];
    if (prev !== undefined && cmpText(formatState(prev), text) >= 0) throw bad('调色板未按码点严格升序（或有重复）');
    const state = parseState(table, text);
    if (formatState(state) !== text) throw bad(`调色板项 ${text} 不是规范形式（应为 ${formatState(state)}）`);
    if (state.name === 'air') throw bad('调色板里不能有空气');
    palette.push(state);
  }

  // 部件表
  const parts: PartDef[] = [];
  const nParts = r.count('部件表', 12);
  for (let i = 0; i < nParts; i += 1) {
    const id = r.u32('部件 id');
    const parent = r.u32('部件 parent');
    const name = r.str('部件名');
    const prevId = parts[i - 1]?.id ?? 0;
    if (id <= prevId) throw bad(`部件表未按 id 严格升序，或 id 为 0（${String(id)}）`);
    if (parent !== 0 && !parts.some((p) => p.id === parent)) {
      throw bad(`部件 ${String(id)} 的 parent ${String(parent)} 不是 0 也不是比它小的已有 id`);
    }
    parts.push({ id, parent, name });
  }

  // 调用表
  const calls: CallDef[] = [];
  const nCalls = r.count('调用表', 16);
  for (let i = 0; i < nCalls; i += 1) {
    const id = r.u32('调用 id');
    const line = r.u32('调用 line');
    const api = r.str('调用 api');
    const args = r.str('调用 args');
    const prevId = calls[i - 1]?.id ?? 0;
    if (id <= prevId) throw bad(`调用表未按 id 严格升序，或 id 为 0（${String(id)}）`);
    calls.push({ id, line, api, args });
  }

  const grid = createGrid(table);
  grid.restoreTables(parts, calls);
  const partIds = new Set(parts.map((p) => p.id));
  const callIds = new Set(calls.map((c) => c.id));
  const usedPalette = new Set<number>();
  const usedParts = new Set<PartId>();
  const usedCalls = new Set<CallId>();

  // 区块
  const nChunks = r.count('区块', 14);
  let prevChunk: readonly [number, number, number] | undefined;
  let seen = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < nChunks; c += 1) {
    const cx = r.i32('区块 cx');
    const cy = r.i32('区块 cy');
    const cz = r.i32('区块 cz');
    checkCoord(cx * 16, cy * 16, cz * 16);
    if (prevChunk !== undefined && (cmp(prevChunk[1], cy) || cmp(prevChunk[2], cz) || cmp(prevChunk[0], cx)) >= 0) {
      throw bad('区块未按 (cy, cz, cx) 严格升序（或有重复）');
    }
    prevChunk = [cx, cy, cz];
    const n = r.u16('区块格数');
    if (n === 0) throw bad(`区块 (${String(cx)}, ${String(cy)}, ${String(cz)}) 格数为 0`);
    let prevIndex = -1;
    for (let k = 0; k < n; k += 1) {
      const i = r.u16('区块内下标');
      const pi = r.u32('调色板索引');
      const part = r.u32('部件 id');
      const call = r.u32('调用 id');
      if (i >= 4096) throw bad(`区块内下标 ${String(i)} 越界（应 < 4096）`);
      if (i <= prevIndex) throw bad('区块内格未按下标严格升序（或有重复）');
      prevIndex = i;
      const state = palette[pi];
      if (state === undefined) throw bad(`调色板索引 ${String(pi)} 越界（共 ${String(palette.length)} 项）`);
      if (part !== 0 && !partIds.has(part)) throw bad(`格引用了不存在的部件 ${String(part)}`);
      if (call !== 0 && !callIds.has(call)) throw bad(`格引用了不存在的调用 ${String(call)}`);
      usedPalette.add(pi);
      if (part !== 0) usedParts.add(part);
      if (call !== 0) usedCalls.add(call);
      const p: readonly [number, number, number] = [cx * 16 + (i & 15), cy * 16 + (i >> 8), cz * 16 + ((i >> 4) & 15)];
      for (let a = 0; a < 3; a += 1) {
        min[a] = Math.min(min[a] ?? 0, p[a] ?? 0);
        max[a] = Math.max(max[a] ?? 0, p[a] ?? 0);
      }
      grid.set(p[0], p[1], p[2], state, part, call);
    }
    seen += n;
  }
  if (seen !== total) throw bad(`头部实体格数 ${String(total)} 与区块里的格总数 ${String(seen)} 不符`);
  const expectBox = total === 0 ? [0, 0, 0, 0, 0, 0] : [...min, ...max];
  if (!expectBox.every((v, i) => v === box[i])) {
    throw bad(`包围盒 [${box.join(', ')}] 与实际格 [${expectBox.join(', ')}] 不符`);
  }

  // 挖空记录
  const air = parseState(table, 'air');
  const nCarved = r.count('挖空记录', 16);
  let prevCarved: readonly [number, number, number] | undefined;
  for (let k = 0; k < nCarved; k += 1) {
    const x = r.i32('挖空 x');
    const y = r.i32('挖空 y');
    const z = r.i32('挖空 z');
    const call = r.u32('挖空调用 id');
    checkCoord(x, y, z);
    if (prevCarved !== undefined && (cmp(prevCarved[1], y) || cmp(prevCarved[2], z) || cmp(prevCarved[0], x)) >= 0) {
      throw bad('挖空记录未按 (y, z, x) 严格升序（或有重复）');
    }
    prevCarved = [x, y, z];
    if (call === 0) throw bad(`挖空记录 (${String(x)}, ${String(y)}, ${String(z)}) 的调用 id 为 0`);
    if (!callIds.has(call)) throw bad(`挖空记录引用了不存在的调用 ${String(call)}`);
    if (grid.get(x, y, z) !== undefined) throw bad(`挖空记录 (${String(x)}, ${String(y)}, ${String(z)}) 与实体格重叠`);
    usedCalls.add(call);
    grid.set(x, y, z, air, 0, call);
  }
  r.end();

  if (usedPalette.size !== palette.length) throw bad('调色板有未被用到的项');
  // 被用到的部件的祖先也算被用到。
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const id of [...usedParts]) {
    let p = byId.get(id)?.parent ?? 0;
    while (p !== 0 && !usedParts.has(p)) {
      usedParts.add(p);
      p = byId.get(p)?.parent ?? 0;
    }
  }
  if (usedParts.size !== parts.length) throw bad('部件表有未被用到的项');
  if (usedCalls.size !== calls.length) throw bad('调用表有未被用到的项');
  return { grid, apiVersion };
}
