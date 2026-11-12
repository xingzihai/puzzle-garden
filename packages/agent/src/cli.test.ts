/**
 * cli.ts 的入口行为测试（AGENT-SPEC §9）：以子进程跑，断言退出码约定。
 * 只测参数 / 帮助这条不启动 Chrome、不联网的路径；覆盖率统计不到子进程，cli.ts 保持接线程度。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('--help 退出码 0 并打印用法', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--mock .*--replay .*--live/s);
});

test('缺少题面 / 多个模型来源：退出码 2，报错到 stderr', () => {
  assert.equal(run(['--live']).status, 2);
  const both = run(['a.md', '--mock', 's.json', '--replay', 'r']);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /恰好给一个/);
});

test('不认识的参数：退出码 2', () => {
  const r = run(['a.md', '--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /不认识的参数/);
});
