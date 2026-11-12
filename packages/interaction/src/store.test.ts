import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { compileBuildBrief } from './brief.ts';
import { exampleIntent, exampleRequirements, exampleScheme } from './example.ts';
import { createSession, reduceSession } from './session.ts';
import { loadSession, saveSession, SessionStoreError, sessionDir, writeArtifacts } from './store.ts';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-session-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('保存 / 读回会话：内容一致，文件是 session.json', async () => {
  await withTempDir(async (root) => {
    let state = createSession('ses-store');
    state = reduceSession(state, { kind: 'recordRequirements', graph: exampleRequirements() });
    const file = await saveSession(state, { root });
    assert.equal(file, join(root, 'ses-store', 'session.json'));
    assert.deepEqual(await loadSession('ses-store', { root }), state);
    assert.deepEqual(await readdir(join(root, 'ses-store')), ['session.json']);
  });
});

test('原子覆盖：第二次保存完整替换，不留下临时文件', async () => {
  await withTempDir(async (root) => {
    const first = createSession('ses-overwrite');
    await saveSession(first, { root });
    const second = reduceSession(first, { kind: 'assistantMessage', text: '方案已更新。' });
    await saveSession(second, { root });
    assert.deepEqual(await loadSession('ses-overwrite', { root }), second);
    const entries = await readdir(join(root, 'ses-overwrite'));
    assert.deepEqual(entries, ['session.json']);
    const raw = await readFile(join(root, 'ses-overwrite', 'session.json'), 'utf8');
    assert.equal(raw.endsWith('\n'), true);
    const parsed = JSON.parse(raw) as { readonly events: readonly unknown[] };
    assert.equal(parsed.events.length, second.events.length);
  });
});

test('非法 session id 全部拒绝，包括路径穿越与绝对路径', async () => {
  await withTempDir(async (root) => {
    const state = createSession('ses-ok');
    for (const id of ['../evil', 'a/b', '/tmp/x', 'Ses-upper', '-starts-with-dash', '', 'a'.repeat(65)]) {
      assert.throws(() => sessionDir(id, { root }), SessionStoreError, id);
      await assert.rejects(() => saveSession({ ...state, sessionId: id }, { root }), SessionStoreError, id);
      await assert.rejects(() => loadSession(id, { root }), SessionStoreError, id);
    }
    assert.equal(await loadSession('ses-missing', { root }), null);
  });
});

test('读取损坏或 id 不一致的会话时明确报错', async () => {
  await withTempDir(async (root) => {
    const state = createSession('ses-broken');
    await saveSession(state, { root });
    const file = join(root, 'ses-broken', 'session.json');
    await writeFile(file, '{"sessionId":"ses-other"}', 'utf8');
    await assert.rejects(() => loadSession('ses-broken', { root }), SessionStoreError);
    await writeFile(file, '{not-json', 'utf8');
    await assert.rejects(() => loadSession('ses-broken', { root }), SessionStoreError);
  });
});

test('artifacts 写入 design / task / spec / gates / prompt-meta，内容来自同一 brief', async () => {
  await withTempDir(async (root) => {
    const brief = compileBuildBrief(exampleScheme(), exampleRequirements());
    const dir = join(root, 'ses-artifacts');
    const paths = await writeArtifacts(dir, brief);
    assert.deepEqual(paths, {
      sessionDir: dir,
      design: join(dir, 'design.md'),
      task: join(dir, 'build-task.md'),
      spec: join(dir, 'build-spec.json'),
      gates: join(dir, 'gates.json'),
      promptMeta: join(dir, 'prompt-meta.json'),
    });
    assert.equal(await readFile(paths.design, 'utf8'), brief.designMarkdown);
    assert.equal(await readFile(paths.task, 'utf8'), brief.taskMarkdown);
    assert.deepEqual(JSON.parse(await readFile(paths.spec, 'utf8')), brief.spec);
    assert.deepEqual(JSON.parse(await readFile(paths.gates, 'utf8')), brief.gates);
    assert.deepEqual(JSON.parse(await readFile(paths.promptMeta, 'utf8')), brief.promptMeta);
    assert.deepEqual((await readdir(dir)).sort(), [
      'build-spec.json',
      'build-task.md',
      'design.md',
      'gates.json',
      'prompt-meta.json',
    ]);
  });
});

test('intent 模式额外写 design-intent.json，旧调用仍保持原 artifacts 集合', async () => {
  await withTempDir(async (root) => {
    const brief = compileBuildBrief(exampleScheme(), exampleRequirements());
    const intent = exampleIntent();
    const dir = join(root, 'ses-intent-artifacts');
    const paths = await writeArtifacts(dir, brief, intent);
    assert.equal(paths.designIntent, join(dir, 'design-intent.json'));
    assert.deepEqual(JSON.parse(await readFile(paths.designIntent, 'utf8')), intent);
    assert.deepEqual((await readdir(dir)).sort(), [
      'build-spec.json',
      'build-task.md',
      'design-intent.json',
      'design.md',
      'gates.json',
      'prompt-meta.json',
    ]);
  });
});
