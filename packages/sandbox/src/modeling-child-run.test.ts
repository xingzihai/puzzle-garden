/**
 * modeling-child 执行细节的单元测试（走真实 child 子进程但不经 bwrap）：成功交付、build-error 行号、
 * import 拒绝、console 截断、微任务不生效。不 import modeling-child-run.ts，覆盖率不统计子进程逻辑。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MODEL_CHILD_PROTOCOL_VERSION, modelChildReportSchema } from './modeling-protocol.ts';
import type { ModelChildReport } from './modeling-protocol.ts';

const childPath = fileURLToPath(new URL('./modeling-child.ts', import.meta.url));

function runChild(code: string, seed = 1, consoleBytes = 8192): ModelChildReport {
  const input = JSON.stringify({ protocol: MODEL_CHILD_PROTOCOL_VERSION, code, seed, limits: { consoleBytes } });
  const result = spawnSync(process.execPath, [childPath], { input, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString('utf8').slice(0, 2000));
  return modelChildReportSchema.parse(JSON.parse(result.stdout.toString('utf8')) as unknown);
}

function entry(body: string): string {
  return `export default function build(model: Model): void {\n${body}\n}\n`;
}

describe('modeling-child-run：执行细节', () => {
  test('box 成功交付 ModelDocument', () => {
    const report = runChild(
      entry('model.box({ id: "b", name: "盒", role: "volume", color: "#112233", size: [1, 2, 3] });'),
    );
    if (report.status !== 'ok') throw new Error(report.status);
    assert.equal(report.document.parts.length, 1);
    assert.equal(report.document.parts[0]?.bounds.max[2], 3);
    assert.match(report.documentHash, /^[0-9a-f]{64}$/);
  });

  test('build 抛错带模型代码行号', () => {
    const report = runChild(
      entry(
        'model.box({ id: "b", name: "盒", role: "volume", color: "#112233", size: [1, 1, 1] });\nthrow new Error("boom");',
      ),
    );
    if (report.status !== 'build-error') throw new Error(report.status);
    assert.equal(report.error.line, 3);
    assert.equal(report.error.name, 'Error');
  });

  test('build 返回 Promise / 非 undefined 被运行期拒绝（绕过预检兜底）', () => {
    const report = runChild(entry('void model; return Promise.resolve(1);'));
    if (report.status !== 'build-error') throw new Error(report.status);
    assert.ok(report.error.message.includes('void'), report.error.message);
  });

  test('静态 import node:fs 被运行期加载钩子拒绝', () => {
    const report = runChild(
      'import fs from "node:fs";\nexport default function build(model: Model): void { void fs; void model; }\n',
    );
    if (report.status !== 'build-error') throw new Error(report.status);
    assert.ok(report.error.message.includes('PG_IMPORT_DENIED'), report.error.message);
  });

  test('console 按字节截断并计数', () => {
    const report = runChild(entry('for (let i = 0; i < 100; i += 1) console.log("xxxxxxxxxxxxxxxxxxxx", i);'), 1, 50);
    if (report.status !== 'ok') throw new Error(report.status);
    const bytes = report.console.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0);
    assert.ok(bytes <= 50, `console 共 ${String(bytes)} 字节`);
    assert.ok(report.consoleTruncated > 0);
  });

  test('build 返回后模型排的微任务不生效', () => {
    const report = runChild(
      entry(
        'model.box({ id: "first", name: "一", role: "volume", color: "#112233", size: [1, 1, 1] });\nPromise.resolve().then((): void => model.box({ id: "late", name: "二", role: "volume", color: "#445566", size: [1, 1, 1] }));',
      ),
    );
    if (report.status !== 'ok') throw new Error(report.status);
    assert.equal(report.document.parts.length, 1);
    assert.equal(report.document.parts[0]?.id, 'first');
  });
});
