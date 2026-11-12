import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { createBlockTable, formatState, parseState } from './block-state.ts';
import { CoreError } from './coord.ts';
import { createGrid } from './grid.ts';
import type { Grid } from './grid.ts';

const table = createBlockTable(
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../assets/mc-1.20.1/block-states.json'), 'utf8')),
);
const S = (t: string) => parseState(table, t);
const stone = S('stone');
const planks = S('oak_planks');
const air = S('air');

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof CoreError ? e.code : 'not-core-error';
  }
  return undefined;
}

function cellsOf(g: Grid): string[] {
  return [...g.cells()]
    .map(
      (c) => `${String(c.x)},${String(c.y)},${String(c.z)}=${formatState(c.state)}/${String(c.part)}/${String(c.call)}`,
    )
    .sort();
}

function argsOf(g: Grid, id: number): string {
  return g.calls().find((c) => c.id === id)!.args;
}

function carvedOf(g: Grid): string[] {
  return [...g.carved()].map((c) => `${String(c.x)},${String(c.y)},${String(c.z)}@${String(c.call)}`).sort();
}

describe('部件与调用', () => {
  it('id 从 1 起递增，父部件必须已存在', () => {
    const g = createGrid(table);
    assert.equal(g.definePart('墙'), 1);
    assert.equal(g.definePart('窗', 1), 2);
    assert.equal(
      codeOf(() => g.definePart('门', 9)),
      'unknown-part',
    );
    assert.equal(
      codeOf(() => g.definePart('')),
      'invalid-argument',
    );
    assert.deepEqual(g.parts(), [
      { id: 1, name: '墙', parent: 0 },
      { id: 2, name: '窗', parent: 1 },
    ]);
  });

  it('defineCall 校验 api 与 line', () => {
    const g = createGrid(table);
    assert.equal(g.defineCall('wall', 3, {}), 1);
    assert.equal(g.defineCall('wall', 0, null), 2);
    assert.equal(
      codeOf(() => g.defineCall('', 1, {})),
      'invalid-argument',
    );
    for (const bad of [-1, 1.5, Number.NaN])
      assert.equal(
        codeOf(() => g.defineCall('a', bad, {})),
        'invalid-argument',
      );
  });

  it('args 存为规范 JSON', () => {
    const g = createGrid(table);
    const args = (v: unknown) => argsOf(g, g.defineCall('x', 0, v));
    assert.equal(
      args({ b: 1, a: [1, undefined, Number.NaN, Infinity], c: undefined, d: 'x' }),
      '{"a":[1,null,null,null],"b":1,"d":"x"}',
    );
    assert.equal(args({ B: 1, a: 2, _: 3 }), '{"B":1,"_":3,"a":2}');
    assert.equal(args(undefined), 'null');
    assert.equal(args(true), 'true');
    assert.equal(args(false), 'false');
    assert.equal(args({ n: { m: [] } }), '{"n":{"m":[]}}');
    const shared = { v: 1 };
    assert.equal(args([shared, shared]), '[{"v":1},{"v":1}]');
  });

  it('args 含函数、symbol、bigint、循环引用时报错', () => {
    const g = createGrid(table);
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    for (const bad of [{ f: () => 0 }, [Symbol('s')], 1n, loop]) {
      assert.equal(
        codeOf(() => g.defineCall('x', 0, bad)),
        'invalid-argument',
      );
    }
  });

  it('args 超过 200 码元时截断并加 …，不切开代理对', () => {
    const g = createGrid(table);
    const long = argsOf(g, g.defineCall('x', 0, 'a'.repeat(300)));
    assert.equal(long.length, 201);
    assert.ok(long.endsWith('…'));
    // '"' 占 1 个码元，再放 198 个 a，第 200 个码元正好是 😀 的高代理项。
    const emoji = argsOf(g, g.defineCall('x', 0, `${'a'.repeat(198)}😀😀`));
    assert.equal(emoji, `"${'a'.repeat(198)}…`);
    const exact = argsOf(g, g.defineCall('x', 0, 'a'.repeat(198)));
    assert.equal(exact.length, 200);
  });
});

