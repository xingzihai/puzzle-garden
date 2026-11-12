/**
 * massing 成功链集成测试（SUBAGENT-LOOP-SPEC §8）：真 bwrap 执行建模子运行 + 真 Chrome 渲染三视角与
 * contact 合成图，父 run 只是 mock 剧本与假体素依赖（体素沙箱不参与）。
 * 断言：子交付文件、contact PNG 1536×384、父 totals 含子花费、trace.subruns、无残留 Chrome。
 * 没有 bwrap 或 Chrome 时整组 skip；本机两样都有，末尾断言 skip 数为 0。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { createClient } from '@pg/llm/client';
import { createScriptedFetch, createVirtualTime, ScriptSchema } from '@pg/llm/mock';
import { MODEL_VERSION } from '@pg/modeling/schema';
import { createModelPrechecker, createModelRunner } from '@pg/sandbox/modeling';
import { detectSandbox, sandboxVersion } from '@pg/sandbox/run';
import { deriveTrace } from '@pg/store/derive';
import type { Event, RunLimits } from '@pg/store/events';
import { createRunDir, openRunDir } from '@pg/store/run-dir';
import {
  CONTACT_HEIGHT,
  CONTACT_WIDTH,
  DEFAULT_CHROME_PATH,
  renderModelContact,
  renderModelViews,
} from '@pg/web/model-render';

import type { ExternalVersions, RunnerDeps, RunnerInput } from '@pg/agent/runner';
import { runRun } from '@pg/agent/runner';

import { MODELING_API, modelingDtsHash } from './model-agent-deps.ts';

const sandbox = detectSandbox();
const support = {
  ok: sandbox.ok && existsSync(DEFAULT_CHROME_PATH),
  reason: sandbox.ok ? `找不到 ${DEFAULT_CHROME_PATH}` : sandbox.reason,
};
const counter = { skipped: 0 };

const ROOT = mkdtempSync(join(tmpdir(), 'pg-massing-integration-'));
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const CHILD_CODE =
  'export default function build(model: Model): void {\n' +
  '  model.box({ id: "base", name: "基座", role: "floor", color: "#9a9a9a", size: [8, 2, 8] });\n' +
  '}\n';

const PARENT_VERSIONS: ExternalVersions = {
  git: { commit: 'integration', dirty: false, diff: null },
  node: process.version,
  precheck: 'p',
  sandbox: sandboxVersion(),
  worldApi: 8,
  // 父 target 是体素，但体素 check / render 在剧本里不会被调用，worldDts 只用于 system 提示。
  worldDts: 'd',
  archiveFormat: 1,
  analysis: 'a',
};

const PARENT_LIMITS: RunLimits = { maxCostCny: 3.5, maxTurns: 4, wallMs: 2_400_000, submitWindow: 2 };

function pngSize(png: Uint8Array): { readonly width: number; readonly height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assert.equal(view.getUint32(0), 0x89504e47, 'PNG 魔数');
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function guarded(name: string, fn: () => Promise<void>): void {
  if (!support.ok) {
    counter.skipped += 1;
    test(name, { skip: support.reason }, () => undefined);
    return;
  }
  test(name, fn);
}

test('有 bwrap 与 Chrome 时 skip 数为 0', () => {
  if (!support.ok) return;
  assert.equal(counter.skipped, 0);
});

guarded('massing 成功链：子交付 + contact 图 + 父 totals/trace 含子运行', async () => {
  const modelPrechecker = createModelPrechecker();
  const modelRunner = createModelRunner();
  try {
    const parentScript = ScriptSchema.parse({
      name: 'massing-parent',
      task: '粗体量',
      steps: [
        {
          reply: {
            kind: 'message',
            content: null,
            toolCalls: [{ name: 'massing', arguments: { brief: '一个 8×2×8 的粗基座', maxTurns: 12, maxCny: 1 } }],
          },
        },
        { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_code', arguments: {} }] } },
        { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_code', arguments: {} }] } },
        { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_code', arguments: {} }] } },
      ],
    });
    const childScript = ScriptSchema.parse({
      name: 'massing-child',
      task: '一个 8×2×8 的粗基座',
      steps: [
        {
          reply: {
            kind: 'message',
            content: null,
            toolCalls: [{ name: 'write_code', arguments: { code: CHILD_CODE } }],
          },
        },
        { reply: { kind: 'message', content: null, toolCalls: [{ name: 'run_model', arguments: {} }] } },
        { reply: { kind: 'message', content: null, toolCalls: [{ name: 'view_model', arguments: {} }] } },
        {
          reply: {
            kind: 'message',
            content: null,
            toolCalls: [{ name: 'submit_model', arguments: { note: '集成测试基座' } }],
          },
        },
      ],
    });

    const parentVt = createVirtualTime();
    const parentClient = createClient({
      config: { baseUrl: 'https://mock.invalid', apiKey: 'mock', timeoutMs: 600_000 },
      fetch: createScriptedFetch(parentScript, 7),
      sleep: parentVt.sleep,
      clock: parentVt.clock,
    });
    const childVt = createVirtualTime();
    const childClient = createClient({
      config: { baseUrl: 'https://mock.invalid', apiKey: 'mock', timeoutMs: 600_000 },
      fetch: createScriptedFetch(childScript, 7),
      sleep: childVt.sleep,
      clock: childVt.clock,
    });

    const store = createRunDir(ROOT, 'massing-parent-run');
    const deps: RunnerDeps = {
      client: parentClient,
      store,
      check: {
        prechecker: { check: () => Promise.reject(new Error('体素预检不该被调用')) },
        runCode: () => Promise.reject(new Error('体素执行不该被调用')),
        registry: loadRegistry(),
      },
      render: () => Promise.reject(new Error('体素渲染不该被调用')),
      worldDts: 'declare const x: 1;\n',
      clock: () => performance.now(),
      versions: PARENT_VERSIONS,
      countTokens: (text) => text.length,
      massing: {
        client: childClient,
        execute: (code, options) => modelRunner.runCode(code, options),
        render: (document, options) =>
          renderModelViews(document, {
            chromePath: DEFAULT_CHROME_PATH,
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
          }),
        renderContact: (document, options) =>
          renderModelContact(document, {
            chromePath: DEFAULT_CHROME_PATH,
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
          }),
        versions: () => ({
          git: { commit: 'integration', dirty: false, diff: null },
          node: process.version,
          precheck: modelPrechecker.version,
          sandbox: sandboxVersion(),
          target: 'modeling',
          modelingApi: MODELING_API,
          modelingDts: modelingDtsHash(),
          modelFormat: MODEL_VERSION,
        }),
        modeling: { modelingApi: MODELING_API, modelFormat: MODEL_VERSION },
      },
    };
    const input: RunnerInput = {
      task: { raw: '粗体量', fed: '粗体量', source: null },
      seed: 7,
      limits: PARENT_LIMITS,
      mode: 'script',
      variant: 'base',
      config: null,
    };
    const outcome = await runRun(input, deps);
    assert.equal(outcome.stopReason, 'max-turns');
    assert.equal(outcome.delivery, null);

    const events = openRunDir(outcome.dir).events();
    const trace = deriveTrace(events);
    const subrun = events.find(
      (event): event is Extract<Event, { type: 'subrun.result' }> => event.type === 'subrun.result',
    );
    assert.ok(subrun !== undefined, '应有 subrun.result');
    assert.equal(subrun.body.status, 'success');
    const traceSubruns = trace.subruns ?? [];
    assert.equal(traceSubruns.length, 1);
    const firstSubrun = traceSubruns[0];
    assert.ok(firstSubrun !== undefined);
    assert.equal(firstSubrun.costCny, subrun.body.costCny);

    // 父 totals 含子花费：父自己的 llm.attempt 结算 + 子 run.end.totals.costCny。
    const childDir = join(outcome.dir, 'sub', 'massing-1');
    const childEvents = openRunDir(childDir).events();
    const childEnd = childEvents.find((event) => event.type === 'run.end');
    assert.ok(childEnd?.type === 'run.end');
    assert.equal(childEnd.body.stopReason, null);
    const parentOwn = events
      .filter((event) => event.type === 'llm.attempt')
      .reduce((sum, event) => {
        assert.ok(event.body.settledCny !== null);
        return sum + Math.round(event.body.settledCny * 1e8);
      }, 0);
    const parentEnd = events.find((event) => event.type === 'run.end');
    assert.ok(parentEnd?.type === 'run.end');
    assert.ok(parentEnd.body.totals.costCny !== null && childEnd.body.totals.costCny !== null);
    assert.equal(
      Math.round(parentEnd.body.totals.costCny * 1e8) - parentOwn,
      Math.round(childEnd.body.totals.costCny * 1e8),
    );
    assert.ok(subrun.body.costCny > 0, '子运行真实花费应为正');

    // 子交付文件齐全。
    assert.ok(existsSync(join(childDir, 'delivery', 'source.ts')));
    assert.ok(existsSync(join(childDir, 'delivery', 'model.json')));
    assert.ok(existsSync(join(childDir, 'delivery', 'manifest.json')));

    // contact 图：render.result purpose=massing、view=contact、1536×384。
    const renderEvent = events.find(
      (event): event is Extract<Event, { type: 'render.result' }> =>
        event.type === 'render.result' && event.body.purpose === 'massing',
    );
    assert.ok(renderEvent !== undefined, '应有 massing render.result');
    assert.equal(renderEvent.body.kind, 'ok');
    const contactShot = renderEvent.body.images[0];
    assert.ok(contactShot !== undefined);
    assert.equal(contactShot.view, 'contact');
    assert.equal(contactShot.pixelsPerCell, 0);
    assert.ok(subrun.body.image !== undefined);
    const png = openRunDir(outcome.dir).blob(subrun.body.image.sha256);
    assert.equal(CONTACT_WIDTH, 1536);
    assert.equal(CONTACT_HEIGHT, 384);
    assert.deepEqual(pngSize(png), { width: CONTACT_WIDTH, height: CONTACT_HEIGHT });

    // 无残留 Chrome：临时 userDataDir 带本进程 pid，pgrep 命令行应找不到。
    const residue = spawnSync('pgrep', ['-af', `pg-model-render-${String(process.pid)}-`], { encoding: 'utf8' });
    assert.equal(residue.stdout.trim(), '', `Chrome 应无残留：${residue.stdout}`);
  } finally {
    await modelRunner.close();
    await modelPrechecker.close();
  }
});
