/**
 * 建模执行端到端集成测试（MODELING-SPEC §4）：经产品 runModelCode 跑真实 bwrap 子进程。
 * 另外用与产品相同的 `sandboxLaunch` 直接跑 modeling-child，验证运行期逃逸边界（无 fs / env / 网络 /
 * 子进程），这些代码片段会被预检提前挡住，所以只有绕过预检直连 child 才能测到运行期兜底。
 * 没有 bwrap 时整组 skip；本机（有 bwrap）跑的末尾断言 skip 数为 0。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { SandboxLayout, SandboxLimits } from './args.ts';
import { sandboxLaunch } from './args.ts';
import { MODEL_CHILD_PROTOCOL_VERSION, hashModelDocument } from './modeling-protocol.ts';
import { modelChildReportSchema } from './modeling-protocol.ts';
import { runModelCode } from './modeling.ts';
import type { ModelExecution } from './modeling.ts';
import { detectSandbox } from './run.ts';

const support = detectSandbox();
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const childPath = fileURLToPath(new URL('./modeling-child.ts', import.meta.url));
const layout: SandboxLayout = {
  repoRoot,
  nodePath: process.execPath,
  childPath,
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

function okOrThrow(result: ModelExecution): Extract<ModelExecution, { kind: 'ok' }> {
  if (result.kind !== 'ok') throw new Error(`不是 ok：${result.kind} ${JSON.stringify(result).slice(0, 300)}`);
  return result;
}

/** 绕过预检直连 modeling-child（与逃逸探针同理）：测运行期边界。 */
function runChildDirect(code: string, seed = 1): { status: number | null; stderr: string; stdout: string } {
  const input = JSON.stringify({ protocol: MODEL_CHILD_PROTOCOL_VERSION, code, seed, limits: { consoleBytes: 8192 } });
  const launch = sandboxLaunch(layout, limits);
  const run = spawnSync(launch.command, [...launch.args], { input, maxBuffer: 64 * 1024 * 1024 });
  return { status: run.status, stderr: run.stderr.toString('utf8'), stdout: run.stdout.toString('utf8') };
}

function directReport(code: string): unknown {
  const run = runChildDirect(code);
  if (run.status !== 0) throw new Error(`child 退出码 ${String(run.status)}：${run.stderr.slice(0, 300)}`);
  return modelChildReportSchema.parse(JSON.parse(run.stdout) as unknown);
}

test('有 bwrap 时 skip 数为 0', () => {
  if (!support.ok) return;
  assert.equal(counter.skipped, 0);
});

guarded('自定义 sin/power 母线（非预置 profile）成功且同种子可复现', async () => {
  const code = [
    'export default function build(model: Model): void {',
    '  const profile = (t: number): Point2 => [10 * Math.sin(Math.PI * t) + 2 * Math.pow(t, 3), 18 * t];',
    '  model.revolve({ id: "roof", name: "曲面屋顶", role: "roof", color: "#8899aa", profile, profileSegments: 32, radialSegments: 48 });',
    '}',
    '',
  ].join('\n');
  const first = okOrThrow(await runModelCode(code, { seed: 7 }));
  const second = okOrThrow(await runModelCode(code, { seed: 7 }));
  assert.equal(first.document.parts.length, 1);
  assert.equal(first.document.parts[0]!.source.operation, 'revolve');
  assert.ok(first.document.parts[0]!.positions.length);
  assert.equal(first.documentHash, second.documentHash);
  assert.match(first.codeHash, /^[0-9a-f]{64}$/);
  assert.equal(first.documentHash, hashModelDocument(first.document));
});

guarded('bezier 组合 + extrude 成功，console 有采样值', async () => {
  const code = [
    'export default function build(model: Model): void {',
    '  const outline: Point2[] = [[0, 0], [8, 0], [8, 6], [0, 6]];',
    '  model.extrude({ id: "base", name: "基座", role: "volume", color: "#aabbcc", outline, height: 3, transform: { translate: [0, 1, 0] } });',
    '  const p = model.bezier([[0, 0], [1, 3], [3, 3], [4, 0]], 0.5);',
    '  console.log("bezier", p[0].toFixed(3), p[1].toFixed(3));',
    '}',
    '',
  ].join('\n');
  const result = okOrThrow(await runModelCode(code));
  assert.equal(result.document.parts[0]!.source.operation, 'extrude');
  assert.equal(result.document.parts[0]!.bounds.min[1], 1);
  assert.ok(
    result.console.some((entry) => entry.text.includes('bezier')),
    JSON.stringify(result.console),
  );
  assert.equal(result.consoleTruncated, 0);
});

