import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { readArchive, writeArchive } from './archive.ts';
import { createBlockTable, formatState, parseState } from './block-state.ts';
import { CoreError } from './coord.ts';
import { createGrid } from './grid.ts';
import type { Grid } from './grid.ts';
import { hashGrid } from './hash.ts';

const table = createBlockTable(
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../assets/mc-1.20.1/block-states.json'), 'utf8')),
);
const S = (t: string) => parseState(table, t);

/** 网格在 CORE-SPEC §6.1 意义下的全部内容。 */
function snapshot(g: Grid) {
  const cells = [...g.cells()]
    .map(
      (c) => `${String(c.x)},${String(c.y)},${String(c.z)}=${formatState(c.state)}/${String(c.part)}/${String(c.call)}`,
    )
    .sort();
  const carved = [...g.carved()].map((c) => `${String(c.x)},${String(c.y)},${String(c.z)}@${String(c.call)}`).sort();
  return { cells, carved, parts: g.parts(), calls: g.calls(), size: g.size, bounds: g.bounds() };
}

// ---- 测试用的原始编码器：按描述逐字段写字节，用来构造非规范存档 ----

interface Raw {
  magic?: string;
  version?: number;
  api?: number;
  flags?: number;
  reserved?: number;
  box: number[];
  total: number;
  palette: string[];
  parts: [number, number, string][];
  calls: [number, number, string, string][];
  chunks: { c: [number, number, number]; cells: [number, number, number, number][] }[];
  carved: [number, number, number, number][];
  tail?: number[];
}

function encode(r: Raw): Uint8Array {
  const out: number[] = [];
  const dv = new DataView(new ArrayBuffer(4));
  const u16 = (v: number) => {
    dv.setUint16(0, v, true);
    out.push(dv.getUint8(0), dv.getUint8(1));
  };
  const u32 = (v: number) => {
    dv.setUint32(0, v, true);
    out.push(...new Uint8Array(dv.buffer));
  };
  const i32 = (v: number) => {
    dv.setInt32(0, v, true);
    out.push(...new Uint8Array(dv.buffer));
  };
  const str = (s: string) => {
    const b = new TextEncoder().encode(s);
    u32(b.length);
    out.push(...b);
  };
  out.push(...new TextEncoder().encode(r.magic ?? 'PGAR'));
  u16(r.version ?? 1);
  u16(r.api ?? 7);
  u16(r.flags ?? (r.total === 0 ? 1 : 0));
  u16(r.reserved ?? 0);
  for (const v of r.box) i32(v);
  u32(r.total);
  u32(r.palette.length);
  for (const s of r.palette) str(s);
  u32(r.parts.length);
  for (const [id, parent, name] of r.parts) {
    u32(id);
    u32(parent);
    str(name);
  }
  u32(r.calls.length);
  for (const [id, line, api, args] of r.calls) {
    u32(id);
    u32(line);
    str(api);
    str(args);
  }
  u32(r.chunks.length);
  for (const ch of r.chunks) {
    for (const v of ch.c) i32(v);
    u16(ch.cells.length);
    for (const [i, pi, part, call] of ch.cells) {
      u16(i);
      u32(pi);
      u32(part);
      u32(call);
    }
  }
  u32(r.carved.length);
  for (const [x, y, z, call] of r.carved) {
    i32(x);
    i32(y);
    i32(z);
    u32(call);
  }
  out.push(...(r.tail ?? []));
  return new Uint8Array(out);
}

/** 一个合法的基准存档：两个区块、两个部件（父子）、两个调用、一条挖空记录。 */
function base(): Raw {
  return {
    box: [0, 0, 0, 16, 1, 0],
    total: 3,
    palette: ['oak_planks', 'stone'],
    parts: [
      [1, 0, '墙'],
      [2, 1, '窗'],
    ],
    calls: [
      [1, 3, 'wall', '{}'],
      [2, 0, 'hole', '{"w":1}'],
    ],
    chunks: [
      {
        c: [0, 0, 0],
        cells: [
          [0, 1, 2, 1],
          [256, 0, 0, 0],
        ],
      },
      { c: [1, 0, 0], cells: [[0, 1, 1, 0]] },
    ],
    carved: [[5, 0, 0, 2]],
  };
}

