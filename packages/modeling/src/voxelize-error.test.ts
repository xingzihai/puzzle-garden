/** VoxelizeError 的单元测试：错误码封闭联合与 message / name 透传。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VoxelizeError } from './voxelize-error.ts';

describe('VoxelizeError', () => {
  it('保留 code、中文 message 与类名', () => {
    const error = new VoxelizeError('material-none', '没有可用于默认材质的方块候选；宿主注入的方块颜色表为空');
    assert.ok(error instanceof Error);
    assert.ok(error instanceof VoxelizeError);
    assert.equal(error.name, 'VoxelizeError');
    assert.equal(error.code, 'material-none');
    assert.match(error.message, /候选/);
  });

  it('四个错误码都可构造', () => {
    const codes = ['document-invalid', 'options-invalid', 'material-none', 'limit-exceeded'] as const;
    for (const code of codes) {
      assert.equal(new VoxelizeError(code, '说明').code, code);
    }
  });
});
