/** runner 外圈接线：工具上下文的子运行宿主组装与 run.end / trace.json 收尾。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

import type { ChatClient } from '@pg/llm/client';
import { createClient } from '@pg/llm/client';
import { createScriptedFetch, createVirtualTime, ScriptSchema } from '@pg/llm/mock';
import { deriveTrace } from '@pg/store/derive';
import { createRunDir, openRunDir } from '@pg/store/run-dir';

import type { MassingHostDeps } from './massing/host.ts';
import { finishRun, targetContext } from './runner-finish.ts';
import type { TargetBudget } from './target.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'pg-runner-finish-'));
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function client(): ChatClient {
  const vt = createVirtualTime();
  const script = ScriptSchema.parse({
    name: 'finish',
    task: 'x',
    steps: [{ reply: { kind: 'message', content: null } }],
  });
  return createClient({
    config: { baseUrl: 'https://mock.invalid', apiKey: 'mock', timeoutMs: 600_000 },
    fetch: createScriptedFetch(script, 1),
    sleep: vt.sleep,
    clock: vt.clock,
  });
}

function budget(): TargetBudget {
  return {
    imageBytes: 3,
    images: 1,
    inWindow: false,
    remainingCny: () => 1,
    reserveSubrun: () => true,
    settleSubrun: () => undefined,
  };
}

it('targetContext：没接 massing 时字段缺席；接了就用 deps 的 client 或父 client', () => {
  const store = createRunDir(ROOT, 'ctx-plain');
  const base = {
    store,
    turn: 2,
    seed: 7,
    clock: () => 0,
    budget: budget(),
    remainingWallMs: () => 100,
    massingClient: client(),
    countTokens: (text: string) => text.length,
    mode: 'script' as const,
    config: null,
  };
  const plain = targetContext(base);
  assert.equal(plain.turn, 2);
  assert.equal(plain.massing, undefined);
  store.close();

  const store2 = createRunDir(ROOT, 'ctx-massing');
  const parentClient = client();
  const childClient = client();
  const deps: MassingHostDeps = { render: () => Promise.reject(new Error('x')) };
  const withHost = targetContext({ ...base, store: store2, massing: deps, massingClient: parentClient });
  assert.ok(withHost.massing !== undefined);
  assert.equal(withHost.massing.client, parentClient);
  assert.equal(withHost.massing.mode, 'script');
  const withChild = targetContext({
    ...base,
    store: store2,
    massing: { ...deps, client: childClient },
    massingClient: parentClient,
  });
  assert.equal(withChild.massing?.client, childClient);
  store2.close();
});

it('finishRun：写 run.end、关闭 store、trace.json 与 deriveTrace 一致', () => {
  const store = createRunDir(ROOT, 'finish-run');
  store.append('run.start', null, {
    task: {
      sha256: 'a'.repeat(64),
      source: null,
      fedSha256: 'a'.repeat(64),
      fed: { sha256: 'b'.repeat(64), bytes: 1 },
    },
    seed: 1,
    mode: 'script',
    limits: { maxCostCny: 1, maxTurns: 4, wallMs: 60_000, submitWindow: 1 },
    guardConstants: { imageBytesSoft: 1, imageBytesHard: 2, contextTokens: 3, minMaxTokens: 4 },
    versions: {
      git: { commit: 'c', dirty: false, diff: null },
      node: '24',
      eventsSchema: 3,
      worldApi: 8,
      worldDts: 'd',
      precheck: 'p',
      sandbox: 's',
      archiveFormat: 1,
      analysis: 'a',
      tools: 't',
      prompt: 'q',
      factsFormat: 1,
      model: 'deepseek-flash',
      pricing: 'pr',
      llmClient: 1,
    },
    config: null,
  });
  finishRun({
    store,
    stopReason: 'max-turns',
    failure: undefined,
    totals: { requests: 1, attempts: 1, prompt: 2, hit: 1, miss: 1, completion: 1, reasoning: 0 },
    turns: 3,
    costCny: 0.5,
    wallMs: 123,
    images: 2,
    imageBytes: 34,
    finish: () => ({}),
  });
  const events = openRunDir(store.dir).events();
  const end = events.find((event) => event.type === 'run.end');
  assert.ok(end?.type === 'run.end');
  assert.equal(end.body.stopReason, 'max-turns');
  assert.deepEqual(end.body.totals, {
    turns: 3,
    requests: 1,
    attempts: 1,
    promptTokens: 2,
    hitTokens: 1,
    missTokens: 1,
    completionTokens: 1,
    reasoningTokens: 0,
    costCny: 0.5,
    wallMs: 123,
    images: 2,
    imageBytes: 34,
  });
  const trace = JSON.parse(readFileSync(join(store.dir, 'trace.json'), 'utf8')) as unknown;
  assert.deepEqual(trace, deriveTrace(events));
});