describe('set / get', () => {
  it('写入、覆盖、读回', () => {
    const g = createGrid(table);
    const p = g.definePart('墙');
    const c = g.defineCall('wall', 1, {});
    g.set(0, 0, 0, stone, p, c);
    assert.equal(g.size, 1);
    assert.deepEqual(g.get(0, 0, 0), { x: 0, y: 0, z: 0, state: stone, part: p, call: c });
    g.set(0, 0, 0, planks, 0, 0);
    assert.equal(g.size, 1);
    assert.deepEqual(g.get(0, 0, 0), { x: 0, y: 0, z: 0, state: planks, part: 0, call: 0 });
    assert.equal(g.get(1, 0, 0), undefined);
    assert.equal(g.get(100, 100, 100), undefined);
  });

  it('非法坐标、不存在的部件或调用报错', () => {
    const g = createGrid(table);
    assert.equal(
      codeOf(() => {
        g.set(0.5, 0, 0, stone, 0, 0);
      }),
      'invalid-coord',
    );
    assert.equal(
      codeOf(() => {
        g.set(0, 5000, 0, stone, 0, 0);
      }),
      'invalid-coord',
    );
    assert.equal(
      codeOf(() => g.get(0, 0, Number.NaN)),
      'invalid-coord',
    );
    assert.equal(
      codeOf(() => {
        g.set(0, 0, 0, stone, 1, 0);
      }),
      'unknown-part',
    );
    assert.equal(
      codeOf(() => {
        g.set(0, 0, 0, stone, 0, 1);
      }),
      'unknown-call',
    );
    assert.equal(g.size, 0);
  });

  it('负坐标与区块边界', () => {
    const g = createGrid(table);
    const pts: [number, number, number][] = [
      [-1, -1, -1],
      [-16, -17, 15],
      [16, 0, -16],
      [33554431, 2047, -33554432],
    ];
    for (const [x, y, z] of pts) g.set(x, y, z, stone, 0, 0);
    assert.equal(g.size, 4);
    for (const [x, y, z] of pts) assert.equal(g.get(x, y, z)?.state, stone);
    assert.deepEqual(g.bounds(), { min: [-16, -17, -33554432], max: [33554431, 2047, 15] });
  });

  it('空网格的 bounds 为 undefined', () => {
    assert.equal(createGrid(table).bounds(), undefined);
  });
});

