/**
 * BuildSheet 施工调用卡：用 tea-house golden BuildSpec 与第二个不同尺寸的 fixture 锁定
 * rect / at / sill / peakY / 期望 bounds，并确认 markdown 里的每个 ```ts 块都能通过真实预检。
 *
 * 关键测试会抽取调用卡代码块并在真 `createWorld` 里执行，再与 golden recipe 的 as-built
 * 包络对比；只读 fixture，离线；不跑模型、不联网。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { test } from 'node:test';

import ts from 'typescript';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import { diffObjects } from '@pg/analysis/object-diff';
import { loadRegistry } from '@pg/blocks/load';
import type { Grid } from '@pg/core/grid';
import { createWorld, rect } from '@pg/geometry';
import { BuildSpec } from '@pg/interaction/schema';
import { createPrechecker } from '@pg/sandbox/precheck';

import type { ConstructionCallCard } from './build-sheet-call-card.ts';
import { buildBuildSheet } from './build-sheet.ts';
import { buildFixture } from './conformance-matrix-fixtures.ts';
import { buildTeaHouseRecipeGrid } from './fixtures/tea-house-recipes.ts';

const WORLD_DTS = readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');
const TEA_HOUSE_SPEC = BuildSpec.parse(
  JSON.parse(readFileSync(new URL('./fixtures/live-run-20261022/build-spec.json', import.meta.url), 'utf8')) as unknown,
);
const REGISTRY = loadRegistry();

interface EnvelopeSignature {
  readonly kind: 'slab' | 'wall' | 'opening' | 'roof';
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] };
  readonly subtype?: string;
}

/** 抽取调用卡代码块，转成 CJS 后在真 world 上执行；返回 compose 后的 grid。 */
function executeTs(code: string, label: string): Grid {
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { default?: (world: unknown) => void } = {};
  const context = vm.createContext({ exports, rect });
  new vm.Script(js, { filename: `${label}-call-card.cjs` }).runInContext(context);
  const build = exports.default;
  if (typeof build !== 'function') throw new Error(`${label}: 代码块没有 default build 函数`);
  const host = createWorld(REGISTRY.table);
  build(host.world);
  return host.compose().grid;
}

function executeEnvelopeCode(markdown: string, label: string): Grid {
  const code = tsBlocks(markdown)[0];
  assert.ok(code !== undefined, `${label}: 没有可执行的 ts 代码块`);
  return executeTs(code, label);
}

