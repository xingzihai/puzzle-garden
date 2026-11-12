import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STUCK_STOP_AT, STUCK_WARN_AT, stuckGuard, stuckStreak } from './stuck.ts';
import type { GuardState, ToolCallSummary } from './types.ts';

const call = (over: Partial<ToolCallSummary> = {}): ToolCallSummary => ({
  name: 'check_code',
  arguments: '{}',
  result: '错误',
  ...over,
});

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

describe('stuckStreak', () => {
  it('只数末尾连续的同名同参数同结果', () => {
    assert.equal(stuckStreak([]), 0);
    assert.equal(stuckStreak([call(), call(), call()]), 3);
    assert.equal(stuckStreak([call(), call({ result: '别的' }), call()]), 1);
  });
});

describe('stuckGuard', () => {
  it('第 3 次提醒、第 5 次停止', () => {
    const before = [call(), call()];
    assert.ok(
      typeof stuckGuard.afterTurn(state({ callsBefore: before }), { calls: [call()], abortedDegenerate: false }) ===
        'object',
    );
    const warn = stuckGuard.afterTurn(state({ callsBefore: before }), { calls: [call()], abortedDegenerate: false });
    assert.ok(typeof warn === 'object' && 'warn' in warn);
    const stop = stuckGuard.afterTurn(state({ callsBefore: [call(), call(), call(), call()] }), {
      calls: [call()],
      abortedDegenerate: false,
    });
    assert.deepEqual(stop, { stop: 'stuck' });
    assert.equal(STUCK_WARN_AT, 3);
    assert.equal(STUCK_STOP_AT, 5);
  });

  it('不触发：结果或参数不同、没有调用', () => {
    assert.equal(
      stuckGuard.afterTurn(state({ callsBefore: [call(), call()] }), {
        calls: [call({ result: 'x' })],
        abortedDegenerate: false,
      }),
      'continue',
    );
    assert.equal(stuckGuard.afterTurn(state(), { calls: [], abortedDegenerate: false }), 'continue');
  });

  it('beforeRequest 不做事', () => {
    assert.equal(stuckGuard.beforeRequest(state()), 'continue');
  });
});