describe('挖空', () => {
  it('挖空删除实体格并记录来源；part 必须为 0', () => {
    const g = createGrid(table);
    const c = g.defineCall('hole', 2, {});
    g.set(1, 2, 3, stone, 0, 0);
    assert.equal(
      codeOf(() => {
        g.set(1, 2, 3, air, g.definePart('墙'), c);
      }),
      'invalid-argument',
    );
    g.set(1, 2, 3, air, 0, c);
    assert.equal(g.size, 0);
    assert.equal(g.get(1, 2, 3), undefined);
    assert.deepEqual(carvedOf(g), ['1,2,3@1']);
    assert.equal(g.bounds(), undefined);
  });

  it('再写实体方块会删掉挖空记录', () => {
    const g = createGrid(table);
    const c = g.defineCall('hole', 0, {});
    g.set(-5, 0, 7, air, 0, c);
    g.set(-5, 0, 7, stone, 0, 0);
    assert.deepEqual(carvedOf(g), []);
  });

  it('call = 0 的挖空删除旧记录；call ≠ 0 覆盖旧记录', () => {
    const g = createGrid(table);
    const c1 = g.defineCall('a', 0, {});
    const c2 = g.defineCall('b', 0, {});
    g.set(0, 0, 0, air, 0, c1);
    g.set(0, 0, 1, air, 0, c1);
    g.set(0, 0, 0, air, 0, c2);
    assert.deepEqual(carvedOf(g), ['0,0,0@2', '0,0,1@1']);
    g.set(0, 0, 0, air, 0, 0);
    assert.deepEqual(carvedOf(g), ['0,0,1@1']);
    g.set(0, 0, 1, air, 0, 0);
    assert.deepEqual(carvedOf(g), []);
    g.set(9, 9, 9, air, 0, 0);
    assert.deepEqual(carvedOf(g), []);
  });

  it('挖空记录的坐标能正确还原（含负坐标）', () => {
    const g = createGrid(table);
    const c = g.defineCall('a', 0, {});
    const pts = ['-33554432,-2048,-33554432', '33554431,2047,33554431', '-1,-1,-1', '17,-3,40'];
    for (const p of pts) {
      const [x, y, z] = p.split(',').map(Number) as [number, number, number];
      g.set(x, y, z, air, 0, c);
    }
    assert.deepEqual(carvedOf(g), pts.map((p) => `${p}@1`).sort());
  });

  it('性质：写入后再挖空，实体格集合等同于从未写入，挖空记录里有该格', () => {
    const coord = fc.tuple(
      fc.integer({ min: -40, max: 40 }),
      fc.integer({ min: -40, max: 40 }),
      fc.integer({ min: -40, max: 40 }),
    );
    fc.assert(
      fc.property(fc.uniqueArray(coord, { selector: (p) => p.join(), maxLength: 30 }), coord, (base, extra) => {
        const a = createGrid(table);
        const b = createGrid(table);
        const ca = a.defineCall('hole', 0, {});
        b.defineCall('hole', 0, {});
        for (const [x, y, z] of base) {
          a.set(x, y, z, stone, 0, 0);
          b.set(x, y, z, stone, 0, 0);
        }
        a.set(...extra, planks, 0, 0);
        a.set(...extra, air, 0, ca);
        b.set(...extra, air, 0, ca);
        assert.deepEqual(cellsOf(a), cellsOf(b));
        assert.equal(a.size, b.size);
        assert.ok(carvedOf(a).includes(`${extra.join(',')}@1`));
      }),
    );
  });
});

describe('restoreTables', () => {
  it('按给定 id 恢复，之后新 id 从最大 id + 1 起', () => {
    const g = createGrid(table);
    g.restoreTables(
      [
        { id: 2, name: '墙', parent: 0 },
        { id: 5, name: '窗', parent: 2 },
      ],
      [{ id: 3, api: 'wall', line: 1, args: '{}' }],
    );
    assert.equal(g.definePart('门'), 6);
    assert.equal(g.defineCall('x', 0, {}), 4);
    assert.equal(
      codeOf(() => {
        g.set(0, 0, 0, stone, 1, 0);
      }),
      'unknown-part',
    );
  });

  it('非空网格、乱序、坏 parent、空名字都报错', () => {
    const used = createGrid(table);
    used.definePart('a');
    assert.equal(
      codeOf(() => {
        used.restoreTables([], []);
      }),
      'invalid-argument',
    );
    const cases: [Parameters<Grid['restoreTables']>, string][] = [
      [
        [
          [
            { id: 2, name: 'a', parent: 0 },
            { id: 1, name: 'b', parent: 0 },
          ],
          [],
        ],
        'invalid-argument',
      ],
      [[[{ id: 0, name: 'a', parent: 0 }], []], 'invalid-argument'],
      [[[{ id: 1, name: 'a', parent: 1 }], []], 'unknown-part'],
      [[[{ id: 1, name: '', parent: 0 }], []], 'invalid-argument'],
      [
        [
          [],
          [
            { id: 1, api: 'a', line: 0, args: '' },
            { id: 1, api: 'a', line: 0, args: '' },
          ],
        ],
        'invalid-argument',
      ],
      [[[], [{ id: 1, api: '', line: 0, args: '' }]], 'invalid-argument'],
    ];
    for (const [args, code] of cases) {
      assert.equal(
        codeOf(() => {
          createGrid(table).restoreTables(...args);
        }),
        code,
      );
    }
  });
});
