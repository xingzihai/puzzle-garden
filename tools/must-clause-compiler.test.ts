import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileBuildBrief } from '@pg/interaction/brief';
import { expandDesignIntent } from '@pg/interaction/design-expand';
import { createIntentHost } from '@pg/interaction/generate-intent';
import { BuildSpec, RequirementGraph } from '@pg/interaction/schema';

import { compileMustClauses, MUST_CLAUSE_COMPILER_VERSION } from './must-clause-compiler.ts';

function readJson(path: URL): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const REQUIREMENTS = RequirementGraph.parse(
  readJson(new URL('../packages/interaction/fixtures/run7-requirements.json', import.meta.url)),
);
const SCHEME = expandDesignIntent(
  readJson(new URL('../packages/interaction/fixtures/run7-rev2-intent.json', import.meta.url)),
  createIntentHost(REQUIREMENTS, { schemeId: 'scheme-compiler-test', revision: 2, status: 'confirmed' }),
).scheme;
const SPEC = BuildSpec.parse(compileBuildBrief(SCHEME, REQUIREMENTS).spec);
const PLAN = compileMustClauses(SPEC);

type Must = BuildSpec['musts'][number];
type Clause = (typeof PLAN)['groups'][number]['leaves'][number];

const RUN7_MUST_IDS = [
  'req-teahouse-program',
  'req-outer-10x8',
  'req-single-storey',
  'req-no-mezzanine',
  'req-single-hall',
  'req-no-partitions',
  'req-interior-8x6',
  'req-wall-thick-1m',
  'req-door-north-west',
  'req-door-clear-1m',
  'req-window-south-4m',
  'req-window-dim',
  'req-no-glass-door',
  'req-no-outdoor-zone',
  'req-no-steps',
  'req-long-table',
  'req-bench-north',
  'req-bench-south',
  'req-seats-10',
  'req-counter',
  'req-counter-no-service',
  'req-stone-base',
  'req-wood-wall-column',
  'req-gable-tile-roof',
  'req-eave-only',
  'req-block-budget',
  'req-no-sign-ticket-frame',
  'req-site-stream-south',
  'req-site-road-north',
  'req-entrance-from-north',
  'req-view-frame',
  'constraint-con-outer-10x8',
  'constraint-con-single-storey',
  'constraint-con-interior-clear',
  'constraint-con-wall-1m',
  'constraint-con-door-2m',
  'constraint-con-door-clear-1m',
  'constraint-con-window-south',
  'constraint-con-material-selection',
  'constraint-con-block-budget',
  'constraint-con-entry-flush',
] as const;

function groupOf(plan: ReturnType<typeof compileMustClauses>, mustId: string) {
  const group = plan.groups.find((item) => item.mustId === mustId);
  assert.ok(group !== undefined, `缺少 must ${mustId}`);
  return group;
}

function leafOf(group: ReturnType<typeof groupOf>, metric: string): Clause {
  const clause = group.leaves.find((item) => item.target?.metric === metric);
  assert.ok(clause !== undefined, `${group.mustId} 缺少 metric=${metric}`);
  return clause;
}

function reportOf(group: ReturnType<typeof groupOf>, expectedId: string): Clause {
  const clause = group.leaves.find(
    (item) => item.check.kind === 'report' && item.check.objectRefs.includes(expectedId),
  );
  assert.ok(clause !== undefined, `${group.mustId} 缺少 report ${expectedId}`);
  return clause;
}

function withMustText(spec: BuildSpec, mustId: string, text: string): BuildSpec {
  return BuildSpec.parse({
    ...spec,
    musts: spec.musts.map((must) => (must.id === mustId ? { ...must, text } : must)),
  });
}

function withExtraMust(spec: BuildSpec, must: Must): BuildSpec {
  return BuildSpec.parse({ ...spec, musts: [...spec.musts, must] });
}

function withTableLength(spec: BuildSpec, length: number): BuildSpec {
  return BuildSpec.parse({
    ...spec,
    interiors: spec.interiors.map((interior) => ({
      ...interior,
      furnitureSpecs: interior.furnitureSpecs.map((item) =>
        item.id === 'f-long-table' ? { ...item, bounds: { min: [11 - length, 1, 5], max: [11, 2, 7] } } : item,
      ),
    })),
  });
}

