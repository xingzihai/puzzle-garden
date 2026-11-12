/**
 * agent:massing 的单元测试（M5b，决策 #112）：参数解析的好 / 坏样本、live / mock 互斥与缺项、
 * 上限收紧、runId / 版本拼装的纯函数，以及入口的错误路径（全部离线、不启 bwrap / Chrome、不联网）。
 * 真 bwrap + Chrome 的端到端在 tools/agent-massing.integration.test.ts。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { createRunDir } from '@pg/store/run-dir';
import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';
import { DEFAULT_CHROME_PATH } from '@pg/web/model-render';

import {
  AGENT_MASSING_USAGE,
  DEFAULT_OUT_DIR,
  DEFAULT_MAX_TURNS,
  DEFAULT_SUBMIT_WINDOW,
  DEFAULT_WALL_MS,
  MAX_RUN_CNY,
  MassingArgError,
  parseAgentMassingArgs,
} from './agent-massing-args.ts';
import {
  effectiveRunLimits,
  estimateTokens,
  loadWorldDts,
  massingRunId,
  taskShortName,
  voxelExternalVersions,
} from './agent-massing-deps.ts';
import { runAgentMassing } from './agent-massing.ts';
import { LIVE_MODEL } from './model-agent-live.ts';

function captureIo(): {
  readonly io: { stdout: (l: string) => void; stderr: (l: string) => void };
  readonly out: string[];
  readonly err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, out, err };
}

const TASK_MD = [
  '# 草模接入构建层测试题',
  '',
  '## 一、需求',
  '做一个粗体量。',
  '',
  '## 二、禁止',
  '不要墙。',
  '',
  '## 三、尺寸',
  '随意。',
  '',
  '## 四、交付',
  '提交即可。',
  '',
  '> 来源：/secret/do-not-feed.md',
  '',
  '## 五、旧工具',
  '不该喂给模型。',
  '',
  '## 六、来源',
  '/secret/path',
  '',
].join('\n');

it('parseAgentMassingArgs：mock 缺省值齐全，好样本通过', () => {
  const opts = parseAgentMassingArgs(['task.md', '--mock', 'script.json']);
  assert.equal(opts.taskPath, 'task.md');
  assert.equal(opts.seed, 0);
  assert.equal(opts.maxCny, MAX_RUN_CNY);
  assert.equal(opts.outDir, DEFAULT_OUT_DIR);
  assert.equal(opts.promptVariant, 'base');
  assert.equal(opts.chromePath, DEFAULT_CHROME_PATH);
  assert.deepEqual(opts.model, { kind: 'script', path: 'script.json' });
  assert.deepEqual(opts.limits, {
    maxCostCny: MAX_RUN_CNY,
    maxTurns: DEFAULT_MAX_TURNS,
    wallMs: DEFAULT_WALL_MS,
    submitWindow: DEFAULT_SUBMIT_WINDOW,
  });

  const full = parseAgentMassingArgs([
    'benchmark/tasks/m1-09.md',
    '--mock',
    's.json',
    '--seed',
    '4294967295',
    '--max-cny',
    '1.25',
    '--out',
    '/tmp/runs',
    '--prompt-variant',
    'craft2',
    '--chrome',
    '/opt/chrome',
  ]);
  assert.equal(full.seed, 4294967295);
  assert.equal(full.maxCny, 1.25);
  assert.equal(full.outDir, '/tmp/runs');
  assert.equal(full.promptVariant, 'craft2');
  assert.equal(full.chromePath, '/opt/chrome');
  assert.equal(
    parseAgentMassingArgs(['task.md', '--mock', 's.json', '--prompt-variant', 'craft-small']).promptVariant,
    'craft-small',
  );
});

it('parseAgentMassingArgs：live 必填 --max-cny / --out，且不接受 --mock', () => {
  const live = parseAgentMassingArgs(['task.md', '--live', '--max-cny', '2', '--out', 'runs']);
  assert.deepEqual(live.model, { kind: 'live' });
  assert.equal(live.maxCny, 2);
  assert.equal(live.outDir, 'runs');

  assert.throws(() => parseAgentMassingArgs(['task.md', '--live']), /必须给 --max-cny/);
  assert.throws(() => parseAgentMassingArgs(['task.md', '--live', '--max-cny', '2']), /必须给 --out/);
  assert.throws(() => parseAgentMassingArgs(['task.md', '--live', '--out', 'runs']), /必须给 --max-cny/);
  assert.throws(
    () => parseAgentMassingArgs(['task.md', '--live', '--max-cny', '2', '--out', 'runs', '--mock', 's.json']),
    /恰好给一个/,
  );
});

it('实验入口解析来源门槛、旧稿资产、反馈与直接构件组', () => {
  const opts = parseAgentMassingArgs([
    'task.md',
    '--mock',
    's.json',
    '--gates',
    'g.json',
    '--feedback',
    '只改屋顶',
    '--seed-code',
    'b.ts',
    '--seed-assets',
    'assets.json',
    '--without-massing',
  ]);
  assert.equal(opts.gatesPath, 'g.json');
  assert.equal(opts.feedback, '只改屋顶');
  assert.equal(opts.seedCodePath, 'b.ts');
  assert.equal(opts.seedAssetsPath, 'assets.json');
  assert.equal(opts.withoutMassing, true);
  assert.throws(() => parseAgentMassingArgs(['task.md', '--mock', 's.json', '--gates']), /缺少取值/);
});

it('parseAgentMassingArgs：坏样本必须报错（缺项 / 上限 / 互斥 / 路径）', () => {
  const bad: [readonly string[], RegExp][] = [
    [[], /缺少题面文件路径/],
    [['--mock', 's.json'], /缺少题面文件路径/],
    [['a.md', 'b.md', '--mock', 's.json'], /只接受一个题面路径/],
    [['a.md'], /必须恰好给一个/],
    [['a.md', '--live', '--mock', 's.json'], /必须恰好给一个/],
    [['a.md', '--mock'], /缺少取值/],
    [['a.md', '--mock', 's.json', '--seed', '-1'], /--seed 应为/],
    [['a.md', '--mock', 's.json', '--seed', '4294967296'], /超出范围/],
    [['a.md', '--mock', 's.json', '--max-cny', '0'], /--max-cny 应为/],
    [['a.md', '--mock', 's.json', '--max-cny', '3.5001'], /不得超过/],
    [['a.md', '--mock', 's.json', '--max-cny', 'abc'], /--max-cny 应为/],
    [['a.md', '--mock', 's.json', '--prompt-variant', 'nope'], /--prompt-variant 只能是/],
    [['a.md', '--mock', 's.json', '--wat'], /不认识的参数/],
    [['/secret/sealed/x.md', '--mock', 's.json'], /sealed/],
  ];
  for (const [argv, pattern] of bad) {
    assert.throws(() => parseAgentMassingArgs(argv), pattern, `应报错：${argv.join(' ')}`);
  }
  assert.throws(
    () => parseAgentMassingArgs(['a.md']),
    (e) => e instanceof MassingArgError,
  );
});

it('effectiveRunLimits：env 只能收紧 --max-cny，不能放宽', () => {
  const limits = { maxCostCny: 2, maxTurns: null, wallMs: 1, submitWindow: 1 };
  assert.deepEqual(effectiveRunLimits(limits, 1.5), { ...limits, maxCostCny: 1.5 });
  assert.equal(effectiveRunLimits(limits, 3.5), limits);
  assert.equal(effectiveRunLimits(limits, 0), limits);
  assert.equal(effectiveRunLimits(limits, undefined), limits);
});

it('taskShortName / massingRunId / estimateTokens 的边界', () => {
  assert.equal(taskShortName('benchmark/tasks/m1-09.md'), 'm1-09');
  assert.equal(taskShortName('题面.md'), 'adhoc');
  assert.match(massingRunId('a/m1-09.md', new Date('2026-10-13T01:02:03Z')), /^20261013-010203-m1-09-[0-9a-f]{6}$/);

  const encoder = new TextEncoder();
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('a'.repeat(300)), Math.ceil(encoder.encode('a'.repeat(300)).length / 3));
});

it('voxelExternalVersions 拼出体素分支，dirty diff 进 blob', () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-agent-massing-deps-'));
  try {
    const store = createRunDir(root, 'versions');
    const worldDts = loadWorldDts();
    const snapshot = { commit: 'a'.repeat(40), dirty: true, diff: new TextEncoder().encode('diff --git a/x b/x\n') };
    const versions = voxelExternalVersions(store, 'precheck-hash', snapshot, worldDts);
    assert.equal(versions.target, undefined);
    assert.equal(versions.worldApi >= 1, true);
    assert.match(versions.worldDts, /^[0-9a-f]{64}$/);
    assert.match(versions.analysis, /^[0-9a-f]{64}$/);
    assert.equal(versions.archiveFormat, 1);
    assert.equal(versions.git.diff?.sha256.length, 64);

    const clean = voxelExternalVersions(store, 'p', { commit: 'b'.repeat(40), dirty: false, diff: null }, worldDts);
    assert.equal(clean.git.diff, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('runAgentMassing：参数 / 读文件错误返回 2 且不建 run 目录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-agent-massing-err-'));
  try {
    const noArgs = captureIo();
    assert.equal(await runAgentMassing([], noArgs.io), 2);
    assert.match(noArgs.err.join('\n'), /缺少题面文件路径/);

    const taskPath = join(root, 'task.md');
    writeFileSync(taskPath, TASK_MD);

    const missingScript = captureIo();
    assert.equal(
      await runAgentMassing(
        [taskPath, '--mock', join(root, 'nope.json'), '--out', join(root, 'runs')],
        missingScript.io,
      ),
      2,
    );
    assert.match(missingScript.err.join('\n'), /读不到/);

    const badScript = join(root, 'bad.json');
    writeFileSync(badScript, '{ not json');
    const scriptIo = captureIo();
    assert.equal(await runAgentMassing([taskPath, '--mock', badScript, '--out', join(root, 'runs')], scriptIo.io), 2);
    assert.match(scriptIo.err.join('\n'), /不是合法 JSON/);

    // 合法剧本 + 缺题面：mock 先读剧本、再读题面，这里验证读题面失败也返回 2。
    const goodScript = join(root, 'good.json');
    writeFileSync(
      goodScript,
      JSON.stringify({ name: 't', task: 't', steps: [{ reply: { kind: 'message', content: null } }] }),
    );
    const missingTask = captureIo();
    assert.equal(
      await runAgentMassing([join(root, 'nope.md'), '--mock', goodScript, '--out', join(root, 'runs')], missingTask.io),
      2,
    );
    assert.match(missingTask.err.join('\n'), /读不到/);

    assert.equal(existsSync(join(root, 'runs')), false, '错误路径不得建 run 目录');
    assert.deepEqual(readdirSync(root).sort(), ['bad.json', 'good.json', 'task.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('runAgentMassing --live：确认缺失 / 模型不在价表时返回 2 且不建目录、不泄漏密钥', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-agent-massing-live-'));
  try {
    const taskPath = join(root, 'task.md');
    writeFileSync(taskPath, TASK_MD);
    const argv = [taskPath, '--live', '--max-cny', '2', '--out', join(root, 'runs')];
    const llm = { baseUrl: 'https://mock.invalid/v1', apiKey: 'sk-secret', model: LIVE_MODEL, timeoutMs: 600_000 };

    const noConfirm = captureIo();
    assert.equal(
      await runAgentMassing(argv, noConfirm.io, { live: { llm, maxRunCostCny: 3.5, liveConfirm: false } }),
      2,
    );
    assert.match(noConfirm.err.join('\n'), /PG_LIVE_CONFIRM=1/);
    assert.equal(noConfirm.err.join('\n').includes('sk-secret'), false);

    const wrongModel = captureIo();
    assert.equal(
      await runAgentMassing(argv, wrongModel.io, {
        live: { llm: { ...llm, model: 'other' }, maxRunCostCny: 3.5, liveConfirm: true },
      }),
      2,
    );
    assert.match(wrongModel.err.join('\n'), /不在价格表/);

    assert.equal(existsSync(join(root, 'runs')), false, '失败不得建 run 目录');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('--help 打印用法并以 0 退出', async () => {
  const help = captureIo();
  assert.equal(await runAgentMassing(['--help'], help.io), 0);
  assert.ok(help.out.some((l) => l.includes('--mock')));
  assert.equal(AGENT_MASSING_USAGE.includes('--mock'), true);
});

/** 合法网格按 JSON 字节精确填充；中文名验证 UTF-8，不能用字符数冒充字节数。 */
function sizedDocument(bytes: number): ModelDocument {
  const model = createModel();
  model.box({ id: 'base', name: '界', role: 'volume', color: '#888888', size: [4, 4, 4] });
  const part = model.finish().parts[0];
  assert.ok(part);
  if (bytes < 2000) {
    const document = { version: 2 as const, parts: [part] };
    const padding = bytes - Buffer.byteLength(JSON.stringify(document));
    assert.ok(padding >= 0);
    const stride = JSON.stringify(part.indices).length - 1;
    return {
      ...document,
      parts: [
        {
          ...part,
          name: part.name + 'a'.repeat(padding % stride),
          indices: Array.from({ length: 1 + Math.floor(padding / stride) }, () => part.indices).flat(),
        },
      ],
    };
  }
  const positions = Array.from({ length: 199997 }, () => [
    1.123456789012345, 2.123456789012345, 3.123456789012345,
  ]).flat();
  positions.push(0, 0, 0, 4, 0, 0, 0, 4, 0);
  const triangle = [199997, 199998, 199999];
  const base = {
    ...part,
    positions,
    indices: triangle,
    bounds: { min: [0, 0, 0] as const, max: [4, 4, 3.123456789012345] as const },
  };
  const document = { version: 2 as const, parts: [base] };
  const extra = bytes - Buffer.byteLength(JSON.stringify(document));
  const stride = JSON.stringify(triangle).length - 1;
  assert.ok(extra >= 0);
  return {
    ...document,
    parts: [
      {
        ...base,
        name: base.name + 'a'.repeat(extra % stride),
        indices: Array.from({ length: 1 + Math.floor(extra / stride) }, () => triangle).flat(),
      },
    ],
  };
}

