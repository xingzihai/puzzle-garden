/**
 * example-controls.ts 的单元测试：样例 / 版本 / 楼层选项、接口 URL、曲率换算与文案、本地结构差异。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Element, LatheProfile, Level, Space } from '@pg/design/schema';

import {
  applyCurvature,
  blueprintsUrl,
  curveFormula,
  curveInfoText,
  curvatureEditable,
  defaultVariant,
  EXAMPLE_OPTIONS,
  exampleIdOf,
  levelOptions,
  localDiffOf,
  reportUrl,
  variantsOf,
  viewDefaults,
} from './example-controls.ts';
import type { ViewerBlueprint } from './scene.ts';

const LINEAR: LatheProfile = { kind: 'linear', curvature: 0, heightSegments: 24, radialSegments: 48 };
const RECIPROCAL: LatheProfile = { kind: 'reciprocal', curvature: 2, heightSegments: 24, radialSegments: 48 };

function roofElement(profile: LatheProfile = LINEAR): Element {
  return {
    id: 'roof-profile',
    name: '旋转壳屋面',
    level: 'roof',
    kind: 'slab',
    bounds: { min: [-16, 12, -16], max: [16, 36, 16] },
    color: '#aabbcc',
    shape: 'lathe',
    direction: 1,
    profile,
  };
}

function levels(): readonly Level[] {
  return [
    { id: 'surface', name: '街面', elevation: 0 },
    { id: 'roof', name: '屋面壳基', elevation: 12 },
  ];
}

function roomSpace(): Space {
  return {
    id: 'sp-room',
    name: '圆厅',
    level: 'surface',
    bounds: { min: [-16, 0, -16], max: [16, 12, 16] },
    role: 'room',
    color: '#ddeeff',
  };
}

function roofBlueprint(profile: LatheProfile): ViewerBlueprint {
  return {
    id: 'bp-roof-lathe',
    title: '圆厅旋转壳屋面',
    description: '单测',
    levels: levels(),
    spaces: [roomSpace()],
    elements: [roofElement(profile)],
    notes: ['说明'],
  };
}

test('exampleIdOf：已知样例返回原值，未知值抛错', () => {
  assert.equal(exampleIdOf('plaza'), 'plaza');
  assert.equal(exampleIdOf('roof'), 'roof');
  assert.throws(() => exampleIdOf('tower'), /未知样例：tower/);
  assert.deepEqual(
    EXAMPLE_OPTIONS.map((option) => option.id),
    ['plaza', 'roof'],
  );
});

test('variantsOf / defaultVariant：plaza 旧三版、roof 三版 profile', () => {
  assert.deepEqual(
    variantsOf('plaza').map((option) => option.id),
    ['base', 'wider-shop', 'wider-cinema'],
  );
  assert.deepEqual(
    variantsOf('roof').map((option) => option.id),
    ['cone', 'reciprocal', 'curved'],
  );
  const labels = variantsOf('roof').map((option) => option.label);
  assert.ok(
    labels.some((label) => label.includes('圆锥')),
    JSON.stringify(labels),
  );
  assert.ok(
    labels.some((label) => label.includes('反比例 k=2')),
    JSON.stringify(labels),
  );
  assert.ok(
    labels.some((label) => label.includes('更收分 k=6')),
    JSON.stringify(labels),
  );
  assert.equal(defaultVariant('plaza'), 'base');
  assert.equal(defaultVariant('roof'), 'cone');
});

test('viewDefaults：roof 默认显示地表、全部楼层；plaza 默认隐藏地表', () => {
  assert.deepEqual(viewDefaults('roof'), { level: 'all', showSurface: true, spaces: true });
  assert.deepEqual(viewDefaults('plaza'), { level: 'all', showSurface: false, spaces: true });
  assert.equal(curvatureEditable('roof'), true);
  assert.equal(curvatureEditable('plaza'), false);
});

test('接口 URL：plaza 不带 example，roof 明确带 example=roof', () => {
  assert.equal(blueprintsUrl('plaza'), '/api/blueprints');
  assert.equal(blueprintsUrl('roof'), '/api/blueprints?example=roof');
  assert.equal(reportUrl('plaza', 'base'), '/api/report?variant=base');
  assert.equal(reportUrl('roof', 'cone'), '/api/report?example=roof&variant=cone');
  assert.equal(reportUrl('roof', 'reciprocal'), '/api/report?example=roof&variant=reciprocal');
});

test('applyCurvature：k=0 派生 linear，k≥1 派生 reciprocal，分段数保持', () => {
  assert.deepEqual(applyCurvature(RECIPROCAL, 0), { ...LINEAR });
  assert.deepEqual(applyCurvature(LINEAR, 3), { ...RECIPROCAL, curvature: 3 });
  assert.deepEqual(applyCurvature(RECIPROCAL, 20), { ...RECIPROCAL, curvature: 20 });
  assert.throws(() => applyCurvature(LINEAR, -1), /0–20 的整数/);
  assert.throws(() => applyCurvature(LINEAR, 21), /0–20 的整数/);
  assert.throws(() => applyCurvature(LINEAR, 1.5), /0–20 的整数/);
});

test('curveFormula / curveInfoText：显示实际公式与 R / H / k / 底顶', () => {
  assert.equal(curveFormula('linear'), 'r(t)=R·(1−t)');
  assert.equal(curveFormula('reciprocal'), 'r(t)=R·(1−t)/(1+k·t)');
  const reverse = curveInfoText(roofElement(RECIPROCAL));
  assert.ok(reverse.includes('r(t)=R·(1−t)/(1+k·t)'), reverse);
  assert.ok(reverse.includes('R=16'), reverse);
  assert.ok(reverse.includes('H=24'), reverse);
  assert.ok(reverse.includes('k=2'), reverse);
  assert.ok(reverse.includes('底 y=12'), reverse);
  assert.ok(reverse.includes('顶 y=36'), reverse);
  const linear = curveInfoText(roofElement(LINEAR));
  assert.ok(linear.includes('r(t)=R·(1−t)'), linear);
  assert.ok(linear.includes('k=0'), linear);
});

test('levelOptions：all 补语区分地上 / 地下，其余用实际楼层 id 与名称', () => {
  assert.deepEqual(levelOptions('roof', levels()), [
    { id: 'all', label: '全部（地上）' },
    { id: 'surface', label: 'surface（街面）' },
    { id: 'roof', label: 'roof（屋面壳基）' },
  ]);
  assert.equal(levelOptions('plaza', levels())[0]?.label, '全部（地下）');
});

test('localDiffOf：曲率变化只把 roof-profile 记为修改，profile 显示实际', () => {
  const base = roofBlueprint(LINEAR);
  const target: ViewerBlueprint = { ...base, elements: [roofElement({ ...LINEAR, curvature: 0, kind: 'linear' })] };
  assert.deepEqual(localDiffOf(base, base), { added: [], removed: [], changed: [], spacesChanged: [] });
  // 改 profile 的 kind / curvature：只有屋面元素变化，空间不动。
  const modified: ViewerBlueprint = { ...base, elements: [roofElement(RECIPROCAL)] };
  assert.deepEqual(localDiffOf(base, modified), {
    added: [],
    removed: [],
    changed: ['roof-profile'],
    spacesChanged: [],
  });
  assert.deepEqual(localDiffOf(base, target).changed, []);
});

test('localDiffOf：新增 / 删除元素与空间变化都按 id 报出', () => {
  const base = roofBlueprint(LINEAR);
  const extra: Element = { ...roofElement(LINEAR), id: 'extra', name: '附加' };
  const added: ViewerBlueprint = { ...base, elements: [roofElement(LINEAR), extra] };
  assert.deepEqual(localDiffOf(base, added).added, ['extra']);
  assert.deepEqual(localDiffOf(added, base).removed, ['extra']);
  const moved: ViewerBlueprint = {
    ...base,
    spaces: [{ ...roomSpace(), bounds: { min: [-16, 0, -16], max: [18, 12, 16] } }],
  };
  assert.deepEqual(localDiffOf(base, moved).spacesChanged, ['sp-room']);
});
