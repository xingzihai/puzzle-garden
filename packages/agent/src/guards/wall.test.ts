import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { wallGuard } from './wall.ts';
import type { GuardState } from './types.ts';

const state = (over: Partial<GuardState> = {}): GuardState => ({
  elapsedMs: 0,
  wallMs: 1000,
  limitCny: 0,
  spentCny: 0,
  plannedMaxTokens: null,
  nextTurn: 1,
  maxTurns: 60,
  submitWindow: 3,
  inWindow: false,
  recentCostsCny: [],
  lastPromptTokens: null,
  imageBytes: 0,
  imageBytesSoft: 32,
  imageBytesHard: 40,
  consecutiveAbortedDegenerate: 0,
  consecutiveNoTool: 0,
  callsBefore: [],
  ...over,
});

describe('wallGuard', () => {
  it('触发：elapsedMs ≥ wallMs → stop wall（请求前与重试前）', () => {
    assert.deepEqual(wallGuard.beforeRequest(state({ elapsedMs: 1000 })), { stop: 'wall' });
    assert.deepEqual(wallGuard.beforeRequest(state({ elapsedMs: 1500 })), { stop: 'wall' });
    assert.deepEqual(wallGuard.beforeRetry?.(state({ elapsedMs: 1000 })), { stop: 'wall' });
  });

  it('不触发：elapsedMs < wallMs', () => {
    assert.equal(wallGuard.beforeRequest(state({ elapsedMs: 999 })), 'continue');
    assert.equal(wallGuard.beforeRetry?.(state({ elapsedMs: 999 })), 'continue');
  });

  it('afterTurn 不做事', () => {
    assert.equal(wallGuard.afterTurn(state(), { calls: [], abortedDegenerate: false }), 'continue');
  });
});
