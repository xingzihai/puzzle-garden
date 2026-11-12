import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SandboxError } from './errors.ts';

describe('SandboxError', () => {
  test('保留 code、name 与 message，且是 Error', () => {
    const error = new SandboxError('invalid-declaration', '声明坏了');
    assert.ok(error instanceof Error);
    assert.ok(error instanceof SandboxError);
    assert.equal(error.name, 'SandboxError');
    assert.equal(error.code, 'invalid-declaration');
    assert.equal(error.message, '声明坏了');
  });
});
