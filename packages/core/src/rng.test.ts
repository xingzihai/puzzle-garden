import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { MAX_SPAN, mulberry32, randomInt } from './rng.ts';

describe('mulberry32', () => {
  // 金标值取自 v0.2beta（tag v0.2beta-final）tools/voxel-stub.mjs 的 mulberry32 实测输出。
  // v0.3 与之逐位一致，旧稿中依赖随机的构件才能复算出同一 hash。
  const GOLDEN: readonly (readonly [number, readonly [number, number, number]])[] = [
    [0, [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197]],
    [1, [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]],
    [42, [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]],
    [-1, [0.8964226141106337, 0.189478256739676, 0.7156526781618595]],
  ];

  for (const [seed, expected] of GOLDEN) {
    it(`seed=${String(seed)} 与 v0.2beta 逐位一致`, () => {
      const next = mulberry32(seed);
      assert.deepEqual([next(), next(), next()], expected);
    });
  }

  it('输出落在 [0, 1)', () => {
    const next = mulberry32(7);
    for (let i = 0; i < 10_000; i += 1) {
      const v = next();
      assert.ok(v >= 0 && v < 1, `第 ${String(i)} 个值越界：${String(v)}`);
    }
  });

  it('非整数 seed 报错而不是静默截断', () => {
    assert.throws(() => mulberry32(1.5), TypeError);
    assert.throws(() => mulberry32(Number.NaN), TypeError);
  });
});

describe('mulberry32 性质', () => {
  it('同一 seed 的序列完全相同（确定性）', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 64 }), (seed, n) => {
        const a = mulberry32(seed);
        const b = mulberry32(seed);
        for (let i = 0; i < n; i += 1) assert.equal(a(), b());
      }),
    );
  });
});

describe('randomInt 性质', () => {
  it('任意合法区间内的结果都是区间内整数', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: -1000, max: 1000 }), fc.nat(1000), (seed, min, span) => {
        const v = randomInt(mulberry32(seed), min, min + span);
        assert.ok(Number.isInteger(v) && v >= min && v <= min + span);
      }),
    );
  });
});

describe('randomInt', () => {
  it('结果在闭区间内且两端都能取到', () => {
    const next = mulberry32(3);
    const seen = new Set<number>();
    for (let i = 0; i < 1_000; i += 1) {
      const v = randomInt(next, -2, 2);
      assert.ok(Number.isInteger(v) && v >= -2 && v <= 2);
      seen.add(v);
    }
    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      [-2, -1, 0, 1, 2],
    );
  });

  it('区间非法时报错', () => {
    const next = mulberry32(0);
    assert.throws(() => randomInt(next, 3, 1), RangeError);
    assert.throws(() => randomInt(next, 0, 1.5), RangeError);
    assert.throws(() => randomInt(next, 0, Number.MAX_SAFE_INTEGER + 1), RangeError);
  });

  it('区间宽度到上限为止', () => {
    const next = mulberry32(0);
    assert.doesNotThrow(() => randomInt(next, 0, MAX_SPAN - 1));
    assert.throws(() => randomInt(next, 0, MAX_SPAN), /2\^32/);
  });
});
