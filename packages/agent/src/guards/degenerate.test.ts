import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEGENERATE_MAX_UNIT,
  DEGENERATE_MIN_UNIT,
  DEGENERATE_REPEATS,
  createDegenerateDetector,
  degenerateGuard,
  detectDegenerate,
} from './degenerate.ts';
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

describe('detectDegenerate', () => {
  it('触发：长 20–400 的片段连续重复 ≥ 8 次', () => {
    const block = 'x'.repeat(DEGENERATE_MIN_UNIT);
    assert.equal(detectDegenerate(block.repeat(DEGENERATE_REPEATS)), true);
    const long = 'word '.repeat(80); // 400
    assert.equal(detectDegenerate(long.repeat(DEGENERATE_REPEATS)), true);
  });

  it('不触发：重复次数不足、片段过短、普通长文本', () => {
    const block = 'x'.repeat(DEGENERATE_MIN_UNIT);
    assert.equal(detectDegenerate(block.repeat(DEGENERATE_REPEATS - 1)), false);
    assert.equal(detectDegenerate('ab'.repeat(4)), false);
    assert.equal(detectDegenerate(Array.from({ length: 3000 }, (_, i) => `line ${String(i)}`).join('\n')), false);
    assert.equal(detectDegenerate(''), false);
  });

  it('基本周期长于 400 的非周期文本不判退化', () => {
    // 用确定但非周期的序列构造 401 码元块；任何 ≤400 的周期都不构成 8 次连续重复。
    const block = Array.from({ length: DEGENERATE_MAX_UNIT + 1 }, (_, i) =>
      String.fromCharCode(97 + (Math.floor(Math.abs(Math.sin(i)) * 1_000_000) % 26)),
    ).join('');
    assert.equal(detectDegenerate(block.repeat(DEGENERATE_REPEATS)), false);
  });
});

describe('createDegenerateDetector', () => {
  it('跨多次 push 拼接后仍能识别；reset 清空', () => {
    const detector = createDegenerateDetector();
    const unit = 'z'.repeat(DEGENERATE_MIN_UNIT);
    let verdict = 'continue' as 'continue' | 'abort';
    for (let i = 0; i < DEGENERATE_REPEATS; i += 1) verdict = detector.push(unit);
    assert.equal(verdict, 'abort');
    assert.equal(detector.text().length, DEGENERATE_MIN_UNIT * DEGENERATE_REPEATS);
    detector.reset();
    assert.equal(detector.text(), '');
    assert.equal(detector.push('hello'), 'continue');
  });

  it('滑到窗口末尾的长重复也能识别', () => {
    const detector = createDegenerateDetector();
    detector.push('a'.repeat(9000));
    assert.equal(detector.push('b'.repeat(200)), 'abort');
  });
});

describe('degenerateGuard', () => {
  it('第一次取消不停止，连续第二次 → stop degenerate-loop', () => {
    assert.equal(degenerateGuard.afterTurn(state(), { calls: [], abortedDegenerate: true }), 'continue');
    assert.deepEqual(
      degenerateGuard.afterTurn(state({ consecutiveAbortedDegenerate: 1 }), {
        calls: [],
        abortedDegenerate: true,
      }),
      { stop: 'degenerate-loop' },
    );
  });

  it('未取消时不停止', () => {
    assert.equal(degenerateGuard.afterTurn(state(), { calls: [], abortedDegenerate: false }), 'continue');
  });

  it('beforeRequest 不做事（取消由 onDelta 触发）', () => {
    assert.equal(degenerateGuard.beforeRequest(state()), 'continue');
  });
});
