/** 草模 target 的 mock 请求链：真实 target + 注入 execute，验证失败修正、交付、窗口与异常停止。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { createClient } from '@pg/llm/client';
import { createScriptedFetch, createVirtualTime, ScriptSchema } from '@pg/llm/mock';
import { ChatRequest } from '@pg/llm/schema';
import { MODEL_DECLARATION } from '@pg/modeling/declaration';
import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';
import type { ModelExecution } from '@pg/sandbox/modeling';
import { deriveTrace } from '@pg/store/derive';
import { createRunDir, openRunDir } from '@pg/store/run-dir';

import { MODEL_FACTS_FORMAT, createModelingTarget, formatModelFacts, modelingSystemPrompt } from './modeling-target.ts';
import type { ModelingTargetDeps } from './modeling-target.ts';
import type { TargetRunnerDeps } from './runner.ts';
import { runRun } from './runner.ts';
import type { ExternalVersions, RunnerInput } from './runner.ts';
import type { TargetBudget } from './target.ts';

/** 测试用预算：只关心图片计数，三个子运行预算方法给最宽容的实现。 */
function testBudget(): TargetBudget {
  return {
    imageBytes: 0,
    images: 0,
    inWindow: false,
    remainingCny: () => Number.POSITIVE_INFINITY,
    reserveSubrun: () => true,
    settleSubrun: () => undefined,
  };
}

const VERSIONS: ExternalVersions = {
  git: { commit: 'test', dirty: false, diff: null },
  node: '24',
  precheck: 'mp',
  sandbox: 'ms',
  target: 'modeling',
  modelingApi: 2,
  modelingDts: 'd',
  modelFormat: 2,
};
const TASK = { raw: '做一个曲面屋顶', fed: '做一个曲面屋顶', source: null };
const LIMITS = { maxTurns: 10, maxCostCny: 3.5, wallMs: 2400000, submitWindow: 1 };

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeDocument(): ModelDocument {
  const model = createModel();
  model.box({ id: 'b', name: '块', role: 'volume', color: '#112233', size: [2, 3, 4] });
  return model.finish();
}

function okExecution(
  code: string,
  console: readonly { readonly level: 'log' | 'warn' | 'error'; readonly text: string }[] = [],
): ModelExecution {
  const document = makeDocument();
  return {
    kind: 'ok',
    document,
    codeHash: sha(code),
    documentHash: sha(JSON.stringify(document)),
    console,
    consoleTruncated: 0,
  };
}

const BAD_TO_GOOD = 'model.box({ id: "b", name: "块", role: "volume", color: "#112233", size: [1, 1, 1] })';

function failingExecute(code: string): Promise<ModelExecution> {
  if (code.includes('BAD')) {
    return Promise.resolve({
      kind: 'build-error',
      message: 'BAD 未定义',
      name: 'ReferenceError',
      line: 1,
      column: 1,
      console: [],
      consoleTruncated: 0,
    });
  }
  return Promise.resolve(okExecution(code));
}

async function runScript(
  name: string,
  deps: ModelingTargetDeps,
  steps: readonly unknown[],
  input: RunnerInput = { task: TASK, seed: 7, mode: 'script', variant: 'base', config: null, limits: LIMITS },
): Promise<{
  readonly root: string;
  readonly dir: string;
  readonly outcome: Awaited<ReturnType<typeof runRun>>;
  readonly events: ReturnType<ReturnType<typeof openRunDir>['events']>;
  readonly trace: ReturnType<typeof deriveTrace>;
  readonly requests: ChatRequest[];
}> {
  const root = mkdtempSync(join(tmpdir(), 'pg-model-target-'));
  const vt = createVirtualTime();
  const script = ScriptSchema.parse({ name, task: TASK.fed, steps });
  const client = createClient({
    config: { baseUrl: 'https://mock.invalid', apiKey: 'test-key', timeoutMs: 600000 },
    fetch: createScriptedFetch(script, 11),
    clock: vt.clock,
    sleep: vt.sleep,
  });
  const store = createRunDir(root, name);
  const runnerDeps: TargetRunnerDeps = {
    target: createModelingTarget(deps),
    client,
    store,
    clock: vt.clock,
    countTokens: (s) => s.length,
    versions: VERSIONS,
  };
  const outcome = await runRun(input, runnerDeps);
  const reader = openRunDir(outcome.dir);
  const events = reader.events();
  const requests = events
    .filter((e) => e.type === 'llm.request')
    .map((e) => ChatRequest.parse(JSON.parse(new TextDecoder().decode(reader.request(e.seq))) as unknown));
  return { root, dir: outcome.dir, outcome, events, trace: deriveTrace(events), requests };
}

