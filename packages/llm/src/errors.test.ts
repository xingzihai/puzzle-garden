/**
 * errors.ts 的测试（MODEL-SPEC §5.2）。
 * 覆盖每类失败的 class / code / retriable，以及 LlmError 的识别与脱敏长度上限。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cancelledFailure,
  httpFailure,
  invalidResponse,
  isLlmError,
  LlmError,
  transportFailure,
  truncatedFailure,
} from './errors.ts';

describe('transportFailure', () => {
  it('network / timeout / idle-timeout 都可重试、status 为 null', () => {
    for (const code of ['network', 'timeout', 'idle-timeout'] as const) {
      const f = transportFailure(code, '连接失败');
      assert.equal(f.class, 'transport');
      assert.equal(f.code, code);
      assert.equal(f.status, null);
      assert.equal(f.retriable, true);
    }
  });
});

describe('httpFailure', () => {
  it('429 可重试', () => {
    const f = httpFailure(429);
    assert.equal(f.code, 'http_429');
    assert.equal(f.retriable, true);
    assert.equal(f.status, 429);
  });

  it('400 / 401 / 402 / 422 不可重试', () => {
    for (const status of [400, 401, 402, 422]) {
      const f = httpFailure(status);
      assert.equal(f.code, 'http_4xx');
      assert.equal(f.retriable, false);
      assert.equal(f.status, status);
    }
  });

  it('500 / 503 可重试', () => {
    for (const status of [500, 503]) {
      const f = httpFailure(status);
      assert.equal(f.code, 'http_5xx');
      assert.equal(f.retriable, true);
      assert.equal(f.status, status);
    }
  });
});

describe('invalidResponse / truncated / cancelled', () => {
  it('invalid-response 不可重试，默认 code', () => {
    const f = invalidResponse('JSON 坏了');
    assert.equal(f.class, 'invalid-response');
    assert.equal(f.code, 'invalid-response');
    assert.equal(f.retriable, false);
  });

  it('[DONE] 无 usage 用 no-usage code', () => {
    assert.equal(invalidResponse('没有 usage', 'no-usage').code, 'no-usage');
  });

  it('truncated 的两种 code 都可重试', () => {
    for (const code of ['insufficient_system_resource', 'aborted'] as const) {
      const f = truncatedFailure(code);
      assert.equal(f.class, 'truncated');
      assert.equal(f.code, code);
      assert.equal(f.retriable, true);
    }
  });

  it('cancelled 不可重试', () => {
    const f = cancelledFailure();
    assert.equal(f.class, 'cancelled');
    assert.equal(f.code, 'cancelled');
    assert.equal(f.retriable, false);
  });

  it('message 截到 400 字符', () => {
    const f = invalidResponse('x'.repeat(500));
    assert.equal(f.message.length, 400);
  });
});

describe('LlmError', () => {
  it('携带 failure 且 name 正确', () => {
    const failure = httpFailure(503);
    const error = new LlmError(failure);
    assert.equal(error.name, 'LlmError');
    assert.equal(error.message, failure.message);
    assert.deepEqual(error.failure, failure);
  });

  it('isLlmError 只认 LlmError', () => {
    assert.equal(isLlmError(new LlmError(cancelledFailure())), true);
    assert.equal(isLlmError(new Error('x')), false);
    assert.equal(isLlmError('x'), false);
  });
});