guarded('入口签名类型核对：model: number / 返回 Promise<void> 在 bwrap 之前被拒', async () => {
  const badParam = await runModelCode('export default function build(model: number): number { return model + 1; }');
  if (badParam.kind !== 'precheck-error') throw new Error(`不是 precheck-error：${badParam.kind}`);
  const codes = badParam.diagnostics.map((d) => d.code);
  assert.ok(codes.includes('PG006') || codes.includes('PG007'), codes.join(','));

  const promise = await runModelCode(
    'export default function build(model: Model): Promise<void> { return Promise.resolve().then(() => model.box({ id: "b", name: "盒", role: "volume", color: "#112233", size: [1, 1, 1] })); }',
  );
  if (promise.kind !== 'precheck-error') throw new Error(`不是 precheck-error：${promise.kind}`);
  assert.ok(promise.diagnostics.some((d) => d.code === 'PG007'));
});

guarded('NaN 采样 → build-error（不允许静默回退）', async () => {
  const code = [
    'export default function build(model: Model): void {',
    '  model.revolve({ id: "bad", name: "坏", role: "roof", color: "#000000", profile: (t: number): Point2 => [t * 2, Number.NaN] });',
    '}',
    '',
  ].join('\n');
  const result = await runModelCode(code);
  if (result.kind !== 'build-error') throw new Error(`不是 build-error：${result.kind}`);
  assert.ok(result.message.includes('有限数字'), result.message);
});

guarded('profile 死循环 → timeout，下一个调用恢复正常', async () => {
  const code = [
    'export default function build(model: Model): void {',
    '  const spin = (t: number): Point2 => { let i = 0; for (;;) { i += 1; if (i < 0) return [0, i]; } };',
    '  model.revolve({ id: "loop", name: "循环", role: "roof", color: "#000000", profile: spin });',
    '}',
    '',
  ].join('\n');
  const timed = await runModelCode(code, { timeoutMs: 1000 });
  assert.equal(timed.kind, 'timeout');
  const recovered = await runModelCode(
    'export default function build(model: Model): void { model.box({ id: "b", name: "盒", role: "volume", color: "#112233", size: [1, 1, 1] }); }',
  );
  assert.equal(recovered.kind, 'ok');
});

guarded('代码超过 256 KiB → too-large', async () => {
  const result = await runModelCode(`// ${'x'.repeat(300 * 1024)}`);
  assert.equal(result.kind, 'too-large');
});

guarded('逃逸：静态 import node:fs / node:child_process 在运行期被加载钩子拒绝', () => {
  for (const spec of ['node:fs', 'node:child_process']) {
    const report = directReport(
      `import x from '${spec}';\nexport default function build(model: Model): void { void x; void model; }\n`,
    );
    assert.equal((report as { status: string }).status, 'build-error');
    const message = (report as { error: { message: string } }).error.message;
    assert.ok(message.includes('PG_IMPORT_DENIED'), `${spec}: ${message}`);
  }
});

guarded('逃逸：运行期 process / Buffer / fetch / require / env 都不存在', () => {
  const code = [
    'export default function build(model: Model): void {',
    '  console.log(typeof globalThis.process, typeof globalThis.Buffer, typeof globalThis.fetch, typeof globalThis.require, typeof globalThis.setTimeout);',
    '  void model;',
    '}',
    '',
  ].join('\n');
  const report = directReport(code);
  assert.equal((report as { status: string }).status, 'ok');
  const text = (report as { console: { text: string }[] }).console[0]?.text;
  assert.equal(text, 'undefined undefined undefined undefined undefined');
});

guarded('逃逸：运行期调用 fetch 失败（断网 + 全局已删）', () => {
  const code = 'export default function build(model: Model): void { void fetch("http://example.com"); void model; }\n';
  const report = directReport(code);
  assert.equal((report as { status: string }).status, 'build-error');
});

guarded('逃逸兜底：绕过预检返回 Promise 的入口在运行期被拒', () => {
  const code = 'export default function build(model: Model) { void model; return Promise.resolve(1); }\n';
  const report = directReport(code);
  assert.equal((report as { status: string }).status, 'build-error');
  assert.ok((report as { error: { message: string } }).error.message.includes('void'));
});