it('system 提示含 Model 声明、粗骨架规则、函数示例与提交窗口', () => {
  const prompt = modelingSystemPrompt({ ...LIMITS, maxTurns: 8, submitWindow: 2 });
  assert.match(prompt, /export default function build\(model: Model\): void/);
  assert.match(prompt, /model\.finish\(\)/);
  assert.match(prompt, /不要在代码里调用/);
  assert.match(prompt, /model\.revolve/);
  assert.match(prompt, /model\.bezier/);
  assert.ok(prompt.includes(MODEL_DECLARATION.trimEnd()), '应包含完整 Model 声明');
  for (const tool of ['write_code', 'edit_code', 'read_code', 'run_model', 'view_model', 'submit_model']) {
    assert.match(prompt, new RegExp(tool));
  }
  assert.match(prompt, /最后 2 轮是提交窗口/);
  assert.match(prompt, /不能再 write_code 整份写入/);
  assert.match(prompt, /（可读、可改、可执行、可看图、可提交）/);
  assert.match(prompt, /提交前必须对当前版本成功看过图/);
  assert.match(prompt, /noUncheckedIndexedAccess/);
  assert.match(prompt, /exactOptionalPropertyTypes/);
  assert.match(prompt, /先判空/);
  assert.match(prompt, /同一轮先 view_model 再 submit_model/);
});

it('formatFacts 报轮次 / 版本 / 窗口与提醒', () => {
  assert.equal(MODEL_FACTS_FORMAT, 2);
  const base = {
    nextTurn: 3,
    maxTurns: 8,
    spentCny: 0.5,
    maxCostCny: 3.5,
    elapsedMs: 120000,
    wallMs: 2400000,
    draftVersion: 2,
    lastCheck: { version: 2, outcome: 'ok' as const, hash: sha('x') },
    lastViewVersion: null,
    window: { remaining: 1, entering: true },
  };
  const text = formatModelFacts(base);
  assert.match(text, /第 3 轮 \/ 共 8 轮/);
  assert.match(text, /当前稿第 v2 版/);
  assert.match(text, /最近执行第 v2 版：执行成功/);
  assert.match(text, /进入提交窗口：剩余 1 轮/);
  assert.match(text, /不能再 write_code 整份写入/);
  assert.match(text, /可看图/);
  const emptyDraft = formatModelFacts({
    ...base,
    draftVersion: null,
    lastCheck: null,
    lastViewVersion: null,
    window: { remaining: 1, entering: true },
  });
  assert.match(emptyDraft, /当前稿：还没有代码/);
  assert.match(emptyDraft, /当前还没有代码，先 write_code 建立初稿/);
  const emptyV1 = formatModelFacts({ ...base, draftVersion: 1, hasDraftCode: false });
  assert.match(emptyV1, /当前还没有代码，先 write_code 建立初稿/);
  const noTool = formatModelFacts({ ...base, event: 'no-tool', window: null });
  assert.match(noTool, /本轮没有调用工具/);
});

it('createModelingTarget 形状：kind / factsFormat / 6 个工具 / finish 只给 lastModel', () => {
  const target = createModelingTarget({ execute: failingExecute });
  assert.equal(target.kind, 'modeling');
  assert.equal(target.factsFormat, MODEL_FACTS_FORMAT);
  assert.equal(target.tools.length, 6);
  const session = target.create(
    { task: TASK, seed: 1, mode: 'script', variant: 'base', config: null, limits: LIMITS },
    testBudget(),
  );
  assert.deepEqual(session.finish(), {});
});

