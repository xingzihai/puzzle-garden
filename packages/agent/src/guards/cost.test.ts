import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LAST_GASP_MIN_OUTPUT_TOKENS } from '@pg/llm/cost';
import { MIN_MAX_TOKENS, costGuard } from './cost.ts';
import type { GuardState } from './types.ts';

const state = (over: Partial<GuardState> = {}): GuardState => ({
  elapsedMs: 0,
  wallMs: 1000,
  limitCny: 3.5,
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

describe('costGuard', () => {
  it('触发：max_tokens < 2000 → stop cost-budget（提交窗口外）', () => {
    assert.deepEqual(costGuard.beforeRequest(state({ plannedMaxTokens: MIN_MAX_TOKENS - 1 })), { stop: 'cost-budget' });
    assert.deepEqual(costGuard.beforeRetry?.(state({ plannedMaxTokens: 0 })), { stop: 'cost-budget' });
  });

  it('提交窗口内允许最后一口气的小上限（≥256）；低于 256 仍停', () => {
    assert.equal(
      costGuard.beforeRequest(state({ plannedMaxTokens: LAST_GASP_MIN_OUTPUT_TOKENS, inWindow: true })),
      'continue',
    );
    assert.deepEqual(costGuard.beforeRequest(state({ plannedMaxTokens: 1024, inWindow: true })), 'continue');
    assert.deepEqual(
      costGuard.beforeRequest(state({ plannedMaxTokens: LAST_GASP_MIN_OUTPUT_TOKENS - 1, inWindow: true })),
      { stop: 'cost-budget' },
    );
    assert.deepEqual(
      costGuard.beforeRequest(state({ plannedMaxTokens: 1500, inWindow: true })),
      { stop: 'cost-budget' },
      '不是最后一口气形状的低预留仍停',
    );
  });

  it('不触发：max_tokens ≥ 2000，或还没预留', () => {
    assert.equal(costGuard.beforeRequest(state({ plannedMaxTokens: MIN_MAX_TOKENS })), 'continue');
    assert.equal(costGuard.beforeRequest(state({ plannedMaxTokens: 40000 })), 'continue');
    assert.equal(costGuard.beforeRequest(state({ plannedMaxTokens: null })), 'continue');
  });

  it('limitCny === 0 时关闭护栏，即使 max_tokens 很低', () => {
    assert.equal(costGuard.beforeRequest(state({ limitCny: 0, plannedMaxTokens: 1 })), 'continue');
  });

  it('afterTurn 不做事', () => {
    assert.equal(costGuard.afterTurn(state(), { calls: [], abortedDegenerate: false }), 'continue');
  });
});
