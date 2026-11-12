/**
 * massing 子运行的 mock 剧本（SUBAGENT-LOOP-SPEC §8）：成功、预算拒绝、父中止、渲染失败、子内部错误、
 * 复用、子触顶未交付、未接线 no-host。
 * 父 run 走真实 `runRun` + 体素 target（假的 check / render 不会被调用），子运行走 `createModelingTarget` +
 * 假 execute / render / renderContact 与独立剧本 client；不发真实请求、不起 bwrap / Chrome。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';

import { deriveTrace } from '@pg/store/derive';
import { openRunDir } from '@pg/store/run-dir';

import {
  CHILD_CODE,
  CONTACT_PNG,
  DOC_HASH,
  PARENT_LIMITS,
  call,
  cleanupRoots,
  firstOf,
  messageStep,
  okExecution,
  runHarness,
  subrunsOf,
  textOf,
} from '../../fixtures/massing-harness.ts';

afterEach(cleanupRoots);

it('massing-success：子四步交付，父收到引用 + 图 + 几何摘要，totals 含子花费', async () => {
  const result = await runHarness({
    parentSteps: [
      messageStep([call('massing', { brief: '做一个六角亭的粗体量', maxTurns: 8, maxCny: 0.4 })]),
      messageStep([call('read_massing', { id: 'massing#1', from: 1, to: 1 })], {
        imageBlocks: 1,
        toolIncludes: ['massing#1'],
      }),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
    ],
  });
  assert.equal(result.outcome.stopReason, 'max-turns');
  assert.equal(result.outcome.delivery, null);

  const massingText = firstOf(textOf(result.dir, result.events, 'massing'));
  assert.match(massingText, /massing#1/);
  assert.match(massingText, /sub\/massing-1/);
  assert.match(massingText, /几何摘要：1 个部件/);
  const readText = firstOf(textOf(result.dir, result.events, 'read_massing'));
  assert.match(readText, /1\| export default function build/);

  // 第二个请求前带 1 个图片块（合成图计入父图片预算）。
  const requests = result.events.filter((event) => event.type === 'llm.request');
  assert.equal(firstOf(requests.slice(1)).body.images, 1);

  // subrun.result：success + 引用 + 文档 hash；文档可读且 hash 复算一致。
  const body = firstOf(subrunsOf(result.events)).body;
  assert.equal(body.status, 'success');
  assert.equal(body.ordinal, 1);
  assert.equal(body.documentHash, DOC_HASH);
  const parentReader = openRunDir(result.dir);
  assert.ok(body.code !== undefined && body.document !== undefined && body.image !== undefined);
  assert.equal(new TextDecoder().decode(parentReader.blob(body.code.sha256)), CHILD_CODE);
  assert.deepEqual(parentReader.blob(body.image.sha256), CONTACT_PNG);

  // 父 totals = 父自己的 llm.attempt + 子 run.end.totals.costCny（不双计）。
  const parentOwn = result.events
    .filter((event) => event.type === 'llm.attempt')
    .reduce((sum, event) => {
      assert.ok(event.body.settledCny !== null);
      return sum + Math.round(event.body.settledCny * 1e8);
    }, 0);
  const end = firstOf(result.events.filter((event) => event.type === 'run.end'));
  assert.ok(end.body.totals.costCny !== null);
  assert.equal(Math.round(end.body.totals.costCny * 1e8) - parentOwn, Math.round(body.costCny * 1e8));
  assert.deepEqual(deriveTrace(result.events).subruns, [
    {
      runId: 'massing-1',
      dir: 'sub/massing-1',
      callId: body.callId,
      status: 'success',
      costCny: body.costCny,
      turns: 4,
    },
  ]);

  // 子 run：parent 关联、交付文件、run.end 为交付（stopReason null）。
  const childEvents = result.childEvents;
  assert.ok(childEvents !== null);
  const childStart = firstOf(childEvents.filter((event) => event.type === 'run.start'));
  assert.deepEqual(childStart.body.parent, { runId: 'parent-run', dir: '../..', callId: body.callId, turn: 1 });
  assert.equal(childStart.runId, 'massing-1');
  assert.equal(
    childEvents.some((event) => event.type === 'model.delivery'),
    true,
  );
  assert.ok(existsSync(join(result.childDir, 'delivery', 'source.ts')));
  assert.ok(existsSync(join(result.childDir, 'delivery', 'model.json')));
});

it('massing-budget：父剩余不足预留 → 拒绝启动、无目录、后续请求正常', async () => {
  const result = await runHarness({
    // 父上限 0.45，第一轮花掉一点后剩余 < effMaxCny 0.5（args maxCny=1 被 host 默认收紧到 0.5）。
    limits: { ...PARENT_LIMITS, maxCostCny: 0.45 },
    parentSteps: [
      messageStep([call('massing', { brief: '做一个大穹顶', maxTurns: 8, maxCny: 1 })]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
    ],
  });
  assert.equal(result.outcome.stopReason, 'max-turns');
  assert.match(firstOf(textOf(result.dir, result.events, 'massing')), /剩余预算/);
  assert.equal(existsSync(join(result.dir, 'sub')), false);
  assert.equal(subrunsOf(result.events).length, 0);
});

it('massing-abort：父 signal 中止 → 子 cancelled、父 cancelled、无交付', async () => {
  const controller = new AbortController();
  const result = await runHarness({
    controller,
    execute: (code) => {
      controller.abort();
      return Promise.resolve(okExecution(code));
    },
    parentSteps: [messageStep([call('massing', { brief: '中止测试', maxTurns: 8, maxCny: 0.4 })])],
  });
  assert.equal(result.outcome.stopReason, 'cancelled');
  assert.equal(result.outcome.delivery, null);
  assert.equal(existsSync(join(result.dir, 'delivery')), false);
  const childEvents = result.childEvents;
  assert.ok(childEvents !== null);
  const end = firstOf(childEvents.filter((event) => event.type === 'run.end'));
  assert.equal(end.body.stopReason, 'cancelled');
  const subrun = firstOf(subrunsOf(result.events)).body;
  assert.equal(subrun.status, 'aborted');
  assert.equal(subrun.stopReason, 'cancelled');
});

it('massing-render-fail：子交付成功但合成图失败，引用仍有效、无图片块', async () => {
  const failure = Object.assign(new Error('unsupported'), { kind: 'unsupported' });
  const result = await runHarness({
    renderContact: () => Promise.reject(failure),
    parentSteps: [
      messageStep([call('massing', { brief: '渲染失败测试', maxTurns: 8, maxCny: 0.4 })]),
      messageStep([call('read_massing', { id: 'massing#1' })], { imageBlocks: 0 }),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
    ],
  });
  assert.equal(result.outcome.stopReason, 'max-turns');
  assert.match(firstOf(textOf(result.dir, result.events, 'massing')), /合成图渲染失败（unsupported）/);
  const subrun = firstOf(subrunsOf(result.events)).body;
  assert.equal(subrun.status, 'success');
  assert.equal(subrun.image, undefined);
  assert.equal(subrun.documentHash, DOC_HASH);
  const failedRender = firstOf(result.events.filter((event) => event.type === 'render.result'));
  assert.equal(failedRender.body.purpose, 'massing');
  assert.equal(failedRender.body.kind, 'unsupported');
});

it('massing-internal：子 run_model 宿主抛错 → 父收 failed、按预留全额结算、父 run 不 internal-error', async () => {
  const result = await runHarness({
    execute: () => Promise.reject(new Error('bwrap boom')),
    parentSteps: [
      messageStep([call('massing', { brief: '内部错误测试', maxTurns: 8, maxCny: 0.4 })]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
    ],
    childSteps: [messageStep([call('write_code', { code: CHILD_CODE })]), messageStep([call('run_model', {})])],
  });
  assert.equal(result.outcome.stopReason, 'max-turns');
  assert.match(firstOf(textOf(result.dir, result.events, 'massing')), /internal-error/);
  const subrun = firstOf(subrunsOf(result.events)).body;
  assert.equal(subrun.status, 'failed');
  assert.equal(subrun.stopReason, 'internal-error');
  // 按预留全额（effMaxCny = 0.4）结算。
  assert.equal(subrun.costCny, 0.4);
  const end = firstOf(result.events.filter((event) => event.type === 'run.end'));
  assert.ok(end.body.totals.costCny !== null && end.body.totals.costCny >= 0.4);
});

it('massing-reuse：同键第二次复用，不新建子目录、不再预留、文本注明复用', async () => {
  const args = { brief: '同一个粗体量', maxTurns: 8, maxCny: 0.4 };
  const result = await runHarness({
    parentSteps: [
      messageStep([call('massing', args)]),
      messageStep([call('massing', args)]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
    ],
  });
  assert.equal(result.outcome.stopReason, 'max-turns');
  const texts = textOf(result.dir, result.events, 'massing');
  assert.equal(texts.length, 2);
  assert.match(firstOf(texts.slice(1)), /同键，复用，没有重新计费/);
  const subruns = subrunsOf(result.events);
  assert.equal(subruns.length, 2);
  const reuse = firstOf(subruns.slice(1)).body;
  assert.equal(reuse.reason, 'reuse');
  assert.equal(reuse.costCny, 0);
  // 只启动一个子运行；子脚本（4 步）只被消费一次。
  const childRoot = join(result.dir, 'sub');
  assert.ok(readFileSync(join(childRoot, 'massing-1', 'events.jsonl'), 'utf8').length > 0);
  assert.equal(existsSync(join(childRoot, 'massing-2')), false);
});

it('子运行触顶未交付（max-turns）：父收 failed，文本含轮数上限与建议', async () => {
  const result = await runHarness({
    massing: { limits: { maxTurns: 4 } },
    parentSteps: [
      messageStep([call('massing', { brief: '不提交的子运行', maxTurns: 40, maxCny: 0.4 })]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
    ],
    childSteps: [
      messageStep([call('write_code', { code: CHILD_CODE })]),
      messageStep([call('run_model', {})]),
      messageStep([call('view_model', {})]),
      messageStep([call('view_model', {})]),
    ],
  });
  assert.equal(result.outcome.stopReason, 'max-turns');
  const text = firstOf(textOf(result.dir, result.events, 'massing'));
  assert.match(text, /未交付/);
  assert.match(text, /轮数上限（4 轮）/);
  assert.match(text, /调大 maxTurns/);
  const subrun = firstOf(subrunsOf(result.events)).body;
  assert.equal(subrun.status, 'failed');
  assert.equal(subrun.stopReason, 'max-turns');
});

it('未接线 host：massing 返回 no-host，父 run 继续', async () => {
  const result = await runHarness({
    massing: null,
    parentSteps: [
      messageStep([call('massing', { brief: '没有宿主', maxTurns: 8, maxCny: 0.4 })]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
    ],
  });
  assert.equal(result.outcome.stopReason, 'max-turns');
  assert.match(firstOf(textOf(result.dir, result.events, 'massing')), /没有接入草模子运行/);
  assert.equal(subrunsOf(result.events).length, 0);
});
