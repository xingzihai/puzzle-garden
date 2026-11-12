import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { turnsGuard } from './turns.ts';
import type { GuardState } from './types.ts';

const state = (over: Partial<GuardState> = {}): GuardState => ({
  elapsedMs: 0,
  wallMs: 1000,
  limitCny: 0,
  spentCny: 0,
  plannedMaxTokens: null,
  nextTurn: 1,
  maxTurns: 6,
  submitWindow: 2,
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

describe('turnsGuard', () => {
  it('触发停止：将要进行第 maxTurns + 1 轮', () => {
    assert.deepEqual(turnsGuard.beforeRequest(state({ nextTurn: 7 })), { stop: 'max-turns' });
  });

  it('触发窗口：第 maxTurns − submitWindow + 1 轮（这里是 5）', () => {
    assert.equal(turnsGuard.beforeRequest(state({ nextTurn: 4 })), 'continue');
    assert.deepEqual(turnsGuard.beforeRequest(state({ nextTurn: 5 })), { window: true });
    assert.deepEqual(turnsGuard.beforeRequest(state({ nextTurn: 6 })), { window: true });
  });

  it('窗口一旦进入：不再重复发窗口信号', () => {
    assert.equal(turnsGuard.beforeRequest(state({ nextTurn: 5, inWindow: true })), 'continue');
  });

  it('maxTurns 为 null（不限轮数）：永远继续，不停、不进窗口', () => {
    for (const nextTurn of [1, 5, 61, 999]) {
      assert.equal(turnsGuard.beforeRequest(state({ nextTurn, maxTurns: null })), 'continue');
    }
    assert.equal(turnsGuard.beforeRequest(state({ nextTurn: 999, maxTurns: null, inWindow: true })), 'continue');
  });

  it('afterTurn 不做事', () => {
    assert.equal(turnsGuard.afterTurn(state(), { calls: [], abortedDegenerate: false }), 'continue');
  });
});