function baseGrid(): Grid {
  const g = createGrid(table);
  const wall = g.definePart('墙');
  const win = g.definePart('窗', wall);
  const c1 = g.defineCall('wall', 3, {});
  const c2 = g.defineCall('hole', 0, { w: 1 });
  g.set(16, 0, 0, S('stone'), wall, 0);
  g.set(0, 1, 0, S('oak_planks'), 0, 0);
  g.set(0, 0, 0, S('stone'), win, c1);
  g.set(5, 0, 0, S('air'), 0, c2);
  return g;
}

function rejects(r: Raw | Uint8Array, re: RegExp): void {
  const bytes = r instanceof Uint8Array ? r : encode(r);
  let err: unknown;
  try {
    readArchive(table, bytes);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof CoreError, `应当报错：${String(re)}`);
  assert.equal(err.code, 'invalid-archive');
  assert.match(err.message, re);
}

describe('writeArchive', () => {
  it('输出与逐字段编码的规范形式逐字节相同', () => {
    assert.deepEqual(writeArchive(baseGrid(), 7), encode(base()));
  });

  it('空网格', () => {
    const bytes = writeArchive(createGrid(table), 0);
    assert.deepEqual(
      bytes,
      encode({ api: 0, box: [0, 0, 0, 0, 0, 0], total: 0, palette: [], parts: [], calls: [], chunks: [], carved: [] }),
    );
    const { grid, apiVersion } = readArchive(table, bytes);
    assert.equal(grid.size, 0);
    assert.equal(apiVersion, 0);
  });

  it('剔除未用的调色板项、部件、调用；保留祖先部件', () => {
    const g = createGrid(table);
    const root = g.definePart('根');
    g.definePart('没用');
    const leaf = g.definePart('叶', root);
    g.defineCall('没用', 0, {});
    const used = g.defineCall('用', 0, {});
    g.set(0, 0, 0, S('glass'), 0, 0);
    g.set(0, 0, 0, S('stone'), leaf, used);
    const back = readArchive(table, writeArchive(g, 1)).grid;
    assert.deepEqual(back.parts(), [
      { id: 1, name: '根', parent: 0 },
      { id: 3, name: '叶', parent: 1 },
    ]);
    assert.deepEqual(
      back.calls().map((c) => c.id),
      [2],
    );
    // 读回后新 id 从最大 id + 1 起
    assert.equal(back.definePart('新'), 4);
    assert.equal(back.defineCall('新', 0, {}), 3);
  });

  it('apiVersion 必须是 u16', () => {
    for (const v of [-1, 65536, 1.5]) {
      assert.throws(() => writeArchive(createGrid(table), v), /apiVersion/);
    }
  });
});

