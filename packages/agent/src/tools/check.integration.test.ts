/**
 * check_code 的集成测试（AGENT-SPEC §12 第 2、3 条）：真 prechecker + 真 runCode（bwrap）。
 * 没有 bwrap 时整组 skip；本机有 bwrap，跑完末尾断言 skip 数为 0。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '@pg/blocks/load';
import { createPrechecker } from '@pg/sandbox/precheck';
import { detectSandbox, runCode } from '@pg/sandbox/run';

import { checkCode } from './check.ts';

const support = detectSandbox();
const counter = { skipped: 0 };
const registry = loadRegistry();
const declaration = readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');
const fixturesDir = fileURLToPath(new URL('../../../geometry/fixtures/', import.meta.url));

function guarded(name: string, fn: () => Promise<void> | void): void {
  if (!support.ok) {
    counter.skipped += 1;
    test(name, { skip: `没有 bwrap：${support.reason}` }, () => undefined);
    return;
  }
  test(name, fn);
}

/** 删去 import 行，得到模型形态（world.d.ts 里 rect 等是全局名字）。 */
function stripImports(code: string): string {
  return code
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('import '))
    .join('\n');
}

test('有 bwrap 时 skip 数为 0', () => {
  if (!support.ok) return;
  assert.equal(counter.skipped, 0);
});

guarded('F5-B（删 import）：预检通过、执行成功、可达目标全部可达', async () => {
  const code = stripImports(readFileSync(join(fixturesDir, 'f5-tow.B.ts'), 'utf8'));
  const prechecker = createPrechecker(declaration);
  try {
    const result = await checkCode(
      { code, version: 1, seed: 12_345 },
      { prechecker, runCode, registry, clock: () => Date.now() },
    );
    assert.equal(result.status, 'ok', result.text);
    assert.match(result.text, /^第 v1 版：执行成功，\d+ 格，包围盒 \([-\d,]+\)–\([-\d,]+\)，调用 \d+ 次。覆盖：/);
    assert.match(result.text, /测量（事实，不判合格）：/);
    assert.match(result.text, / {2}目标：floorPlate#\d+/);
    assert.ok(!result.text.includes('到不了'), result.text);
    assert.ok(!result.text.includes('没有站立点'), result.text);
    assert.equal(result.run?.kind, 'ok');
    assert.ok(result.archive instanceof Uint8Array);
    assert.ok(result.measures !== undefined);
  } finally {
    await prechecker.close();
  }
});

guarded('build 抛错样本：执行出错文本带文件名与行号，无测量', async () => {
  const code = `export default function build(w: World): void {
  const base = w.plinth({ footprint: rect(-3, -3, 3, 3), height: 1, material: 'stone_bricks' });
  const hall = w.walls({ on: base, height: 6, material: 'oak_planks' });
  w.opening({
    in: hall.facade('south'),
    kind: 'window',
    shape: 'rect',
    width: 3,
    height: 2,
    sill: 2,
    mullion: { material: 'iron_bars', every: 5 },
  });
}
`;
  const prechecker = createPrechecker(declaration);
  try {
    const result = await checkCode(
      { code, version: 1, seed: 0 },
      { prechecker, runCode, registry, clock: () => Date.now() },
    );
    assert.equal(result.status, 'build-error', result.text);
    assert.match(result.text, /^第 v1 版：执行出错 building\.ts:\d+:\d+ Error：/);
    assert.match(result.text, /（出错时不合成，没有测量。）$/);
    assert.equal(result.run?.kind, 'build-error');
    assert.equal(result.measures, undefined);
  } finally {
    await prechecker.close();
  }
});
