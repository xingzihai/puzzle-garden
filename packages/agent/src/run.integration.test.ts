/**
 * 一次完整 run 的集成测试（AGENT-SPEC §10 success / replay、§12 第 3 条）：
 * 真 prechecker + 真 runCode（bwrap）+ 真 Chrome + 真 client + 剧本 fetch 跑到 submitted；
 * 再对产出的 run 目录做 strict 回放，逐条请求 sha256 与交付存档 hash 必须一致。
 * 没有 bwrap 或 Chrome 时整组 skip；本机两样都有，末尾断言 skip 数为 0。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '@pg/blocks/load';
import { createClient } from '@pg/llm/client';
import { createReplayFetch, createScriptedFetch, createVirtualTime, ScriptSchema } from '@pg/llm/mock';
import type { Script } from '@pg/llm/mock';
import type { Renderer } from '@pg/render/render';
import { createRenderer } from '@pg/render/render';
import { createPrechecker } from '@pg/sandbox/precheck';
import type { Prechecker } from '@pg/sandbox/precheck';
import { detectSandbox, runCode } from '@pg/sandbox/run';
import type { RunLimits } from '@pg/store/events';
import { createRunDir, openRunDir } from '@pg/store/run-dir';

import { computeVersions, estimateTokens, loadWorldDts, readTask } from './cli-deps.ts';
import { runRun } from './runner.ts';
import type { RunOutcome, RunnerDeps, RunnerInput } from './runner.ts';

const CHROME = '/usr/bin/google-chrome';
const sandbox = detectSandbox();
const support = { ok: sandbox.ok && existsSync(CHROME), reason: sandbox.ok ? `找不到 ${CHROME}` : sandbox.reason };
const counter = { skipped: 0 };

const SCRIPT_PATH = fileURLToPath(new URL('../fixtures/scripts/success.json', import.meta.url));
const TASK_PATH = fileURLToPath(new URL('../fixtures/tasks/small-house.md', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'pg-run-integration-'));
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const LIMITS: RunLimits = { maxCostCny: 3.5, maxTurns: null, wallMs: 2_400_000, submitWindow: 3 };
const SEED = 7;

function pgrep(pid: number): string[] {
  const result = spawnSync('pgrep', ['-f', `pg-render-${String(pid)}-`], { encoding: 'utf8' });
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
}

function guarded(name: string, fn: () => Promise<void>): void {
  if (!support.ok) {
    counter.skipped += 1;
    test(name, { skip: support.reason }, () => undefined);
    return;
  }
  test(name, fn);
}

function readScript(): { script: Script; sha256: string } {
  const bytes = readFileSync(SCRIPT_PATH);
  return {
    script: ScriptSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function inputFor(mode: 'script' | 'replay', scriptSha: string, replayOf?: string): RunnerInput {
  return {
    task: readTask(TASK_PATH),
    seed: SEED,
    limits: LIMITS,
    mode,
    variant: 'base',
    ...(mode === 'script' ? { script: { name: 'success', sha256: scriptSha } } : {}),
    ...(mode === 'replay' && replayOf !== undefined ? { replayOf } : {}),
    config: null,
  };
}

function depsFor(
  store: ReturnType<typeof createRunDir>,
  client: RunnerDeps['client'],
  clock: () => number,
  prechecker: Prechecker,
  renderer: Renderer,
): RunnerDeps {
  return {
    client,
    check: { prechecker, runCode, registry: loadRegistry() },
    render: (archive, request) => renderer.render(archive, request),
    store,
    clock,
    versions: computeVersions(prechecker),
    worldDts: loadWorldDts(),
    countTokens: estimateTokens,
  };
}

test('有 bwrap 与 Chrome 时 skip 数为 0', () => {
  if (!support.ok) return;
  assert.equal(counter.skipped, 0);
});

guarded('success 剧本 + strict 回放：交付齐全、请求 sha 与存档 hash 一致', async () => {
  const registry = loadRegistry();
  const worldDts = loadWorldDts();
  const { script, sha256 } = readScript();
  const prechecker = createPrechecker(worldDts);
  const renderer = createRenderer(registry);
  try {
    // ── success：真沙箱 + 真 Chrome + 剧本 fetch ──
    const vt = createVirtualTime();
    const client = createClient({
      config: { baseUrl: 'https://mock.invalid', apiKey: 'mock', timeoutMs: 600_000 },
      fetch: createScriptedFetch(script, SEED),
      sleep: vt.sleep,
      clock: vt.clock,
    });
    const store = createRunDir(ROOT, 'success-run');
    const outcome: RunOutcome = await runRun(
      inputFor('script', sha256),
      depsFor(store, client, vt.clock, prechecker, renderer),
    );

    // 交付：stopReason 为 null，delivery/ 齐全（代码、存档、6 张图）
    assert.equal(outcome.stopReason, null);
    const delivery = outcome.delivery;
    assert.ok(delivery !== null, '应交付');
    const deliveryDir = join(outcome.dir, 'delivery');
    assert.ok(existsSync(join(deliveryDir, 'building.ts')));
    assert.ok(existsSync(join(deliveryDir, 'building.pgar')));
    assert.ok(existsSync(join(deliveryDir, 'delivery.json')));
    const renders = readdirSync(join(deliveryDir, 'render')).sort();
    assert.equal(renders.length, 6);
    assert.deepEqual(renders, ['east.png', 'iso-se.png', 'north.png', 'south.png', 'top.png', 'west.png'].sort());

    // 事件流：delivery 事件的 hash / codeVersion 与 outcome 一致；看图请求带图片块
    const events = openRunDir(outcome.dir).events();
    const deliveryEvent = events.find((e) => e.type === 'delivery');
    assert.ok(deliveryEvent !== undefined);
    assert.equal(deliveryEvent.body.hash, delivery.hash);
    assert.equal(deliveryEvent.body.renders.length, 6);
    const requests = events.filter((e) => e.type === 'llm.request');
    assert.equal(requests.length, 3, 'write+check / view / submit 各一次请求');
    const third = requests[2];
    assert.ok(third !== undefined);
    assert.ok(third.body.images >= 2, '第 3 次请求前看过图');

    // ── strict 回放：新 run，逐条请求 sha256 与交付存档 hash 必须一致 ──
    const source = openRunDir(outcome.dir);
    const vt2 = createVirtualTime();
    const client2 = createClient({
      config: { baseUrl: 'https://mock.invalid', apiKey: 'mock', timeoutMs: 600_000 },
      fetch: createReplayFetch(source, SEED, { sleep: vt2.sleep }),
      sleep: vt2.sleep,
      clock: vt2.clock,
    });
    const store2 = createRunDir(ROOT, 'replay-run');
    const replay = await runRun(
      inputFor('replay', sha256, outcome.dir),
      depsFor(store2, client2, vt2.clock, prechecker, renderer),
    );
    assert.equal(replay.stopReason, null);
    const replayDelivery = replay.delivery;
    assert.ok(replayDelivery !== null);
    assert.equal(replayDelivery.hash, delivery.hash, '回放交付存档 hash 必须与原 run 一致');

    const originalShas = openRunDir(outcome.dir)
      .events()
      .filter((e) => e.type === 'llm.request')
      .map((e) => e.body.requestSha);
    const replayShas = openRunDir(replay.dir)
      .events()
      .filter((e) => e.type === 'llm.request')
      .map((e) => e.body.requestSha);
    assert.deepEqual(replayShas, originalShas, '回放每次请求体 sha256 逐条一致');

    // 交付存档字节也与原 run 相同（hash 的来源）
    assert.deepEqual(
      new Uint8Array(readFileSync(join(replay.dir, 'delivery', 'building.pgar'))),
      new Uint8Array(readFileSync(join(deliveryDir, 'building.pgar'))),
    );
    assert.equal(originalShas.length, 3);
  } finally {
    await renderer.close();
    await prechecker.close();
  }
  assert.deepEqual(pgrep(process.pid), [], 'Chrome 应无残留');
});
