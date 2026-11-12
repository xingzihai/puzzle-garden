import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileBuildSpec } from '@pg/interaction/brief';
import { isFlushMustText } from '@pg/interaction/flush-text';
import { compileDesignReport } from '@pg/interaction/report';
import { BuildSpec, DesignScheme, deriveFloorDatum, RequirementGraph } from '@pg/interaction/schema';

import { buildBuildSheet } from './build-sheet.ts';
import { buildFixture } from './conformance-matrix-fixtures.ts';

const REQUIREMENTS = RequirementGraph.parse(
  JSON.parse(
    readFileSync(new URL('../packages/interaction/fixtures/run7-requirements.json', import.meta.url), 'utf8'),
  ) as unknown,
);
const SCHEME = DesignScheme.parse(
  JSON.parse(
    readFileSync(new URL('../packages/interaction/fixtures/run7-rev2-scheme.json', import.meta.url), 'utf8'),
  ) as unknown,
);

test('FloorDatum 与 BuildSheet 同一 run-7 方案：site top y1 → 都是 flush / 无冲突', () => {
  const sheet = buildBuildSheet(compileBuildSpec(SCHEME, REQUIREMENTS));
  const datum = deriveFloorDatum(SCHEME, REQUIREMENTS);

  assert.equal(sheet.conflicts.length, 0);
  assert.equal(datum.conflict, null);
  assert.equal(datum.datum.gradeY, sheet.datum.gradeY);
  assert.equal(datum.datum.standingY, sheet.datum.standingY);
  assert.equal(datum.datum.slabTopY, sheet.datum.slabTopY);
  assert.equal(datum.datum.entryThresholdY, sheet.datum.entryThresholdY);
  assert.equal(datum.datum.entryTransition, 'flush');
  assert.equal(sheet.datum.source, datum.datum.source);
  assert.equal(sheet.datum.targetGradeY, null);
  // run-7 rev2 确实有 flush must；site top y1 已齐平，不能误报。
  assert.ok(sheet.musts.some((must) => isFlushMustText(must.text)));
});

test('声明侧只有窗：Design / BuildSheet 都回退北侧非窗门，窗口绝不当入口', () => {
  const scheme = DesignScheme.parse({
    ...SCHEME,
    site: { ...SCHEME.site, entranceSide: 'south' },
  });
  const spec = compileBuildSpec(scheme, REQUIREMENTS);
  assert.equal(spec.entranceSide, 'south');
  const sheet = buildBuildSheet(spec);
  const datum = deriveFloorDatum(scheme, REQUIREMENTS);

  assert.equal(sheet.datum.entryThresholdY, 1);
  assert.equal(datum.datum.entryThresholdY, 1);
  assert.equal(datum.datum.entryTransition, 'flush');
  assert.equal(sheet.datum.entryThresholdY, datum.datum.entryThresholdY);
  assert.ok(sheet.datum.doors.some((door) => door.id === 'op-entry-north'));
  assert.deepEqual(sheet.datum.doors, datum.datum.doors);
});

test('额外同侧 / 非入口侧非窗门：Design 与 BuildSheet 的 doors 都列全部非窗洞口', () => {
  const northDoor = SCHEME.openings.find((opening) => opening.id === 'op-entry-north');
  const southWindow = SCHEME.openings.find((opening) => opening.id === 'op-south-window');
  assert.ok(northDoor !== undefined);
  assert.ok(southWindow !== undefined);
  const extraNorth = {
    ...northDoor,
    id: 'op-entry-north-2',
    bounds: { min: [6, 1, 2] as const, max: [8, 3, 3] as const },
  };
  const extraSouth = {
    ...northDoor,
    id: 'op-south-door',
    name: '南侧次入口',
    host: southWindow.host,
    side: 'south' as const,
    bounds: { min: [6, 1, 9] as const, max: [8, 3, 10] as const },
  };
  const scheme = DesignScheme.parse({
    ...SCHEME,
    openings: [...SCHEME.openings, extraNorth, extraSouth],
  });
  const spec = compileBuildSpec(scheme, REQUIREMENTS);
  const sheet = buildBuildSheet(spec);
  const datum = deriveFloorDatum(scheme, REQUIREMENTS);

  assert.deepEqual(
    datum.datum.doors.map((door) => door.id),
    ['op-entry-north', 'op-entry-north-2', 'op-south-door'],
  );
  assert.deepEqual(sheet.datum.doors, datum.datum.doors);
  assert.equal(sheet.datum.entryThresholdY, 1);
  assert.equal(datum.datum.entryThresholdY, 1);
});