function withNorthBenchSouthOfTable(spec: BuildSpec): BuildSpec {
  return BuildSpec.parse({
    ...spec,
    interiors: spec.interiors.map((interior) => ({
      ...interior,
      furnitureSpecs: interior.furnitureSpecs.map((item) =>
        item.id === 'f-bench-north' ? { ...item, bounds: { min: [7, 1, 8], max: [11, 2, 9] } } : item,
      ),
    })),
  });
}

test('run-7：41 groups，41 个 must id 全覆盖，compilerVersion 稳定', () => {
  assert.equal(MUST_CLAUSE_COMPILER_VERSION, 'must-clause-v1');
  assert.equal(PLAN.tool, 'must-clause-compiler');
  assert.equal(PLAN.compilerVersion, MUST_CLAUSE_COMPILER_VERSION);
  assert.equal(PLAN.groups.length, 41);
  assert.deepEqual(
    PLAN.groups.map((group) => group.mustId),
    [...RUN7_MUST_IDS],
  );
  assert.deepEqual(
    PLAN.groups.map((group) => group.mustId),
    SPEC.musts.map((must) => must.id),
  );
  for (const group of PLAN.groups) assert.ok(group.leaves.length >= 1, group.mustId);
  assert.equal(PLAN.summary.musts, 41);
  assert.equal(PLAN.summary.leaves, 109);
  assert.equal(PLAN.summary.conflicts, 0);
});

test('run-7：run7 全部 must 使用显式规则，没有 no-compiler-rule fallback', () => {
  for (const group of PLAN.groups) {
    for (const clause of group.leaves) {
      assert.notEqual(clause.reason, 'no-compiler-rule', clause.clauseId);
    }
  }
});

test('run-7：外轮廓 / 单层 / 净尺寸 / 墙厚 targets 与 spec 派生值一致', () => {
  const outer = groupOf(PLAN, 'req-outer-10x8');
  assert.equal(leafOf(outer, 'width').target?.value, 10);
  assert.equal(leafOf(outer, 'width').target?.unit, 'm');
  assert.equal(leafOf(outer, 'depth').target?.value, 8);
  assert.deepEqual(reportOf(outer, 'wall:f1').check.objectRefs, ['wall:f1']);
  assert.equal(leafOf(outer, 'width').conflict, null);

  const storey = groupOf(PLAN, 'req-single-storey');
  assert.equal(leafOf(storey, 'count').target?.value, 1);
  assert.equal(leafOf(storey, 'count').check.id, 'check:storey:f1');
  assert.ok(storey.leaves.some((clause) => clause.check.id === 'check:absence:stairs-basement'));

  const clear = groupOf(PLAN, 'req-interior-8x6');
  assert.equal(leafOf(clear, 'width').target?.value, 8);
  assert.equal(leafOf(clear, 'depth').target?.value, 6);
  assert.equal(leafOf(clear, 'area').target?.value, 48);
  assert.equal(leafOf(clear, 'width').check.id, 'check:clear:f1');

  const thickness = groupOf(PLAN, 'req-wall-thick-1m');
  assert.equal(leafOf(thickness, 'thickness').target?.value, 1);
  assert.equal(leafOf(thickness, 'thickness').check.id, 'check:thickness:f1');
  assert.equal(thickness.leaves.length, 2);
  assert.equal(thickness.leaves[1]?.target, null);

  const constraintWall = groupOf(PLAN, 'constraint-con-wall-1m');
  assert.equal(constraintWall.leaves.length, 1);
  assert.equal(leafOf(constraintWall, 'thickness').target?.value, 1);
});

