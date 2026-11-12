import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { box, gridOf } from './fixtures.test.ts';
import { MIN_SYMMETRY, measureSymmetry } from './symmetry.ts';

const isGlass = (c: { readonly state: { readonly name: string } }): boolean => c.state.name === 'glass';

describe('measureSymmetry', () => {
  it('完全对称的两翼（at 为整数）：matched = cells，lonely 为空', () => {
    const g = gridOf([...box(-2, 1, 0, -2, 3, 0, 'stone'), ...box(2, 1, 0, 2, 3, 0, 'stone')]);
    const x = measureSymmetry(g).axes.find((a) => a.axis === 'x');
    assert.ok(x !== undefined);
    assert.equal(x.at, 0);
    assert.equal(x.cells, 6);
    assert.equal(x.matched, 6);
    assert.equal(x.glass, 0);
    assert.equal(x.glassMatched, 0);
    assert.deepEqual(x.lonely, []);
    assert.deepEqual(x.lonelyGlass, []);
  });

  it('完全对称的两翼（at 为 .5）：镜面在两列之间', () => {
    const g = gridOf([...box(0, 1, 0, 0, 3, 0, 'stone'), ...box(1, 1, 0, 1, 3, 0, 'stone')]);
    const x = measureSymmetry(g).axes.find((a) => a.axis === 'x');
    assert.ok(x !== undefined);
    assert.equal(x.at, 0.5);
    assert.equal(x.matched, x.cells);
    assert.deepEqual(x.lonely, []);
  });

  it('删掉一侧一扇窗后 lonelyGlass 有一组，包围盒正确', () => {
    const left = [1, 2, 3, 4, 6, 7, 8, 9].map((y) => [-2, y, 0, 'stone'] as const);
    const right = [1, 2, 3, 4, 6, 7, 8, 9].map((y) => [2, y, 0, 'stone'] as const);
    const g = gridOf([...left, ...right, [-2, 5, 0, 'glass']]);
    const x = measureSymmetry(g, { glass: isGlass }).axes.find((a) => a.axis === 'x');
    assert.ok(x !== undefined);
    assert.equal(x.cells, 17);
    assert.equal(x.matched, 16);
    assert.equal(x.glass, 1);
    assert.equal(x.glassMatched, 0);
    assert.equal(x.glassBelow, 1);
    assert.equal(x.glassAbove, 0);
    assert.equal(x.lonely.length, 1);
    assert.equal(x.lonelyGlass.length, 1);
    const lonely = x.lonely[0];
    const lonelyGlass = x.lonelyGlass[0];
    assert.ok(lonely !== undefined && lonelyGlass !== undefined);
    assert.equal(lonely.cells, 1);
    assert.equal(lonelyGlass.cells, 1);
    assert.deepEqual(lonely.bounds, { min: [-2, 5, 0], max: [-2, 5, 0] });
    assert.deepEqual(lonelyGlass.bounds, { min: [-2, 5, 0], max: [-2, 5, 0] });
    assert.equal(lonelyGlass.samples[0]?.block, 'glass');
  });

  it('两扇窗都在时玻璃全部对上（glassMatched = glass）', () => {
    const g = gridOf([
      ...box(-2, 1, 0, -2, 3, 0, 'stone'),
      ...box(2, 1, 0, 2, 3, 0, 'stone'),
      [-2, 2, 0, 'glass'],
      [2, 2, 0, 'glass'],
    ]);
    const x = measureSymmetry(g, { glass: isGlass }).axes.find((a) => a.axis === 'x');
    assert.ok(x !== undefined);
    assert.equal(x.glass, 2);
    assert.equal(x.glassMatched, 2);
    assert.deepEqual(x.lonelyGlass, []);
    assert.equal(x.glassBelow, 1);
    assert.equal(x.glassAbove, 1);
  });

  it('纵向不对称（matched / cells < 0.8）的轴不进 axes', () => {
    const g = gridOf([
      [-1, 1, 0, 'stone'],
      [1, 1, 0, 'stone'],
      [-1, 2, 0, 'stone'],
      [1, 2, 0, 'stone'],
      [0, 1, 5, 'stone'],
    ]);
    const r = measureSymmetry(g);
    assert.deepEqual(
      r.axes.map((a) => a.axis),
      ['x'],
    );
    assert.equal(r.axes[0]?.matched, 5);
  });

  it('镜面偏离包围盒中线 1 格时仍能找到正确的 at', () => {
    // 关于 x = 0 对称的 10 格 + 一个把 max 推到 4 的离群格；中线在 x = 1。
    const g = gridOf([...box(-2, 1, 0, -2, 5, 0, 'stone'), ...box(2, 1, 0, 2, 5, 0, 'stone'), [4, 1, 0, 'stone']]);
    const x = measureSymmetry(g).axes.find((a) => a.axis === 'x');
    assert.ok(x !== undefined);
    assert.equal(x.at, 0);
    assert.equal(x.matched, 10);
  });

  it('同数平局取离中线近的', () => {
    // s = 0（中线）与 s = 1 都是 4 个对上，取 |s − 0| 小的 0。
    const g = gridOf([-5, -4, -3, 4, 5].map((x) => [x, 1, 0, 'stone'] as const));
    const x = measureSymmetry(g).axes.find((a) => a.axis === 'x');
    assert.ok(x !== undefined);
    assert.equal(x.at, 0);
    assert.equal(x.matched, 4);
    assert.equal(x.matched / x.cells, MIN_SYMMETRY);
  });

  it('同数且离中线一样远时取 s 小的', () => {
    // s = −2 与 s = 0 都离中线 s = −1 一格、都是 8 个对上，取小的 −2。
    const xs = [-9, 9, 7, -4, -6, 4, 6, -8, 8, -10];
    const g = gridOf(xs.map((x) => [x, 1, 0, 'stone'] as const));
    const x = measureSymmetry(g).axes.find((a) => a.axis === 'x');
    assert.ok(x !== undefined);
    assert.equal(x.at, -1);
    assert.equal(x.matched, 8);
  });

  it('axes 先 x 后 z；空网格返回空 axes', () => {
    const g = gridOf([...box(-1, 1, -1, 1, 1, 1, 'stone')]);
    assert.deepEqual(
      measureSymmetry(g).axes.map((a) => a.axis),
      ['x', 'z'],
    );
    assert.deepEqual(measureSymmetry(gridOf([])), { axes: [] });
  });

  it('不对称组按格数降序、同数按最小 (y, z, x)', () => {
    // 20 格对称主体 + 两条不对称的竖线：3 格组在前、1 格组在后。
    const g = gridOf([
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((y) => [[-1, y, 0, 'stone'] as const, [1, y, 0, 'stone'] as const]),
      [-5, 1, 0, 'stone'],
      [-5, 2, 0, 'stone'],
      [-5, 3, 0, 'stone'],
      [5, 5, 0, 'stone'],
    ]);
    const x = measureSymmetry(g).axes.find((a) => a.axis === 'x');
    assert.ok(x !== undefined);
    assert.equal(x.cells, 24);
    assert.equal(x.matched, 20);
    assert.deepEqual(
      x.lonely.map((grp) => grp.cells),
      [3, 1],
    );
  });
});

