/**
 * 草模资产通道的端到端集成测试（MASSING-CONVERSION-SPEC §5.2、§9）：经产品 runCode 跑真实 bwrap，
 * 把宿主注入的 ModelDocument 与颜色候选传进 child，由 world.massingImport 写入存档。
 * 没有 bwrap 时整组 skip；本机（有 bwrap）跑的末尾断言 skip 数为 0。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';

import { detectSandbox, runCode } from './run.ts';
import type { RunInput, RunResult } from './run.ts';

const support = detectSandbox();
const counter = { skipped: 0 };

function guarded(name: string, fn: () => Promise<void> | void): void {
  if (!support.ok) {
    counter.skipped += 1;
    test(name, { skip: `没有 bwrap：${support.reason}` }, () => undefined);
    return;
  }
  test(name, fn);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function okOrThrow(result: RunResult): Extract<RunResult, { kind: 'ok' }> {
  if (result.kind !== 'ok') throw new Error(`不是 ok：${result.kind} ${JSON.stringify(result).slice(0, 300)}`);
  return result;
}

/**
 * 两个部件：`shell` 带显式 material（deepslate_tiles），`tone` 不带 material（颜色与候选 stone_bricks
 * 完全一致，走 role+颜色默认映射），平移错开互不重叠。两件都是 solid 盒。
 */
function twoPartDocument(): ModelDocument {
  const model = createModel();
  model.box({
    id: 'shell',
    name: '外壳',
    role: 'volume',
    color: '#7a7a7a',
    material: 'deepslate_tiles',
    size: [4, 3, 4],
  });
  model.box({
    id: 'tone',
    name: '素面',
    role: 'volume',
    color: '#7a7a7a',
    transform: { translate: [6, 0, 0] },
    size: [2, 2, 2],
  });
  return model.finish();
}

const candidates = [
  { id: 'stone_bricks', rgb: 0x7a7a7a, family: 'stone' },
  { id: 'oak_planks', rgb: 0xb8945f, family: 'wood' },
] as const;

function hallAssets(document: ModelDocument): RunInput['assets'] {
  return { documents: [{ id: 'hall', document }], colorCandidates: [...candidates] };
}

const buildCode = [
  'export default function build(w: World): void {',
  "  const h = w.massingImport('hall');",
  '  console.log(String(h.counts.cells));',
  '}',
  '',
].join('\n');

test('有 bwrap 时 skip 数为 0', () => {
  if (!support.ok) return;
  assert.equal(counter.skipped, 0);
});

guarded('M1c：部件 material 与默认映射各按优先级写入，来源是 massingImport 一次调用', async () => {
  const result = okOrThrow(await runCode({ code: buildCode, seed: 1, assets: hallAssets(twoPartDocument()) }));
  // shell solid 4×3×4 = 48 格；tone solid 2×2×2 = 8 格；默认 at=[0,1,0]。
  assert.equal(result.grid.size, 56);
  assert.equal(result.report.console[0]?.text, '56');
  assert.equal(result.grid.get(0, 1, 0)?.state.name, 'deepslate_tiles');
  assert.equal(result.grid.get(6, 1, 0)?.state.name, 'stone_bricks');
  assert.equal(result.grid.get(6, 1, 0)?.state.canonical, 'stone_bricks');
  const massingCalls = result.grid.calls().filter((c) => c.api === 'massingImport');
  assert.equal(massingCalls.length, 1);
  assert.equal(result.grid.calls().length, 1);
});

guarded('M1c：同输入同 seed 两次执行 hash 与存档字节相同（确定性）', async () => {
  const input: RunInput = { code: buildCode, seed: 7, assets: hallAssets(twoPartDocument()) };
  const a = okOrThrow(await runCode(input));
  const b = okOrThrow(await runCode(input));
  assert.equal(a.hash, b.hash);
  assert.equal(sha256(a.archive), sha256(b.archive));
});

guarded('M1c：assets-too-large 在宿主侧提前返回，不启动子进程', async () => {
  const document = twoPartDocument();
  const assets: RunInput['assets'] = {
    documents: Array.from({ length: 9 }, (_, i) => ({ id: `d${String(i)}`, document })),
    colorCandidates: [...candidates],
  };
  const result = await runCode({ code: buildCode, seed: 1, assets });
  if (result.kind !== 'assets-too-large') throw new Error(`不是 assets-too-large：${result.kind}`);
  assert.equal(result.reason, 'documents-count');
  assert.equal(result.documents, 9);
  assert.equal(result.limit, 8);
});

guarded('M1c：asset-missing 是模型可见的 build-error，带可行动文案', async () => {
  const result = await runCode({
    code: "export default function build(w: World): void { w.massingImport('missing'); }\n",
    seed: 1,
    assets: hallAssets(twoPartDocument()),
  });
  if (result.kind !== 'build-error') throw new Error(`不是 build-error：${result.kind}`);
  const error = result.report.error;
  if (error === undefined) throw new Error('build-error 报告缺少 error 字段');
  assert.equal(error.name, 'MassingError');
  assert.match(error.message, /找不到草模资产 missing/);
  assert.match(error.message, /massing 工具/);
});