test('run-7：门 / 窗 targets、report refs 与 schedule 检查', () => {
  const door = groupOf(PLAN, 'req-door-north-west');
  assert.equal(leafOf(door, 'width').target?.value, 2);
  assert.equal(leafOf(door, 'side').target?.value, 'north');
  assert.equal(leafOf(door, 'centerX').target?.value, 'west-of-center');
  assert.deepEqual(reportOf(door, 'opening:op-entry-north').check.objectRefs, ['opening:op-entry-north']);
  assert.equal(leafOf(door, 'width').check.params['expectedId'], 'op-entry-north');

  const doorClear = groupOf(PLAN, 'req-door-clear-1m');
  assert.equal(leafOf(doorClear, 'door-clear').target?.value, 1);
  assert.equal(leafOf(doorClear, 'door-clear').check.id, 'check:door-clear:op-entry-north');

  const windowSouth = groupOf(PLAN, 'req-window-south-4m');
  assert.equal(leafOf(windowSouth, 'width').target?.value, 4);
  assert.equal(leafOf(windowSouth, 'side').target?.value, 'south');
  assert.equal(leafOf(windowSouth, 'onlyOnSide').target?.value, 1);
  assert.deepEqual(reportOf(windowSouth, 'opening:op-south-window').check.objectRefs, ['opening:op-south-window']);

  const windowDim = groupOf(PLAN, 'req-window-dim');
  assert.equal(leafOf(windowDim, 'sill').target?.value, 1);
  assert.equal(leafOf(windowDim, 'height').target?.value, 2);
  assert.equal(leafOf(windowDim, 'head').target?.value, 3);
  assert.ok(windowDim.leaves.some((clause) => clause.check.kind === 'report'));

  const constraintWindow = groupOf(PLAN, 'constraint-con-window-south');
  assert.deepEqual(
    constraintWindow.leaves
      .filter((clause) => clause.target !== null && clause.check.kind !== 'report')
      .map((clause) => [clause.target?.metric, clause.target?.value]),
    [
      ['side', 'south'],
      ['width', 4],
      ['sill', 1],
      ['height', 2],
      ['head', 3],
      ['onlyOnSide', 1],
    ],
  );
  assert.equal(reportOf(constraintWindow, 'opening:op-south-window').check.kind, 'report');
});

test('run-7：absence / flush / budget / roof 使用 allowlisted check id', () => {
  assert.equal(groupOf(PLAN, 'req-no-mezzanine').leaves[0]?.check.kind, 'qualitative');
  assert.equal(groupOf(PLAN, 'req-no-partitions').leaves[0]?.check.id, 'check:absence:partition');
  assert.equal(groupOf(PLAN, 'req-counter-no-service').leaves[0]?.check.id, 'check:absence:counter-service');
  assert.equal(groupOf(PLAN, 'req-no-glass-door').leaves[0]?.check.id, 'check:absence:glass-door');
  assert.equal(groupOf(PLAN, 'req-no-outdoor-zone').leaves[0]?.check.id, 'check:absence:eave-platform');
  assert.equal(groupOf(PLAN, 'req-no-outdoor-zone').leaves[1]?.check.id, 'check:absence:base-platform');
  assert.equal(
    groupOf(PLAN, 'req-stone-base').leaves.find((clause) => clause.check.id === 'check:absence:base-platform')?.check
      .kind,
    'coverage',
  );
  assert.equal(groupOf(PLAN, 'req-no-steps').leaves[0]?.check.id, 'check:flush:op-entry-north');
  assert.equal(groupOf(PLAN, 'req-stone-base').leaves[0]?.target, null);
  assert.ok(groupOf(PLAN, 'req-stone-base').leaves.some((clause) => clause.check.kind === 'report'));

  const budget = groupOf(PLAN, 'req-block-budget');
  assert.equal(leafOf(budget, 'maxBlocks').target?.value, 20000);
  assert.equal(leafOf(budget, 'maxBlocks').check.id, 'check:budget:20000');

  const roof = groupOf(PLAN, 'req-gable-tile-roof');
  assert.equal(leafOf(roof, 'form').target?.value, 'gable');
  assert.equal(leafOf(roof, 'form').check.kind, 'roof');
  assert.deepEqual(reportOf(roof, 'roof').check.objectRefs, ['roof']);
  assert.equal(roof.leaves.filter((clause) => clause.target === null).length, 1);
});

