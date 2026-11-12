/** model-agent-deps 的单元测试：hash、git 快照、版本拼装与 mock 运行时元数据。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { MODEL_DECLARATION } from '@pg/modeling/declaration';
import { MODEL_VERSION } from '@pg/modeling/schema';
import { createRunDir } from '@pg/store/run-dir';

import {
  MODELING_API,
  buildDemoScript,
  createMockModelRuntime,
  gitSnapshot,
  loadDemoCode,
  modelExternalVersions,
  modelingDtsHash,
  realClock,
  realSleep,
  sha256Hex,
} from './model-agent-deps.ts';

it('sha256Hex / modelingDtsHash 与声明同源', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(modelingDtsHash(), /^[0-9a-f]{64}$/);
  assert.equal(modelingDtsHash(), sha256Hex(MODEL_DECLARATION));
});

it('gitSnapshot 是真实 git 快照；dirty 与 diff 一致', () => {
  const snap = gitSnapshot();
  assert.match(snap.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof snap.dirty, 'boolean');
  if (snap.dirty) {
    assert.ok(snap.diff !== null && snap.diff.length > 0, '脏工作区应给出非空 diff');
  } else {
    assert.equal(snap.diff, null);
  }
});

it('modelExternalVersions 拼出草模分支，dirty diff 进 blob', () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-deps-'));
  try {
    const store = createRunDir(root, 'versions');
    const snapshot = { commit: 'a'.repeat(40), dirty: true, diff: new TextEncoder().encode('diff --git a/x b/x\n') };
    const versions = modelExternalVersions(store, 'precheck-hash', snapshot);
    assert.equal(versions.target, 'modeling');
    assert.equal(versions.modelingApi, MODELING_API);
    assert.equal(versions.modelFormat, MODEL_VERSION);
    assert.equal(versions.modelingDts, modelingDtsHash());
    assert.match(versions.precheck, /precheck-hash/);
    assert.equal(typeof versions.git.diff, 'object');
    assert.match(versions.git.diff?.sha256 ?? '', /^[0-9a-f]{64}$/);

    const clean = modelExternalVersions(store, 'p', { commit: 'b'.repeat(40), dirty: false, diff: null });
    assert.equal(clean.git.diff, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('createMockModelRuntime 给出剧本名与内容 hash，且不向外暴露 mock 虚拟时钟', () => {
  const script = buildDemoScript({ task: '做一个函数粗模', goodCode: loadDemoCode(), note: 'n' });
  const runtime = createMockModelRuntime(script, 3);
  assert.equal(runtime.script.name, 'model-demo');
  assert.equal(runtime.script.sha256, sha256Hex(JSON.stringify(script)));
  // 运行时只暴露 client 与剧本元数据；runner 的墙钟由 deps 的真实 clock / sleep 提供。
  assert.deepEqual(Object.keys(runtime).sort(), ['client', 'script']);
});

it('realClock 单调推进真实时间', async () => {
  const t0 = realClock();
  await realSleep(15, new AbortController().signal);
  const t1 = realClock();
  assert.ok(Number.isFinite(t0) && Number.isFinite(t1));
  assert.ok(t1 > t0, `真实等待应计入 realClock：${String(t0)} → ${String(t1)}`);
});

it('realSleep 到点 resolve，signal 中止立刻 reject，且清掉定时器', async () => {
  await realSleep(1, new AbortController().signal);

  const controller = new AbortController();
  const pending = realSleep(60_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');

  const already = new AbortController();
  already.abort();
  await assert.rejects(realSleep(60_000, already.signal), (error: unknown) => error instanceof Error);
});
