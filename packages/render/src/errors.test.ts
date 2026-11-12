/** errors.ts：RenderError 的 code / name / message。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RenderError } from './errors.ts';

test('RenderError 携带 code、name 与 message', () => {
  const error = new RenderError('invalid-request', 'views 不能重复');
  assert.equal(error.code, 'invalid-request');
  assert.equal(error.name, 'RenderError');
  assert.equal(error.message, 'views 不能重复');
  assert.ok(error instanceof Error);
});
