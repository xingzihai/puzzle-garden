import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { box, gridOf, ground } from './fixtures.test.ts';
import { measureRoofProfile } from './roof-profile.ts';

const isTiles = (c: { state: { name: string } }): boolean => c.state.name.endsWith('_tiles');

describe('measureRoofProfile', () => {
  it('好样本：逐层收进的薄壳，每列厚 1', () => {
    const g = gridOf([
      ...ground(4),
      ...box(-3, 4, -3, 3, 4, 3, 'deepslate_tiles').filter(([x, , z]) => Math.abs(x) === 3 || Math.abs(z) === 3),
      ...box(-2, 5, -2, 2, 5, 2, 'deepslate_tiles').filter(([x, , z]) => Math.abs(x) === 2 || Math.abs(z) === 2),
      ...box(-1, 6, -1, 1, 6, 1, 'deepslate_tiles'),
    ]);
    const r = measureRoofProfile(g, isTiles);
    assert.equal(r.cells, 24 + 16 + 9);
    assert.deepEqual(
      r.layers.map((l) => [l.y, l.cells, l.faceBelow]),
      [
        [4, 24, 0],
        [5, 16, 0],
        [6, 9, 0],
      ],
    );
    assert.deepEqual(r.layers[0]?.bounds, { min: [-3, 4, -3], max: [3, 4, 3] });
    assert.deepEqual(r.thickness, { 1: 49, 2: 0, '3+': 0 });
    assert.deepEqual(r.thickSamples, []);
  });

  it('坏样本：叠层屋面，列厚 2 与 3+ 都被数出，并给出样例', () => {
    const g = gridOf([
      ...box(0, 4, 0, 3, 4, 0, 'deepslate_tiles'),
      ...box(0, 5, 0, 1, 5, 0, 'deepslate_tiles'),
      [0, 6, 0, 'deepslate_tiles'],
      [0, 3, 0, 'oak_planks'],
    ]);
    const r = measureRoofProfile(g, isTiles);
    assert.deepEqual(r.thickness, { 1: 2, 2: 1, '3+': 1 });
    assert.deepEqual(
      r.thickSamples.map((s) => [s.x, s.y, s.block]),
      [
        [0, 4, 'deepslate_tiles'],
        [1, 4, 'deepslate_tiles'],
      ],
    );
    assert.equal(r.layers[0]?.faceBelow, 1);
  });

  it('同一列有两段不相连的屋面时取最长的一段', () => {
    const g = gridOf([
      [0, 4, 0, 'deepslate_tiles'],
      [0, 7, 0, 'deepslate_tiles'],
      [0, 8, 0, 'deepslate_tiles'],
    ]);
    const r = measureRoofProfile(g, isTiles);
    assert.deepEqual(r.thickness, { 1: 0, 2: 1, '3+': 0 });
    assert.equal(r.thickSamples[0]?.y, 7);
  });

  it('没有屋面格', () => {
    assert.deepEqual(measureRoofProfile(gridOf(ground(1)), isTiles), {
      cells: 0,
      layers: [],
      thickness: { 1: 0, 2: 0, '3+': 0 },
      thickSamples: [],
      excess: { columns: 0, cells: 0 },
      excessSamples: [],
    });
  });

  it('陡坡：竖向补到比最低邻列高 1 格是连接，不算叠层；多出的格算', () => {
    // 一排三列，列顶 4 / 6 / 8：中列需 6−4 = 2 格，右列需 8−6 = 2 格
    const ok = gridOf([
      [0, 4, 0, 'deepslate_tiles'],
      [1, 5, 0, 'deepslate_tiles'],
      [1, 6, 0, 'deepslate_tiles'],
      [2, 7, 0, 'deepslate_tiles'],
      [2, 8, 0, 'deepslate_tiles'],
    ]);
    const r = measureRoofProfile(ok, isTiles);
    assert.deepEqual(r.thickness, { 1: 1, 2: 2, '3+': 0 }, '旧统计会把连接当成列厚 2');
    assert.deepEqual(r.excess, { columns: 0, cells: 0 });
    // 中列再往下多一格：超出 1
    const bad = gridOf([
      [0, 4, 0, 'deepslate_tiles'],
      [1, 4, 0, 'deepslate_tiles'],
      [1, 5, 0, 'deepslate_tiles'],
      [1, 6, 0, 'deepslate_tiles'],
      [2, 7, 0, 'deepslate_tiles'],
      [2, 8, 0, 'deepslate_tiles'],
    ]);
    const rb = measureRoofProfile(bad, isTiles);
    assert.deepEqual(rb.excess, { columns: 1, cells: 1 });
    assert.deepEqual(
      rb.excessSamples.map((s) => [s.x, s.y]),
      [[1, 4]],
    );
  });

  it('孤立一列没有邻列：只需 1 格，多出的都算', () => {
    const r = measureRoofProfile(gridOf(box(0, 4, 0, 0, 6, 0, 'deepslate_tiles')), isTiles);
    assert.deepEqual(r.excess, { columns: 1, cells: 2 });
  });
});