describe('readArchive', () => {
  it('读回基准存档', () => {
    const { grid, apiVersion } = readArchive(table, encode(base()));
    assert.equal(apiVersion, 7);
    assert.deepEqual(snapshot(grid), snapshot(baseGrid()));
    assert.equal(hashGrid(grid), hashGrid(baseGrid()));
  });

  it('接受 Uint8Array 视图（带偏移）', () => {
    const bytes = encode(base());
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 4);
    assert.equal(readArchive(table, padded.subarray(4, 4 + bytes.length)).grid.size, 3);
  });

  it('头部错误', () => {
    rejects({ ...base(), magic: 'PGAX' }, /magic/);
    rejects({ ...base(), version: 2 }, /格式版本是 2/);
    rejects({ ...base(), flags: 2 }, /未定义的位/);
    rejects({ ...base(), flags: 1 }, /标志 bit0/);
    rejects({ ...base(), reserved: 1 }, /保留字段/);
    rejects({ ...base(), box: [0, 0, 0, 16, 2, 0] }, /包围盒/);
    rejects({ ...base(), total: 4 }, /实体格数 4.*格总数 3/);
    rejects(
      { box: [0, 0, 0, 0, 0, 0], total: 0, flags: 0, palette: [], parts: [], calls: [], chunks: [], carved: [] },
      /标志 bit0/,
    );
    rejects({ box: [0, 0, 0, 0, 0, 1], total: 0, palette: [], parts: [], calls: [], chunks: [], carved: [] }, /包围盒/);
  });

  it('截断与多余字节', () => {
    const bytes = encode(base());
    for (const n of [0, 3, 10, 40, 60, bytes.length - 1]) rejects(bytes.subarray(0, n), /截断/);
    rejects({ ...base(), tail: [0] }, /多余/);
    // 数量字段巨大时直接判截断，不按它分配内存
    const huge = encode({ ...base(), palette: [] });
    new DataView(huge.buffer).setUint32(40, 0xffffffff, true);
    rejects(huge, /截断/);
  });

  it('字符串不是合法 UTF-8', () => {
    const bytes = encode({
      ...base(),
      parts: [
        [1, 0, 'x'],
        [2, 1, '窗'],
      ],
    });
    const at = bytes.indexOf(0x78); // 'x'
    bytes[at] = 0xff;
    rejects(bytes, /UTF-8/);
  });

  it('调色板错误', () => {
    rejects({ ...base(), palette: ['stone', 'oak_planks'] }, /调色板未按码点/);
    rejects({ ...base(), palette: ['stone', 'stone'] }, /调色板未按码点/);
    rejects({ ...base(), palette: ['oak_planks', 'stone', 'tnt'] }, /未被用到/);
    rejects({ ...base(), palette: ['minecraft:oak_planks', 'stone'] }, /不是规范形式/);
    rejects({ ...base(), palette: ['oak_planks', 'stonee'] }, /未知方块/);
    rejects({ ...base(), palette: ['air', 'oak_planks'] }, /空气/);
    const r = base();
    r.chunks[0]!.cells[0]![1] = 9;
    rejects(r, /调色板索引 9 越界/);
  });

  it('部件表与调用表错误', () => {
    rejects(
      {
        ...base(),
        parts: [
          [2, 0, '墙'],
          [1, 0, '窗'],
        ],
      },
      /部件表未按 id/,
    );
    rejects(
      {
        ...base(),
        parts: [
          [0, 0, '墙'],
          [2, 0, '窗'],
        ],
      },
      /部件表未按 id/,
    );
    rejects(
      {
        ...base(),
        parts: [
          [1, 2, '墙'],
          [2, 0, '窗'],
        ],
      },
      /parent 2/,
    );
    rejects(
      {
        ...base(),
        parts: [
          [1, 0, '墙'],
          [2, 1, '窗'],
          [3, 0, '多余'],
        ],
      },
      /部件表有未被用到/,
    );
    rejects(
      {
        ...base(),
        parts: [
          [1, 0, ''],
          [2, 1, '窗'],
        ],
      },
      /名字为空/,
    );
    rejects(
      {
        ...base(),
        calls: [
          [2, 0, 'a', ''],
          [1, 0, 'b', ''],
        ],
      },
      /调用表未按 id/,
    );
    rejects(
      {
        ...base(),
        calls: [
          [1, 3, 'wall', '{}'],
          [2, 0, 'hole', ''],
          [3, 0, 'x', ''],
        ],
      },
      /调用表有未被用到/,
    );
    rejects(
      {
        ...base(),
        calls: [
          [1, 3, '', '{}'],
          [2, 0, 'hole', ''],
        ],
      },
      /api 为空/,
    );
    const r = base();
    r.chunks[0]!.cells[0]![2] = 9;
    rejects(r, /不存在的部件 9/);
    const r2 = base();
    r2.chunks[0]!.cells[0]![3] = 9;
    rejects(r2, /不存在的调用 9/);
  });

  it('区块错误', () => {
    const swapped = base();
    swapped.chunks.reverse();
    rejects(swapped, /区块未按/);
    const dup = base();
    dup.chunks[1] = { c: [0, 0, 0], cells: [[1, 1, 1, 0]] };
    rejects(dup, /区块未按/);
    const empty = base();
    empty.chunks.push({ c: [2, 0, 0], cells: [] });
    rejects(empty, /格数为 0/);
    const cellOrder = base();
    cellOrder.chunks[0]!.cells.reverse();
    rejects(cellOrder, /区块内格未按下标/);
    const idx = base();
    idx.chunks[0]!.cells[1]![0] = 4096;
    rejects(idx, /下标 4096 越界/);
    const far = base();
    far.chunks[1]!.c = [3000000, 0, 0];
    rejects(far, /越界/);
  });

  it('挖空记录错误', () => {
    rejects({ ...base(), carved: [[5, 0, 0, 0]] }, /调用 id 为 0/);
    rejects({ ...base(), carved: [[5, 0, 0, 9]] }, /不存在的调用 9/);
    rejects({ ...base(), carved: [[0, 0, 0, 2]] }, /与实体格重叠/);
    rejects(
      {
        ...base(),
        carved: [
          [6, 0, 0, 2],
          [5, 0, 0, 2],
        ],
      },
      /挖空记录未按/,
    );
    rejects(
      {
        ...base(),
        carved: [
          [5, 0, 0, 2],
          [5, 0, 0, 2],
        ],
      },
      /挖空记录未按/,
    );
    rejects({ ...base(), carved: [[5, 9999, 0, 2]] }, /越界/);
  });
});