test('报告 / FloorDatum / BuildSheet 共用 slabTopY / standingY / gradeY，无 floorY 别名', () => {
  const sheet = buildBuildSheet(compileBuildSpec(SCHEME, REQUIREMENTS));
  const datum = deriveFloorDatum(SCHEME, REQUIREMENTS);
  const report = compileDesignReport(SCHEME, REQUIREMENTS);

  assert.equal(datum.datum.slabTopY + SCHEME.structure.floorThickness, datum.datum.standingY);
  assert.equal(sheet.datum.slabTopY + SCHEME.structure.floorThickness, sheet.datum.standingY);
  assert.equal(sheet.datum.standingY, datum.datum.standingY);
  assert.equal(sheet.datum.gradeY, datum.datum.gradeY);
  assert.equal(Object.hasOwn(sheet.datum, 'floorY'), false);
  assert.equal(Object.hasOwn(datum.datum, 'floorY'), false);
  assert.ok(report.includes('standingY'));
  assert.ok(report.includes('slabTopY'));
  assert.ok(report.includes('gradeY'));
  assert.ok(!report.includes('floorY'));
});

test('FloorDatum 与 BuildSheet 同一低场地：site top y0 → 都是一格冲突', () => {
  const lowSite = { min: [0, -1, 0], max: [14, 5, 12] } as const;
  const lowScheme = DesignScheme.parse({
    ...SCHEME,
    site: { ...SCHEME.site, bounds: lowSite },
  });
  const lowSpec = BuildSpec.parse({
    ...compileBuildSpec(SCHEME, REQUIREMENTS),
    siteBounds: lowSite,
  });
  const sheet = buildBuildSheet(lowSpec);
  const datum = deriveFloorDatum(lowScheme, REQUIREMENTS);

  assert.equal(sheet.conflicts.length, 1);
  assert.ok(datum.conflict);
  assert.equal(datum.conflict.id, sheet.conflicts[0]?.id);
  assert.deepEqual(datum.conflict.mustIds, sheet.conflicts[0]?.mustIds);
  assert.equal(datum.conflict.targetGradeY, sheet.conflicts[0]?.targetGradeY);
  assert.deepEqual(datum.conflict.options, sheet.conflicts[0]?.options);
  assert.equal(datum.datum.gradeY, sheet.datum.gradeY);
  assert.equal(sheet.datum.gradeY, 0);
  assert.equal(datum.datum.standingY, sheet.datum.standingY);
  assert.equal(datum.datum.standingY, 1);
  assert.equal(datum.datum.entryTransition, 'one-step');
  assert.equal(sheet.datum.entryTransition, 'one-step');
  assert.equal(sheet.datum.targetGradeY, 1);
});

