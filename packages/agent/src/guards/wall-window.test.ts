import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WALL_WINDOW_MS, wallWindowGuard } from './wall-window.ts';
import type { GuardState } from './types.ts';

const state = (over: Partial<GuardState> = {}): GuardState => ({
  elapsedMs: 0,
  wallMs: 2_400_000,
  limitCny: 3.5,
  spentCny: 0,
  plannedMaxTokens: null,
  nextTurn: 1,
  maxTurns: null,
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

describe('wallWindowGuard（决策 #87）', () => {
  it('常量：提前量 3 分钟', () => {
    assert.equal(WALL_WINDOW_MS, 180_000);
  });

  it('触发：wallMs − elapsedMs < 180_000（边界取严格小于）', () => {
    // 余额 179_999 < 180_000，进入
    assert.deepEqual(wallWindowGuard.beforeRequest(state({ elapsedMs: 2_400_000 - 179_999 })), { window: true });
    // 余额恰好 180_000，不进入
    assert.equal(wallWindowGuard.beforeRequest(state({ elapsedMs: 2_400_000 - 180_000 })), 'continue');
    // 余额 180_001，不进入
    assert.equal(wallWindowGuard.beforeRequest(state({ elapsedMs: 2_400_000 - 180_001 })), 'continue');
  });

  it('不触发：刚开跑或时间充裕', () => {
    assert.equal(wallWindowGuard.beforeRequest(state({ elapsedMs: 0 })), 'continue');
  });

  it('已在窗口内或墙钟已过：不再重复发窗口信号', () => {
    assert.equal(wallWindowGuard.beforeRequest(state({ elapsedMs: 2_400_000, inWindow: true })), 'continue');
    assert.equal(
      wallWindowGuard.beforeRequest(state({ elapsedMs: 2_500_000, wallMs: 2_400_000, inWindow: true })),
      'continue',
    );
  });

  it('afterTurn 不做事', () => {
    assert.equal(wallWindowGuard.afterTurn(state(), { calls: [], abortedDegenerate: false }), 'continue');
  });
});
