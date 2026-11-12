/**
 * 统一 datum 交叉检查：evidence 使用 FloorDatum 的 slabTopY / standingY / gradeY / entryTransition，
 * 不再依赖 BuildSheet 的歧义 floorY。覆盖 run-7 flush、低场地 one-step、floorThickness > 1。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileBuildSpec } from '@pg/interaction/brief';
import { BuildSpec, DesignScheme, deriveFloorDatum, RequirementGraph } from '@pg/interaction/schema';

import { buildBuildSheet } from './build-sheet.ts';
import { deriveEvidenceDatum } from './conformance-shadow.ts';

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

test('run-7 flush：evidence datum 与 FloorDatum / BuildSheet 的站立面一致', () => {
  const spec = compileBuildSpec(SCHEME, REQUIREMENTS);
  const sheet = buildBuildSheet(spec);
  const floor = deriveFloorDatum(SCHEME, REQUIREMENTS);
  const datum = deriveEvidenceDatum(spec, sheet.datum);

  assert.equal(datum.slabTopY, floor.datum.slabTopY);
  assert.equal(datum.standingY, floor.datum.standingY);
  assert.equal(datum.gradeY, floor.datum.gradeY);
  assert.equal(datum.entryTransition, 'flush');
  assert.equal(datum.standingY, sheet.datum.standingY);
  const sheetDatum = sheet.datum as { readonly slabTopY?: number };
  if (sheetDatum.slabTopY !== undefined) assert.equal(datum.slabTopY, sheetDatum.slabTopY);
});

test('低场地 one-step：evidence datum 跟 FloorDatum 走，且 BuildSheet 有 flush-entry 冲突', () => {
  const lowSite = { min: [0, -1, 0], max: [14, 5, 12] } as const;
  const lowScheme = DesignScheme.parse({ ...SCHEME, site: { ...SCHEME.site, bounds: lowSite } });
  const lowSpec = BuildSpec.parse({ ...compileBuildSpec(SCHEME, REQUIREMENTS), siteBounds: lowSite });
  const sheet = buildBuildSheet(lowSpec);
  const floor = deriveFloorDatum(lowScheme, REQUIREMENTS);
  const datum = deriveEvidenceDatum(lowSpec, sheet.datum);

  assert.equal(datum.gradeY, 0);
  assert.equal(datum.standingY, 1);
  assert.equal(datum.entryTransition, 'one-step');
  assert.equal(datum.gradeY, floor.datum.gradeY);
  assert.equal(datum.entryTransition, floor.datum.entryTransition);
  assert.equal(sheet.conflicts.length, 1);
  assert.equal(sheet.conflicts[0]?.kind, 'flush-entry');
});

test('floorThickness > 1：evidence 用 slabTopY，不依赖旧 floorY 别名', () => {
  const thickScheme = DesignScheme.parse({
    ...SCHEME,
    structure: { ...SCHEME.structure, floorThickness: 2 },
  });
  const thickSpec = compileBuildSpec(thickScheme, REQUIREMENTS);
  const sheet = buildBuildSheet(thickSpec);
  const floor = deriveFloorDatum(thickScheme, REQUIREMENTS);
  const datum = deriveEvidenceDatum(thickSpec, sheet.datum);

  assert.equal(datum.standingY, 1);
  assert.equal(datum.floorThickness, 2);
  assert.equal(datum.slabTopY, -1);
  assert.equal(datum.slabTopY, floor.datum.slabTopY);
  const sheetDatum = sheet.datum as { readonly slabTopY?: number };
  if (sheetDatum.slabTopY !== undefined) assert.equal(datum.slabTopY, sheetDatum.slabTopY);
  assert.equal(datum.standingY - datum.floorThickness, datum.slabTopY);
});
