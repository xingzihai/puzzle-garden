/**
 * B 组（草模能力并入构建层）离线全链集成测试（MASSING-BUILD-EXPERIMENT §6 M5）：
 * 父是体素 target，mock 剧本直接 write_code 写入 use world.surfaceShell 的落地结构（复用 s1-hex 夹具：
 * 六角台基 + 曲面六坡凹曲屋面 + 旋转宝顶）→ check_code（真预检 + 真 bwrap）→ view_building（真 Chrome）→ submit。
 * 断言：交付成功、调用表含 surfaceShell、格数与测量（悬空 0）与 shell-fixtures 金标一致、渲染成功。
 * 没有 bwrap 或 Chrome 时整组 skip；本机两样都有，末尾断言 skip 数为 0。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { measureFloating } from '@pg/analysis/floating';
import { loadRegistry } from '@pg/blocks/load';
import { readArchive } from '@pg/core/archive';
import { API_VERSION } from '@pg/geometry';
import { createClient } from '@pg/llm/client';
import { createScriptedFetch, createVirtualTime, ScriptSchema } from '@pg/llm/mock';
import { createRenderer } from '@pg/render/render';
import { createPrechecker } from '@pg/sandbox/precheck';
import { detectSandbox, runCode, sandboxVersion } from '@pg/sandbox/run';
import type { Event, RunLimits } from '@pg/store/events';
import { createRunDir, openRunDir } from '@pg/store/run-dir';

import type { ExternalVersions, RunnerDeps, RunnerInput } from '@pg/agent/runner';
import { runRun } from '@pg/agent/runner';

const sandbox = detectSandbox();
const support = {
  ok: sandbox.ok && existsSync('/usr/bin/google-chrome'),
  reason: sandbox.ok ? '找不到 /usr/bin/google-chrome' : sandbox.reason,
};
const counter = { skipped: 0 };

const ROOT = mkdtempSync(join(tmpdir(), 'pg-shell-chain-'));
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

/** s1-hex 夹具去掉 import 行后的正文；沙箱代码不允许 import，golden 与 shell-fixtures.test.ts 同源。 */
const HEX_CODE = readFileSync(
  fileURLToPath(new URL('../packages/geometry/fixtures/s1-hex.ts', import.meta.url)),
  'utf8',
)
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('import '))
  .join('\n');

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

guarded('B 组全链：surfaceShell 直接落地 → 真 check/看图 → 交付且测量过金标', async () => {
  const registry = loadRegistry();
  const prechecker = createPrechecker(WORLD_DTS);
  const renderer = createRenderer(registry);
  try {
    const script = ScriptSchema.parse({
      name: 'shell-chain-parent',
      task: '用 surfaceShell 做一个六角亭屋面',
      steps: [
        {
          expect: { lastUserIncludes: ['surfaceShell'] },
          reply: { kind: 'message', content: null, toolCalls: [{ name: 'write_code', arguments: { code: HEX_CODE } }] },
        },
        {
          expect: { toolIncludes: ['已写入第 v1 版'] },
          reply: { kind: 'message', content: null, toolCalls: [{ name: 'check_code', arguments: {} }] },
        },
        {
          // 真 bwrap：模型看见带测量的执行结果。
          expect: { toolIncludes: ['执行成功'] },
          reply: { kind: 'message', content: null, toolCalls: [{ name: 'view_building', arguments: {} }] },
        },
        {
          // 真 Chrome：提交前最后一条 user 消息应带上两张迭代图。
          expect: { toolIncludes: ['已渲染'], imageBlocks: 2 },
          reply: {
            kind: 'message',
            content: null,
            toolCalls: [{ name: 'submit', arguments: { note: 'B 组离线全链' } }],
          },
        },
      ],
    });
    const vt = createVirtualTime();
    const client = createClient({
      config: { baseUrl: 'https://mock.invalid', apiKey: 'mock', timeoutMs: 600_000 },
      fetch: createScriptedFetch(script, 7),
      sleep: vt.sleep,
      clock: vt.clock,
    });
    const store = createRunDir(ROOT, 'shell-chain-run');
    const deps: RunnerDeps = {
      client,
      store,
      check: { prechecker, runCode, registry },
      render: (archive, request) => renderer.render(archive, request),
      worldDts: WORLD_DTS,
      clock: () => performance.now(),
      versions: PARENT_VERSIONS,
      countTokens: (text) => text.length,
    };
    const input: RunnerInput = {
      task: { raw: '用 surfaceShell 做一个六角亭屋面', fed: '用 surfaceShell 做一个六角亭屋面', source: null },
      seed: 7,
      limits: PARENT_LIMITS,
      mode: 'script',
      variant: 'base',
      config: null,
    };
    const outcome = await runRun(input, deps);
    assert.equal(outcome.stopReason, null);
    assert.ok(outcome.delivery !== null, '应交付');

    // 交付物：代码、存档、6 张交付渲染图。
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

    // 存档金标（来源 shell-fixtures.test.ts）：359 格、两种 surfaceShell 调用、悬空 0、材质计数一致。
    const archive = new Uint8Array(readFileSync(join(deliveryDir, 'building.pgar')));
    const grid = readArchive(registry.table, archive).grid;
    assert.equal(grid.size, 359);
    assert.deepEqual(
      grid.calls().map((c) => c.api),
      ['plinth', 'surfaceShell', 'surfaceShell'],
    );
    assert.equal(measureFloating(grid).cells, 0, '屋面与宝顶必须落在台基上');
    const counts: Record<string, number> = {};
    for (const cell of grid.cells()) counts[cell.state.name] = (counts[cell.state.name] ?? 0) + 1;
    assert.deepEqual(counts, { stone_bricks: 147, deepslate_tiles: 200, gold_block: 12 });

    // check.result：真预检 + 真 bwrap 的调用计数与格数。
    const events = openRunDir(outcome.dir).events();
    const checkEvent = events.find(
      (event): event is Extract<Event, { type: 'check.result' }> => event.type === 'check.result',
    );
    assert.ok(checkEvent !== undefined, '应有 check.result');
    const run = checkEvent.body.run;
    if (run?.kind !== 'ok') throw new Error(`check.result 的 run 应是 ok：${String(run?.kind)}`);
    assert.equal(run.cells, 359);
    assert.deepEqual(checkEvent.body.apiCalls, { plinth: 1, surfaceShell: 2 });

    // 体素渲染：看图迭代与交付各一份 ok 结果。
    const renders = events.filter(
      (event): event is Extract<Event, { type: 'render.result' }> => event.type === 'render.result',
    );
    const deliverRender = renders.find((event) => event.body.purpose === 'deliver');
    assert.ok(deliverRender !== undefined);
    assert.equal(deliverRender.body.kind, 'ok');
    assert.equal(deliverRender.body.images.length, 6);
    const iterateRender = renders.find((event) => event.body.purpose === 'iterate');
    assert.ok(iterateRender !== undefined);
    assert.equal(iterateRender.body.kind, 'ok');
    assert.equal(iterateRender.body.images.length, 2);
  } finally {
    await renderer.close();
    await prechecker.close();
  }

  // 无残留 Chrome（renderer 已关闭）。
  const residue = spawnSync('pgrep', ['-af', `pg-render-${String(process.pid)}-`], { encoding: 'utf8' });
  assert.equal(residue.stdout.trim(), '', `Chrome 应无残留：${residue.stdout}`);
});
