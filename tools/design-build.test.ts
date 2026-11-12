/**
 * design:build 的单元测试：dry-run 读取 artifacts、fixed 权威、gates / 题面截取；
 * 缺文件 / 非法 gates / 非法 session；--live 未确认时不创建 client。
 * 全部离线：不读真实配置、不创建 Chrome、不跑 bwrap。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import type { Config } from '@pg/config';
import { writeArchive } from '@pg/core/archive';
import { API_VERSION, createWorld } from '@pg/geometry';
import { DEFAULT_SESSION_ROOT } from '@pg/interaction/store';
import type { ChatClient } from '@pg/llm/client';

import { runDesignAgent } from './design-agent.ts';
import type { DesignBuildStartInfo } from './design-build-runner.ts';
import { startDesignBuild } from './design-build-runner.ts';
import {
  DESIGN_BUILD_USAGE,
  DesignBuildError,
  designRunLimits,
  designRunnerInput,
  parseDesignBuildArgs,
  readDesignSession,
  resolveLiveRuntime,
  runDesignBuild,
} from './design-build.ts';
import type { DesignBuildDeps, DesignBuildIo, DesignRunnerInput } from './design-build.ts';

interface Capture {
  readonly io: DesignBuildIo;
  readonly out: string[];
  readonly err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (line) => {
        out.push(line);
      },
      stderr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

const silent: DesignBuildIo = { stdout: () => undefined, stderr: () => undefined };

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-design-build-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 用离线示例写出真实 artifacts，确保测试读的是设计层的实际格式。 */
async function exampleSession(root: string, id = 'ses-design-build'): Promise<string> {
  const code = await runDesignAgent(['--example', '--out', root, '--session', id], { io: silent });
  assert.equal(code, 0);
  return join(root, id);
}

function liveConfig(overrides: Partial<Config> = {}): Config {
  return {
    llm: { baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'deepseek-flash', timeoutMs: 1000 },
    maxRunCostCny: 0,
    liveConfirm: false,
    ...overrides,
  };
}

