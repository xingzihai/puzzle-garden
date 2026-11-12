import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { createBlockTable, parseState } from './block-state.ts';
import { createGrid } from './grid.ts';
import type { Grid } from './grid.ts';
import { fnv1a, hashGrid } from './hash.ts';

const table = createBlockTable(
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../assets/mc-1.20.1/block-states.json'), 'utf8')),
);

type Put = readonly [number, number, number, string];

function build(puts: readonly Put[]): Grid {
  const g = createGrid(table);
  for (const [x, y, z, s] of puts) g.set(x, y, z, parseState(table, s), 0, 0);
  return g;
}

describe('fnv1a', () => {
  it('金标值（CORE-SPEC §5.3）', () => {
    assert.equal(fnv1a('').toString(16), '811c9dc5');
    assert.equal(fnv1a('stone').toString(16), 'c81958fa');
    assert.equal(fnv1a('oak_stairs[facing=east]').toString(16), '29fa6649');
  });

  it('按 UTF-8 字节而不是 UTF-16 码元', () => {
    // '中' 的 UTF-8 是 e4 b8 ad 三个字节；按码元算只有一个 0x4e2d。
    let h = 0x811c9dc5;
    for (const b of [0xe4, 0xb8, 0xad]) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    assert.equal(fnv1a('中'), h);
  });
});

describe('hashGrid', () => {
  // 金标来源：docs/CORE-SPEC.md §5.3。
  const GOLDEN: readonly (readonly [readonly Put[], string])[] = [
    [[], '92ca2f0ecb72770f0c66c0248c03471f'],
    [[[0, 0, 0, 'stone']], '93a130dc8ef15ae87e873b4ec8fad2f1'],
    [[[-1, -64, -30000000, 'stone']], '2268cd82be73eb0078bfdd2000baae94'],
    [
      [
        [0, 0, 0, 'stone'],
        [1, 0, 0, 'oak_stairs[facing=east]'],
      ],
      'a9d71c1013db4bc4bc6e12b910bedf08',
    ],
    [
      [
        [0, 0, 0, 'stone'],
        [0, 1, 0, 'oak_planks'],
      ],
      '4507369d5d72c6d78b751c543537cd79',
    ],
  ];
  for (const [puts, expected] of GOLDEN) {
    it(`金标 ${JSON.stringify(puts)}`, () => {
      assert.equal(hashGrid(build(puts)), expected);
    });
  }

  it('状态写法不同但规范形式相同时 hash 相同', () => {
    assert.equal(
      hashGrid(build([[1, 0, 0, 'minecraft:oak_stairs[waterlogged=false,facing=east,half=bottom]']])),
      hashGrid(build([[1, 0, 0, 'oak_stairs[facing=east]']])),
    );
  });

  it('不看部件、调用、挖空记录', () => {
    const a = build([[0, 0, 0, 'stone']]);
    const b = createGrid(table);
    const p = b.definePart('墙');
    const c = b.defineCall('wall', 7, { h: 3 });
    b.set(0, 0, 0, parseState(table, 'stone'), p, c);
    b.set(5, 5, 5, parseState(table, 'air'), 0, c);
    assert.equal(hashGrid(b), hashGrid(a));
  });
});

describe('hashGrid 性质', () => {
  const states = ['stone', 'oak_planks', 'oak_stairs[facing=east]', 'glass', 'oak_log[axis=x]'];
  const coord = fc.tuple(
    fc.integer({ min: -100, max: 100 }),
    fc.integer({ min: -2048, max: 2047 }),
    fc.integer({ min: -100, max: 100 }),
  );
  const put = fc.tuple(coord, fc.constantFrom(...states)).map(([[x, y, z], s]): Put => [x, y, z, s]);
  const uniquePuts = fc.uniqueArray(put, {
    selector: (p) => `${String(p[0])},${String(p[1])},${String(p[2])}`,
    maxLength: 60,
  });

  it('坐标互不重叠的写入按任意顺序执行，hash 相同', () => {
    fc.assert(
      fc.property(
        uniquePuts.chain((puts) => fc.tuple(fc.constant(puts), fc.shuffledSubarray(puts, { minLength: puts.length }))),
        ([puts, shuffled]) => {
          assert.equal(hashGrid(build(shuffled)), hashGrid(build(puts)));
        },
      ),
    );
  });

  it('同一格集合无论经过怎样的覆盖与挖空得到，hash 都相同', () => {
    fc.assert(
      fc.property(uniquePuts, fc.array(put, { maxLength: 40 }), (finalPuts, noise) => {
        // 先写一堆噪声（含与最终集合重叠的格），再把不在最终集合里的噪声格挖掉，最后写最终集合。
        const g = createGrid(table);
        const call = g.defineCall('hole', 0, {});
        for (const [x, y, z, s] of noise) g.set(x, y, z, parseState(table, s), 0, 0);
        const keep = new Set(finalPuts.map((p) => `${String(p[0])},${String(p[1])},${String(p[2])}`));
        for (const [x, y, z] of noise) {
          if (!keep.has(`${String(x)},${String(y)},${String(z)}`)) g.set(x, y, z, parseState(table, 'air'), 0, call);
        }
        for (const [x, y, z, s] of finalPuts) g.set(x, y, z, parseState(table, s), 0, 0);
        assert.equal(hashGrid(g), hashGrid(build(finalPuts)));
      }),
    );
  });

  it('输出是 32 位小写十六进制', () => {
    fc.assert(
      fc.property(uniquePuts, (puts) => {
        assert.match(hashGrid(build(puts)), /^[0-9a-f]{32}$/);
      }),
      { numRuns: 20 },
    );
  });
});