function envelopeSignature(grid: Grid): readonly EnvelopeSignature[] {
  return extractAsBuiltObjects(grid, REGISTRY)
    .objects.filter((object) => object.kind !== 'furniture' && object.kind !== 'site' && object.kind !== 'unknown')
    .map((object) =>
      object.kind === 'opening'
        ? { kind: object.kind, bounds: object.bounds, subtype: object.opening.subtype }
        : { kind: object.kind, bounds: object.bounds },
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function assertEnvelopePasses(sheet: ReturnType<typeof buildBuildSheet>, grid: Grid, label: string): void {
  const report = diffObjects(sheet.expectedObjects, extractAsBuiltObjects(grid, REGISTRY));
  assert.deepEqual(
    report.summary,
    {
      pass: 5,
      fail: 0,
      missing: 0,
      extra: 0,
      unverified: 0,
      blockingCount: 0,
      blocking: false,
      fullyVerified: true,
    },
    `${label}: ${report.items.map((item) => `${item.id}:${item.status}:${item.reason ?? ''}`).join(' | ')}`,
  );
}

function cardById(cards: readonly ConstructionCallCard[], id: string): ConstructionCallCard {
  const card = cards.find((candidate) => candidate.id === id);
  if (card === undefined) throw new Error(`missing call card ${id}`);
  return card;
}

function tsBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

async function assertPrechecks(markdown: string, label: string): Promise<void> {
  const blocks = tsBlocks(markdown);
  assert.ok(blocks.length > 0, `${label}: 没有 ts 代码块可预检`);
  const prechecker = createPrechecker(WORLD_DTS);
  try {
    for (const [index, block] of blocks.entries()) {
      assert.equal(/\bBounds\b/.test(block), false, `${label} 第 ${String(index + 1)} 块使用了未导出的 Bounds`);
      const result = await prechecker.check(block);
      assert.equal(
        result.kind,
        'ok',
        result.kind === 'failed'
          ? `${label} 第 ${String(index + 1)} 块预检失败：${result.diagnostics.map((d) => `${d.code} ${d.message}`).join(' | ')}`
          : `${label} 第 ${String(index + 1)} 块预检结果 ${result.kind}`,
      );
    }
  } finally {
    await prechecker.close();
  }
}

test('茶亭 golden：rect / at / sill / peakY 与 tea-house-recipes 的换算一致', () => {
  const sheet = buildBuildSheet(TEA_HOUSE_SPEC);
  const { callCards } = sheet;

  assert.deepEqual(
    callCards.map((card) => card.id),
    ['slab:f1', 'wall:f1', 'opening:op-entry-north', 'opening:op-south-window', 'roof'],
  );

  const slab = cardById(callCards, 'slab:f1');
  assert.deepEqual(slab.rect, { x0: 2, z0: 2, x1: 11, z1: 9 });
  assert.equal(
    slab.call,
    "w.floorPlate({ footprint: rect(2, 2, 11, 9), y: 0, thickness: 1, material: 'polished_andesite' })",
  );
  assert.deepEqual(slab.expectedBounds, { min: [2, 0, 2], max: [12, 1, 10] });

  const wall = cardById(callCards, 'wall:f1');
  assert.deepEqual(wall.rect, { x0: 2, z0: 2, x1: 11, z1: 9 });
  assert.equal(
    wall.call,
    "w.walls({ footprint: rect(2, 2, 11, 9), y: 1, height: 4, thickness: 1, material: 'dark_oak_planks' })",
  );
  assert.deepEqual(wall.expectedBounds, { min: [2, 1, 2], max: [12, 5, 10] });

  // golden recipe：openingStart = outerMin + floor((outerMax - outerMin + 1 - width) / 2)。
  const door = cardById(callCards, 'opening:op-entry-north');
  assert.deepEqual(door.rect, { x0: 3, z0: 2, x1: 4, z1: 2 });
  assert.equal(
    door.call,
    "w.opening({ in: wall_f1.facade('north'), kind: 'door', width: 2, height: 2, sill: 0, at: -3 })",
  );
  assert.deepEqual(door.expectedBounds, { min: [3, 1, 2], max: [5, 3, 3] });
  assert.equal(door.params, 'at=-3 · sill=0 · width=2 · height=2 · door @ wall_f1.north');

  const window = cardById(callCards, 'opening:op-south-window');
  assert.deepEqual(window.rect, { x0: 5, z0: 9, x1: 8, z1: 9 });
  assert.equal(
    window.call,
    "w.opening({ in: wall_f1.facade('south'), kind: 'window', width: 4, height: 2, sill: 1, at: 0, fill: 'glass' })",
  );
  assert.deepEqual(window.expectedBounds, { min: [5, 2, 9], max: [9, 4, 10] });

  // golden recipe：gable / ridge x / peakY=ridgeHeight=7 / overhang 1；footprint 是墙顶承托轮廓。
  const roof = cardById(callCards, 'roof');
  assert.deepEqual(roof.rect, { x0: 2, z0: 2, x1: 11, z1: 9 });
  assert.equal(
    roof.call,
    "w.roof({ footprint: rect(2, 2, 11, 9), y: 5, kind: 'gable', ridge: 'x', peakY: 7, overhang: 1, thickness: 1, material: 'deepslate_tiles', gableMaterial: 'deepslate_tiles' })",
  );
  assert.deepEqual(roof.expectedBounds, { min: [1, 5, 1], max: [13, 8, 11] });
  assert.equal(roof.params, 'eaveY=5 · peakY=7 · overhang=1 · kind=gable · ridge=x');

  assert.match(sheet.markdown, /## 施工调用卡/);
  assert.match(sheet.markdown, /\| 对象 \| rect（x\/z，闭区间） \| 关键参数 \| 期望 bounds（半开） \|/);
  assert.match(sheet.markdown, /数字来自合同，不要改成示例值/);
  assert.match(sheet.markdown, /不要改这些数字/);
  // W11-19：调用卡必须把 API 的 y / 净尺寸 / frame / 半开断言语义写成不可误读的说明。
  assert.match(sheet.markdown, /floorPlate\.y.*walls\.y.*构件\*\*底部\*\* y/);
  assert.match(sheet.markdown, /站立面 = `y \+ thickness`，墙顶 = `y \+ height`/);
  assert.match(sheet.markdown, /石基座 \/ `plinth` 在 y0（墙下）.*不要抬到 y1/);
  assert.match(sheet.markdown, /`opening\.width` \/ `height` 是\*\*净宽 \/ 净高，不含框\*\*/);
  assert.match(sheet.markdown, /2 格门就是 `width: 2`.*不要写成 3 格再手工补洞/);
  assert.match(sheet.markdown, /`frame` 可选.*不传就不外凸.*默认宽 1.*向墙外凸 1 格.*并入墙包络/);
  assert.match(sheet.markdown, /`bounds\.min === expected\.min` 且 `bounds\.max \+ 1 === expected\.max`/);
  assert.match(sheet.markdown, /只覆盖包络对象；家具、门窗框、线脚、室内仍由你补/);
  assert.match(sheet.markdown, /10 格跨宽 2 → x6\.\.7，宽 3 → x5\.\.7/);
  const lockLines = sheet.markdown.split('\n').filter((line) => line.includes('不要改这些数字；如果必须改'));
  assert.equal(lockLines.length, sheet.callCards.length, '每张调用卡都应有一行“不要改”锁定说明');
  assert.match(sheet.markdown, /合同净宽 2 \/ 净高 2（不含框）/);
  assert.match(sheet.markdown, /门窗 `frame` 外凸 1 格可能并入墙包络/);
  assert.deepEqual(door.netSize, { width: 2, height: 2 });
  assert.deepEqual(window.netSize, { width: 4, height: 2 });
  assert.equal(slab.netSize, undefined);
  const code = tsBlocks(sheet.markdown)[0] ?? '';
  assert.equal(code.includes('furniture:'), false, '调用卡不应生成家具代码');
  assert.equal(code.includes('w.set('), false, '调用卡不应生成细部代码');
  assert.match(code, /自检：净宽 2 \/ 净高 2（不含框），不要改/);

  // 真执行：调用卡代码块在 createWorld 里跑通，且 slab / wall / opening / roof 的
  // as-built 包络与 golden recipe 完全一致。
  const generated = executeEnvelopeCode(sheet.markdown, 'tea-house');
  const golden = buildTeaHouseRecipeGrid(TEA_HOUSE_SPEC);
  assert.deepEqual(envelopeSignature(generated), envelopeSignature(golden));
  assert.deepEqual(
    new Set(envelopeSignature(generated).map((object) => object.kind)),
    new Set(['slab', 'wall', 'opening', 'roof']),
  );
  assertEnvelopePasses(sheet, generated, 'tea-house generated');
  assertEnvelopePasses(sheet, golden, 'tea-house golden');
});

test('反例：把门从 at=-3 / width=2 改成 at=-2 / width=3 会被对象 diff 抓住', () => {
  const sheet = buildBuildSheet(TEA_HOUSE_SPEC);
  const door = cardById(sheet.callCards, 'opening:op-entry-north');
  assert.equal(
    door.call,
    "w.opening({ in: wall_f1.facade('north'), kind: 'door', width: 2, height: 2, sill: 0, at: -3 })",
  );

  const code = tsBlocks(sheet.markdown)[0] ?? '';
  const tampered = code.replace('width: 2, height: 2, sill: 0, at: -3', 'width: 3, height: 2, sill: 0, at: -2');
  assert.notEqual(tampered, code, '反例必须真的替换掉门调用');

  // at=-2 / width=3 不会运行报错（洞仍放得下），但净宽变成 3、bounds 撑到 [3,1,2]..[6,3,3)；
  // 调用卡自带的 assertCellBounds 会立刻 throw（第一道）；去掉断言后对象 diff 仍必须 fail（第二道）。
  assert.throws(() => executeTs(tampered, 'tea-house-tampered-door'), /opening:op-entry-north bounds mismatch/);
  const unchecked = tampered.replace(/^\s*assertCellBounds\(.*\);\n/gm, '');
  const grid = executeTs(unchecked, 'tea-house-tampered-door-unchecked');
  const report = diffObjects(sheet.expectedObjects, extractAsBuiltObjects(grid, REGISTRY));
  const doorItem = report.items.find((item) => item.expectedId === 'opening:op-entry-north');
  assert.ok(
    doorItem !== undefined,
    report.items.map((item) => `${item.id}:${item.status}:${item.reason ?? ''}`).join(' | '),
  );
  assert.equal(doorItem.status, 'fail');
  assert.match(doorItem.reason ?? '', /width|bounds|mismatch|净宽/u);
  assert.equal(report.summary.pass, 4);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.summary.blocking, true);
});

test('第二个不同尺寸的 BuildSpec：H3 8×6 单坡，不复用茶亭坐标', () => {
  const fixture = buildFixture('H3', 'good');
  const sheet = buildBuildSheet(fixture.spec);

  assert.deepEqual(
    sheet.callCards.map((card) => card.id),
    ['slab:f1', 'wall:f1', 'opening:op-h3-door', 'opening:op-h3-window', 'roof'],
  );

  const slab = cardById(sheet.callCards, 'slab:f1');
  assert.deepEqual(slab.rect, { x0: 1, z0: 1, x1: 8, z1: 6 });
  assert.match(slab.call ?? '', /y: 0, thickness: 1, material: 'polished_granite'/);
  assert.deepEqual(slab.expectedBounds, { min: [1, 0, 1], max: [9, 1, 7] });

  const wall = cardById(sheet.callCards, 'wall:f1');
  assert.deepEqual(wall.rect, { x0: 1, z0: 1, x1: 8, z1: 6 });
  assert.match(wall.call ?? '', /y: 1, height: 4, thickness: 1, material: 'sandstone'/);

  // 东侧门：东西立面按 z 居中；at=0。南窗 x3..4 宽 2，按 x1..8 居中后 at=-1。
  const door = cardById(sheet.callCards, 'opening:op-h3-door');
  assert.equal(
    door.call,
    "w.opening({ in: wall_f1.facade('east'), kind: 'door', width: 2, height: 2, sill: 0, at: 0 })",
  );
  assert.deepEqual(door.expectedBounds, { min: [8, 1, 3], max: [9, 3, 5] });

  const window = cardById(sheet.callCards, 'opening:op-h3-window');
  assert.equal(
    window.call,
    "w.opening({ in: wall_f1.facade('south'), kind: 'window', width: 2, height: 2, sill: 1, at: -1, fill: 'light_blue_stained_glass_pane' })",
  );
  assert.deepEqual(window.expectedBounds, { min: [3, 2, 6], max: [5, 4, 7] });

  const roof = cardById(sheet.callCards, 'roof');
  assert.equal(
    roof.call,
    "w.roof({ footprint: rect(1, 1, 8, 6), y: 5, kind: 'shed', ridge: 'x', peakY: 7, overhang: 0, thickness: 1, material: 'deepslate_bricks' })",
  );
  assert.deepEqual(roof.expectedBounds, { min: [1, 5, 1], max: [9, 8, 7] });

  // 明确证明没有把茶亭的 10×8 / at=-3 / peakY=7 之外的茶亭值抄进来。
  assert.equal(sheet.markdown.includes('rect(2, 2, 11, 9)'), false);
  assert.equal(sheet.markdown.includes('at: -3'), false);

  const generated = executeEnvelopeCode(sheet.markdown, 'H3');
  assertEnvelopePasses(sheet, generated, 'H3 generated');
  assert.equal(generated.size > 0, true);
});

test('多段墙 H4：不能安全折叠的包络调用被置空并给出明确 note', () => {
  const sheet = buildBuildSheet(buildFixture('H4', 'good').spec);
  assert.deepEqual(
    sheet.callCards.map((card) => card.id),
    ['slab:f1', 'wall:f1', 'opening:op-h4-door', 'opening:op-h4-window', 'roof'],
  );
  for (const card of sheet.callCards) {
    assert.equal(card.call, null, `${card.id} 不应生成会绑到错误墙段的调用`);
    assert.match(card.note ?? '', /多段|矩形|L 形|屋面段/u, card.id);
  }
  const code = tsBlocks(sheet.markdown)[0] ?? '';
  for (const call of ['w.floorPlate(', 'w.walls(', 'w.opening(', 'w.roof(']) {
    assert.equal(code.includes(call), false, `H4 调用卡不应包含 ${call}`);
  }
});

test('洞口 level 找不到承载墙时不回退第一张墙卡', () => {
  const spec = BuildSpec.parse({
    ...TEA_HOUSE_SPEC,
    openings: TEA_HOUSE_SPEC.openings.map((opening) =>
      opening.id === 'op-entry-north' ? { ...opening, level: 'missing-level' } : opening,
    ),
  });
  const sheet = buildBuildSheet(spec);
  const door = cardById(sheet.callCards, 'opening:op-entry-north');
  assert.equal(door.call, null);
  assert.match(door.note ?? '', /没有可承载该洞口的墙卡片/u);
});

test('多层 BuildSpec：墙 / 板投影未支持时所有包络调用置空并标记 unverified', () => {
  const multiLevel = BuildSpec.parse({
    ...TEA_HOUSE_SPEC,
    levels: [...TEA_HOUSE_SPEC.levels, { id: 'f2', name: '二层', elevation: 5, height: 3 }],
    bounds: { min: [2, 1, 2], max: [12, 8, 10] },
  });
  const sheet = buildBuildSheet(multiLevel);
  assert.deepEqual(new Set(sheet.callCards.map((card) => card.kind)), new Set(['slab', 'wall', 'opening', 'roof']));
  for (const card of sheet.callCards) {
    assert.equal(card.call, null, card.id);
    assert.match(card.note ?? '', /多个楼层|多段|矩形/u, card.id);
  }
  assert.ok(
    sheet.callCards.some((card) => card.id === 'wall:f2'),
    '二层墙应在调用卡表里被点名',
  );
  const code = tsBlocks(sheet.markdown)[0] ?? '';
  for (const call of ['w.floorPlate(', 'w.walls(', 'w.opening(', 'w.roof(']) {
    assert.equal(code.includes(call), false, `多层调用卡不应包含 ${call}`);
  }
});

test('调用卡只覆盖包络对象，markdown 代码块全部通过 world.d.ts 预检', async () => {
  const teaHouse = buildBuildSheet(TEA_HOUSE_SPEC);
  await assertPrechecks(teaHouse.markdown, 'tea-house');

  const h3 = buildBuildSheet(buildFixture('H3', 'good').spec);
  await assertPrechecks(h3.markdown, 'H3');
  assert.deepEqual(
    new Set([...teaHouse.callCards, ...h3.callCards].map((card) => card.kind)),
    new Set(['slab', 'wall', 'opening', 'roof']),
  );
});
