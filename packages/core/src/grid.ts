/**
 * 稀疏体素网格：区块存储、调色板、部件表、调用表、挖空记录（docs/CORE-SPEC.md §4）。
 *
 * 负责：按"后写覆盖"记录每格的方块状态与来源（部件、调用），以及挖空的来源。
 * 不负责：写入冲突的优先级（开洞 > 结构 > 装饰，由 @pg/geometry 在写入前决定）、hash、存档字节。
 */

import { formatState, isAir } from './block-state.ts';
import type { BlockState, BlockTable } from './block-state.ts';
import { CoreError, checkCoord, chunkCoord, chunkKey } from './coord.ts';

/** 部件 id：正整数；用在"引用"的位置时 0 表示"无"。 */
export type PartId = number;
/** 调用 id：正整数；用在"引用"的位置时 0 表示"无"。 */
export type CallId = number;

export interface PartDef {
  readonly id: PartId;
  readonly name: string;
  /** 0 表示没有父部件。 */
  readonly parent: PartId;
}

export interface CallDef {
  readonly id: CallId;
  readonly api: string;
  /** 0 表示未知。 */
  readonly line: number;
  /** 规范 JSON，最长 200 个 UTF-16 码元（超出时截断并加 `…`）。 */
  readonly args: string;
}

export interface Cell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly state: BlockState;
  readonly part: PartId;
  readonly call: CallId;
}

export interface CarvedCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly call: CallId;
}

export interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

const CHUNK_VOLUME = 4096;
const ARGS_MAX = 200;

interface Chunk {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** 调色板索引 + 1；0 表示空。 */
  readonly state: Uint32Array;
  readonly part: Uint32Array;
  readonly call: Uint32Array;
  count: number;
}

/** 区块内下标 `(ly << 8) | (lz << 4) | lx`。 */
function localIndex(x: number, y: number, z: number, c: Chunk): number {
  return ((y - c.cy * 16) << 8) | ((z - c.cz * 16) << 4) | (x - c.cx * 16);
}

function canonicalJson(value: unknown, stack: object[], inArray: boolean): string | undefined {
  switch (typeof value) {
    case 'undefined':
      return inArray ? 'null' : undefined;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'string':
      return JSON.stringify(value);
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new CoreError('invalid-argument', `defineCall 的 args 不能含 ${typeof value}`);
    case 'object': {
      if (value === null) return 'null';
      if (stack.includes(value)) throw new CoreError('invalid-argument', 'defineCall 的 args 有循环引用');
      stack.push(value);
      let out: string;
      if (Array.isArray(value)) {
        const items: unknown[] = value;
        out = `[${items.map((v) => canonicalJson(v, stack, true) ?? 'null').join(',')}]`;
      } else {
        const rec = value as Record<string, unknown>;
        const parts: string[] = [];
        for (const k of Object.keys(rec).sort()) {
          const v = canonicalJson(rec[k], stack, false);
          if (v !== undefined) parts.push(`${JSON.stringify(k)}:${v}`);
        }
        out = `{${parts.join(',')}}`;
      }
      stack.pop();
      return out;
    }
  }
}

/**
 * args 的规范 JSON（CORE-SPEC §4.1）。顶层 `undefined` 写成 `null`（规格未单列，按数组元素同样处理）。
 * 超过 200 个码元时截断并加 `…`，不切开代理对。
 */