test('run-7：家具尺寸 / kind / relation / report 与 door-clear 净空', () => {
  const table = groupOf(PLAN, 'req-long-table');
  assert.equal(leafOf(table, 'length').target?.value, 4);
  assert.equal(leafOf(table, 'depth').target?.value, 2);
  assert.equal(leafOf(table, 'kind').target?.value, 'table');
  assert.equal(leafOf(table, 'relation').target?.value, 'east-wall');
  assert.equal(leafOf(table, 'axis').target?.value, 'x');
  assert.deepEqual(reportOf(table, 'furniture:f-long-table').check.objectRefs, ['furniture:f-long-table']);

  const northBench = groupOf(PLAN, 'req-bench-north');
  assert.equal(leafOf(northBench, 'length').target?.value, 4);
  assert.equal(leafOf(northBench, 'depth').target?.value, 1);
  assert.equal(leafOf(northBench, 'relation').target?.value, 'north-of');
  assert.equal(leafOf(northBench, 'relation').check.params['referenceId'], 'f-long-table');
  assert.equal(leafOf(northBench, 'west-of-door-clear').target?.value, true);

  const southBench = groupOf(PLAN, 'req-bench-south');
  assert.equal(leafOf(southBench, 'relation').target?.value, 'south-of');

  const counter = groupOf(PLAN, 'req-counter');
  assert.equal(leafOf(counter, 'length').target?.value, 2);
  assert.equal(leafOf(counter, 'depth').target?.value, 1);
  assert.equal(leafOf(counter, 'relation').target?.value, 'west-wall');
  assert.deepEqual(reportOf(counter, 'furniture:f-counter').check.objectRefs, ['furniture:f-counter']);
  assert.ok(counter.leaves.some((clause) => clause.check.kind === 'qualitative'));

  const seats = groupOf(PLAN, 'req-seats-10');
  assert.equal(leafOf(seats, 'count').target?.value, 10);
  assert.deepEqual(leafOf(seats, 'seatsPerBench').target?.value, [5, 5]);
  assert.equal(leafOf(seats, 'count').check.id, 'check:seats:10');
});

test('acid：must 4m 长桌 vs spec 3m → conflict，不静默通过', () => {
  const plan = compileMustClauses(withTableLength(SPEC, 3));
  const table = groupOf(plan, 'req-long-table');
  const length = leafOf(table, 'length');
  assert.equal(length.target?.value, 4);
  assert.equal(length.specTarget, 3);
  const conflict = length.conflict;
  assert.ok(conflict !== null);
  assert.equal(conflict.mustTarget, 4);
  assert.equal(conflict.specTarget, 3);
  assert.deepEqual(reportOf(table, 'furniture:f-long-table').check.objectRefs, ['furniture:f-long-table']);
});

test('acid：text 双坡 vs spec roof.form=shed → conflict，form leaf 保留 gable 目标', () => {
  const spec = BuildSpec.parse({ ...SPEC, roof: { ...SPEC.roof, form: 'shed' } });
  const roof = groupOf(compileMustClauses(spec), 'req-gable-tile-roof');
  const form = leafOf(roof, 'form');
  assert.equal(form.target?.value, 'gable');
  assert.equal(form.specTarget, 'shed');
  const conflict = form.conflict;
  assert.ok(conflict !== null);
  assert.equal(conflict.mustTarget, 'gable');
  assert.equal(conflict.specTarget, 'shed');
});

test('acid：text 预算 100 方块 vs spec 20000 → conflict', () => {
  const spec = withMustText(SPEC, 'req-block-budget', '整体预算 100 方块。');
  const budget = groupOf(compileMustClauses(spec), 'req-block-budget');
  const clause = leafOf(budget, 'maxBlocks');
  assert.equal(clause.target?.value, 100);
  assert.equal(clause.specTarget, 20000);
  assert.ok(clause.conflict !== null);
});

test('acid：北凳文本 vs spec 把同名家具放到南侧 → relation conflict', () => {
  const spec = withNorthBenchSouthOfTable(SPEC);
  const bench = groupOf(compileMustClauses(spec), 'req-bench-north');
  const relation = leafOf(bench, 'relation');
  assert.equal(relation.target?.value, 'north-of');
  assert.equal(relation.specTarget, 'south-of');
  assert.ok(relation.conflict !== null);
});

test('acid：座位文本只在 seat must id 下生成 seat 检查；非 seat id 回落 program qualitative', () => {
  const spec = withExtraMust(SPEC, {
    id: 'req-program-extra',
    text: '茶亭提供 10 座饮茶空间。',
    source: 'requirement',
  });
  const extra = groupOf(compileMustClauses(spec), 'req-program-extra');
  assert.ok(extra.leaves.every((clause) => !clause.check.id.startsWith('check:seats')));
  assert.ok(extra.leaves.every((clause) => clause.target === null));
  const first = extra.leaves[0];
  assert.ok(first !== undefined);
  assert.equal(first.kind, 'program');
  assert.equal(first.check.kind, 'qualitative');
  assert.equal(first.reason, 'no-compiler-rule');
});