describe('性质', () => {
  const states = ['stone', 'oak_planks', 'oak_stairs[facing=east]', 'glass', 'oak_log[axis=x]', 'air'];
  const op = fc.record({
    x: fc.integer({ min: -40, max: 40 }),
    y: fc.integer({ min: -40, max: 40 }),
    z: fc.integer({ min: -40, max: 40 }),
    s: fc.constantFrom(...states),
    part: fc.nat(4),
    call: fc.nat(4),
  });

  function run(ops: readonly { x: number; y: number; z: number; s: string; part: number; call: number }[]): Grid {
    const g = createGrid(table);
    const p1 = g.definePart('a');
    g.definePart('b', p1);
    g.definePart('c', p1);
    g.definePart('d');
    for (let i = 1; i <= 4; i += 1) g.defineCall(`api${String(i)}`, i, { i });
    for (const o of ops) g.set(o.x, o.y, o.z, S(o.s), o.s === 'air' ? 0 : o.part, o.call);
    return g;
  }

  it('写出再读回：格、部件、调用、挖空记录相同，hash 相同，再写出字节相同', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), fc.integer({ min: 0, max: 0xffff }), (ops, api) => {
        const g = run(ops);
        const bytes = writeArchive(g, api);
        const { grid, apiVersion } = readArchive(table, bytes);
        assert.equal(apiVersion, api);
        assert.deepEqual(snapshot(grid).cells, snapshot(g).cells);
        assert.deepEqual(snapshot(grid).carved, snapshot(g).carved);
        assert.equal(hashGrid(grid), hashGrid(g));
        assert.deepEqual(writeArchive(grid, api), bytes);
      }),
    );
  });

  it('坐标互不重叠的写入按任意顺序执行，存档字节相同', () => {
    const unique = fc.uniqueArray(op, {
      selector: (o) => `${String(o.x)},${String(o.y)},${String(o.z)}`,
      maxLength: 60,
    });
    fc.assert(
      fc.property(
        unique.chain((ops) => fc.tuple(fc.constant(ops), fc.shuffledSubarray(ops, { minLength: ops.length }))),
        ([ops, shuffled]) => {
          assert.deepEqual(writeArchive(run(shuffled), 1), writeArchive(run(ops), 1));
        },
      ),
    );
  });
});
