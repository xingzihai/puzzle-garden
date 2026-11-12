import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_TOOL_STOP_AT, noToolGuard } from './no-tool.ts';
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

const turn = (calls: number) => ({
  calls: Array.from({ length: calls }, () => ({ name: 'read_code', arguments: '{}', result: 'x' })),
  abortedDegenerate: false,
});

describe('noToolGuard', () => {
  it('触发：连续第 3 轮没有工具调用 → stop no-tool', () => {
    assert.deepEqual(noToolGuard.afterTurn(state({ consecutiveNoTool: NO_TOOL_STOP_AT - 1 }), turn(0)), {
      stop: 'no-tool',
    });
  });

  it('不触发：不足 3 轮、或有工具调用', () => {
    assert.equal(noToolGuard.afterTurn(state({ consecutiveNoTool: 1 }), turn(0)), 'continue');
    assert.equal(noToolGuard.afterTurn(state({ consecutiveNoTool: 5 }), turn(2)), 'continue');
  });

  it('beforeRequest 不做事', () => {
    assert.equal(noToolGuard.beforeRequest(state()), 'continue');
  });
});
