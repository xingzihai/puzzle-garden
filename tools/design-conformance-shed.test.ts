/**
 * 单坡 / 双坡 form 分类回归：从零构造 Grid + BuildSpec，不读取 .work / run-9。
 *
 * 覆盖：
 * - ascending shed [5,5,6,6,6,7] → shed / eave 5 / ridge 7 / 21.8°
 * - descending shed [7,6,6,6,5,5] → shed / eave 5 / ridge 7 / 21.8°
 * - 非对称 gable（H2 good profile）仍是 gable
 * - flat 仍是 flat
 * - 2 格脊线仍是 stepped（与 run-9 现有回归测试同口径，单独合成，不改现有测试）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Grid } from '@pg/core/grid';
import { BuildSpec } from '@pg/interaction/schema';
import type { Bounds, RoofForm } from '@pg/interaction/schema';

import { evaluateRoof } from './design-conformance.ts';

const LEVEL = 'f1';
const ELEVATION = 1;
const ROOF_BASE = 5;
const ROOF_BLOCK = 'deepslate_tiles';

function box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Bounds {
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

interface RoofSpecInput {
  readonly form: RoofForm;
  readonly pitchDegrees: number;
  readonly eaveHeight: number;
  readonly ridgeHeight: number;
}

function makeSpec(roof: RoofSpecInput): BuildSpec {
  return BuildSpec.parse({
    schemeId: 'shed-regression',
    schemeRevision: 1,
    title: '单坡分类回归',
    scope: 'exterior+entry',
    bounds: box(1, ELEVATION, 1, 11, 8, 9),
    siteBounds: box(0, 0, 0, 12, 9, 10),
    levels: [{ id: LEVEL, name: '地面层', elevation: ELEVATION, height: 4 }],
    spaces: [],
    elements: [],
    openings: [],
    routes: [],
    structure: {
      system: 'load-bearing-walls',
      material: 'm-wall',
      spanX: 10,
      spanZ: 8,
      floorThickness: 1,
      cantilever: 0,
      notes: null,
    },
    roof: {
      form: roof.form,
      material: 'm-roof',
      pitchDegrees: roof.pitchDegrees,
      eaveHeight: roof.eaveHeight,
      ridgeHeight: roof.ridgeHeight,
      overhang: 0,
      drainage: null,
      skylights: [],
      notes: null,
    },
    facades: [],
    materials: [
      { id: 'm-wall', name: '墙体', block: 'stone_bricks', role: 'wall', color: null, notes: null },
      { id: 'm-roof', name: '屋面', block: ROOF_BLOCK, role: 'roof', color: null, notes: null },
    ],
    details: [],
    interiors: [],
    counts: {
      levels: 1,
      spaces: 0,
      elements: 0,
      openings: 0,
      routes: 0,
      musts: 0,
      footprintX: 10,
      footprintZ: 8,
      footprintAreaM2: 80,
    },
    budget: { maxBlocks: 10_000, targetBlocks: null, estimatedBlocks: null, maxCostCny: null },
    forbidden: [],
    musts: [],
  });
}

/** 沿 axis 的每个 coord 放一列屋面，cross 轴方向铺满 [crossFirst, crossLast]。 */
function roofGrid(heights: readonly number[], axis: 'x' | 'z', crossFirst: number, crossLast: number): Grid {
  const registry = loadRegistry();
  const grid = createGrid(registry.table);
  const state = parseState(registry.table, ROOF_BLOCK);
  const call = grid.defineCall('set', 1, { fixture: 'shed-regression' });
  for (let index = 0; index < heights.length; index += 1) {
    const coord = index + 1;
    const top = heights[index] ?? ROOF_BASE;
    for (let cross = crossFirst; cross <= crossLast; cross += 1) {
      const x = axis === 'x' ? coord : cross;
      const z = axis === 'z' ? coord : cross;
      for (let y = ROOF_BASE; y <= top; y += 1) grid.set(x, y, z, state, 0, call);
    }
  }
  return grid;
}

function evaluate(
  roof: RoofSpecInput,
  heights: readonly number[],
  axis: 'x' | 'z',
  crossFirst = 1,
  crossLast = 8,
): ReturnType<typeof evaluateRoof> {
  const spec = makeSpec(roof);
  return evaluateRoof(spec, roofGrid(heights, axis, crossFirst, crossLast));
}

function assertAllRoofChecksPass(result: ReturnType<typeof evaluateRoof>): void {
  for (const check of result.checks) {
    assert.equal(check.status, 'pass', `${check.id}: ${check.detail}`);
  }
}

test('ascending shed [5,5,6,6,6,7] 判为 shed，eave 5 / ridge 7 / 21.8°', () => {
  const result = evaluate({ form: 'shed', pitchDegrees: 22, eaveHeight: 5, ridgeHeight: 7 }, [5, 5, 6, 6, 6, 7], 'z');
  assert.equal(result.actual.form, 'shed');
  assert.equal(result.actual.eaveHeight, 5);
  assert.equal(result.actual.ridgeHeight, 7);
  assert.equal(result.actual.pitchDegrees, 21.8);
  assertAllRoofChecksPass(result);
});

test('descending shed [7,6,6,6,5,5] 判为 shed，eave 5 / ridge 7 / 21.8°', () => {
  const result = evaluate({ form: 'shed', pitchDegrees: 22, eaveHeight: 5, ridgeHeight: 7 }, [7, 6, 6, 6, 5, 5], 'z');
  assert.equal(result.actual.form, 'shed');
  assert.equal(result.actual.eaveHeight, 5);
  assert.equal(result.actual.ridgeHeight, 7);
  assert.equal(result.actual.pitchDegrees, 21.8);
  assertAllRoofChecksPass(result);
});

test('非对称双坡 [5,5,6,6,7,6,6,5,5,5] 仍是 gable', () => {
  const result = evaluate(
    { form: 'gable', pitchDegrees: 25, eaveHeight: 5, ridgeHeight: 7 },
    [5, 5, 6, 6, 7, 6, 6, 5, 5, 5],
    'x',
    1,
    8,
  );
  assert.equal(result.actual.form, 'gable');
  assert.equal(result.actual.eaveHeight, 5);
  assert.equal(result.actual.ridgeHeight, 7);
  assert.equal(result.actual.pitchDegrees, 24.2);
  assertAllRoofChecksPass(result);
});

test('flat 仍是 flat，eave = ridge = 5，pitch 0', () => {
  const result = evaluate({ form: 'flat', pitchDegrees: 0, eaveHeight: 5, ridgeHeight: 5 }, [5, 5, 5, 5, 5, 5], 'z');
  assert.equal(result.actual.form, 'flat');
  assert.equal(result.actual.eaveHeight, 5);
  assert.equal(result.actual.ridgeHeight, 5);
  assert.equal(result.actual.pitchDegrees, 0);
  assertAllRoofChecksPass(result);
});

test('2 格脊线仍是 stepped（不因单坡修复被放宽）', () => {
  const result = evaluate({ form: 'gable', pitchDegrees: 45, eaveHeight: 5, ridgeHeight: 7 }, [5, 6, 7, 7, 6, 5], 'z');
  assert.equal(result.actual.form, 'stepped');
  assert.equal(result.actual.ridgeWidth, 2);
  const form = result.checks.find((check) => check.id === 'roof.form');
  assert.ok(form !== undefined);
  assert.equal(form.status, 'fail');
  assert.equal(form.actual, 'stepped');
  for (const check of result.checks.filter((item) => item.id !== 'roof.form')) {
    assert.equal(check.status, 'pass', `${check.id}: ${check.detail}`);
  }
});
