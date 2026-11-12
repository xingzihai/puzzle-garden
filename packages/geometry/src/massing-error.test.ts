import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MassingError, massingCodeFromVoxelize } from './massing-error.ts';

describe('MassingError', () => {
  it('保留 code / name / 自定义中文可行动 message', () => {
    const error = new MassingError('below-ground', '导入后存在 y<1 的格：请把 at.y 抬高');
    assert.ok(error instanceof MassingError);
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'MassingError');
    assert.equal(error.code, 'below-ground');
    assert.match(error.message, /at\.y/);
  });

  it('不给 message 时用每个 code 的缺省中文文案', () => {
    for (const code of [
      'asset-missing',
      'assets-too-large',
      'out-of-range',
      'below-ground',
      'empty-import',
      'material-missing',
      'material-invalid',
      'document-invalid',
      'options-invalid',
      'limit-exceeded',
    ] as const) {
      const error = new MassingError(code);
      assert.equal(error.code, code);
      assert.ok(error.message.length > 0);
    }
  });
});

describe('massingCodeFromVoxelize', () => {
  it('映射表：material-none → material-missing，其余同名', () => {
    assert.equal(massingCodeFromVoxelize('document-invalid'), 'document-invalid');
    assert.equal(massingCodeFromVoxelize('options-invalid'), 'options-invalid');
    assert.equal(massingCodeFromVoxelize('material-none'), 'material-missing');
    assert.equal(massingCodeFromVoxelize('limit-exceeded'), 'limit-exceeded');
  });
});
