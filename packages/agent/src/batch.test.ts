/**
 * batch 的单元测试（AGENT-SPEC §8、决策 #38）：批准文件 schema、上限 / sealed 拒绝、只跑第 1 个样本。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BatchError, NEXT_STEP_HINT, parseApproval, readApproval, runBatch, validateApproval } from './batch.ts';
import type { Approval } from './batch.ts';

const DIR = mkdtempSync(join(tmpdir(), 'pg-batch-'));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

const OK: Approval = {
  id: 'm1-batch-1',
  by: 'owner',
  date: '2026-10-03',
  text: '批准跑 1 个小屋样本',
  tasks: ['packages/agent/fixtures/tasks/small-house.md'],
  runsPerTask: 1,
  maxCostCnyPerRun: 3.5,
};

function item(runId: string) {
  return { runId, stopReason: null, costCny: 0.5, turns: 3 };
}

describe('batch', () => {
  it('parseApproval：合法通过；缺字段 / id 格式 / 日期报错', () => {
    assert.deepEqual(parseApproval(OK), OK);
    assert.throws(() => parseApproval({ ...OK, by: 'someone' }), BatchError);
    assert.throws(() => parseApproval({ ...OK, id: 'Bad ID' }), BatchError);
    assert.throws(() => parseApproval({ ...OK, date: '2026/10/03' }), BatchError);
    assert.throws(() => parseApproval({ ...OK, tasks: [] }), BatchError);
    assert.throws(() => parseApproval({ ...OK, text: '' }), BatchError);
  });

  it('readApproval：坏 JSON 报可读错误；合法文件读回', () => {
    const bad = join(DIR, 'bad.json');
    writeFileSync(bad, '{不是 JSON');
    assert.throws(
      () => readApproval(bad),
      (e: unknown) => e instanceof BatchError && e.message.includes('不是合法 JSON'),
    );
    assert.throws(() => readApproval(join(DIR, 'missing.json')), BatchError);
    const good = join(DIR, 'good.json');
    writeFileSync(good, JSON.stringify(OK));
    assert.deepEqual(readApproval(good), OK);
  });

  it('validateApproval：单次上限 ≤ 3.5；sealed 路径拒绝', () => {
    assert.doesNotThrow(() => {
      validateApproval(OK);
    });
    assert.throws(
      () => {
        validateApproval({ ...OK, maxCostCnyPerRun: 3.6 });
      },
      (e: unknown) => e instanceof BatchError && e.message.includes('超过 3.5'),
    );
    assert.throws(
      () => {
        validateApproval({ ...OK, tasks: ['/x/sealed/t.md'] });
      },
      (e: unknown) => e instanceof BatchError && e.message.includes('sealed'),
    );
  });

  it('runBatch：只跑第 1 个样本，给出剩余数与下一步提示', async () => {
    const calls: { task: string; seed: number }[] = [];
    const approval: Approval = { ...OK, tasks: ['a.md', 'b.md', 'c.md'], seed: 7 };
    const report = await runBatch(approval, (task, seed) => {
      calls.push({ task, seed });
      return Promise.resolve(item('run-1'));
    });
    assert.deepEqual(calls, [{ task: 'a.md', seed: 7 }]);
    assert.equal(report.ran, 1);
    assert.equal(report.plannedTasks, 3);
    assert.equal(report.remaining, 2);
    assert.equal(report.first.task, 'a.md');
    assert.equal(report.first.result.runId, 'run-1');
    assert.equal(report.nextStep, NEXT_STEP_HINT);
  });

  it('runBatch：校验不过时不调用 runOne', async () => {
    let called = 0;
    await assert.rejects(
      runBatch({ ...OK, maxCostCnyPerRun: 9 }, () => {
        called += 1;
        return Promise.resolve(item('x'));
      }),
      BatchError,
    );
    assert.equal(called, 0);
  });
});
