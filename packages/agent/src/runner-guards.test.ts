/** 护栏组装顺序与全部事件分支；具体停止行为由各护栏测试和 runner 测试覆盖。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardMetric, RUN_GUARDS, WINDOW_GUARDS } from './runner-guards.ts';
import type { GuardState } from './guards/types.ts';

test('护栏顺序与窗口子集固定，metric 支持各护栏与未预留值', () => {
  assert.deepEqual(
    RUN_GUARDS.map((g) => g.name),
    ['wall', 'cost', 'turns', 'cost-window', 'wall-window', 'context', 'image', 'degenerate', 'stuck', 'no-tool'],
  );
  assert.deepEqual(
    WINDOW_GUARDS.map((g) => g.name),
    ['turns', 'cost-window', 'wall-window'],
  );
  const s: GuardState = {
    elapsedMs: 1,
    wallMs: 60000,
    limitCny: 3.5,
    spentCny: 1,
    plannedMaxTokens: null,
    nextTurn: 2,
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
  };
  for (const g of RUN_GUARDS) assert.equal(guardMetric(g.name, s, []).length, 2);
  assert.deepEqual(guardMetric('cost', s, []), [0, 2000]);
  assert.deepEqual(guardMetric('cost', { ...s, plannedMaxTokens: 100 }, []), [100, 2000]);
  assert.deepEqual(guardMetric('turns', { ...s, maxTurns: 8 }, []), [2, 8]);
  assert.equal(guardMetric('context', { ...s, lastPromptTokens: 30 }, [])[0], 30);
});