test('--dry-run 读取 design / task / gates，装配 fixed authority，且不读配置、不创建 client', async () => {
  await withTempDir(async (root) => {
    const dir = await exampleSession(root);
    const captured = capture();
    let configCalls = 0;
    let clientCalls = 0;
    const deps: DesignBuildDeps = {
      io: captured.io,
      loadConfig: () => {
        configCalls += 1;
        throw new Error('dry-run 不应读取配置');
      },
      createLiveClient: () => {
        clientCalls += 1;
        throw new Error('dry-run 不应创建 client');
      },
    };

    const code = await runDesignBuild(['--dry-run', '--session-dir', dir], deps);
    assert.equal(code, 0);
    assert.equal(configCalls, 0);
    assert.equal(clientCalls, 0);
    assert.equal(captured.err.length, 0);

    const text = captured.out.join('\n');
    assert.match(text, /designAuthority: fixed/);
    assert.match(text, /variant: craft-small/);
    assert.match(text, /gates: .*"reachAll":true/);
    assert.match(text, /gates: .*"structureSpans"/);
    assert.match(text, /runId: \d{8}-\d{6}-build-task-[0-9a-f]{6}/);
    assert.match(text, /limits: .*"maxCostCny":3.5/);
    assert.match(text, /design\.md: .*（\d+ 字符）/);
    assert.match(text, /build-task\.md: .*原文 \d+ 字符；fed \d+ 字符/);
    assert.match(text, /buildSheet objects: \d+ \[/);
    assert.match(text, /buildSheet callCards: \d+ \[/);
    assert.match(text, /buildSheet musts: \d+ \[/);
    assert.match(text, /buildSheet datum: 楼板顶 y-?\d+；站立面 y-?\d+；室外地面 y-?\d+；入口 /);
    assert.match(text, /buildSheet conflicts: \d+ \[/);
    assert.match(text, /build-sheet\.json: .*build-sheet\.json/);
    assert.match(text, /build-sheet\.md: .*build-sheet\.md/);

    const session = readDesignSession(dir);
    const raw = await readFile(join(dir, 'build-task.md'), 'utf8');
    const gates = JSON.parse(await readFile(join(dir, 'gates.json'), 'utf8')) as unknown;
    assert.equal(session.taskRaw, raw);
    assert.ok(session.taskFed.startsWith('# 稻田茶亭'));
    assert.match(session.taskFed, /## 四、验收与自由发挥/);
    assert.deepEqual(session.gates, gates);
    assert.ok(session.spec.schemeId.length > 0);
    assert.equal(session.buildSheet.expectedObjects.length, session.buildSheet.objects.length);
    assert.ok(
      text.includes(
        `buildSheet objects: ${String(session.buildSheet.objects.length)} [${session.buildSheet.objects.map((object) => object.id).join(', ')}]`,
      ),
    );
    assert.ok(
      text.includes(
        `buildSheet callCards: ${String(session.buildSheet.callCards.length)} [${session.buildSheet.callCards.map((card) => card.id).join(', ')}]`,
      ),
    );
    assert.ok(text.includes(`buildSheet musts: ${String(session.buildSheet.musts.length)} [`));
    assert.ok(text.includes(`buildSheet datum: ${session.buildSheet.datum.summary}`));
    assert.ok(
      text.includes(
        `buildSheet conflicts: ${String(session.buildSheet.conflicts.length)} [${session.buildSheet.conflicts.map((conflict) => conflict.id).join(', ')}]`,
      ),
    );

    const artifactJson = JSON.parse(await readFile(join(dir, 'build-sheet.json'), 'utf8')) as {
      readonly schemaVersion?: unknown;
      readonly tool?: unknown;
      readonly markdown?: unknown;
    };
    assert.equal(artifactJson.schemaVersion, 2);
    assert.equal(artifactJson.tool, 'build-sheet');
    assert.equal(artifactJson.markdown, undefined);
    const markdown = await readFile(join(dir, 'build-sheet.md'), 'utf8');
    assert.ok(markdown.includes('# BuildSheet'));
    assert.ok(markdown.includes('## 施工调用卡'));

    const verifiedSchemes = Object.keys(session.verifiedMapping.schemes);
    const verifiedMusts = verifiedSchemes.reduce(
      (total, schemeId) => total + Object.keys(session.verifiedMapping.schemes[schemeId] ?? {}).length,
      0,
    );
    assert.ok(
      text.includes(`verified mapping: ${String(verifiedSchemes.length)} scheme(s), ${String(verifiedMusts)} must(s)`),
    );
    assert.ok(text.includes(`verified-must-map.json: ${join(dir, 'verified-must-map.json')}`));
    const verifiedArtifact = JSON.parse(await readFile(join(dir, 'verified-must-map.json'), 'utf8')) as {
      readonly tool?: unknown;
    };
    assert.equal(verifiedArtifact.tool, 'verified-must-map');
    assert.deepEqual(verifiedArtifact, session.verifiedMapping);

    // 旧文件不能被当作当前映射：readDesignSession 只从 spec 重新派生。
    await writeFile(
      join(dir, 'verified-must-map.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        tool: 'verified-must-map',
        mapping: 'verified',
        schemes: { stale: { 'must-stale': ['wall:f1'] } },
      })}\n`,
      'utf8',
    );
    const reread = readDesignSession(dir);
    assert.deepEqual(reread.verifiedMapping, session.verifiedMapping);
    assert.equal('stale' in reread.verifiedMapping.schemes, false);

    const options = parseDesignBuildArgs(['--dry-run', '--session-dir', dir]);
    const input = designRunnerInput(session, {
      seed: options.seed,
      limits: designRunLimits(options),
      config: null,
    });
    assert.equal(input.task.raw, session.taskRaw);
    assert.equal(input.task.fed, session.taskFed);
    assert.equal(input.task.source, session.taskPath);
    assert.equal(input.initialDesign, session.design);
    assert.equal(input.initialBuildSheet, session.buildSheet.markdown);
    assert.equal(input.designAuthority, 'fixed');
    assert.equal(input.variant, 'craft-small');
    assert.equal(input.mode, 'live');
    assert.equal(input.seed, 0);
    assert.deepEqual(input.limits, { maxCostCny: 3.5, maxTurns: null, wallMs: 2_400_000, submitWindow: 3 });
  });
});

test('缺文件 / 非法 gates / 非法 session / 缺节题面都返回 2', async () => {
  await withTempDir(async (root) => {
    const dir = await exampleSession(root, 'ses-broken');
    const missing = capture();
    await rm(join(dir, 'gates.json'));
    assert.equal(await runDesignBuild(['--dry-run', '--session-dir', dir], { io: missing.io }), 2);
    assert.ok(missing.err.some((line) => line.includes('gates.json 不存在')));

    const invalid = capture();
    await writeFile(join(dir, 'gates.json'), '{"reachAll":"yes"}\n', 'utf8');
    assert.equal(await runDesignBuild(['--dry-run', '--session-dir', dir], { io: invalid.io }), 2);
    assert.ok(invalid.err.some((line) => line.includes('gatesSchema')));

    const invalidSpec = capture();
    await writeFile(join(dir, 'build-spec.json'), '{"schemeId":"broken"}\n', 'utf8');
    assert.equal(await runDesignBuild(['--dry-run', '--session-dir', dir], { io: invalidSpec.io }), 2);
    assert.ok(invalidSpec.err.some((line) => line.includes('build-spec.json 不合 BuildSpec')));

    const badId = capture();
    assert.equal(await runDesignBuild(['--dry-run', '--session', '../escape', '--out', root], { io: badId.io }), 2);
    assert.ok(badId.err.some((line) => line.includes('非法 session id')));

    const noSession = capture();
    assert.equal(
      await runDesignBuild(['--dry-run', '--session', 'ses-not-there', '--out', root], { io: noSession.io }),
      2,
    );
    assert.ok(noSession.err.some((line) => line.includes('design.md 不存在')));

    const noSections = await exampleSession(root, 'ses-no-sections');
    const brokenTask = capture();
    await writeFile(join(noSections, 'build-task.md'), '# 缺节\n\n## 一、只有一节\n', 'utf8');
    assert.equal(await runDesignBuild(['--dry-run', '--session-dir', noSections], { io: brokenTask.io }), 2);
    assert.ok(brokenTask.err.some((line) => line.includes('无法截取一至四节')));
  });
});

test('--live 未确认 PG_LIVE_CONFIRM=1 返回 2，且不创建 client；模型不在价格表同样拒绝', async () => {
  await withTempDir(async (root) => {
    const dir = await exampleSession(root, 'ses-live-unconfirmed');
    let clientCreated = false;
    const unconfirmed = capture();
    const deps: DesignBuildDeps = {
      io: unconfirmed.io,
      loadConfig: () => liveConfig(),
      createLiveClient: () => {
        clientCreated = true;
        throw new Error('未确认时不应创建 client');
      },
    };
    assert.equal(await runDesignBuild(['--live', '--session-dir', dir], deps), 2);
    assert.equal(clientCreated, false);
    assert.ok(unconfirmed.err.some((line) => line.includes('PG_LIVE_CONFIRM=1')));

    const badModel = capture();
    let badModelClient = false;
    assert.equal(
      await runDesignBuild(['--live', '--session-dir', dir], {
        io: badModel.io,
        loadConfig: () =>
          liveConfig({
            liveConfirm: true,
            llm: { baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'not-in-pricing', timeoutMs: 1000 },
          }),
        createLiveClient: () => {
          badModelClient = true;
          throw new Error('模型校验失败时不应创建 client');
        },
      }),
      2,
    );
    assert.equal(badModelClient, false);
    assert.ok(badModel.err.some((line) => line.includes('不在价格表')));
  });
});

test('参数：模式二选一、session 来源互斥、上限校验与 help', async () => {
  assert.throws(() => parseDesignBuildArgs([]), /--dry-run 或 --live/);
  assert.throws(() => parseDesignBuildArgs(['--dry-run', '--live', '--session-dir', 'x']), /只能选一个/);
  assert.throws(() => parseDesignBuildArgs(['--dry-run']), /--session/);
  assert.throws(() => parseDesignBuildArgs(['--dry-run', '--session', 'ses-a', '--session-dir', 'x']), /互斥/);
  assert.throws(() => parseDesignBuildArgs(['--dry-run', '--out', 'o', '--session-dir', 'x']), /--out/);
  assert.throws(() => parseDesignBuildArgs(['--dry-run', '--session', '../escape']), /非法 session id/);
  assert.throws(() => parseDesignBuildArgs(['--dry-run', '--session', 'ses-a', '--max-cny', '4']), /0 到 3.5/);
  assert.throws(() => parseDesignBuildArgs(['--dry-run', '--session', 'ses-a', '--max-turns', '3']), /4–200/);
  assert.throws(() => parseDesignBuildArgs(['--dry-run', '--session', 'ses-a', '--wall-ms', '1000']), /60000/);
  assert.throws(() => parseDesignBuildArgs(['--dry-run', '--session', 'ses-a', '--seed', '-1']), /4294967295/);

  const parsed = parseDesignBuildArgs(['--dry-run', '--session', 'ses-a', '--out', '/tmp/design-out']);
  assert.equal(parsed.sessionDir, join('/tmp/design-out', 'ses-a'));
  assert.equal(
    parseDesignBuildArgs(['--dry-run', '--session', 'ses-a']).sessionDir,
    join(DEFAULT_SESSION_ROOT, 'ses-a'),
  );
  assert.equal(parseDesignBuildArgs(['--dry-run', '--session-dir', '/tmp/session']).sessionDir, '/tmp/session');

  const captured = capture();
  assert.equal(await runDesignBuild(['--help'], { io: captured.io }), 0);
  assert.deepEqual(captured.out, [DESIGN_BUILD_USAGE]);
});

test('PG_PROMPT_VERSION 从 live config 进入 RunnerInput 扩展，但不污染 run.start config', async () => {
  await withTempDir(async (root) => {
    const dir = await exampleSession(root, 'ses-prompt-version');
    const options = parseDesignBuildArgs(['--live', '--session-dir', dir]);
    const runtime = resolveLiveRuntime(options, {
      loadConfig: () => liveConfig({ liveConfirm: true, promptVersion: 'v2' }),
      client: {} as ChatClient,
    });
    assert.equal(runtime.config.promptVersion, 'v2');

    const session = readDesignSession(dir);
    const input = designRunnerInput(session, {
      seed: 0,
      limits: designRunLimits(options),
      config: runtime.config,
    });
    assert.equal(input.promptVersion, 'v2');
    assert.deepEqual(input.config, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
    assert.equal('promptVersion' in input.config, false, 'run.start config 必须是 strict schema 的字段');
    assert.match(input.initialDesign ?? '', /^# 设计摘要：/u, 'v2 fixed 必须传 digest');
    assert.notEqual(input.initialDesign, session.design, 'v2 fixed 不应再传完整 design.md');
    assert.equal(input.initialDesignKind, 'digest', 'read_design 必须知道来源是摘要');
    assert.equal(input.firstRequestBudget?.maxTokens, 20_000, 'v2 生产必须带 20k 首请求硬上限');
    assert.ok(input.initialDesign?.includes('## 9. Must 摘要（'), 'v2 digest 应有 must 摘要引用');
    for (const must of session.spec.musts) {
      assert.ok(!input.initialDesign?.includes(must.text), `v2 digest 不应重复 must 全文 ${must.id}`);
      assert.ok(input.initialBuildSheet?.includes(must.text), `BuildSheet 必须保留 must 全文 ${must.id}`);
    }

    const v1 = designRunnerInput(session, {
      seed: 0,
      limits: designRunLimits(options),
      config: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 },
    });
    assert.equal(v1.promptVersion, undefined, '缺省必须保持 v1');
    assert.equal(v1.initialDesign, session.design, 'v1 回滚路径必须逐字保留完整 design.md');
  });
});

test('startDesignBuild 包装 RunWriter 转发事件，并返回 runDir / delivery / 渲染图', async () => {
  await withTempDir(async (root) => {
    const dir = await exampleSession(root, 'ses-runner');
    const out = join(root, 'runs');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const seen: string[] = [];
    const started: { value: DesignBuildStartInfo | null } = { value: null };
    let seenBuildSheet: string | undefined;
    let seenInitialDesign: string | undefined;
    let seenExpectedObjects = 0;
    let seenPromptVersion: string | undefined;
    let seenShadowTool: unknown;
    let seenShadowBlocking: number | undefined;
    const fakeRun: NonNullable<DesignBuildDeps['runRun']> = (input, deps) => {
      seenBuildSheet = input.initialBuildSheet;
      seenInitialDesign = input.initialDesign;
      seenExpectedObjects = deps.check.expectedObjects?.length ?? 0;
      seenPromptVersion = (input as DesignRunnerInput).promptVersion;
      const archive = writeArchive(createWorld(loadRegistry().table).compose().grid, API_VERSION);
      const shadowReport = deps.check.conformanceReportOf?.(archive) as
        { readonly tool?: unknown; readonly summary?: { readonly blockingCount?: number } } | undefined;
      seenShadowTool = shadowReport?.tool;
      seenShadowBlocking = shadowReport?.summary?.blockingCount;
      deps.check.onCheckArchive?.(archive);
      deps.store.append('turn.start', 1, { elapsedMs: 0, spentCny: 0 });
      deps.store.writeDelivery([
        { path: 'render/axon.png', bytes: png },
        { path: 'building.pgar', bytes: archive },
      ]);
      deps.store.append('run.end', 1, {
        stopReason: null,
        totals: {
          turns: 1,
          requests: 1,
          attempts: 1,
          promptTokens: 1,
          hitTokens: null,
          missTokens: null,
          completionTokens: 1,
          reasoningTokens: 0,
          costCny: 0.1,
          wallMs: 10,
          images: 1,
          imageBytes: png.length,
        },
      });
      return Promise.resolve({
        runId: deps.store.runId,
        dir: deps.store.dir,
        stopReason: null,
        delivery: { codeVersion: 1, hash: 'fake-hash' },
        costCny: 0.1,
        turns: 1,
      });
    };

    const result = await startDesignBuild(
      {
        sessionDir: dir,
        outDir: out,
        seed: 7,
        maxCny: 1.5,
        onStart: (info) => {
          started.value = info;
        },
        onEvent: (event) => {
          seen.push(event.type);
        },
      },
      {
        loadConfig: () => liveConfig({ liveConfirm: true, promptVersion: 'v2' }),
        client: {} as ChatClient,
        runRun: fakeRun,
        now: () => new Date('2026-10-19T00:00:00Z'),
      },
    );

    assert.equal(result.outcome.turns, 1);
    assert.equal(result.delivery?.hash, 'fake-hash');
    assert.deepEqual(
      result.renders.map((path) => basename(path)),
      ['axon.png'],
    );
    assert.ok(result.runDir.startsWith(out));
    assert.ok(started.value !== null);
    assert.equal(started.value.runDir, result.runDir);
    assert.deepEqual(seen, ['turn.start', 'run.end']);
    assert.equal(result.shadow?.error, null);
    const shadow = result.shadow;
    assert.match(shadow.summary, /构建自证（影子，仅报告）：blocking=/);
    assert.ok(existsSync(join(result.runDir, 'conformance-diff.json')));
    assert.ok(existsSync(join(result.runDir, 'conformance-evidence.json')));
    const session = readDesignSession(dir);
    assert.equal(seenBuildSheet, session.buildSheet.markdown);
    assert.equal(seenExpectedObjects, session.buildSheet.expectedObjects.length);
    assert.equal(seenPromptVersion, 'v2', '网页 / CLI 共用的 startDesignBuild 也必须透传 promptVersion');
    assert.match(seenInitialDesign ?? '', /^# 设计摘要：/u, 'startDesignBuild 的 v2 路径也必须传 digest');
    assert.notEqual(seenInitialDesign, session.design, 'startDesignBuild 不应再传完整 design.md');
    assert.equal(seenShadowTool, 'conformance-diff', 'check deps 必须拿到生产 shadow 报告，而不是对象图回退');
    assert.ok(
      seenShadowBlocking !== undefined && seenShadowBlocking > 0,
      '空存档对照茶室 BuildSheet 应有 blocking；provider 未接线时会拿不到报告',
    );
    const artifact = JSON.parse(await readFile(join(dir, 'build-sheet.json'), 'utf8')) as {
      readonly tool?: unknown;
    };
    assert.equal(artifact.tool, 'build-sheet');
    assert.ok((await readFile(join(dir, 'build-sheet.md'), 'utf8')).includes('# BuildSheet'));
    const first = result.renders[0];
    assert.ok(first !== undefined);
    assert.deepEqual(await readFile(first), png);
  });
});

test('DesignBuildError 有稳定 name，便于入口映射退出码 2', () => {
  assert.equal(new DesignBuildError('x').name, 'DesignBuildError');
});
