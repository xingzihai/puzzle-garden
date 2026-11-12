import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { checkScheme } from './conversation-support.ts';
import { RequirementGraph } from './requirements.ts';
import { DesignScheme } from './scheme.ts';
import { verifySchemeAgainstRequirements } from './scheme-gate.ts';

function fixture<T>(name: string, parse: (value: unknown) => T): T {
  return parse(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')));
}

const RUN7 = fixture('run7-requirements.json', (value) => RequirementGraph.parse(value));
const REV1 = fixture('run7-rev1-scheme.json', (value) => DesignScheme.parse(value));
const REV2 = fixture('run7-rev2-scheme.json', (value) => DesignScheme.parse(value));

const REAL_CODES = ['table-4x2', 'no-chairs', 'door-clearance-1m', 'counter-table-1m'] as const;

test('run-7 rev1：B1 恰好报 4 个真实家具 / 净空问题', () => {
  const report = verifySchemeAgainstRequirements(REV1, RUN7);
  assert.equal(report.passed, false);
  assert.equal(report.counts.blocking, 4);
  assert.equal(report.counts.warning, 0);
  assert.equal(report.counts.unverified, 0);
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    [...REAL_CODES],
  );
  for (const issue of report.issues) {
    assert.ok(issue.mustIds.length > 0, `${issue.code} 缺 must id`);
    assert.ok(issue.options.length > 0, `${issue.code} 缺可行动选项`);
    assert.ok(issue.expected.length > 0);
    assert.ok(issue.actual.length > 0);
  }
  const byCode = new Map(report.issues.map((issue) => [issue.code, issue]));
  assert.deepEqual(byCode.get('table-4x2')?.mustIds, ['req-long-table']);
  assert.deepEqual(byCode.get('no-chairs')?.mustIds, ['req-seats-10']);
  assert.ok(byCode.get('door-clearance-1m')?.mustIds.includes('req-door-clear-1m'));
  assert.ok(byCode.get('door-clearance-1m')?.mustIds.includes('constraint-con-door-clear-1m'));
  assert.deepEqual(byCode.get('counter-table-1m')?.mustIds, ['req-counter', 'req-long-table']);
  assert.ok(report.checkedMustIds.includes('req-long-table'));
  assert.ok(report.checkedMustIds.includes('req-seats-10'));
  assert.ok(report.checkedMustIds.includes('req-door-clear-1m'));
  assert.ok(report.checkedMustIds.includes('req-counter'));
  assert.ok(report.checkedMustIds.includes('req-outer-10x8'));
});

test('run-7 rev2：B1 通过；opening 入口不被误判成门类型问题', () => {
  const report = verifySchemeAgainstRequirements(REV2, RUN7);
  assert.equal(report.passed, true);
  assert.deepEqual(report.issues, []);
  assert.equal(report.counts.blocking, 0);
  assert.ok(REV2.openings.some((opening) => opening.id === 'op-entry-north' && opening.kind === 'opening'));
});

test('checkScheme 接入 B1 + C1：rev1 四个 B1 issue，rev2 无 datum 假冲突', () => {
  const rev1 = checkScheme(REV1, RUN7);
  assert.deepEqual(
    rev1.issues.map((issue) => issue.code),
    [...REAL_CODES],
  );
  assert.equal(rev1.conflicts.length, 4);
  assert.ok(rev1.conflicts.every((conflict) => conflict.kind === 'gate' && conflict.status === 'open'));
  assert.ok(rev1.conflicts.every((conflict) => conflict.options.length > 0));

  const rev2 = checkScheme(REV2, RUN7);
  assert.deepEqual(rev2.issues, []);
  assert.deepEqual(rev2.conflicts, []);
});