it('种子资产预检：无代码、重复 id、超数量在 live 配置前失败；满额只拒绝 live 草模组', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-agent-seed-validation-'));
  try {
    const assetsPath = join(root, 'assets.json');
    const seedPath = join(root, 'seed.ts');
    writeFileSync(seedPath, 'export default function build(w: World): void {}');
    const document = { version: 2, parts: [] };
    let startupReads = 0;
    const live = {
      get llm(): never {
        startupReads += 1;
        throw new Error('已到 live 配置');
      },
      maxRunCostCny: 2,
      liveConfirm: false,
    };
    const run = async (assets: unknown, args: string[], expected: RegExp): Promise<void> => {
      writeFileSync(assetsPath, JSON.stringify(assets));
      const captured = captureIo();
      assert.equal(
        await runAgentMassing(
          ['task.md', '--live', '--max-cny', '2', '--out', join(root, 'runs'), '--seed-assets', assetsPath, ...args],
          captured.io,
          { live },
        ),
        2,
      );
      assert.match(captured.err.join('\n'), expected);
      assert.equal(existsSync(join(root, 'runs')), false);
    };
    await run([], [], /需要同时给 --seed-code/);
    const withCode = ['--seed-code', seedPath];
    await run(
      [
        { id: 'a', document },
        { id: 'a', document },
      ],
      withCode,
      /id 必须唯一/,
    );
    const assets = Array.from({ length: 9 }, (_, i) => ({ id: `seed-${String(i)}`, document }));
    await run(assets, withCode, /数量不得超过 8/);
    await run(assets.slice(0, 8), withCode, /无新生成余量/);
    assert.equal(startupReads, 0);
    await run(assets.slice(0, 7), withCode, /已到 live 配置/);
    await run(assets.slice(0, 8), [...withCode, '--without-massing'], /已到 live 配置/);
    assert.equal(startupReads, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('种子资产 UTF-8 边界：单份 16 MiB、合计 32 MiB 可过预检，超 1 字节拒绝且不读 live 配置', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-agent-seed-bytes-'));
  try {
    const assetsPath = join(root, 'assets.json');
    const seedPath = join(root, 'seed.ts');
    writeFileSync(seedPath, 'export default function build(w: World): void {}');
    const limit = 16 * 1024 * 1024;
    const exact = sizedDocument(limit);
    const smaller = sizedDocument(limit - 700);
    const small = sizedDocument(700);
    assert.equal(Buffer.byteLength(JSON.stringify(exact)), limit);
    assert.equal(Buffer.byteLength(JSON.stringify(smaller)), limit - 700);
    assert.equal(Buffer.byteLength(JSON.stringify(small)), 700);
    let startupReads = 0;
    const live = {
      get llm(): never {
        startupReads += 1;
        throw new Error('已到 live 配置');
      },
      maxRunCostCny: 2,
      liveConfirm: false,
    };
    const run = async (documents: ModelDocument[], expected: RegExp): Promise<void> => {
      writeFileSync(
        assetsPath,
        JSON.stringify(documents.map((document, i) => ({ id: `seed-${String(i)}`, document }))),
      );
      const captured = captureIo();
      assert.equal(
        await runAgentMassing(
          [
            'task.md',
            '--live',
            '--max-cny',
            '2',
            '--out',
            join(root, 'runs'),
            '--seed-code',
            seedPath,
            '--seed-assets',
            assetsPath,
          ],
          captured.io,
          { live },
        ),
        2,
      );
      assert.match(captured.err.join('\n'), expected);
      assert.equal(existsSync(join(root, 'runs')), false);
    };
    await run([exact], /已到 live 配置/);
    await run([sizedDocument(limit + 1)], /单文档 16777217 字节.*16777216/);
    await run([exact, smaller, small], /已到 live 配置/);
    await run([exact, smaller, sizedDocument(701)], /总计 33554433 字节.*33554432/);
    assert.equal(startupReads, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
