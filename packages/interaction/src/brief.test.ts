import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractTaskBody } from '@pg/agent/task-body';

import { compileBuildBrief, compileGates, lintBrief } from './brief.ts';
import { MAX_TASK_CHARS } from './build.ts';
import { exampleRequirements, exampleScheme } from './example.ts';
import { DesignScheme } from './scheme.ts';

const BASE = () => compileBuildBrief(exampleScheme(), exampleRequirements());

function codes(issues: readonly { readonly code: string }[]): readonly string[] {
  return issues.map((issue) => issue.code);
}

test('四节题面可被 extractTaskBody 解析，且 lint 干净', () => {
  const brief = BASE();
  const body = extractTaskBody(brief.taskMarkdown);
  assert.deepEqual(
    body.sections.map((section) => section.numeral),
    ['一', '二', '三', '四'],
  );
  assert.match(brief.taskMarkdown, /## 一、需求与设计意图/);
  assert.match(brief.taskMarkdown, /## 四、验收与自由发挥/);
  assert.equal(brief.promptMeta.compilerVersion, '0.1.0');
  assert.equal(brief.promptMeta.capabilityCardVersion.length > 0, true);
  assert.deepEqual(lintBrief(brief, exampleRequirements()), []);
});

test('gates 映射现有门槛：可达、结构跨度与悬空来源', () => {
  const gates = compileGates(exampleScheme());
  assert.equal(gates.reachAll, true);
  assert.deepEqual(gates.structureSpans, { x: [1, 12], z: [1, 10] });
  assert.ok(gates.floatingAllowApis?.includes('walls'));
  assert.ok(gates.floatingAllowApis?.includes('floorPlate'));
  assert.ok(gates.floatingAllowApis?.includes('roof'));
});

test('题面数字改成 spec 中不存在的值会被 lint 检出', () => {
  const brief = BASE();
  const tampered = { ...brief, taskMarkdown: brief.taskMarkdown.replace('16', '99') };
  const issues = lintBrief(tampered);
  assert.ok(codes(issues).includes('number-unknown'));
  assert.ok(issues.some((issue) => issue.message.includes('99')));
});

test('删除 must 行会被 lint 检出；需求图的 must 缺失也检出', () => {
  const brief = BASE();
  const withoutMust = {
    ...brief,
    taskMarkdown: brief.taskMarkdown
      .split('\n')
      .filter((line) => !line.includes('req-use'))
      .join('\n'),
  };
  assert.ok(codes(lintBrief(withoutMust)).includes('must-missing'));

  const withoutSpecMusts = { ...brief, spec: { ...brief.spec, musts: [] } };
  assert.ok(codes(lintBrief(withoutSpecMusts, exampleRequirements())).includes('must-not-in-spec'));
});

test('删除禁项、洞口宿主损坏、预算倒挂都能被 lint 检出', () => {
  const brief = BASE();
  const withoutForbidden = {
    ...brief,
    taskMarkdown: brief.taskMarkdown
      .split('\n')
      .filter((line) => !line.includes('不得改变南向看景开口'))
      .join('\n'),
  };
  assert.ok(codes(lintBrief(withoutForbidden)).includes('forbidden-missing'));

  const brokenOpening = {
    ...brief,
    spec: {
      ...brief.spec,
      openings: brief.spec.openings.map((opening, index) =>
        index === 0 ? { ...opening, host: 'el-missing' } : opening,
      ),
    },
  };
  assert.ok(codes(lintBrief(brokenOpening)).includes('opening-reference'));

  const overBudget = {
    ...brief,
    spec: {
      ...brief.spec,
      budget: { ...brief.spec.budget, targetBlocks: brief.spec.budget.maxBlocks + 1 },
    },
  };
  assert.ok(codes(lintBrief(overBudget)).includes('budget'));
});

test('超长题面被 lint 检出', () => {
  const brief = BASE();
  const tooLong = { ...brief, taskMarkdown: 'x'.repeat(MAX_TASK_CHARS + 1) };
  assert.ok(codes(lintBrief(tooLong)).includes('task-too-long'));
});

test('编译确定：同输入生成逐字节相同的题面与报告', () => {
  const first = BASE();
  const second = BASE();
  assert.equal(first.taskMarkdown, second.taskMarkdown);
  assert.equal(first.designMarkdown, second.designMarkdown);
  assert.deepEqual(first.gates, second.gates);
});

test('没有需求图时仍能编译，约束与必须项只来自方案', () => {
  const brief = compileBuildBrief(exampleScheme());
  assert.equal(brief.promptMeta.requirementsGraphId, 'req-tea');
  assert.equal(
    brief.spec.musts.every((must) => must.source === 'detail'),
    true,
  );
  assert.deepEqual(lintBrief(brief), []);
});

test('稀疏方案覆盖空洞口 / 路线 / 立面 / 细部 / 室内与空值分支', () => {
  const scheme = DesignScheme.parse({
    ...exampleScheme(),
    meta: { ...exampleScheme().meta, scope: 'exterior+entry' },
    site: { ...exampleScheme().site, outdoorZones: [], notes: null },
    openings: [],
    circulation: [],
    facades: [],
    details: [],
    interiors: [],
    decisions: [],
    roof: { ...exampleScheme().roof, drainage: null, skylights: ['南侧天窗'], notes: null },
    structure: { ...exampleScheme().structure, notes: null },
    forbidden: [exampleScheme().forbidden[0]!, exampleScheme().forbidden[0]!],
  });
  const brief = compileBuildBrief(scheme);
  assert.match(brief.taskMarkdown, /无洞口/);
  assert.match(brief.taskMarkdown, /未指定显式路线/);
  assert.match(brief.taskMarkdown, /未指定立面分层/);
  assert.match(brief.taskMarkdown, /细部：无额外条目/);
  assert.match(brief.taskMarkdown, /本方案未包含室内设计/);
  assert.match(brief.taskMarkdown, /天窗：南侧天窗/);
  assert.deepEqual(lintBrief(brief), []);
  assert.equal(brief.spec.forbidden.filter((item) => item.includes('南向看景开口')).length, 1);
  assert.equal(compileGates(scheme).reachAll, undefined);
});

test('长路线只列前段并指向完整点表', () => {
  const base = exampleScheme();
  const route = base.circulation[0]!;
  const scheme = DesignScheme.parse({
    ...base,
    circulation: [
      {
        ...route,
        points: Array.from({ length: 13 }, (_, index) => [10 + index, 1, 12] as const),
      },
    ],
    facades: base.facades.map((facade, index) => (index === 0 ? { ...facade, topMaterialId: null } : facade)),
  });
  const brief = compileBuildBrief(scheme);
  assert.match(brief.taskMarkdown, /完整点表见 build-spec\.json/);
  assert.match(brief.taskMarkdown, /顶部 —/);
  assert.deepEqual(lintBrief(brief), []);
});

test('需求约束进入 must 与禁项', () => {
  const brief = compileBuildBrief(exampleScheme(), exampleRequirements());
  assert.ok(brief.spec.musts.some((must) => must.id === 'constraint-reqc-budget' && must.source === 'constraint'));
  assert.ok(brief.spec.forbidden.some((item) => item.includes('旅游景点式')));
});
