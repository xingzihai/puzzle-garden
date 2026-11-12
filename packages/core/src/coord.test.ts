import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { CoreError, XZ_MAX, XZ_MIN, Y_MAX, Y_MIN, checkCoord, chunkCoord, chunkKey } from './coord.ts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof CoreError ? e.code : 'not-core-error';
  }
  return undefined;
}

describe('checkCoord', () => {
  it('范围端点合法', () => {
    assert.doesNotThrow(() => {
      checkCoord(XZ_MIN, Y_MIN, XZ_MIN);
    });
    assert.doesNotThrow(() => {
      checkCoord(XZ_MAX, Y_MAX, XZ_MAX);
    });
    assert.equal(XZ_MIN, -(2 ** 25));
    assert.equal(XZ_MAX, 2 ** 25 - 1);
    assert.equal(Y_MIN, -2048);
    assert.equal(Y_MAX, 2047);
  });

  it('越界报错，信息里有轴名和范围', () => {
    assert.throws(() => {
      checkCoord(XZ_MAX + 1, 0, 0);
    }, /x=33554432 越界.*-33554432, 33554431/);
    assert.throws(() => {
      checkCoord(0, Y_MIN - 1, 0);
    }, /y=-2049 越界/);
    assert.throws(() => {
      checkCoord(0, 0, XZ_MIN - 1);
    }, /z=/);
  });

  it('非整数一律报错，不取整', () => {
    for (const bad of [0.5, Number.NaN, Number.POSITIVE_INFINITY, -Infinity, 2 ** 53]) {
      assert.equal(
        codeOf(() => {
          checkCoord(0, bad, 0);
        }),
        'invalid-coord',
      );
    }
    assert.throws(() => {
      checkCoord(1.5, 0, 0);
    }, /x 必须是整数，实际是 1.5/);
  });

  it('CoreError 带 code 与 name', () => {
    const e = new CoreError('unknown-block', '消息');
    assert.equal(e.code, 'unknown-block');
    assert.equal(e.name, 'CoreError');
    assert.ok(e instanceof Error);
  });
});

describe('chunkCoord', () => {
  it('向下取整（负数也是）', () => {
    assert.equal(chunkCoord(0), 0);
    assert.equal(chunkCoord(15), 0);
    assert.equal(chunkCoord(16), 1);
    assert.equal(chunkCoord(-1), -1);
    assert.equal(chunkCoord(-16), -1);
    assert.equal(chunkCoord(-17), -2);
  });

  it('局部坐标在 0–15', () => {
    fc.assert(
      fc.property(fc.integer({ min: XZ_MIN, max: XZ_MAX }), (v) => {
        const local = v - chunkCoord(v) * 16;
        assert.ok(local >= 0 && local <= 15);
      }),
    );
  });
});

describe('chunkKey', () => {
  const cxz = fc.integer({ min: chunkCoord(XZ_MIN), max: chunkCoord(XZ_MAX) });
  const cy = fc.integer({ min: chunkCoord(Y_MIN), max: chunkCoord(Y_MAX) });

  it('端点区块的键是安全整数，最大值不超过 2^52', () => {
    const lo = chunkKey(chunkCoord(XZ_MIN), chunkCoord(Y_MIN), chunkCoord(XZ_MIN));
    const hi = chunkKey(chunkCoord(XZ_MAX), chunkCoord(Y_MAX), chunkCoord(XZ_MAX));
    assert.equal(lo, 0);
    assert.equal(hi, 2 ** 52 - 1);
    assert.ok(Number.isSafeInteger(hi));
  });

  it('不同区块的键不同（单射）', () => {
    fc.assert(
      fc.property(cxz, cy, cxz, cxz, cy, cxz, (ax, ay, az, bx, by, bz) => {
        const same = ax === bx && ay === by && az === bz;
        assert.equal(chunkKey(ax, ay, az) === chunkKey(bx, by, bz), same);
      }),
    );
  });
});