test('B1 选项带有可执行方向，不把冲突写成静默通过', () => {
  const report = verifySchemeAgainstRequirements(REV1, RUN7);
  const table = report.issues.find((issue) => issue.code === 'table-4x2');
  const chairs = report.issues.find((issue) => issue.code === 'no-chairs');
  const clearance = report.issues.find((issue) => issue.code === 'door-clearance-1m');
  const counter = report.issues.find((issue) => issue.code === 'counter-table-1m');
  assert.ok(table?.options.some((option) => option.id === 'resize-table-to-must'));
  assert.ok(chairs?.options.some((option) => option.id === 'remove-chairs'));
  assert.ok(clearance?.options.some((option) => option.id === 'move-blocking-furniture'));
  assert.ok(counter?.options.some((option) => option.id === 'move-counter-west'));
  for (const issue of report.issues) {
    assert.ok(issue.options.some((option) => option.action === 'repair'));
    assert.ok(issue.options.some((option) => option.action === 'waive'));
  }
});

function report(scheme: DesignScheme) {
  return verifySchemeAgainstRequirements(scheme, RUN7);
}

function graphWith(requirementIds: readonly string[], extra: readonly unknown[] = []): RequirementGraph {
  return RequirementGraph.parse({
    ...RUN7,
    requirements: [...RUN7.requirements.filter((requirement) => requirementIds.includes(requirement.id)), ...extra],
    constraints: [],
    preferences: [],
    ambiguities: [],
    conflicts: [],
    missing: [],
    capabilities: [],
    decisions: [],
  });
}

function reportWith(scheme: DesignScheme, requirements: RequirementGraph) {
  return verifySchemeAgainstRequirements(scheme, requirements);
}

function issueOf(reportValue: ReturnType<typeof report>, code: string) {
  const found = reportValue.issues.find((issue) => issue.code === code);
  assert.ok(found, `缺少 issue ${code}；实际：${reportValue.issues.map((issue) => issue.code).join('、')}`);
  return found;
}

function assertContract(issue: ReturnType<typeof issueOf>, mustId: string): void {
  assert.ok(issue.mustIds.includes(mustId), `${issue.code} 缺 must ${mustId}`);
  assert.ok(issue.expected.length > 0, `${issue.code} 缺 expected`);
  assert.ok(issue.actual.length > 0, `${issue.code} 缺 actual`);
  assert.ok(
    issue.options.some((option) => option.action === 'repair'),
    `${issue.code} 缺 repair 选项`,
  );
  assert.ok(
    issue.options.some((option) => option.action === 'waive'),
    `${issue.code} 缺 waive 选项`,
  );
}

test('新增 must 被机械核对：外轮廓 / 墙厚 / 入口 / 南窗 / 屋面 / 材料 / 净尺寸', () => {
  const checked = report(REV2);
  for (const id of [
    'req-outer-10x8',
    'constraint-con-outer-10x8',
    'req-interior-8x6',
    'constraint-con-interior-clear',
    'req-wall-thick-1m',
    'constraint-con-wall-1m',
    'req-door-north-west',
    'req-entrance-from-north',
    'constraint-con-door-2m',
    'req-window-south-4m',
    'req-window-dim',
    'constraint-con-window-south',
    'req-gable-tile-roof',
    'req-stone-base',
    'req-wood-wall-column',
    'constraint-con-material-selection',
  ]) {
    assert.ok(checked.checkedMustIds.includes(id), `未检查 ${id}`);
    assert.ok(!checked.uncheckedMustIds.includes(id), `${id} 不应保持 unchecked`);
  }
  // 纯视觉 / 无法从 scheme 对上的 prose 必须保持 unverified，不能算 pass。
  assert.ok(checked.uncheckedMustIds.includes('req-view-frame'));
});

test('外轮廓 10×8 变异：报 mustIds / expected / actual / options', () => {
  const scheme = DesignScheme.parse({
    ...REV2,
    site: { ...REV2.site, buildingBounds: { min: [2, 1, 2], max: [13, 5, 10] } },
  });
  const issue = issueOf(report(scheme), 'outer-10x8');
  assert.deepEqual(issue.mustIds, ['req-outer-10x8', 'constraint-con-outer-10x8']);
  assert.match(issue.expected, /10m×8m/);
  assert.match(issue.actual, /11m×8m/);
  assertContract(issue, 'req-outer-10x8');
});