function canonicalArgs(args: unknown): string {
  const json = canonicalJson(args, [], true) ?? 'null';
  if (json.length <= ARGS_MAX) return json;
  let end = ARGS_MAX;
  const last = json.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${json.slice(0, end)}…`;
}

export class Grid {
  readonly table: BlockTable;
  readonly #chunks = new Map<number, Chunk>();
  readonly #palette: BlockState[] = [];
  readonly #paletteIndex = new Map<string, number>();
  readonly #parts = new Map<PartId, PartDef>();
  readonly #calls = new Map<CallId, CallDef>();
  /** 区块键 → 区块内下标 → 调用 id。 */
  readonly #carved = new Map<number, Map<number, CallId>>();
  #size = 0;
  #nextPart = 1;
  #nextCall = 1;

  constructor(table: BlockTable) {
    this.table = table;
  }

  /** 实体格数。 */
  get size(): number {
    return this.#size;
  }

  definePart(name: string, parent: PartId = 0): PartId {
    if (typeof name !== 'string' || name === '') {
      throw new CoreError('invalid-argument', `部件名必须是非空字符串，实际是 ${JSON.stringify(name)}`);
    }
    if (parent !== 0 && !this.#parts.has(parent)) {
      throw new CoreError('unknown-part', `父部件 ${String(parent)} 不存在，必须先定义父部件`);
    }
    const id = this.#nextPart;
    this.#parts.set(id, { id, name, parent });
    this.#nextPart = id + 1;
    return id;
  }

  defineCall(api: string, line: number, args: unknown): CallId {
    if (typeof api !== 'string' || api === '') {
      throw new CoreError('invalid-argument', `api 必须是非空字符串，实际是 ${JSON.stringify(api)}`);
    }
    if (!Number.isSafeInteger(line) || line < 0) {
      throw new CoreError('invalid-argument', `line 必须是非负整数（0 表示未知），实际是 ${String(line)}`);
    }
    const id = this.#nextCall;
    this.#calls.set(id, { id, api, line, args: canonicalArgs(args) });
    this.#nextCall = id + 1;
    return id;
  }

  /** 部件表，按 id 升序。 */
  parts(): readonly PartDef[] {
    return [...this.#parts.values()].sort((a, b) => a.id - b.id);
  }

  /** 调用表，按 id 升序。 */
  calls(): readonly CallDef[] {
    return [...this.#calls.values()].sort((a, b) => a.id - b.id);
  }

  set(x: number, y: number, z: number, state: BlockState, part: PartId, call: CallId): void {
    checkCoord(x, y, z);
    if (part !== 0 && !this.#parts.has(part)) throw new CoreError('unknown-part', `部件 ${String(part)} 不存在`);
    if (call !== 0 && !this.#calls.has(call)) throw new CoreError('unknown-call', `调用 ${String(call)} 不存在`);
    const cx = chunkCoord(x);
    const cy = chunkCoord(y);
    const cz = chunkCoord(z);
    const key = chunkKey(cx, cy, cz);
    if (isAir(state)) {
      if (part !== 0) {
        throw new CoreError('invalid-argument', `挖空（写空气）不属于任何部件，part 必须为 0，实际是 ${String(part)}`);
      }
      this.#carve(key, cx, cy, cz, x, y, z, call);
      return;
    }
    let chunk = this.#chunks.get(key);
    if (chunk === undefined) {
      chunk = {
        cx,
        cy,
        cz,
        state: new Uint32Array(CHUNK_VOLUME),
        part: new Uint32Array(CHUNK_VOLUME),
        call: new Uint32Array(CHUNK_VOLUME),
        count: 0,
      };
      this.#chunks.set(key, chunk);
    }
    const i = localIndex(x, y, z, chunk);
    if (chunk.state[i] === 0) {
      chunk.count += 1;
      this.#size += 1;
    }
    chunk.state[i] = this.#paletteSlot(state) + 1;
    chunk.part[i] = part;
    chunk.call[i] = call;
    const carvedHere = this.#carved.get(key);
    if (carvedHere?.delete(i) === true && carvedHere.size === 0) this.#carved.delete(key);
  }

  #carve(key: number, cx: number, cy: number, cz: number, x: number, y: number, z: number, call: CallId): void {
    const i = ((y - cy * 16) << 8) | ((z - cz * 16) << 4) | (x - cx * 16);
    const chunk = this.#chunks.get(key);
    if (chunk !== undefined && chunk.state[i] !== 0) {
      chunk.state[i] = 0;
      chunk.part[i] = 0;
      chunk.call[i] = 0;
      chunk.count -= 1;
      this.#size -= 1;
      if (chunk.count === 0) this.#chunks.delete(key);
    }
    let carvedHere = this.#carved.get(key);
    if (call !== 0) {
      if (carvedHere === undefined) {
        carvedHere = new Map();
        this.#carved.set(key, carvedHere);
      }
      carvedHere.set(i, call);
    } else if (carvedHere?.delete(i) === true && carvedHere.size === 0) {
      // 来源未知的挖空：删掉旧记录，不保留一个可能已经不对的来源。
      this.#carved.delete(key);
    }
  }

  #paletteSlot(state: BlockState): number {
    const text = formatState(state);
    let slot = this.#paletteIndex.get(text);
    if (slot === undefined) {
      slot = this.#palette.length;
      this.#palette.push(state);
      this.#paletteIndex.set(text, slot);
    }
    return slot;
  }

  get(x: number, y: number, z: number): Cell | undefined {
    checkCoord(x, y, z);
    const cx = chunkCoord(x);
    const cy = chunkCoord(y);
    const cz = chunkCoord(z);
    const chunk = this.#chunks.get(chunkKey(cx, cy, cz));
    if (chunk === undefined) return undefined;
    const i = localIndex(x, y, z, chunk);
    const slot = chunk.state[i] ?? 0;
    const state = this.#palette[slot - 1];
    if (state === undefined) return undefined;
    return { x, y, z, state, part: chunk.part[i] ?? 0, call: chunk.call[i] ?? 0 };
  }

  /** 全部实体格；顺序不作保证。 */
  *cells(): Generator<Cell> {
    for (const c of this.#chunks.values()) {
      const bx = c.cx * 16;
      const by = c.cy * 16;
      const bz = c.cz * 16;
      for (let i = 0; i < CHUNK_VOLUME; i += 1) {
        const slot = c.state[i] ?? 0;
        if (slot === 0) continue;
        const state = this.#palette[slot - 1];
        // 调色板只增不减，slot 一定有效；这里的判断只为收窄类型。
        if (state === undefined) continue;
        yield {
          x: bx + (i & 15),
          y: by + (i >> 8),
          z: bz + ((i >> 4) & 15),
          state,
          part: c.part[i] ?? 0,
          call: c.call[i] ?? 0,
        };
      }
    }
  }

  /** 挖空记录；顺序不作保证。 */
  *carved(): Generator<CarvedCell> {
    for (const [key, cells] of this.#carved) {
      // 从区块键反解区块坐标，与 chunkKey 的打包方式对应。
      const cz = (key % 2 ** 22) - 2 ** 21;
      const rest = Math.floor(key / 2 ** 22);
      const cy = (rest % 256) - 128;
      const cx = Math.floor(rest / 256) - 2 ** 21;
      for (const [i, call] of cells) {
        yield { x: cx * 16 + (i & 15), y: cy * 16 + (i >> 8), z: cz * 16 + ((i >> 4) & 15), call };
      }
    }
  }

  /** 实体格的闭区间包围盒；没有实体格时为 undefined。 */
  bounds(): Bounds | undefined {
    if (this.#size === 0) return undefined;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const { x, y, z } of this.cells()) {
      const p = [x, y, z];
      for (let a = 0; a < 3; a += 1) {
        const v = p[a] ?? 0;
        if (v < (min[a] ?? 0)) min[a] = v;
        if (v > (max[a] ?? 0)) max[a] = v;
      }
    }
    return { min: [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0], max: [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0] };
  }

  /**
   * 按给定 id 恢复部件与调用表（存档读取用）。只能在空网格上调用一次；之后新 id 从最大 id + 1 起。
   * 表必须按 id 升序、id 为正且不重复，部件的 parent 为 0 或已出现的更小 id。
   */
  restoreTables(parts: readonly PartDef[], calls: readonly CallDef[]): void {
    if (this.#parts.size > 0 || this.#calls.size > 0 || this.#size > 0 || this.#carved.size > 0) {
      throw new CoreError('invalid-argument', 'restoreTables 只能用于空网格');
    }
    let prev = 0;
    for (const p of parts) {
      if (!Number.isSafeInteger(p.id) || p.id <= prev) {
        throw new CoreError('invalid-argument', `部件 id 必须为正整数且严格升序，${String(p.id)} 不满足`);
      }
      if (p.parent !== 0 && !this.#parts.has(p.parent)) {
        throw new CoreError('unknown-part', `部件 ${String(p.id)} 的父部件 ${String(p.parent)} 不存在或不比它小`);
      }
      if (p.name === '') throw new CoreError('invalid-argument', `部件 ${String(p.id)} 的名字为空`);
      this.#parts.set(p.id, { id: p.id, name: p.name, parent: p.parent });
      prev = p.id;
    }
    this.#nextPart = prev + 1;
    prev = 0;
    for (const c of calls) {
      if (!Number.isSafeInteger(c.id) || c.id <= prev) {
        throw new CoreError('invalid-argument', `调用 id 必须为正整数且严格升序，${String(c.id)} 不满足`);
      }
      if (c.api === '') throw new CoreError('invalid-argument', `调用 ${String(c.id)} 的 api 为空`);
      this.#calls.set(c.id, { id: c.id, api: c.api, line: c.line, args: c.args });
      prev = c.id;
    }
    this.#nextCall = prev + 1;
  }
}

export function createGrid(table: BlockTable): Grid {
  return new Grid(table);
}
