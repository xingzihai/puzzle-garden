import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gridOf } from './fixtures.test.ts';
import { ALL26, FACE, MAX_SAMPLES, boxOf, cellKey, compareCells, packer, samplesOf } from './sample.ts';

describe('sample', () => {
  it('邻接偏移', () => {
    assert.equal(FACE.length, 6);
    assert.equal(ALL26.length, 26);
    assert.equal(new Set(ALL26.map((d) => d.join())).size, 26);
  });

  it('cellKey 区分负号与位数', () => {
    assert.notEqual(cellKey(1, 12, 3), cellKey(11, 2, 3));
    assert.equal(cellKey(-1, 0, 2), '-1,0,2');
  });

  it('compareCells 按 (y, z, x)', () => {
    const cs = [
      { x: 0, y: 1, z: 0 },
      { x: 5, y: 0, z: 1 },
      { x: 9, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ].sort(compareCells);
    assert.deepEqual(
      cs.map((c) => c.x),
      [1, 9, 5, 0],
    );
  });

  it('samplesOf 排序、截断，空气格记为 air', () => {
    const g = gridOf([[0, 0, 0, 'stone']]);
    const many = Array.from({ length: 30 }, (_, i) => ({ x: i, y: 0, z: 0 })).reverse();
    const s = samplesOf(g, many);
    assert.equal(s.length, MAX_SAMPLES);
    assert.deepEqual(s[0], { x: 0, y: 0, z: 0, block: 'stone', call: 0 });
    assert.deepEqual(s[1], { x: 1, y: 0, z: 0, block: 'air', call: 0 });
  });

  it('boxOf', () => {
    assert.equal(boxOf([]), undefined);
    assert.deepEqual(
      boxOf([
        { x: 1, y: -2, z: 3 },
        { x: -1, y: 5, z: 0 },
      ]),
      { min: [-1, -2, 0], max: [1, 5, 3] },
    );
  });

  it('packer：范围内的键唯一，范围判断准确', () => {
    const pk = packer({ min: [-2, -1, -3], max: [1, 2, 0] }, 1);
    const keys = new Set<number>();
    for (let x = -3; x <= 2; x += 1)
      for (let y = -2; y <= 3; y += 1) for (let z = -4; z <= 1; z += 1) keys.add(pk.key(x, y, z));
    assert.equal(keys.size, 6 * 6 * 6);
    assert.ok(pk.inside(-3, -2, -4) && pk.inside(2, 3, 1));
    assert.ok(!pk.inside(3, 0, 0) && !pk.inside(0, -3, 0) && !pk.inside(0, 0, 2));
    assert.equal(packer(undefined, 0).key(0, 0, 0), 0);
  });

  it('packer：跨度超出安全整数时报错，不静默冲突', () => {
    assert.throws(
      () => packer({ min: [-(2 ** 25), -2048, -(2 ** 25)], max: [2 ** 25 - 1, 2047, 2 ** 25 - 1] }, 0),
      /太大/,
    );
  });
});