test('墙厚 / 室内净尺寸变异：都从外墙几何推导，不读 prose', () => {
  const scheme = DesignScheme.parse({
    ...REV2,
    elements: REV2.elements.map((element) =>
      element.id === 'wall-f1-x-p000002-p000002-p000012'
        ? { ...element, thickness: 2, bounds: { min: [2, 1, 2], max: [12, 5, 4] } }
        : element,
    ),
  });
  const reportValue = report(scheme);
  const wall = issueOf(reportValue, 'wall-thickness-1m');
  assert.deepEqual(wall.mustIds, ['req-wall-thick-1m', 'constraint-con-wall-1m']);
  assert.match(wall.actual, /2m/);
  assertContract(wall, 'req-wall-thick-1m');
  const interior = issueOf(reportValue, 'interior-8x6');
  assert.match(interior.actual, /8m×5m/);
  assertContract(interior, 'req-interior-8x6');
});

test('入口方位变异：入口在北侧时不会误判 door kind', () => {
  const scheme = DesignScheme.parse({ ...REV2, site: { ...REV2.site, entranceSide: 'south' } });
  const issue = issueOf(report(scheme), 'entrance-side-north');
  assert.match(issue.actual, /south/);
  assertContract(issue, 'req-door-north-west');
  assert.ok(!report(scheme).issues.some((candidate) => candidate.code.includes('door-kind')));
});

test('入口归属只认入口 / 门 must；声明侧只有窗时不把窗当入口', () => {
  const scheme = DesignScheme.parse({ ...REV2, site: { ...REV2.site, entranceSide: 'south' } });
  const reportValue = report(scheme);
  const issue = issueOf(reportValue, 'entrance-side-north');
  assert.ok(!issue.mustIds.includes('req-bench-north'), '家具 must 不应归给入口');
  assert.deepEqual(issue.mustIds, ['req-door-north-west', 'req-entrance-from-north', 'constraint-con-door-2m']);
  assert.ok(!reportValue.issues.some((candidate) => candidate.code.startsWith('door-clearance-')));
});

test('入口净宽变异：2m → 3m 报 entrance-width-2m', () => {
  const scheme = DesignScheme.parse({
    ...REV2,
    openings: REV2.openings.map((opening) =>
      opening.id === 'op-entry-north' ? { ...opening, bounds: { min: [3, 1, 2], max: [6, 3, 3] } } : opening,
    ),
  });
  const issue = issueOf(report(scheme), 'entrance-width-2m');
  assert.match(issue.actual, /3m/);
  assertContract(issue, 'constraint-con-door-2m');
});

test('同侧多门：入口按声明顺序，不因 lower-id 的 3m 门误报 entrance-width-2m', () => {
  const realDoor = REV2.openings.find((opening) => opening.id === 'op-entry-north');
  assert.ok(realDoor !== undefined);
  const lowerIdWideDoor = {
    ...realDoor,
    id: 'op-entry-a-3m',
    name: '同侧非入口 3m 门洞',
    bounds: { min: [6, 1, 2], max: [9, 3, 3] },
  };
  const scheme = DesignScheme.parse({
    ...REV2,
    openings: [realDoor, lowerIdWideDoor, ...REV2.openings.filter((opening) => opening.id !== 'op-entry-north')],
  });
  assert.ok(!report(scheme).issues.some((candidate) => candidate.code === 'entrance-width-2m'));
});

test('入口缺失变异：北侧没有非窗洞口时报 entrance-missing-north', () => {
  const scheme = DesignScheme.parse({
    ...REV2,
    openings: REV2.openings.map((opening) =>
      opening.id === 'op-entry-north' ? { ...opening, side: 'east' as const } : opening,
    ),
  });
  const issue = issueOf(report(scheme), 'entrance-missing-north');
  assertContract(issue, 'req-entrance-from-north');
});

test('南窗方位变异：窗改到东侧时报 window-south-missing', () => {
  const scheme = DesignScheme.parse({
    ...REV2,
    openings: REV2.openings.map((opening) =>
      opening.id === 'op-south-window' ? { ...opening, side: 'east' as const } : opening,
    ),
  });
  const issue = issueOf(report(scheme), 'window-south-missing');
  assertContract(issue, 'req-window-south-4m');
});