describe('measureSymmetry 性质', () => {
  const cell = fc.tuple(
    fc.integer({ min: -6, max: 6 }),
    fc.integer({ min: 0, max: 8 }),
    fc.integer({ min: -6, max: 6 }),
  );
  const cells = fc.uniqueArray(cell, { selector: (c) => c.join(), maxLength: 60 });
  const glassOf = (c: { readonly y: number }): boolean => c.y % 2 === 0;

  it('水平平移后 matched / 玻璃计数不变，at 随之平移', () => {
    fc.assert(
      fc.property(cells, fc.integer({ min: -30, max: 30 }), fc.integer({ min: -30, max: 30 }), (cs, dx, dz) => {
        const a = measureSymmetry(gridOf(cs.map(([x, y, z]) => [x, y, z, 'stone'] as const)), { glass: glassOf });
        const b = measureSymmetry(gridOf(cs.map(([x, y, z]) => [x + dx, y, z + dz, 'stone'] as const)), {
          glass: glassOf,
        });
        assert.equal(b.axes.length, a.axes.length);
        for (let i = 0; i < a.axes.length; i += 1) {
          const ax = a.axes[i];
          const bx = b.axes[i];
          if (ax === undefined || bx === undefined) throw new Error('axes 数量不一致');
          assert.equal(bx.axis, ax.axis);
          assert.equal(bx.cells, ax.cells);
          assert.equal(bx.matched, ax.matched);
          assert.equal(bx.glass, ax.glass);
          assert.equal(bx.glassMatched, ax.glassMatched);
          assert.equal(bx.glassBelow, ax.glassBelow);
          assert.equal(bx.glassAbove, ax.glassAbove);
          assert.equal(bx.at - ax.at, ax.axis === 'x' ? dx : dz);
          assert.deepEqual(
            bx.lonely.map((grp) => grp.cells),
            ax.lonely.map((grp) => grp.cells),
          );
          assert.deepEqual(
            bx.lonelyGlass.map((grp) => grp.cells),
            ax.lonelyGlass.map((grp) => grp.cells),
          );
        }
      }),
    );
  });

  it('同输入同输出', () => {
    fc.assert(
      fc.property(cells, (cs) => {
        const g = gridOf(cs.map(([x, y, z]) => [x, y, z, 'stone'] as const));
        assert.deepEqual(measureSymmetry(g), measureSymmetry(g));
      }),
    );
  });
});
