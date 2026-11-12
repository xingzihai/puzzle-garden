import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IMAGE_BYTES_HARD, IMAGE_BYTES_SOFT, imageGuard, viewAllowed } from './image.ts';
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
  imageBytesSoft: IMAGE_BYTES_SOFT,
  imageBytesHard: IMAGE_BYTES_HARD,
  consecutiveAbortedDegenerate: 0,
  consecutiveNoTool: 0,
  callsBefore: [],
  ...over,
});

describe('imageGuard', () => {
  it('软上限：> 32 MB 警告并拒绝后续看图', () => {
    const result = imageGuard.afterTurn(state({ imageBytes: IMAGE_BYTES_SOFT + 1 }), {
      calls: [],
      abortedDegenerate: false,
    });
    assert.ok(typeof result === 'object' && 'warn' in result);
    if (typeof result === 'object' && 'warn' in result) assert.ok(result.warn.includes('view_building'));
    assert.equal(viewAllowed(IMAGE_BYTES_SOFT + 1), false);
  });

  it('硬上限：> 40 MB → stop image-budget（请求前与轮末）', () => {
    const over = state({ imageBytes: IMAGE_BYTES_HARD + 1 });
    assert.deepEqual(imageGuard.beforeRequest(over), { stop: 'image-budget' });
    assert.deepEqual(imageGuard.afterTurn(over, { calls: [], abortedDegenerate: false }), { stop: 'image-budget' });
  });

  it('不触发：未超软上限', () => {
    const ok = state({ imageBytes: IMAGE_BYTES_SOFT });
    assert.equal(imageGuard.beforeRequest(ok), 'continue');
    assert.equal(imageGuard.afterTurn(ok, { calls: [], abortedDegenerate: false }), 'continue');
    assert.equal(viewAllowed(IMAGE_BYTES_SOFT), true);
  });
});