test('南窗宽 / 窗台 / 窗高 / 洞顶变异：逐项报 expected 与 actual', () => {
  const wide = DesignScheme.parse({
    ...REV2,
    openings: REV2.openings.map((opening) =>
      opening.id === 'op-south-window' ? { ...opening, bounds: { min: [5, 2, 9], max: [10, 4, 10] } } : opening,
    ),
  });
  const wideIssue = issueOf(report(wide), 'window-south-4m');
  assert.match(wideIssue.actual, /5m/);
  assertContract(wideIssue, 'constraint-con-window-south');

  const highSill = DesignScheme.parse({
    ...REV2,
    openings: REV2.openings.map((opening) =>
      opening.id === 'op-south-window' ? { ...opening, bounds: { min: [5, 3, 9], max: [9, 5, 10] } } : opening,
    ),
  });
  const sillIssue = issueOf(report(highSill), 'window-south-sill-1m');
  assert.match(sillIssue.actual, /2m/);
  assertContract(sillIssue, 'req-window-dim');
  const headIssue = issueOf(report(highSill), 'window-south-head-3m');
  assert.match(headIssue.actual, /4m/);
});

test('南窗数量 / 多余洞口变异：单窗与“南墙无其他洞口”都机械核对', () => {
  const southWindow = REV2.openings.find((opening) => opening.id === 'op-south-window');
  assert.ok(southWindow);
  const extraWindow = DesignScheme.parse({
    ...REV2,
    openings: [
      ...REV2.openings,
      { ...southWindow, id: 'op-south-window-2', bounds: { min: [6, 2, 9], max: [10, 4, 10] } },
    ],
  });
  assertContract(issueOf(report(extraWindow), 'window-south-count'), 'req-window-south-4m');

  const extraDoor = DesignScheme.parse({
    ...REV2,
    openings: [
      ...REV2.openings,
      {
        ...southWindow,
        id: 'op-south-door',
        name: '南侧落地门',
        kind: 'door' as const,
        bounds: { min: [6, 1, 9], max: [8, 3, 10] },
      },
    ],
  });
  assertContract(issueOf(report(extraDoor), 'window-south-extra-opening'), 'constraint-con-window-south');
});

test('屋面形式 / 坡度变异：双坡必须 gable 且坡度 > 0', () => {
  const hip = DesignScheme.parse({ ...REV2, roof: { ...REV2.roof, form: 'hip' } });
  const formIssue = issueOf(report(hip), 'roof-form-gable');
  assert.match(formIssue.actual, /hip/);
  assertContract(formIssue, 'req-gable-tile-roof');

  const flatPitch = DesignScheme.parse({ ...REV2, roof: { ...REV2.roof, pitchDegrees: 0 } });
  const pitchIssue = issueOf(report(flatPitch), 'roof-pitch');
  assert.match(pitchIssue.expected, /坡度 > 0/);
  assertContract(pitchIssue, 'req-gable-tile-roof');
});

test('材料选择变异：屋面不再是深色瓦时报 material-dark-tile-roof', () => {
  const scheme = DesignScheme.parse({
    ...REV2,
    materials: REV2.materials.map((material) =>
      material.id === 'm-roof' ? { ...material, block: 'oak_planks' } : material,
    ),
  });
  const issue = issueOf(report(scheme), 'material-dark-tile-roof');
  assert.match(issue.actual, /oak_planks/);
  assertContract(issue, 'constraint-con-material-selection');
});

test('单一石基座 must 只跑石基座检查', () => {
  const scheme = DesignScheme.parse({
    ...REV2,
    facades: REV2.facades.map((facade) => ({ ...facade, baseMaterialId: 'm-wood' })),
  });
  const reportValue = reportWith(scheme, graphWith(['req-stone-base']));
  const issue = issueOf(reportValue, 'material-stone-base');
  assert.deepEqual(issue.mustIds, ['req-stone-base']);
  assert.ok(reportValue.checkedMustIds.includes('req-stone-base'));
  assert.ok(!reportValue.issues.some((candidate) => candidate.code.startsWith('material-wood-')));
  assert.ok(!reportValue.issues.some((candidate) => candidate.code.startsWith('material-dark-')));
});