test('H1 低场地 + 唯一 flush 文本 must：恰好一个 conflict，target=standingY=1', () => {
  const fixture = buildFixture('H1', 'good');
  const low = BuildSpec.parse({
    ...fixture.spec,
    siteBounds: {
      min: [fixture.spec.siteBounds.min[0], -1, fixture.spec.siteBounds.min[2]],
      max: [fixture.spec.siteBounds.max[0], 0, fixture.spec.siteBounds.max[2]],
    },
    musts: [{ id: 'must-flush-entry', text: '入口与村道齐平', source: 'constraint' }],
    counts: { ...fixture.spec.counts, musts: 1 },
  });
  const sheet = buildBuildSheet(low);

  assert.equal(sheet.conflicts.length, 1);
  const conflict = sheet.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.id, 'conflict-flush-entry');
  assert.deepEqual(conflict.mustIds, ['must-flush-entry']);
  assert.equal(sheet.datum.standingY, 1);
  assert.equal(sheet.datum.gradeY, 0);
  assert.equal(sheet.datum.entryTransition, 'one-step');
  assert.equal(conflict.targetGradeY, 1);
  assert.equal(conflict.recommendedSource, 'raise-site');
  assert.equal(conflict.options.length, 4);
});

test('must id 含 flush 但文本不匹配：不推断冲突', () => {
  const fixture = buildFixture('H1', 'good');
  const noFlushText = BuildSpec.parse({
    ...fixture.spec,
    siteBounds: {
      min: [fixture.spec.siteBounds.min[0], -1, fixture.spec.siteBounds.min[2]],
      max: [fixture.spec.siteBounds.max[0], 0, fixture.spec.siteBounds.max[2]],
    },
    musts: [{ id: 'must-flush-entry', text: '入口保持现状，不做改动', source: 'constraint' }],
    counts: { ...fixture.spec.counts, musts: 1 },
  });
  assert.equal(buildBuildSheet(noFlushText).conflicts.length, 0);
});

test('BuildSpec.entranceSide（Design 新增字段）优先选择对应侧入口', () => {
  const fixture = buildFixture('H1', 'good');
  const northDoor = fixture.spec.openings.find((opening) => opening.kind !== 'window');
  assert.ok(northDoor !== undefined);
  const southDoor = {
    ...northDoor,
    id: 'op-south-door',
    side: 'south' as const,
    bounds: { min: [3, 2, 8] as const, max: [5, 4, 9] as const },
    sillHeight: 1,
    headHeight: 3,
  };
  const spec = {
    ...fixture.spec,
    entranceSide: 'south' as const,
    openings: [...fixture.spec.openings, southDoor],
  } as unknown as BuildSpec;
  const sheet = buildBuildSheet(spec);
  assert.equal(sheet.datum.entryThresholdY, 2);
});

test('FloorDatum 与 BuildSheet 同一 floorThickness=2：slabTop 下移一格，expected slab 同步', () => {
  const thickScheme = DesignScheme.parse({
    ...SCHEME,
    structure: { ...SCHEME.structure, floorThickness: 2 },
  });
  const thickSpec = compileBuildSpec(thickScheme, REQUIREMENTS);
  const sheet = buildBuildSheet(thickSpec);
  const datum = deriveFloorDatum(thickScheme, REQUIREMENTS);

  assert.equal(thickSpec.structure.floorThickness, 2);
  assert.equal(datum.datum.slabTopY, -1);
  assert.equal(sheet.datum.slabTopY, -1);
  assert.equal(sheet.datum.standingY, 1);
  assert.equal(datum.datum.slabTopY + thickSpec.structure.floorThickness, datum.datum.standingY);
  assert.equal(sheet.datum.slabTopY + thickSpec.structure.floorThickness, sheet.datum.standingY);
  assert.equal(Object.hasOwn(datum.datum, 'floorY'), false);
  assert.equal(Object.hasOwn(sheet.datum, 'floorY'), false);
  const slab = sheet.objects.find((object) => object.id === 'slab:f1');
  assert.ok(slab !== undefined);
  assert.equal(slab.bounds.min[1], -1);
  assert.equal(slab.bounds.max[1], 1);
  const expectedSlab = sheet.expectedObjects.find((object) => object.id === 'slab:f1');
  assert.ok(expectedSlab !== undefined);
  assert.deepEqual(expectedSlab.bounds, slab.bounds);
});