it('写坏码 → 执行失败反馈 → 局部修改 → 成功 → 交付完整文件', async () => {
  const { root, dir, outcome, events, trace, requests } = await runScript(
    'delivers',
    {
      execute: failingExecute,
      render: () => Promise.resolve([{ name: 'iso', png: Uint8Array.from([1, 2, 3]) }]),
    },
    [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'write_code', arguments: { code: 'const x = BAD;' } },
            { name: 'run_model', arguments: {} },
          ],
        },
      },
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'edit_code', arguments: { edits: [{ find: 'BAD', replace: BAD_TO_GOOD }] } },
            { name: 'run_model', arguments: {} },
            { name: 'view_model', arguments: {} },
          ],
        },
      },
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [{ name: 'submit_model', arguments: { note: '完成' } }],
        },
      },
    ],
  );
  try {
    assert.equal(outcome.stopReason, null);
    assert.equal(outcome.delivery?.codeVersion, 2);
    assert.equal(trace.delivered, true);
    assert.ok(trace.lastModel, 'trace 应带 lastModel');
    assert.equal(trace.lastArchive, undefined);
    assert.match(JSON.stringify(requests[1]?.messages), /执行出错|BAD 未定义/);

    const checks = events.filter((e) => e.type === 'model.check');
    assert.deepEqual(
      checks.map((e) => e.body.status),
      ['build-error', 'ok'],
    );
    assert.equal(
      events.some((e) => e.type === 'check.result' || e.type === 'delivery'),
      false,
    );
    assert.equal(events.filter((e) => e.type === 'code.version').length, 2);
    assert.equal(events.filter((e) => e.type === 'model.delivery').length, 1);
    assert.equal(events.find((e) => e.type === 'submit')?.body.accepted, true);

    for (const file of ['source.ts', 'model.json', 'manifest.json', 'note.md']) {
      assert.equal(existsSync(join(dir, 'delivery', file)), true, `${file} 应存在`);
    }
    assert.match(readFileSync(join(dir, 'delivery', 'source.ts'), 'utf8'), /model\.box/);
    const manifest = JSON.parse(readFileSync(join(dir, 'delivery', 'manifest.json'), 'utf8')) as {
      readonly seed: number;
      readonly modelingApi: number;
      readonly modelFormat: number;
    };
    assert.equal(manifest.seed, 7);
    assert.equal(manifest.modelingApi, 2);
    assert.equal(manifest.modelFormat, 2);
    const start = events.find((e) => e.type === 'run.start');
    assert.equal(start?.body.versions.factsFormat, MODEL_FACTS_FORMAT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('view_model 的图在轮末进入请求，run.end 累计图片', async () => {
  const { root, outcome, events, trace } = await runScript(
    'views',
    {
      execute: (code) => Promise.resolve(okExecution(code)),
      render: () => Promise.resolve([{ name: 'iso', png: Uint8Array.from([1, 2, 3]) }]),
    },
    [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'write_code', arguments: { code: 'const x = 1;' } },
            { name: 'run_model', arguments: {} },
          ],
        },
      },
      {
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'view_model', arguments: {} }] },
      },
      {
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'submit_model', arguments: { note: '' } }] },
      },
    ],
  );
  try {
    assert.equal(outcome.delivery?.codeVersion, 1);
    assert.equal(trace.totals.images, 1);
    assert.ok(trace.totals.imageBytes > 0);
    assert.equal(events.filter((e) => e.type === 'render.result').length, 0, '草模不复用体素 render.result');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('未看图就 submit 被拒，补看图后再提交成功', async () => {
  const { root, outcome, events } = await runScript(
    'submit-gate',
    {
      execute: (code) => Promise.resolve(okExecution(code)),
      render: () => Promise.resolve([{ name: 'iso', png: Uint8Array.from([1, 2, 3]) }]),
    },
    [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'write_code', arguments: { code: 'const x = 1;' } },
            { name: 'run_model', arguments: {} },
          ],
        },
      },
      {
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'submit_model', arguments: { note: '' } }] },
      },
      {
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'view_model', arguments: {} }] },
      },
      {
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'submit_model', arguments: { note: '' } }] },
      },
    ],
  );
  try {
    const submits = events.filter((e) => e.type === 'submit');
    assert.deepEqual(
      submits.map((e) => e.body.accepted),
      [false, true],
      '第一次未看图被拒，看图后被接受',
    );
    assert.match(submits[0]?.body.reason ?? '', /还没有成功看过图/);
    assert.equal(outcome.delivery?.codeVersion, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('无 bwrap：run_model 后以 sandbox-unsupported 停止，不交付', async () => {
  const { root, outcome, events, trace } = await runScript(
    'unsupported',
    { execute: () => Promise.resolve({ kind: 'unsupported', message: '缺少 bwrap' }) },
    [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'write_code', arguments: { code: 'const x = 1;' } },
            { name: 'run_model', arguments: {} },
          ],
        },
      },
    ],
  );
  try {
    assert.equal(outcome.stopReason, 'sandbox-unsupported');
    assert.equal(outcome.delivery, null);
    assert.equal(trace.delivered, false);
    assert.equal(events.find((e) => e.type === 'model.check')?.body.status, 'unsupported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('execute 抛异常：run 以 internal-error 停止并记录，不吞', async () => {
  const { root, outcome, events } = await runScript(
    'throws',
    { execute: () => Promise.reject(new Error('模拟宿主缺陷')) },
    [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'write_code', arguments: { code: 'const x = 1;' } },
            { name: 'run_model', arguments: {} },
          ],
        },
      },
    ],
  );
  try {
    assert.equal(outcome.stopReason, 'internal-error');
    assert.equal(events.find((e) => e.type === 'model.check')?.body.status, 'internal-error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
