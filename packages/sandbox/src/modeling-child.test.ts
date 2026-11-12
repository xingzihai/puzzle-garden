/**
 * modeling-child.ts 的接线测试（不经 bwrap）：只验证 PG_PROTOCOL_ERROR 走退出码 3。
 * 覆盖率统计不到子进程，所以 modeling-child.ts 保持接线程度；执行细节在 modeling-child-run.test.ts。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const childPath = fileURLToPath(new URL('./modeling-child.ts', import.meta.url));

test('modeling-child 对非法 JSON 输入以退出码 3 报告 protocol-error', () => {
  const result = spawnSync(process.execPath, [childPath], { input: 'not json', encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.ok(result.stderr.includes('PG_PROTOCOL_ERROR'), result.stderr);
});

test('modeling-child 对不合 schema 的输入以退出码 3 报告 protocol-error', () => {
  const result = spawnSync(process.execPath, [childPath], {
    input: JSON.stringify({ protocol: 999 }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 3);
  assert.ok(result.stderr.includes('PG_PROTOCOL_ERROR'), result.stderr);
});
