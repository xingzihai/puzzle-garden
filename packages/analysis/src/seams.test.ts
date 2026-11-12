import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { box, gridOf, ground } from './fixtures.test.ts';
import { measureSeams } from './seams.ts';

describe('measureSeams', () => {
  it('坏样本：两块板之间 1 层空气', () => {
    const g = gridOf([...box(0, 1, 0, 2, 1, 2, 'stone'), ...box(0, 3, 0, 2, 3, 2, 'stone')]);
    const r = measureSeams(g);
    assert.equal(r.cells, 9);
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0]!.layers, 1);
    assert.deepEqual(r.groups[0]!.bounds, { min: [0, 2, 0], max: [2, 2, 2] });
    assert.deepEqual(r.groups[0]!.samples[0], { x: 0, y: 2, z: 0, block: 'air', call: 0 });
  });

  it('2 层空气算夹层，layers = 2', () => {
    const g = gridOf([...box(0, 1, 0, 2, 1, 2, 'stone'), ...box(0, 4, 0, 2, 4, 2, 'stone')]);
    const r = measureSeams(g);
    assert.equal(r.cells, 18);
    assert.equal(r.groups[0]?.layers, 2);
  });

  it('好样本：3 层及以上的空气是有意的空间', () => {
    const g = gridOf([...box(0, 1, 0, 2, 1, 2, 'stone'), ...box(0, 5, 0, 2, 5, 2, 'stone')]);
    assert.equal(measureSeams(g).cells, 0);
  });

  it('好样本：细柱、单格踏面之间的空隙不算', () => {
    const g = gridOf([
      ...ground(3),
      [0, 2, 0, 'stone'],
      [0, 4, 0, 'stone'],
      [1, 1, 1, 'oak_stairs'],
      [1, 3, 1, 'oak_stairs'],
    ]);
    assert.equal(measureSeams(g).cells, 0);
  });

  it('只有一侧有延展时不算', () => {
    const g = gridOf([...box(0, 1, 0, 2, 1, 2, 'stone'), [1, 3, 1, 'stone']]);
    assert.equal(measureSeams(g).cells, 0);
  });

  it('多组按格数降序', () => {
    const g = gridOf([
      ...box(0, 1, 0, 2, 1, 2, 'stone'),
      ...box(0, 3, 0, 2, 3, 2, 'stone'),
      ...box(10, 1, 10, 11, 1, 11, 'stone'),
      ...box(10, 3, 10, 11, 3, 11, 'stone'),
    ]);
    assert.deepEqual(
      measureSeams(g).groups.map((x) => x.cells),
      [9, 4],
    );
  });

  it('同组混有 1 层与 2 层时 layers 取 2', () => {
    const g = gridOf([
      ...box(0, 1, 0, 3, 1, 1, 'stone'),
      ...box(0, 3, 0, 1, 3, 1, 'stone'),
      ...box(2, 4, 0, 3, 4, 1, 'stone'),
    ]);
    const r = measureSeams(g);
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0]?.layers, 2);
  });
});

describe('measureSeams 性质', () => {
  const cell = fc.tuple(
    fc.integer({ min: -4, max: 4 }),
    fc.integer({ min: 0, max: 6 }),
    fc.integer({ min: -4, max: 4 }),
  );
  const cells = fc.uniqueArray(cell, { selector: (c) => c.join(), maxLength: 80 });

  it('写入顺序与水平平移不影响结果', () => {
    fc.assert(
      fc.property(cells, fc.integer({ min: -30, max: 30 }), fc.integer({ min: -30, max: 30 }), (cs, dx, dz) => {
        const a = measureSeams(gridOf(cs.map(([x, y, z]) => [x, y, z, 'stone'] as const)));
        const b = measureSeams(gridOf([...cs].reverse().map(([x, y, z]) => [x + dx, y, z + dz, 'stone'] as const)));
        assert.equal(a.cells, b.cells);
        assert.deepEqual(
          a.groups.map((g) => [g.cells, g.layers]),
          b.groups.map((g) => [g.cells, g.layers]),
        );
      }),
    );
  });
});
