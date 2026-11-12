import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTEXT_TOKEN_LIMIT, contextGuard } from './context.ts';
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

describe('contextGuard', () => {
  it('触发：上次 prompt_tokens > 900_000 → stop context-limit', () => {
    assert.deepEqual(contextGuard.beforeRequest(state({ lastPromptTokens: CONTEXT_TOKEN_LIMIT + 1 })), {
      stop: 'context-limit',
    });
  });

  it('不触发：等于上限、低于上限、或还没有上次请求', () => {
    assert.equal(contextGuard.beforeRequest(state({ lastPromptTokens: CONTEXT_TOKEN_LIMIT })), 'continue');
    assert.equal(contextGuard.beforeRequest(state({ lastPromptTokens: 100 })), 'continue');
    assert.equal(contextGuard.beforeRequest(state({ lastPromptTokens: null })), 'continue');
  });

  it('afterTurn 不做事', () => {
    assert.equal(contextGuard.afterTurn(state(), { calls: [], abortedDegenerate: false }), 'continue');
  });
});
