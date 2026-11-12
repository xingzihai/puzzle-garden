import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { box, gridOf, ground } from './fixtures.test.ts';
import { measureFloating } from './floating.ts';

describe('measureFloating', () => {
  it('好样本：落地的柱子与压在地面上的格不悬空', () => {
    const g = gridOf([...ground(3), ...box(0, 1, 0, 0, 6, 0, 'stone')]);
    assert.deepEqual(measureFloating(g), { cells: 0, edgeOnly: 0, groups: [] });
  });

  it('y = 1 的格即使没有地面层也算落地', () => {
    assert.equal(measureFloating(gridOf([[5, 1, 5, 'stone']])).cells, 0);
  });

  it('坏样本：离地的块整组悬空，带样例与包围盒', () => {
    const g = gridOf([...ground(3), ...box(0, 4, 0, 1, 4, 1, 'oak_planks')]);
    const r = measureFloating(g);
    assert.equal(r.cells, 4);
    assert.equal(r.edgeOnly, 0);
    assert.equal(r.groups.length, 1);
    const grp = r.groups[0]!;
    assert.deepEqual(grp.bounds, { min: [0, 4, 0], max: [1, 4, 1] });
    assert.deepEqual(grp.samples[0], { x: 0, y: 4, z: 0, block: 'oak_planks', call: 0 });
  });

  it('tag 只统计每组的标签格数，不改变悬空判定；样例截断不影响计数', () => {
    // 离地 25 格的一整块：21 格瓦（超过 20 个样例上限）+ 4 格金块，同在一组
    const cells = [
      ...ground(3),
      ...box(0, 5, 0, 4, 5, 4, 'deepslate_tiles').filter(([x, , z]) => !(x === 4 && z >= 1)),
      ...box(4, 5, 1, 4, 5, 4, 'gold_block'),
    ];
    const g = gridOf(cells);
    const plain = measureFloating(g);
    const tagged = measureFloating(g, { tag: (c) => c.state.name === 'deepslate_tiles' });
    assert.equal(tagged.cells, plain.cells);
    assert.equal(tagged.groups.length, 1);
    const grp = tagged.groups[0]!;
    assert.equal(grp.cells, 25);
    assert.equal(grp.tagged, 21);
    assert.equal(grp.samples.length, 20);
    assert.equal(plain.groups[0]!.tagged, 0);
  });

  it('只靠棱相连的楼梯级标为 edgeOnly', () => {
    // 地面上一根柱，柱顶斜上方一格：与柱只共棱
    const g = gridOf([...ground(2), [0, 1, 0, 'stone'], [1, 2, 0, 'stone'], [2, 3, 0, 'stone']]);
    const r = measureFloating(g);
    assert.equal(r.cells, 2);
    assert.equal(r.edgeOnly, 2);
    assert.equal(r.groups[0]?.edgeOnly, true);
  });

  it('多组按格数降序，同格数按最小坐标', () => {
    const g = gridOf([...ground(9), ...box(5, 5, 5, 5, 5, 6, 'stone'), [-5, 5, -5, 'stone'], [-7, 5, -7, 'stone']]);
    const r = measureFloating(g);
    assert.deepEqual(
      r.groups.map((x) => [x.cells, x.samples[0]?.x]),
      [
        [2, 5],
        [1, -7],
        [1, -5],
      ],
    );
  });

  it('样例最多 20 个', () => {
    const g = gridOf(box(0, 5, 0, 9, 5, 9, 'stone'));
    const r = measureFloating(g);
    assert.equal(r.cells, 100);
    assert.equal(r.groups[0]?.samples.length, 20);
  });

  it('空网格', () => {
    assert.deepEqual(measureFloating(gridOf([])), { cells: 0, edgeOnly: 0, groups: [] });
  });
});

describe('measureFloating 性质', () => {
  const cell = fc.tuple(
    fc.integer({ min: -6, max: 6 }),
    fc.integer({ min: 0, max: 8 }),
    fc.integer({ min: -6, max: 6 }),
  );
  const cells = fc.uniqueArray(cell, { selector: (c) => c.join(), maxLength: 60 });

  it('写入顺序不影响结果', () => {
    fc.assert(
      fc.property(
        cells.chain((cs) => fc.tuple(fc.constant(cs), fc.shuffledSubarray(cs, { minLength: cs.length }))),
        ([a, b]) => {
          const ga = gridOf(a.map(([x, y, z]) => [x, y, z, 'stone'] as const));
          const gb = gridOf(b.map(([x, y, z]) => [x, y, z, 'stone'] as const));
          assert.deepEqual(measureFloating(ga), measureFloating(gb));
        },
      ),
    );
  });

  it('水平平移不改变计数', () => {
    fc.assert(
      fc.property(cells, fc.integer({ min: -50, max: 50 }), fc.integer({ min: -50, max: 50 }), (cs, dx, dz) => {
        const a = measureFloating(gridOf(cs.map(([x, y, z]) => [x, y, z, 'stone'] as const)));
        const b = measureFloating(gridOf(cs.map(([x, y, z]) => [x + dx, y, z + dz, 'stone'] as const)));
        assert.equal(a.cells, b.cells);
        assert.equal(a.edgeOnly, b.edgeOnly);
        assert.deepEqual(
          a.groups.map((g) => g.cells),
          b.groups.map((g) => g.cells),
        );
      }),
    );
  });
});
