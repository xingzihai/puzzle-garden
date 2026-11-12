import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { classifyOutcome } from './classify.ts';
import type { ClassifyInput } from './classify.ts';
import type { ChildReport } from './protocol.ts';

const okReport: ChildReport = {
  status: 'ok',
  hash: 'h',
  calls: 0,
  overlaps: [],
  console: [],
  consoleTruncated: 0,
};

function input(overrides: Partial<ClassifyInput>): ClassifyInput {
  return {
    timedOut: false,
    exitCode: 0,
    stderrHead: '',
    report: okReport,
    reportOverLimit: false,
    archiveOverLimit: false,
    ...overrides,
  };
}

describe('classify：结果分类', () => {
  test('ok / build-error', () => {
    assert.equal(classifyOutcome(input({})), 'ok');
    assert.equal(classifyOutcome(input({ report: { ...okReport, status: 'build-error' } })), 'build-error');
  });

  test('timeout 优先于一切', () => {
    assert.equal(classifyOutcome(input({ timedOut: true, exitCode: 137 })), 'timeout');
  });

  test('报告超限归 crashed，存档超限归 output-too-large', () => {
    assert.equal(classifyOutcome(input({ reportOverLimit: true, archiveOverLimit: true })), 'crashed');
    assert.equal(classifyOutcome(input({ archiveOverLimit: true })), 'output-too-large');
  });

  test('按退出码与 stderr 判 OOM', () => {
    assert.equal(classifyOutcome(input({ exitCode: 134, stderrHead: 'heap out of memory' })), 'out-of-memory');
    assert.equal(classifyOutcome(input({ exitCode: 133, stderrHead: 'Fatal process out of memory' })), 'out-of-memory');
    // 反例：退出码对但 stderr 不含关键字，或 stderr 对但退出码不对。
    assert.equal(classifyOutcome(input({ exitCode: 134, stderrHead: 'boom' })), 'crashed');
    assert.equal(classifyOutcome(input({ exitCode: 1, stderrHead: 'heap out of memory' })), 'crashed');
  });

  test('帧缺失或损坏归 crashed；有报告但退出码非 0 也 crashed', () => {
    assert.equal(classifyOutcome(input({ report: null })), 'crashed');
    assert.equal(classifyOutcome(input({ exitCode: 1 })), 'crashed');
  });
});