test('acid：外墙厚 1m + 造型优雅 → thickness + qualitative 两个 leaf；裸厚度只有 thickness', () => {
  const decorated = withExtraMust(SPEC, {
    id: 'req-generic-wall-decorated',
    text: '外墙厚 1m，造型优雅。',
    source: 'requirement',
  });
  const decoratedGroup = groupOf(compileMustClauses(decorated), 'req-generic-wall-decorated');
  assert.equal(decoratedGroup.leaves.length, 2);
  const thickness = decoratedGroup.leaves[0];
  const tail = decoratedGroup.leaves[1];
  assert.ok(thickness !== undefined);
  assert.ok(tail !== undefined);
  const thicknessTarget = thickness.target;
  assert.ok(thicknessTarget !== null);
  assert.equal(thicknessTarget.value, 1);
  assert.equal(thicknessTarget.metric, 'thickness');
  assert.equal(tail.target, null);
  assert.equal(tail.check.kind, 'qualitative');

  const plain = withExtraMust(SPEC, {
    id: 'req-generic-wall-plain',
    text: '外墙厚1m。',
    source: 'requirement',
  });
  const plainGroup = groupOf(compileMustClauses(plain), 'req-generic-wall-plain');
  assert.equal(plainGroup.leaves.length, 1);
  assert.equal(plainGroup.leaves[0]?.target?.value, 1);
});

test('generic budget：没有 run7 id 时也从文本提取上限', () => {
  const spec = withExtraMust(SPEC, {
    id: 'req-generic-cost',
    text: '整体预算 777 方块。',
    source: 'requirement',
  });
  const budget = groupOf(compileMustClauses(spec), 'req-generic-cost');
  assert.equal(leafOf(budget, 'maxBlocks').target?.value, 777);
  assert.ok(leafOf(budget, 'maxBlocks').conflict !== null);
});

test('acid：长桌长边旋转 90° 时 table-long-axis not-met（不能只看 max/min 尺寸）', () => {
  const rotated = BuildSpec.parse({
    ...SPEC,
    interiors: SPEC.interiors.map((interior) => ({
      ...interior,
      furnitureSpecs: interior.furnitureSpecs.map((item) =>
        item.id === 'f-long-table' ? { ...item, bounds: { min: [9, 1, 4] as const, max: [11, 2, 8] as const } } : item,
      ),
    })),
  });
  const plan = compileMustClauses(rotated);
  const axis = groupOf(plan, 'req-long-table').leaves.find((leaf) => leaf.target?.metric === 'axis');
  assert.ok(axis !== undefined);
  assert.equal(axis.target?.value, 'x');
  assert.notEqual(axis.conflict, null);
});

test('acid：constraint-con-door-2m 保留北墙 / 西段位置 leaf', () => {
  const door = groupOf(PLAN, 'constraint-con-door-2m');
  assert.equal(leafOf(door, 'side').target?.value, 'north');
  assert.equal(leafOf(door, 'centerX').target?.value, 'west-of-center');
});

test('acid：通用负向 must 不按关键词生成正向窗 leaf', () => {
  const spec = withExtraMust(SPEC, { id: 'req-no-window', text: '不做 4m 宽窗。', source: 'requirement' });
  const plan = compileMustClauses(spec);
  const group = groupOf(plan, 'req-no-window');
  assert.equal(group.leaves.length, 1);
  assert.equal(group.leaves[0]?.check.kind, 'qualitative');
  assert.equal(group.leaves[0].target, null);
});

test('acid：id 含 seats 但文本是 program 时不生成 seat leaf', () => {
  const spec = withExtraMust(SPEC, {
    id: 'req-teahouse-seats-program',
    text: '茶亭提供 10 座饮茶空间。',
    source: 'requirement',
  });
  const plan = compileMustClauses(spec);
  const group = groupOf(plan, 'req-teahouse-seats-program');
  assert.equal(group.leaves.length, 1);
  assert.equal(group.leaves[0]?.check.kind, 'qualitative');
  assert.equal(
    group.leaves.some((leaf) => leaf.check.id.startsWith('check:seats:')),
    false,
  );
});

test('acid：must 预算比 spec 宽松时用更严格的 spec 上限，不误报 conflict', () => {
  const spec = withExtraMust(SPEC, { id: 'req-budget-30000', text: '整体预算 30000 方块。', source: 'constraint' });
  const plan = compileMustClauses(spec);
  const budget = leafOf(groupOf(plan, 'req-budget-30000'), 'maxBlocks');
  assert.equal(budget.target?.value, 30000);
  assert.equal(budget.check.params['specMax'], 20000);
  assert.equal(budget.conflict, null);
});
