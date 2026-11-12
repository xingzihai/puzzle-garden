import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleScheme } from './example.ts';
import { planProjection } from './preview-core.ts';
import {
  AREA,
  buildingLabel,
  elementParts,
  elementsOf,
  entranceArrow,
  furniturePlans,
  furnitureShape,
  gridLines,
  levelPlanBounds,
  materialColor,
  openingParts,
  planFileNames,
  routeParts,
  wallParts,
  zoneLabel,
} from './preview-plan-draw.ts';

test('levelPlanBounds 合并建筑、室外空间与家具范围', () => {
  const scheme = exampleScheme();
  const level = scheme.levels[0];
  assert.ok(level !== undefined);
  const bounds = levelPlanBounds(scheme, level);
  assert.ok(bounds.min[0] <= scheme.site.buildingBounds.min[0]);
  assert.ok(bounds.max[0] >= scheme.site.buildingBounds.max[0]);
  assert.ok(bounds.max[2] >= 18);
  assert.ok(Number.isFinite(bounds.max[0]));
});

test('平面绘制件输出墙带、门弧、窗双线、家具与动线箭头', () => {
  const scheme = exampleScheme();
  const level = scheme.levels[0];
  assert.ok(level !== undefined);
  const projection = planProjection(levelPlanBounds(scheme, level), AREA, 2.8);
  const openings = openingParts(scheme, level, projection);
  assert.ok(openings.labels.length >= 3);
  assert.match(openings.svg, /stroke-dasharray/);
  assert.ok((openings.svg.match(/stroke="#527f86"/g) ?? []).length >= 2);
  const furniture = furniturePlans(scheme, level, projection);
  assert.ok(furniture.length >= 5);
  assert.ok(furniture.some((item) => item.kind === 'light'));
  const light = furniture.find((item) => item.kind === 'light');
  assert.ok(light !== undefined);
  assert.match(furnitureShape(light), /<circle/);
  const rug = furniture.find((item) => item.kind === 'rug');
  assert.ok(rug !== undefined);
  assert.match(furnitureShape(rug), /stroke-dasharray="4 3"/);
  assert.match(wallParts(scheme, level, projection), /opacity="0.94"/);
  assert.match(routeParts(scheme, level, projection), /plan-entry-arrow/);
  assert.match(gridLines(projection, levelPlanBounds(scheme, level)), /<line/);
});

test('总平面标签与入口箭头', () => {
  const scheme = exampleScheme();
  const zone = scheme.site.outdoorZones[0];
  assert.ok(zone !== undefined);
  const projection = planProjection(scheme.site.bounds, AREA, 1);
  const rect = projection.rect(zone.bounds);
  const labels = zoneLabel(zone, rect);
  assert.ok(labels.length >= 1);
  const building = buildingLabel(scheme, projection.rect(scheme.site.buildingBounds));
  assert.equal(building[0], '建筑主体');
  const arrow = entranceArrow(scheme, projection, 'test-entry', true);
  assert.equal(arrow.side, '北');
  assert.match(arrow.svg, /marker-end="url\(#test-entry\)"/);
  assert.ok(arrow.label[0] > 0 && arrow.label[1] > 0);
});

test('平面文件名安全、冲突追加序号', () => {
  const scheme = exampleScheme();
  const levels = [...scheme.levels, { ...scheme.levels[0]!, id: 'a/b' }, { ...scheme.levels[0]!, id: 'a-b' }];
  const names = planFileNames(levels);
  assert.equal(names[0], 'plan-lv-ground.svg');
  assert.equal(names[1], 'plan-a-b.svg');
  assert.equal(names[2], 'plan-a-b-3.svg');
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((name) => !name.includes('/')));
});

test('材质色回退与元素绘制不产生 undefined / NaN', () => {
  const scheme = exampleScheme();
  const level = scheme.levels[0];
  assert.ok(level !== undefined);
  const projection = planProjection(levelPlanBounds(scheme, level), AREA, 2.8);
  assert.equal(materialColor(scheme.materials, 'missing', '#123456'), '#123456');
  const parts = `${elementParts(scheme, level, projection)}${String(elementsOf(scheme, level.id).length)}`;
  assert.doesNotMatch(parts, /undefined|NaN/);
});
