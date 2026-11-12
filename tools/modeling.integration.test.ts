/**
 * 草模 CLI 的端到端集成测试：真实 bwrap 编译交付、真实 Chrome 渲染，演示 agent 的 mock 循环。
 *
 * 覆盖：`tools/model-build.ts` 成功原子交付 / 拒绝覆盖 / 失败无残留；`tools/model-agent.ts --demo`
 *   真实沙箱 + 真实 Chrome 走完 坏码→报错→修复→看图→提交，交付文件齐全；把交付模型渲成截图存
 *   `.work/modeling-demo/tests/evidence/`（不入库）作为证据。需要 bwrap 与 Chrome，缺任一整组 skip。
 * 单元测试在 tools/model-build.test.ts、tools/model-agent.test.ts，不需要这些外部依赖。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ModelDocument } from '@pg/modeling/schema';
import { detectSandbox } from '@pg/sandbox/run';
import { openRunDir } from '@pg/store/run-dir';
import { renderModelViews } from '@pg/web/model-render';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CHROME = '/usr/bin/google-chrome';
const SAMPLE = join(REPO, 'benchmark/modeling/function-study.ts');
const EVIDENCE = join(REPO, '.work/modeling-demo/tests/evidence');

const sandbox = detectSandbox();
const skip = sandbox.ok ? (existsSync(CHROME) ? false : `找不到 ${CHROME}`) : `没有 bwrap：${sandbox.reason}`;

/** 只看自己启动的 Chrome：渲染器临时用户目录带 `pg-model-render-<宿主 pid>-` 前缀。 */
function pgrepOwn(pid: number): string[] {
  const result = spawnSync('pgrep', ['-f', `pg-model-render-${String(pid)}-`], { encoding: 'utf8' });
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
}

/** 跑一个 CLI 子进程，返回退出码与输出。 */
function runCli(args: readonly string[], timeout = 240_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('model:build 真实 bwrap 交付三份文件，拒绝覆盖已存在目录', { timeout: 120_000, skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-model-build-it-'));
  try {
    const outDir = join(dir, 'out');
    const first = runCli(['tools/model-build.ts', '--code', SAMPLE, '--out', outDir, '--seed', '7']);
    assert.equal(first.status, 0, first.stderr);
    const files = readdirSync(outDir).sort();
    assert.deepEqual(files, ['manifest.json', 'model.json', 'source.ts']);
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as {
      readonly status: string;
      readonly codeHash: string;
      readonly documentHash: string;
      readonly seed: number;
    };
    assert.equal(manifest.status, 'ok');
    assert.equal(manifest.seed, 7);
    assert.match(manifest.codeHash, /^[0-9a-f]{64}$/);
    assert.match(manifest.documentHash, /^[0-9a-f]{64}$/);
    const before = readFileSync(join(outDir, 'source.ts'), 'utf8');

    const second = runCli(['tools/model-build.ts', '--code', SAMPLE, '--out', outDir, '--seed', '7']);
    assert.notEqual(second.status, 0, '已存在目录应被拒绝');
    assert.equal(readFileSync(join(outDir, 'source.ts'), 'utf8'), before, '拒绝后内容不变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('model:build 执行失败时非零退出且不产出目录', { timeout: 120_000, skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-model-build-bad-'));
  try {
    const codePath = join(dir, 'bad.ts');
    writeFileSync(
      codePath,
      [
        'export default function build(model: Model): void {',
        '  model.revolve({ id: "b", name: "坏", role: "roof", color: "#000000", profile: (t: number): Point2 => [t, Number.NaN] });',
        '}',
        '',
      ].join('\n'),
    );
    const outDir = join(dir, 'out');
    const result = runCli(['tools/model-build.ts', codePath, '--out', outDir]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(outDir), false, '失败不得留交付目录');
    assert.match(result.stderr, /执行失败|执行出错/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('model:agent --demo 真实沙箱 + Chrome 交付，并留渲染证据', { timeout: 300_000, skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-model-agent-it-'));
  try {
    const result = runCli(['tools/model-agent.ts', '--demo', '--out', dir, '--seed', '7'], 280_000);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /不是真实模型调用/);
    const entries = readdirSync(dir);
    assert.equal(entries.length, 1, `应只有一个 run 目录，实际 ${entries.join(', ')}`);
    const runDir = join(dir, entries[0] ?? '');
    for (const file of ['source.ts', 'model.json', 'manifest.json', 'note.md']) {
      assert.ok(readFileSync(join(runDir, 'delivery', file)).length > 0, `${file} 应存在且非空`);
    }
    const manifest = JSON.parse(readFileSync(join(runDir, 'delivery', 'manifest.json'), 'utf8')) as {
      readonly status: string;
      readonly documentHash: string;
    };
    assert.equal(manifest.status, 'ok');

    // 真实 bwrap / Chrome 的耗时必须计入 runner 的真实墙钟：turn.start / tool.result / run.end 都 > 0。
    const events = openRunDir(runDir).events();
    const start = events.find((e) => e.type === 'run.start');
    assert.ok(start !== undefined, '应有 run.start');
    assert.equal(start.body.mode, 'script', '演练是 script 模式，没有真实 LLM');
    assert.ok(
      events.some((e) => e.type === 'turn.start' && e.body.elapsedMs > 0),
      'turn.start.elapsedMs 应计入真实执行 / 渲染耗时',
    );
    assert.ok(
      events.some((e) => e.type === 'tool.result' && e.body.name === 'run_model' && e.body.wallMs > 0),
      'run_model 的 wallMs 应反映真实 bwrap 执行耗时',
    );
    const end = events.find((e) => e.type === 'run.end');
    assert.ok(end !== undefined, '应有 run.end');
    assert.ok(end.body.totals.wallMs > 0, 'run.end 墙钟应反映真实耗时');

    // 交付模型用真实 Chrome 再渲一次，作为测试证据（.work 不入库）。
    const model = ModelDocument.parse(JSON.parse(readFileSync(join(runDir, 'delivery', 'model.json'), 'utf8')));
    const shots = await renderModelViews(model, { chromePath: CHROME, width: 800, height: 600, settleMs: 300 });
    // 查看器默认视角为 overall / top / side（顺序固定）。
    assert.deepEqual(
      shots.map((s) => s.name),
      ['overall', 'top', 'side'],
    );
    mkdirSync(EVIDENCE, { recursive: true });
    const runId = entries[0] ?? 'run';
    for (const shot of shots) {
      assert.equal(shot.png[0], 0x89, `${shot.name} 应是 PNG`);
      writeFileSync(join(EVIDENCE, `${runId}-${shot.name}.png`), shot.png);
    }
    assert.deepEqual(pgrepOwn(process.pid), [], '渲染后不应残留自己启动的 Chrome');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
