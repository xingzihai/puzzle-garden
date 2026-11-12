/**
 * A 组（草模作构建层子代理）离线全链集成测试（MASSING-BUILD-EXPERIMENT §6 M5）：
 * 父是体素 target，mock 父剧本依次调 massing → write_code（用 world.massingImport('massing#1') 落地）
 * → check_code（真预检 + 真 bwrap，带会话登记的草模资产通道）→ view_building（真 Chrome）→ submit。
 * 子运行与 massing 工具依赖全部真实：真 @pg/sandbox/modeling 执行、真建模三视图、真 contact 合成图。
 * 断言：stopReason=null、delivery 齐全（代码 / 存档 / 渲染图）、存档调用表含 massingImport 且格数符合子文档、
 * trace.subruns 1 条、无残留 Chrome。没有 bwrap 或 Chrome 时整组 skip；本机两样都有，末尾断言 skip 数为 0。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '@pg/blocks/load';
import { readArchive } from '@pg/core/archive';
import { API_VERSION } from '@pg/geometry';
import { createClient } from '@pg/llm/client';
import { createScriptedFetch, createVirtualTime, ScriptSchema } from '@pg/llm/mock';
import { MODEL_VERSION } from '@pg/modeling/schema';
import { createRenderer } from '@pg/render/render';
import { createModelPrechecker, createModelRunner } from '@pg/sandbox/modeling';
import { createPrechecker } from '@pg/sandbox/precheck';
import { detectSandbox, runCode, sandboxVersion } from '@pg/sandbox/run';
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

const ROOT = mkdtempSync(join(tmpdir(), 'pg-massing-chain-'));
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const WORLD_DTS = readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');

const PARENT_VERSIONS: ExternalVersions = {
  git: { commit: 'integration', dirty: false, diff: null },
  node: process.version,
  precheck: 'p',
  sandbox: sandboxVersion(),
  worldApi: API_VERSION,
  worldDts: createHash('sha256').update(WORLD_DTS).digest('hex'),
  archiveFormat: 1,
  analysis: 'a',
};

const PARENT_LIMITS: RunLimits = { maxCostCny: 3.5, maxTurns: 8, wallMs: 2_400_000, submitWindow: 2 };

/** 子交付一个 4×2×4 的实心基座（solid 默认），落地后应为 32 格、单一 massingImport 调用。 */
const CHILD_CODE =
  'export default function build(model: Model): void {\n' +
  '  model.box({ id: "base", name: "基座", role: "volume", color: "#9a9a9a", material: "stone_bricks", size: [4, 2, 4] });\n' +
  '}\n';

const PARENT_CODE = [
  'export default function build(w: World): void {',
  "  w.massingImport('massing#1');",
  '}',
  '',
].join('\n');

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

