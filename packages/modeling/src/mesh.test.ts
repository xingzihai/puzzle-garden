/** mesh 通用工具的单元测试：-0 规范化与包围盒计算，含坏输入。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clean, computeBounds } from './mesh.ts';

describe('clean', () => {
  it('把 -0 规范成 0，其余值原样', () => {
    assert.equal(Object.is(clean(-0), 0), true);
    assert.equal(Object.is(clean(0), 0), true);
    assert.equal(clean(-3.5), -3.5);
    assert.equal(clean(100000), 100000);
  });
});

describe('computeBounds', () => {
  it('由顶点算出 min / max', () => {
    assert.deepEqual(computeBounds([0, 0, 0, 2, -3, 4, -1, 5, 2]), { min: [-1, -3, 0], max: [2, 5, 4] });
  });

  it('把 -0 规范成 0', () => {
    const bounds = computeBounds([-0, -0, -0]);
    assert.equal(Object.is(bounds.min[0], 0), true);
    assert.equal(Object.is(bounds.max[0], 0), true);
  });

  it('空数组报错', () => {
    assert.throws(() => computeBounds([]), /顶点数组为空/);
  });

  it('长度不是 3 的倍数报错', () => {
    assert.throws(() => computeBounds([1, 2]), /不是 3 的倍数/);
  });
});
