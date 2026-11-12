/**
 * massing 的边界与回放（不走完整父循环，直接调 `runMassingTool`）：
 * 回放成功 / 复用 / 缺记录、墙钟与目录已存在的拒绝、宿主异常与启动前抛错、图片预算跳过与渲染中止、
 * 坏文档降级。SUBAGENT-LOOP-SPEC §2–§7。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';

import { createRunDir, openRunDir } from '@pg/store/run-dir';

import {
  CHILD_CODE,
  CONTACT_PNG,
  DOC,
  DOC_HASH,
  call,
  cleanupRoots,
  directBudget,
  directContext,
  directHost,
  directStore,
  firstOf,
  initialToolState,
  messageStep,
  runHarness,
  subrunsOf,
  textOf,
} from '../../fixtures/massing-harness.ts';
import { runMassingTool } from './host.ts';
import { massingReuseKey } from './tool.ts';

afterEach(cleanupRoots);

it('回放：按 callId 从原 run 重建 text / image / 文档，不启动子运行', async () => {
  const result = await runHarness({
    parentSteps: [
      messageStep([call('massing', { brief: '回放源', maxTurns: 8, maxCny: 0.4 })]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
    ],
  });
  const original = firstOf(subrunsOf(result.events)).body;
  const originalText = firstOf(textOf(result.dir, result.events, 'massing'));

  const store = directStore();
  const budget = directBudget();
  const state = initialToolState();
  const host = directHost({ replayParent: openRunDir(result.dir) }, 'replay');
  const outcome = await runMassingTool(
    { brief: '回放源', maxTurns: 8, maxCny: 0.4 },
    original.callId,
    state,
    directContext(store, budget, { massing: host }),
  );
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.text, originalText);
  assert.equal(outcome.images.length, 2);
  assert.equal(state.massing.ordinal, 1);
  assert.equal(state.massing.runs.length, 1);
  assert.equal(firstOf(state.massing.runs).source, CHILD_CODE);
  assert.equal(firstOf(state.massing.runs).documentHash, DOC_HASH);
  assert.equal(state.massingDocuments.length, 1);
  assert.deepEqual(firstOf(state.massingDocuments), { id: 'massing#1', document: DOC });
  assert.equal(budget.spent, original.costCny);
});

it('回放：复用记录的文本与图也按记录重建（不复用表也不重复登记）', async () => {
  const args = { brief: '重复体量', maxTurns: 8, maxCny: 0.4 };
  const result = await runHarness({
    parentSteps: [
      messageStep([call('massing', args)]),
      messageStep([call('massing', args)]),
      messageStep([call('read_code', {})]),
      messageStep([call('read_code', {})]),
    ],
  });
  const second = firstOf(subrunsOf(result.events).slice(1));
  const parentReader = openRunDir(result.dir);
  const secondText = parentReader.blob(second.body.text.sha256);
  const store = directStore();
  const state = initialToolState();
  const outcome = await runMassingTool(
    args,
    second.body.callId,
    state,
    directContext(store, directBudget(), { massing: directHost({ replayParent: parentReader }, 'replay') }),
  );
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.text, new TextDecoder().decode(secondText));
  assert.equal(outcome.images.length, 2);
  assert.equal(state.massing.runs.length, 0);
  assert.equal(state.massingDocuments.length, 0);
});

it('回放：缺记录或没接 replayParent → replay-missing', async () => {
  const store = directStore();
  const missing = await runMassingTool(
    { brief: 'x', maxTurns: 8, maxCny: 0.4 },
    'call_none',
    initialToolState(),
    directContext(store, directBudget(), { massing: directHost({}, 'replay') }),
  );
  assert.equal(missing.status, 'replay-missing');
});

it('拒绝：父剩余墙钟不足释放预留；目录已存在不消耗序号', async () => {
  const store = directStore();
  const budget = directBudget();
  const state = initialToolState();
  const wall = await runMassingTool(
    { brief: '墙钟不足', maxTurns: 8, maxCny: 0.4 },
    'call_wall',
    state,
    directContext(store, budget, { massing: directHost(), remainingWallMs: () => 59_999 }),
  );
  assert.equal(wall.status, 'rejected');
  assert.match(wall.text, /剩余墙钟/);
  assert.equal(budget.reserved, 0);
  assert.equal(budget.spent, 0);
  assert.equal(state.massing.ordinal, 0);

  // 目录已存在：不启动、不消耗序号、不残留预留。
  const existingRoot = mkdtempSync(join(tmpdir(), 'pg-massing-dir-'));
  const dirStore = createRunDir(existingRoot, 'parent');
  mkdirSync(join(dirStore.dir, 'sub', 'massing-1'), { recursive: true });
  const dirBudget = directBudget();
  const dirState = initialToolState();
  const exists = await runMassingTool(
    { brief: '目录占用', maxTurns: 8, maxCny: 0.4 },
    'call_dir',
    dirState,
    directContext(dirStore, dirBudget, { massing: directHost() }),
  );
  assert.equal(exists.status, 'rejected');
  assert.match(exists.text, /目录已存在/);
  assert.equal(dirState.massing.ordinal, 0);
  assert.equal(dirBudget.reserved, 0);
});

it('宿主异常：runRun 前的依赖工厂抛错 → failed、按预留全额、事件 reason=host-error', async () => {
  const store = directStore();
  const budget = directBudget();
  const outcome = await runMassingTool(
    { brief: '宿主异常', maxTurns: 8, maxCny: 0.4 },
    'call_host',
    initialToolState(),
    directContext(store, budget, {
      massing: directHost({
        versions: () => {
          throw new Error('版本工厂坏了');
        },
      }),
    }),
  );
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.text, /internal-error/);
  assert.match(outcome.text, /版本工厂坏了/);
  assert.equal(budget.spent, 0.4);
  assert.equal(budget.reserved, 0);
  const subrun = firstOf(subrunsOf(openRunDir(store.dir).events())).body;
  assert.equal(subrun.status, 'failed');
  assert.equal(subrun.reason, 'host-error');
  assert.equal(subrun.costCny, 0.4);
});

it('启动前的意外宿主缺陷：不扣费、原样抛出', async () => {
  const store = directStore();
  const budget = directBudget();
  await assert.rejects(
    runMassingTool(
      { brief: '预检查抛错', maxTurns: 8, maxCny: 0.4 },
      'call_throw',
      initialToolState(),
      directContext(store, budget, {
        massing: directHost(),
        remainingWallMs: () => {
          throw new Error('时钟坏了');
        },
      }),
    ),
    /时钟坏了/,
  );
  assert.equal(budget.spent, 0);
  assert.equal(budget.reserved, 0);
});

it('合成图超预算跳过渲染；渲染中止不算子运行失败', async () => {
  // 超预算：不调 renderContact，文本注明未附图，render.result 记 image-budget-skip。
  const store = directStore();
  const state = initialToolState();
  state.imageBytes = Number.MAX_SAFE_INTEGER;
  const skipped = await runMassingTool(
    { brief: '图片超限', maxTurns: 8, maxCny: 0.4 },
    'call_skip',
    state,
    directContext(store, directBudget(), { massing: directHost() }),
  );
  assert.equal(skipped.status, 'ok');
  assert.match(skipped.text, /未附合成图/);
  assert.equal(skipped.images.length, 0);
  const renderSkip = firstOf(
    openRunDir(store.dir)
      .events()
      .filter((event) => event.type === 'render.result'),
  );
  assert.equal(renderSkip.body.kind, 'image-budget-skip');

  // 渲染中止：status aborted，记录仍是子运行 success 且无 image。
  const abortStore = directStore();
  const controller = new AbortController();
  const aborted = await runMassingTool(
    { brief: '渲染中止', maxTurns: 8, maxCny: 0.4 },
    'call_abort',
    initialToolState(),
    directContext(abortStore, directBudget(), {
      signal: controller.signal,
      massing: directHost({
        renderContact: () => {
          controller.abort();
          return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
      }),
    }),
  );
  assert.equal(aborted.status, 'aborted');
  assert.match(aborted.text, /合成图被中止/);
  const abortRecord = firstOf(subrunsOf(openRunDir(abortStore.dir).events())).body;
  assert.equal(abortRecord.status, 'success');
  assert.equal(abortRecord.image, undefined);
});

it('复用命中但图片累计超限：文本注明未附合成图，记录不带 image', async () => {
  const store = directStore();
  const state = initialToolState();
  state.imageBytes = Number.MAX_SAFE_INTEGER;
  state.massing.runs.push({
    id: 'massing#3',
    ordinal: 3,
    runId: 'massing-3',
    dir: 'sub/massing-3',
    key: massingReuseKey({ brief: '复用超限', maxTurns: 20, maxCny: 0.5 }),
    text: '旧的成功文本',
    source: CHILD_CODE,
    image: CONTACT_PNG,
    document: DOC,
    documentHash: DOC_HASH,
  });
  const outcome = await runMassingTool(
    { brief: '复用超限', maxTurns: 20, maxCny: 0.5 },
    'call_reuse',
    state,
    directContext(store, directBudget(), { massing: directHost() }),
  );
  assert.equal(outcome.status, 'ok');
  assert.match(outcome.text, /旧的成功文本/);
  assert.match(outcome.text, /未附合成图/);
  assert.equal(outcome.images.length, 0);
  const record = firstOf(subrunsOf(openRunDir(store.dir).events())).body;
  assert.equal(record.reason, 'reuse');
  assert.equal(record.image, undefined);
});

it('回放：记录里的文档坏掉时不登记，仍返回原文本', async () => {
  const store = directStore();
  const encoder = new TextEncoder();
  const textRef = store.putBlob(encoder.encode('旧文本'));
  const codeRef = store.putBlob(encoder.encode(CHILD_CODE));
  const docRef = store.putBlob(encoder.encode('not json'));
  const callId = 'call_bad_doc';
  store.append('subrun.result', 1, {
    runId: 'massing-1',
    dir: 'sub/massing-1',
    callId,
    ordinal: 1,
    status: 'success',
    reservedCny: 0.5,
    costCny: 0.1,
    turns: 4,
    code: codeRef,
    document: docRef,
    documentHash: 'f'.repeat(64),
    text: textRef,
  });
  store.close();
  const state = initialToolState();
  const outcome = await runMassingTool(
    { brief: '坏文档', maxTurns: 8, maxCny: 0.4 },
    callId,
    state,
    directContext(store, directBudget(), { massing: directHost({ replayParent: openRunDir(store.dir) }, 'replay') }),
  );
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.text, '旧文本');
  assert.equal(state.massing.runs.length, 0);
  assert.equal(state.massingDocuments.length, 0);
});

it('渲染失败对象不是 Error 时 kind 回退为 error', async () => {
  const store = directStore();
  const outcome = await runMassingTool(
    { brief: '空消息异常', maxTurns: 8, maxCny: 0.4 },
    'call_str',
    initialToolState(),
    directContext(store, directBudget(), {
      massing: directHost({ renderContact: () => Promise.reject(new Error('')) }),
    }),
  );
  assert.equal(outcome.status, 'render-failed');
  assert.match(outcome.text, /（error）/);
});