guarded('A 组全链：massing 子运行 → massingImport 落地 → 真 check/看图 → 交付', async () => {
  const registry = loadRegistry();
  const prechecker = createPrechecker(WORLD_DTS);
  const renderer = createRenderer(registry);
  const modelPrechecker = createModelPrechecker();
  const modelRunner = createModelRunner();
  try {
    const parentScript = ScriptSchema.parse({
      name: 'massing-chain-parent',
      task: '用草模子运行做一个基座并落地',
      steps: [
        {
          reply: {
            kind: 'message',
            content: null,
            toolCalls: [{ name: 'massing', arguments: { brief: '一个 4×2×4 的实心基座', maxTurns: 12, maxCny: 0.5 } }],
          },
        },
        {
          // 子运行成功文本应已带回引用与合成图（1 张 contact）。
          expect: { toolIncludes: ['massing#1'], imageBlocks: 1 },
          reply: {
            kind: 'message',
            content: null,
            toolCalls: [{ name: 'write_code', arguments: { code: PARENT_CODE } }],
          },
        },
        {
          expect: { toolIncludes: ['已写入第 v1 版'] },
          reply: { kind: 'message', content: null, toolCalls: [{ name: 'check_code', arguments: {} }] },
        },
        {
          // 真 bwrap：模型看见带资产的执行结果。
          expect: { toolIncludes: ['执行成功'] },
          reply: { kind: 'message', content: null, toolCalls: [{ name: 'view_building', arguments: {} }] },
        },
        {
          // 真 Chrome：提交前最后一条 user 消息应带上两张迭代图。
          expect: { toolIncludes: ['已渲染'], imageBlocks: 2 },
          reply: {
            kind: 'message',
            content: null,
            toolCalls: [{ name: 'submit', arguments: { note: 'A 组离线全链' } }],
          },
        },
      ],
    });
    const childScript = ScriptSchema.parse({
      name: 'massing-chain-child',
      task: '一个 4×2×4 的实心基座',
      steps: [
        {
          reply: {
            kind: 'message',
            content: null,
            toolCalls: [{ name: 'write_code', arguments: { code: CHILD_CODE } }],
          },
        },
        {
          expect: { toolIncludes: ['已写入第 v1 版'] },
          reply: { kind: 'message', content: null, toolCalls: [{ name: 'run_model', arguments: {} }] },
        },
        {
          expect: { toolIncludes: ['执行成功'] },
          reply: { kind: 'message', content: null, toolCalls: [{ name: 'view_model', arguments: {} }] },
        },
        {
          expect: { imageBlocks: 3 },
          reply: {
            kind: 'message',
            content: null,
            toolCalls: [{ name: 'submit_model', arguments: { note: '离线全链基座' } }],
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

    const store = createRunDir(ROOT, 'massing-chain-run');
    const deps: RunnerDeps = {
      client: parentClient,
      store,
      check: { prechecker, runCode, registry },
      render: (archive, request) => renderer.render(archive, request),
      worldDts: WORLD_DTS,
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
      task: { raw: '用草模子运行做一个基座并落地', fed: '用草模子运行做一个基座并落地', source: null },
      seed: 7,
      limits: PARENT_LIMITS,
      mode: 'script',
      variant: 'base',
      config: null,
    };
    const outcome = await runRun(input, deps);
    assert.equal(outcome.stopReason, null);
    const delivery = outcome.delivery;
    assert.ok(delivery !== null, '应交付');

    // 交付物：代码、存档、交付说明与 6 张交付渲染图。
    const deliveryDir = join(outcome.dir, 'delivery');
    for (const name of ['building.ts', 'building.pgar', 'delivery.json']) {
      assert.ok(existsSync(join(deliveryDir, name)), `交付缺 ${name}`);
    }
    assert.deepEqual(readdirSync(join(deliveryDir, 'render')).sort(), [
      'east.png',
      'iso-se.png',
      'north.png',
      'south.png',
      'top.png',
      'west.png',
    ]);

    // 存档：massingImport 落地子文档的 4×2×4 solid 盒 = 32 格，材质来自子部件自带 material。
    const archive = new Uint8Array(readFileSync(join(deliveryDir, 'building.pgar')));
    const grid = readArchive(registry.table, archive).grid;
    assert.equal(grid.size, 32);
    assert.deepEqual(
      grid.calls().map((c) => c.api),
      ['massingImport'],
    );
    assert.equal(grid.get(0, 1, 0)?.state.name, 'stone_bricks');

    const events = openRunDir(outcome.dir).events();
    const checkEvent = events.find(
      (event): event is Extract<Event, { type: 'check.result' }> => event.type === 'check.result',
    );
    assert.ok(checkEvent !== undefined, '应有 check.result');
    const run = checkEvent.body.run;
    if (run?.kind !== 'ok') throw new Error(`check.result 的 run 应是 ok：${String(run?.kind)}`);
    assert.equal(run.cells, 32);
    assert.deepEqual(checkEvent.body.apiCalls, { massingImport: 1 });

    // 子运行：trace 1 条、成功、花费为正；子交付文件齐全。
    const trace = deriveTrace(events);
    const traceSubruns = trace.subruns ?? [];
    assert.equal(traceSubruns.length, 1);
    const subrun = events.find(
      (event): event is Extract<Event, { type: 'subrun.result' }> => event.type === 'subrun.result',
    );
    assert.ok(subrun !== undefined, '应有 subrun.result');
    assert.equal(subrun.body.status, 'success');
    assert.equal(subrun.body.ordinal, 1);
    assert.ok(subrun.body.costCny > 0, '子运行真实花费应为正');
    const childDir = join(outcome.dir, 'sub', 'massing-1');
    for (const name of ['source.ts', 'model.json', 'manifest.json']) {
      assert.ok(existsSync(join(childDir, 'delivery', name)), `子交付缺 ${name}`);
    }

    // contact 合成图：1536×384，purpose=massing。
    const contactEvent = events.find(
      (event): event is Extract<Event, { type: 'render.result' }> =>
        event.type === 'render.result' && event.body.purpose === 'massing',
    );
    assert.ok(contactEvent !== undefined, '应有 massing render.result');
    assert.equal(contactEvent.body.kind, 'ok');
    assert.equal(contactEvent.body.images[0]?.view, 'contact');
    const contactPng = openRunDir(outcome.dir).blob(contactEvent.body.images[0].png.sha256);
    const view = new DataView(contactPng.buffer, contactPng.byteOffset, contactPng.byteLength);
    assert.deepEqual(
      { width: view.getUint32(16), height: view.getUint32(20) },
      { width: CONTACT_WIDTH, height: CONTACT_HEIGHT },
    );

    // 体素交付渲染成功。
    const deliverRender = events.find(
      (event): event is Extract<Event, { type: 'render.result' }> =>
        event.type === 'render.result' && event.body.purpose === 'deliver',
    );
    assert.ok(deliverRender !== undefined);
    assert.equal(deliverRender.body.kind, 'ok');
    assert.equal(deliverRender.body.images.length, 6);
  } finally {
    await renderer.close();
    await prechecker.close();
    await modelRunner.close();
    await modelPrechecker.close();
  }

  // 无残留 Chrome：体素渲染与建模渲染各用自己的临时 userDataDir 前缀（renderer 已关闭）。
  for (const pattern of [`pg-render-${String(process.pid)}-`, `pg-model-render-${String(process.pid)}-`]) {
    const residue = spawnSync('pgrep', ['-af', pattern], { encoding: 'utf8' });
    assert.equal(residue.stdout.trim(), '', `Chrome 应无残留（${pattern}）：${residue.stdout}`);
  }
});
