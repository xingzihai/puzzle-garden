/**
 * 语义茶亭 golden：用 run-9 v2 的 BuildSpec + buildBuildSheet，以 floorPlate / walls / opening / roof
 * 四类高层调用复现 10×8 茶亭，核对返回的 `.bounds` 与 BuildSheet（半开），并验证 1 格挑檐不再触发 structureSpans。
 *
 * 只读 fixture，离线；不跑 checker、不读 .work、不调用模型。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { ReachReport } from '@pg/analysis/reach';
import type { ReachTargets } from '@pg/analysis/reach-targets';
import { loadRegistry } from '@pg/blocks/load';
import type { Bounds, Grid } from '@pg/core/grid';
import { createWorld, rect } from '@pg/geometry';
import { BuildSpec } from '@pg/interaction/schema';

import { evaluateGates } from '../packages/agent/src/gates.ts';
import type { GateInput } from '../packages/agent/src/gates.ts';
import { buildBuildSheet } from './build-sheet.ts';
import type { BuildSheet, BuildSheetObject } from './build-sheet.ts';

const registry = loadRegistry();
const SPEC = BuildSpec.parse(
  JSON.parse(
    readFileSync(new URL('./fixtures/conformance-run9-v2/build-spec.json', import.meta.url), 'utf8'),
  ) as unknown,
);
const SHEET = buildBuildSheet(SPEC);

/** BuildSheet 的 bounds 是半开 [min,max)；world 句柄 bounds 是占用格闭区间，max +1 后才同口径。 */
function halfOpen(bounds: Bounds): Bounds {
  return {
    min: [bounds.min[0], bounds.min[1], bounds.min[2]],
    max: [bounds.max[0] + 1, bounds.max[1] + 1, bounds.max[2] + 1],
  };
}

function objectById(sheet: BuildSheet, id: string): BuildSheetObject {
  const object = sheet.objects.find((item) => item.id === id);
  if (object === undefined) throw new Error(`missing BuildSheet object ${id}`);
  return object;
}

interface Handle {
  readonly bounds: Bounds;
}

interface TeaHouse {
  readonly grid: Grid;
  readonly floor: Handle;
  readonly hall: Handle;
  readonly door: Handle;
  readonly win: Handle;
  readonly roof: Handle & { readonly peak: readonly [number, number, number] };
}

/** 10×8（或 12×8）茶亭：rect 的 max 是最后一格，所以 10 宽是 x2..11。ridge=null 时只用 pitch。 */
function buildTeaHouse(width = 10, ridge: number | null = 7): TeaHouse {
  const host = createWorld(registry.table);
  const w = host.world;
  const footprint = rect(2, 2, 2 + width - 1, 9);
  const floor = w.floorPlate({ footprint, y: 0, thickness: 1, material: 'polished_andesite' });
  const hall = w.walls({ footprint, y: 1, height: 4, thickness: 1, material: 'oak_planks' });
  const door = w.opening({ in: hall.facade('north'), kind: 'door', width: 2, height: 2, sill: 0, at: -3 });
  const win = w.opening({
    in: hall.facade('south'),
    kind: 'window',
    width: 4,
    height: 2,
    sill: 1,
    fill: 'glass',
    at: 0,
  });
  const roof =
    ridge === null
      ? w.roof({
          on: hall,
          kind: 'gable',
          ridge: 'x',
          pitch: 0.5,
          overhang: 1,
          thickness: 1,
          material: 'deepslate_tiles',
        })
      : w.roof({
          on: hall,
          kind: 'gable',
          ridge: 'x',
          peakY: ridge,
          overhang: 1,
          thickness: 1,
          material: 'deepslate_tiles',
        });
  return { grid: host.compose().grid, floor, hall, door, win, roof };
}

const noReach: ReachReport = {
  standable: 0,
  reached: 0,
  maxReachedY: undefined,
  maxStandableY: undefined,
  targets: [],
  blockers: [],
};
const noTargets: ReachTargets = { targets: [], missing: [], skipped: [] };

function gateInput(grid: Grid): GateInput {
  return { grid, calls: grid.calls(), symmetry: { axes: [] }, reach: noReach, reachTargets: noTargets, registry };
}

describe('语义茶亭 golden：BuildSheet → 四类高层调用', () => {
  const tea = buildTeaHouse();

  it('slab / wall / door / window 的返回 bounds 与 BuildSheet 半开 bounds 一致', () => {
    assert.deepEqual(halfOpen(tea.floor.bounds), objectById(SHEET, 'slab:f1').bounds);
    assert.deepEqual(halfOpen(tea.hall.bounds), objectById(SHEET, 'wall:f1').bounds);
    assert.deepEqual(halfOpen(tea.door.bounds), objectById(SHEET, 'opening:op-entry-north').bounds);
    assert.deepEqual(halfOpen(tea.win.bounds), objectById(SHEET, 'opening:op-south-window').bounds);
  });

  it('roof 的返回 bounds 与 BuildSheet 完全一致（peakY 对齐 ridge y7）', () => {
    const expected = objectById(SHEET, 'roof');
    assert.equal(expected.kind, 'roof');
    assert.deepEqual(halfOpen(tea.roof.bounds), expected.bounds);
    assert.equal(tea.roof.peak[1], 7);
  });

  it('pitch-only：0.5 只能到脊 6，与 BuildSheet ridge7 差 1 格；规则要求报告冲突或用 peakY', () => {
    const expected = objectById(SHEET, 'roof');
    assert.equal(expected.kind, 'roof');
    const pitchOnly = buildTeaHouse(10, null);
    assert.equal(pitchOnly.roof.peak[1], 6);
    assert.equal(expected.ridgeY, 7);
    assert.notEqual(pitchOnly.roof.peak[1], expected.ridgeY);
    const exact = buildTeaHouse(10, expected.ridgeY);
    assert.equal(exact.roof.peak[1], expected.ridgeY);
    assert.deepEqual(halfOpen(exact.roof.bounds), expected.bounds);
  });

  it('10×8 footprint + 1 格挑檐通过 structureSpans x[1,10] z[1,8]（挑檐不计入跨度）', () => {
    assert.deepEqual(evaluateGates({ structureSpans: { x: [1, 10], z: [1, 8] } }, gateInput(tea.grid)), {
      passed: true,
      failed: [],
    });
  });

  it('12 宽变体 + 1 格挑檐：structureSpans 只在 x 轴失败', () => {
    const wide = buildTeaHouse(12);
    assert.deepEqual(evaluateGates({ structureSpans: { x: [1, 10], z: [1, 8] } }, gateInput(wide.grid)).failed, [
      '结构跨度：x 12 不在 1–10',
    ]);
  });
});
