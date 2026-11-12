/** bezierPoint 的单元测试：端点、直线退化、已知取值与 t 范围。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bezierPoint } from './bezier.ts';

const P0 = [0, 0] as const;
const P1 = [1, 2] as const;
const P2 = [2, 2] as const;
const P3 = [3, 0] as const;

describe('bezierPoint', () => {
  it('t=0 与 t=1 落在端点', () => {
    assert.deepEqual(bezierPoint([P0, P1, P2, P3], 0), [0, 0]);
    assert.deepEqual(bezierPoint([P0, P1, P2, P3], 1), [3, 0]);
  });

  it('共线控制点退化为直线', () => {
    const point = bezierPoint(
      [
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 1],
      ],
      0.25,
    );
    assert.ok(Math.abs(point[1] - 1) < 1e-12);
  });

  it('已知中点取值', () => {
    const point = bezierPoint([P0, P1, P2, P3], 0.5);
    assert.ok(Math.abs(point[0] - 1.5) < 1e-12);
    assert.ok(Math.abs(point[1] - 1.5) < 1e-12);
  });

  it('t 允许超出 [0,1] 并给出外推点', () => {
    const before = bezierPoint([P0, P1, P2, P3], -0.5);
    const after = bezierPoint([P0, P1, P2, P3], 1.5);
    assert.notDeepEqual(before, [0, 0]);
    assert.notDeepEqual(after, [3, 0]);
  });

  it('把 -0 规范成 0', () => {
    const point = bezierPoint(
      [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ],
      0,
    );
    assert.equal(Object.is(point[0], 0), true);
    assert.equal(Object.is(point[1], 0), true);
  });
});
