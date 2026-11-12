import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { costWindowGuard } from './cost-window.ts';
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

describe('costWindowGuard（MODEL-SPEC §4.3 推演）', () => {
  it('触发：余额 < 3 × 最近 3 次最大实际花费 → 进入窗口', () => {
    const result = costWindowGuard.beforeRequest(state({ spentCny: 3.2, recentCostsCny: [0.1, 0.12, 0.09] }));
    assert.deepEqual(result, { window: true });
  });

  it('不触发：余额足够（3.50 − 2.90 = 0.60 ≥ 0.36）', () => {
    assert.equal(
      costWindowGuard.beforeRequest(state({ spentCny: 2.9, recentCostsCny: [0.08, 0.12, 0.1] })),
      'continue',
    );
  });

  it('不足 3 次时用已有的；没有历史不触发', () => {
    // [0.05] → 阈值 0.15，余额 0.10 < 0.15，进入
    assert.deepEqual(costWindowGuard.beforeRequest(state({ spentCny: 3.4, recentCostsCny: [0.05] })), {
      window: true,
    });
    // 余额 0.30 ≥ 0.15，不进
    assert.equal(costWindowGuard.beforeRequest(state({ spentCny: 3.2, recentCostsCny: [0.05] })), 'continue');
    assert.deepEqual(costWindowGuard.beforeRequest(state({ spentCny: 3.4, recentCostsCny: [0.05, 0.24] })), {
      window: true,
    });
    assert.equal(costWindowGuard.beforeRequest(state({ spentCny: 3.4, recentCostsCny: [] })), 'continue');
  });

  it('已在窗口或 limit=0（关闭护栏）时不触发', () => {
    assert.equal(
      costWindowGuard.beforeRequest(state({ spentCny: 3.4, recentCostsCny: [0.3], inWindow: true })),
      'continue',
    );
    assert.equal(
      costWindowGuard.beforeRequest(state({ limitCny: 0, spentCny: 3.4, recentCostsCny: [0.3] })),
      'continue',
    );
  });

  it('afterTurn 不做事', () => {
    assert.equal(costWindowGuard.afterTurn(state(), { calls: [], abortedDegenerate: false }), 'continue');
  });
});
