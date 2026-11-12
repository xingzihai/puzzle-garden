/**
 * 逃逸集成测试（SANDBOX-SPEC §10 第 11 条）：bwrap + --permission 两层用与产品相同的
 * `sandboxLaunch` 直接跑探针脚本（最坏情形，探针可用 process 与 import）；端到端用 runCode
 * 跑模型形态样本。没有 bwrap 时整组 skip。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { SandboxLayout, SandboxLimits } from './args.ts';
import { sandboxLaunch } from './args.ts';
import { decodeFrame } from './frame.ts';
import { detectSandbox, runCode } from './run.ts';

const support = detectSandbox();
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const probePath = fileURLToPath(new URL('../fixtures/escape-probe.ts', import.meta.url));
const layout: SandboxLayout = {
  repoRoot,
  nodePath: process.execPath,
  childPath: fileURLToPath(new URL('./child.ts', import.meta.url)),
  blockStatesPath: fileURLToPath(new URL('../../../assets/mc-1.20.1/block-states.json', import.meta.url)),
};
const limits: SandboxLimits = { maxOldSpaceMiB: 3072, addressSpaceGiB: 8 };

const counter = { skipped: 0 };
function guarded(name: string, fn: () => Promise<void> | void): void {
  if (!support.ok) {
    counter.skipped += 1;
    test(name, { skip: `没有 bwrap：${support.reason}` }, () => undefined);
    return;
  }
  test(name, fn);
}

interface ProbeRun {
  readonly result: Record<string, unknown>;
  readonly raw: string;
  readonly status: number | null;
}

function probe(name: string): ProbeRun {
  const launch = sandboxLaunch(layout, limits, probePath, [name, repoRoot]);
  const run = spawnSync(launch.command, [...launch.args], { encoding: 'utf8', timeout: 30_000 });
  const raw = run.stdout;
  const line = raw.split('\n').find((row) => row.startsWith('PROBE_RESULT:'));
  const result = line === undefined ? {} : (JSON.parse(line.slice('PROBE_RESULT:'.length)) as Record<string, unknown>);
  return { result, raw, status: run.status };
}

function assertDenied(value: unknown, what: string): void {
  const text = String(value);
  assert.notEqual(value, 'ok', `${what} 不应成功`);
  assert.ok(text.length > 0, `${what} 应有错误`);
}

test('有 bwrap 时 skip 数为 0', () => {
  if (!support.ok) return;
  assert.equal(counter.skipped, 0);
});

guarded('第 11 条：网络 fetch / net.connect 都失败', () => {
  const { result } = probe('network');
  assert.ok(String(result['fetch']).includes('ENETUNREACH'), String(result['fetch']));
  assert.ok(String(result['net']).includes('ENETUNREACH'), String(result['net']));
});

guarded('第 11 条：读家目录、仓库 .env、/etc/passwd、/proc/1/cmdline 都失败', () => {
  const dotenv = join(repoRoot, '.env.sbxtest');
  writeFileSync(dotenv, 'SECRET=1\n');
  try {
    const { result } = probe('read');
    for (const key of ['dotenv', 'home', 'etc', 'proc']) assertDenied(result[key], key);
  } finally {
    rmSync(dotenv, { force: true });
  }
});

guarded('第 11 条：写 /tmp、仓库根、/opt/pg 都失败且宿主侧无文件', () => {
  const repoFile = join(repoRoot, 'pg-escape');
  const tmpFile = '/tmp/pg-escape';
  const optFile = '/opt/pg/pg-escape';
  const { result } = probe('write');
  for (const key of ['tmp', 'repo', 'opt']) assertDenied(result[key], key);
  assert.equal(existsSync(repoFile), false);
  assert.equal(existsSync(tmpFile), false);
  assert.equal(existsSync(optFile), false);
  rmSync(repoFile, { force: true });
  rmSync(tmpFile, { force: true });
});

guarded('第 11 条：execFileSync / Worker / process.binding / dlopen / inspector 都失败', () => {
  const { result } = probe('process');
  for (const key of ['execFileSync', 'worker', 'binding', 'dlopen', 'inspector']) assertDenied(result[key], key);
});

guarded('第 11 条：eval 与 new Function 都失败（EvalError）', () => {
  const { result } = probe('eval');
  assert.ok(String(result['eval']).includes('EvalError'), String(result['eval']));
  assert.ok(String(result['fn']).includes('EvalError'), String(result['fn']));
});

guarded('第 11 条：环境变量只剩 PWD 与 TZ', () => {
  // eslint-disable-next-line no-restricted-properties -- 测试要在宿主进程里造一个密钥，验证它不会进沙箱
  process.env['PG_TEST_SECRET'] = 'secret';
  const { result } = probe('env');
  const keys = Array.isArray(result['keys']) ? (result['keys'] as string[]) : [];
  assert.ok(keys.includes('PWD'));
  assert.ok(keys.includes('TZ'));
  assert.ok(!keys.includes('PG_TEST_SECRET'));
  assert.ok(keys.length <= 3, keys.join(','));
});

guarded('第 11 条：探针先写 JUNK → 宿主分帧判坏帧', () => {
  const { raw } = probe('stdout');
  assert.ok(raw.includes('JUNK'));
  const decoded = decodeFrame(Buffer.from(raw));
  assert.equal(decoded.ok, false);
});

guarded('第 11 条：端到端静态 import node:fs → build-error（PG_IMPORT_DENIED）', async () => {
  const code = "import fs from 'node:fs';\nexport default function build(w: World): void { void fs; void w; }\n";
  const result = await runCode({ code, seed: 1 });
  if (result.kind !== 'build-error') throw new Error(`不是 build-error：${result.kind}`);
  assert.ok(result.report.error?.message.includes('PG_IMPORT_DENIED'), result.report.error?.message);
});

guarded('第 11 条：端到端动态 import node:fs → build-error', async () => {
  const code = "export default function build(w: World): void { void w; }\nawait import('node:fs');\n";
  const result = await runCode({ code, seed: 1 });
  if (result.kind !== 'build-error') throw new Error(`不是 build-error：${result.kind}`);
  assert.ok(result.report.error?.message.includes('PG_IMPORT_DENIED'), result.report.error?.message);
});

guarded(
  '第 11 条：端到端删全局后 process / Buffer / fetch / WebAssembly / Intl / setTimeout 为 undefined',
  async () => {
    const code = [
      'export default function build(w: World): void {',
      '  console.log(',
      '    typeof globalThis.process,',
      '    typeof globalThis.Buffer,',
      '    typeof globalThis.fetch,',
      '    typeof globalThis.WebAssembly,',
      '    typeof globalThis.Intl,',
      '    typeof globalThis.setTimeout,',
      '  );',
      '  void w;',
      '}',
      '',
    ].join('\n');
    const result = await runCode({ code, seed: 1 });
    if (result.kind !== 'ok') throw new Error(`不是 ok：${result.kind}`);
    assert.equal(result.report.console[0]?.text, 'undefined undefined undefined undefined undefined undefined');
  },
);

guarded('F1：白名单外的 Node 全局（Event / URL / structuredClone）删掉，performance 恒为 0', async () => {
  const code = [
    'export default function build(w: World): void {',
    '  console.log(',
    '    typeof globalThis.Event,',
    '    typeof globalThis.URL,',
    '    typeof globalThis.structuredClone,',
    '    String(globalThis.performance.now()),',
    '  );',
    '  void w;',
    '}',
    '',
  ].join('\n');
  const result = await runCode({ code, seed: 1 });
  if (result.kind !== 'ok') throw new Error(`不是 ok：${result.kind}`);
  assert.equal(result.report.console[0]?.text, 'undefined undefined undefined 0');
});

guarded('第 11 条：Object.prototype.x = 1 不影响宿主进程', async () => {
  const code = 'export default function build(w: World): void { Object.prototype.x = 1; void w; }\n';
  const result = await runCode({ code, seed: 1 });
  assert.equal(result.kind, 'build-error');
  assert.equal(({} as { x?: number }).x, undefined);
});