test('单一木墙木柱 must 只跑木质检查，并覆盖墙身与柱体语义', () => {
  const bodyMismatch = DesignScheme.parse({
    ...REV2,
    facades: REV2.facades.map((facade) => ({ ...facade, bodyMaterialId: 'm-stone' })),
  });
  const bodyReport = reportWith(bodyMismatch, graphWith(['req-wood-wall-column']));
  const bodyIssue = issueOf(bodyReport, 'material-wood-wall-column');
  assert.deepEqual(bodyIssue.mustIds, ['req-wood-wall-column']);
  assert.match(bodyIssue.actual, /墙身不是木质/);
  assert.ok(!bodyReport.issues.some((candidate) => candidate.code.startsWith('material-stone-')));
  assert.ok(!bodyReport.issues.some((candidate) => candidate.code.startsWith('material-dark-')));

  const wallMismatch = DesignScheme.parse({
    ...REV2,
    elements: REV2.elements.map((element) =>
      element.id === 'wall-f1-x-p000002-p000002-p000012' ? { ...element, material: 'm-stone' } : element,
    ),
  });
  const wallReport = reportWith(wallMismatch, graphWith(['req-wood-wall-column']));
  const wallIssue = issueOf(wallReport, 'material-wood-wall-column');
  assert.match(wallIssue.actual, /外墙不是木质/);

  const structureMismatch = DesignScheme.parse({
    ...REV2,
    structure: { ...REV2.structure, material: 'm-stone' },
  });
  const structureReport = reportWith(structureMismatch, graphWith(['req-wood-wall-column']));
  assert.match(issueOf(structureReport, 'material-wood-wall-column').actual, /结构材料不是木质/);
});

test('单一深色瓦 must 只跑屋面检查', () => {
  const scheme = DesignScheme.parse({
    ...REV2,
    materials: REV2.materials.map((material) =>
      material.id === 'm-roof' ? { ...material, block: 'oak_planks' } : material,
    ),
  });
  const reportValue = reportWith(scheme, graphWith(['req-gable-tile-roof']));
  const issue = issueOf(reportValue, 'material-dark-tile-roof');
  assert.deepEqual(issue.mustIds, ['req-gable-tile-roof']);
  assert.ok(!reportValue.issues.some((candidate) => candidate.code.startsWith('material-stone-')));
  assert.ok(!reportValue.issues.some((candidate) => candidate.code.startsWith('material-wood-')));
});

test('未知材料 must 保持 unchecked，不猜 stone / wood / tile', () => {
  const unknown = {
    id: 'req-material-rammed-earth',
    text: '外墙采用夯土做法。',
    quote: null,
    source: 'user',
    kind: 'aesthetic',
    priority: 'must',
    status: 'confirmed',
    confidence: 0.8,
    affects: ['material'],
    evidence: 'synthetic single material must',
  };
  const reportValue = reportWith(REV2, graphWith([], [unknown]));
  assert.ok(reportValue.uncheckedMustIds.includes('req-material-rammed-earth'));
  assert.ok(!reportValue.checkedMustIds.includes('req-material-rammed-earth'));
  assert.ok(!reportValue.issues.some((candidate) => candidate.code.startsWith('material-')));
});

test('缺少长凳 / 柜台不能假通过：presence + dimension 都检查', () => {
  const withoutBenches = DesignScheme.parse({
    ...REV2,
    interiors: REV2.interiors.map((interior) => ({
      ...interior,
      furnitureSpecs: interior.furnitureSpecs.filter((item) => item.kind !== 'bench'),
    })),
  });
  const benchReport = verifySchemeAgainstRequirements(withoutBenches, RUN7);
  assert.equal(benchReport.passed, false);
  assert.ok(benchReport.issues.some((issue) => issue.code === 'seating-missing'));
  assert.ok(benchReport.issues.some((issue) => issue.code === 'bench-missing'));

  const withoutCounter = DesignScheme.parse({
    ...REV2,
    interiors: REV2.interiors.map((interior) => ({
      ...interior,
      furnitureSpecs: interior.furnitureSpecs.filter((item) => item.kind !== 'counter'),
    })),
  });
  const counterReport = verifySchemeAgainstRequirements(withoutCounter, RUN7);
  assert.equal(counterReport.passed, false);
  assert.ok(counterReport.issues.some((issue) => issue.code === 'counter-missing'));
});
