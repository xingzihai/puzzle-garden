/**
 * child-preload 的单元测试（F1）：以 `node --require` 预加载跑一个探针进程，断言 Date 后门被堵住，
 * 且预加载不往 stdout 写任何东西（否则会破坏 child 的二进制分帧）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const preloadPath = fileURLToPath(new URL('./child-preload.ts', import.meta.url));

const script = `
const RealDate = Date.prototype.constructor;
console.log(JSON.stringify({
  direct: Date.now(),
  viaCtor: RealDate.now(),
  ctorIsReal: Date.prototype.constructor === Date,
  instance: new Date() instanceof Date,
}));
`;

test('child-preload 在冻结前堵住 Date 后门，且不污染 stdout', () => {
  const run = spawnSync(
    process.execPath,
    ['--frozen-intrinsics', '--no-warnings', '--require', preloadPath, '--input-type=module', '--eval', script],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `预加载不应写 stdout：${run.stdout}`);
  const parsed = JSON.parse(lines[0] ?? '{}') as {
    direct: number;
    viaCtor: number;
    ctorIsReal: boolean;
    instance: boolean;
  };
  assert.equal(parsed.direct, 946684800000);
  assert.equal(parsed.viaCtor, 946684800000);
  assert.equal(parsed.ctorIsReal, false);
  assert.equal(parsed.instance, true);
});
