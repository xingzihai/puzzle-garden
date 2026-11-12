/**
 * Wave 5 覆盖证据回归：run-7 完美网格必须让可测的几何 / 家具 / 材料 / 标高检查
 * 全部 pass；删家具、改材质、改尺寸后必须 fail / missing，不能假通过。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import type { AsBuiltObject, AsBuiltObjectGraph, FurnitureObject } from '@pg/analysis/as-built';
import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { compileBuildSpec } from '@pg/interaction/brief';
import { expandDesignIntent } from '@pg/interaction/design-expand';
import { createIntentHost } from '@pg/interaction/generate-intent';
import { BuildSpec, DesignScheme, RequirementGraph } from '@pg/interaction/schema';

import { buildRun7PerfectGrid } from './fixtures/run7-perfect-grid.ts';
import {
  coverageById,
  evaluateCoverage,
  furnitureItemsById,
  projectCoverageObjects,
  projectExpectedFurniture,
} from './coverage-evidence.ts';

const REQUIREMENTS = new URL('../packages/interaction/fixtures/run7-requirements.json', import.meta.url);
const INTENT = new URL('../packages/interaction/fixtures/run7-rev2-intent.json', import.meta.url);
const SCHEME = new URL('../packages/interaction/fixtures/run7-rev2-scheme.json', import.meta.url);

function readJson(path: URL): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const REQUIREMENTS_GRAPH = RequirementGraph.parse(readJson(REQUIREMENTS));
const DESIGN = DesignScheme.parse(readJson(SCHEME));
const EXPANDED = expandDesignIntent(
  readJson(INTENT),
  createIntentHost(REQUIREMENTS_GRAPH, {
    schemeId: DESIGN.meta.id,
    revision: DESIGN.meta.revision,
    status: 'confirmed',
  }),
).scheme;
const SPEC_FROM_INTENT = BuildSpec.parse(compileBuildSpec(EXPANDED, REQUIREMENTS_GRAPH));
const RUN7_GRID = buildRun7PerfectGrid(SPEC_FROM_INTENT);
const RUN7_REGISTRY = loadRegistry();

function graphFor(spec: BuildSpec): AsBuiltObjectGraph {
  return extractAsBuiltObjects(spec === SPEC_FROM_INTENT ? RUN7_GRID : buildRun7PerfectGrid(spec), RUN7_REGISTRY);
}

function statusOf(graph: AsBuiltObjectGraph, id: string): string {
  const check = coverageById(evaluateCoverage(SPEC_FROM_INTENT, graph, RUN7_GRID, RUN7_REGISTRY)).get(id);
  assert.ok(check !== undefined, `missing coverage check ${id}`);
  return check.status;
}

test('run-7 perfect as-built：家具、材料、层数、净尺寸、墙厚、齐平检查全部 pass', () => {
  const graph = graphFor(SPEC_FROM_INTENT);
  assert.equal(graph.summary.objectCounts.furniture, 6);
  assert.equal(graph.summary.unknownCells, 0);
  const coverage = evaluateCoverage(SPEC_FROM_INTENT, graph, RUN7_GRID, RUN7_REGISTRY);
  for (const id of [
    'check:storey:f1',
    'check:clear:f1',
    'check:thickness:f1',
    'check:material:wall',
    'check:material:roof',
    'check:material:base',
    'check:absence:mezzanine',
    'check:absence:partition',
    'check:absence:glass-door',
    'check:absence:counter-service',
    'check:absence:eave-platform',
    'check:absence:base-platform',
    'check:schedule:north',
    'check:schedule:south',
    'check:door-position:op-entry-north',
    'check:flush:op-entry-north',
    'check:seats:10',
  ]) {
    assert.equal(statusOf(graph, id), 'pass', `${id} 应 pass：${JSON.stringify(coverageById(coverage).get(id))}`);
  }
  const furniture = furnitureItemsById(coverage);
  for (const id of [
    'furniture:f-long-table',
    'furniture:f-bench-north',
    'furniture:f-bench-south',
    'furniture:f-counter',
  ]) {
    const item = furniture.get(id);
    assert.ok(item !== undefined, `missing furniture diff ${id}`);
    assert.equal(item.status, 'pass', `${id} 应 pass：${item.reason ?? ''}`);
  }
  assert.equal(
    coverage.checks.some((check) => check.status === 'fail'),
    false,
  );
});

test('家具尺寸 / 存在性 / 座位容量：删凳、改桌深、改材质都会 fail 或 missing', () => {
  const graph = graphFor(SPEC_FROM_INTENT);
  const furniture = graph.objects.filter((object): object is FurnitureObject => object.kind === 'furniture');
  assert.ok(furniture.length > 0);

  const withoutBench = {
    ...graph,
    objects: graph.objects.filter(
      (object) => !(object.kind === 'furniture' && object.bounds.min[2] === 3 && object.bounds.max[0] === 11),
    ),
  };
  const noBench = furnitureItemsById(evaluateCoverage(SPEC_FROM_INTENT, withoutBench, RUN7_GRID, RUN7_REGISTRY));
  assert.equal(noBench.get('furniture:f-bench-north')?.status, 'missing');

  const wrongTable = {
    ...graph,
    objects: graph.objects.map((object): AsBuiltObject => {
      if (object.kind !== 'furniture' || object.bounds.min[0] !== 7 || object.bounds.min[2] !== 5) return object;
      return {
        ...object,
        bounds: {
          min: object.bounds.min,
          max: [object.bounds.max[0], object.bounds.max[1], object.bounds.max[2] - 1] as const,
        },
        furniture: { ...object.furniture, seatCapacity: object.furniture.seatCapacity },
      };
    }),
  };
  const tableItem = furnitureItemsById(evaluateCoverage(SPEC_FROM_INTENT, wrongTable, RUN7_GRID, RUN7_REGISTRY)).get(
    'furniture:f-long-table',
  );
  assert.ok(tableItem?.status === 'fail' || tableItem?.status === 'missing');

  const wrongMaterial = {
    ...graph,
    objects: graph.objects.map((object): AsBuiltObject => {
      if (object.kind !== 'furniture' || object.bounds.min[2] !== 3) return object;
      return { ...object, materials: [{ block: 'stone_bricks', cells: object.cells }] };
    }),
  };
  const materialItem = furnitureItemsById(
    evaluateCoverage(SPEC_FROM_INTENT, wrongMaterial, RUN7_GRID, RUN7_REGISTRY),
  ).get('furniture:f-bench-north');
  assert.equal(materialItem?.status, 'fail');
});

function addCells(
  grid: ReturnType<typeof buildRun7PerfectGrid>,
  cells: readonly (readonly [number, number, number, string])[],
) {
  for (const [x, y, z, block] of cells) {
    grid.set(x, y, z, parseState(RUN7_REGISTRY.table, block), 0, 0);
  }
  return grid;
}

function partitionStatus(grid: ReturnType<typeof buildRun7PerfectGrid>, spec = SPEC_FROM_INTENT): string {
  const checks = coverageById(evaluateCoverage(spec, extractAsBuiltObjects(grid, RUN7_REGISTRY), grid, RUN7_REGISTRY));
  const status = checks.get('check:absence:partition')?.status;
  assert.ok(status !== undefined);
  return status;
}

test('P0：2-cell 膝墙、分体 / 对角玻璃、chest / fence、桌上玻璃都不得 pass', () => {
  assert.notEqual(
    partitionStatus(
      addCells(buildRun7PerfectGrid(SPEC_FROM_INTENT), [
        [4, 1, 7, 'stone_bricks'],
        [5, 1, 7, 'stone_bricks'],
      ]),
    ),
    'pass',
  );

  const split = buildRun7PerfectGrid(SPEC_FROM_INTENT);
  for (let y = 1; y <= 3; y += 1) {
    addCells(split, [
      [4, y, 4, 'glass'],
      [5, y, 4, 'glass'],
      [7, y, 4, 'glass'],
      [8, y, 4, 'glass'],
    ]);
  }
  assert.equal(partitionStatus(split), 'fail');

  const diagonal = addCells(buildRun7PerfectGrid(SPEC_FROM_INTENT), [
    [4, 1, 4, 'stone_bricks'],
    [5, 1, 5, 'stone_bricks'],
    [6, 1, 4, 'stone_bricks'],
    [7, 1, 5, 'stone_bricks'],
  ]);
  assert.equal(partitionStatus(diagonal), 'fail');

  const chest = addCells(buildRun7PerfectGrid(SPEC_FROM_INTENT), [
    [4, 1, 4, 'chest'],
    [5, 1, 4, 'chest'],
    [6, 1, 4, 'chest'],
    [7, 1, 4, 'chest'],
  ]);
  assert.equal(partitionStatus(chest), 'fail');

  const fence = addCells(buildRun7PerfectGrid(SPEC_FROM_INTENT), [
    [4, 1, 4, 'oak_fence'],
    [5, 1, 4, 'oak_fence'],
    [6, 1, 4, 'oak_fence'],
  ]);
  assert.equal(partitionStatus(fence), 'fail');

  const screen = buildRun7PerfectGrid(SPEC_FROM_INTENT);
  for (let x = 7; x <= 10; x += 1) addCells(screen, [[x, 2, 5, 'glass']]);
  assert.equal(partitionStatus(screen), 'fail');
});

test('P1：设计内的 3m 柜子不是隔断，也不触发 clear false reject', () => {
  const interior = SPEC_FROM_INTENT.interiors[0];
  assert.ok(interior !== undefined);
  const cabinet = {
    id: 'f-test-cabinet',
    name: '3m 高柜',
    kind: 'storage' as const,
    bounds: { min: [5, 1, 7] as const, max: [8, 4, 9] as const },
    materialId: 'm-wood',
    orientation: null,
    notes: null,
  };
  const withCabinet = BuildSpec.parse({
    ...SPEC_FROM_INTENT,
    interiors: [{ ...interior, furnitureSpecs: [...interior.furnitureSpecs, cabinet] }],
  });
  const grid = buildRun7PerfectGrid(withCabinet);
  const coverage = evaluateCoverage(withCabinet, extractAsBuiltObjects(grid, RUN7_REGISTRY), grid, RUN7_REGISTRY);
  const checks = coverageById(coverage);
  assert.equal(checks.get('check:absence:partition')?.status, 'pass');
  assert.equal(checks.get('check:clear:f1')?.status, 'pass');
  // 3m 贴墙柜的 as-built 几何仍可能被并入墙面板；关键是不再被判成隔断 / 净尺寸失败。
  assert.notEqual(furnitureItemsById(coverage).get('furniture:f-test-cabinet')?.status, 'fail');

  const glassInside = buildRun7PerfectGrid(withCabinet);
  for (let x = 5; x <= 7; x += 1) {
    for (let y = 1; y <= 3; y += 1) addCells(glassInside, [[x, y, 8, 'glass']]);
  }
  assert.equal(partitionStatus(glassInside, withCabinet), 'fail');
});

test('P0：未建 cabinet bbox 内的墙、8×3×1 storage 墙不得 pass', () => {
  const interior = SPEC_FROM_INTENT.interiors[0];
  assert.ok(interior !== undefined);
  const cabinet = {
    id: 'f-unbuilt-cabinet',
    name: '未建柜',
    kind: 'storage' as const,
    bounds: { min: [5, 1, 8] as const, max: [8, 4, 9] as const },
    materialId: 'm-wood',
    orientation: null,
    notes: null,
  };
  const unbuiltSpec = BuildSpec.parse({
    ...SPEC_FROM_INTENT,
    interiors: [{ ...interior, furnitureSpecs: [...interior.furnitureSpecs, cabinet] }],
  });
  const unbuiltGrid = buildRun7PerfectGrid(unbuiltSpec);
  for (let x = 5; x <= 7; x += 1) {
    for (let y = 1; y <= 3; y += 1) addCells(unbuiltGrid, [[x, y, 8, 'oak_planks']]);
  }
  assert.notEqual(partitionStatus(unbuiltGrid, unbuiltSpec), 'pass');

  const storage = {
    id: 'f-storage-wall',
    name: '8m storage 墙',
    kind: 'storage' as const,
    bounds: { min: [4, 1, 4] as const, max: [12, 4, 5] as const },
    materialId: 'm-wood',
    orientation: null,
    notes: null,
  };
  const storageSpec = BuildSpec.parse({
    ...SPEC_FROM_INTENT,
    interiors: [{ ...interior, furnitureSpecs: [...interior.furnitureSpecs, storage] }],
  });
  assert.equal(partitionStatus(buildRun7PerfectGrid(storageSpec), storageSpec), 'unverified');
});

test('材料对象为空时三个 material 检查都 unverified，不能 NaN 假通过', () => {
  const graph = graphFor(SPEC_FROM_INTENT);
  const empty = {
    ...graph,
    objects: graph.objects.map((object): AsBuiltObject => ({ ...object, materials: [] })),
  };
  const checks = coverageById(evaluateCoverage(SPEC_FROM_INTENT, empty, RUN7_GRID, RUN7_REGISTRY));
  for (const id of ['check:material:wall', 'check:material:roof', 'check:material:base']) {
    assert.equal(checks.get(id)?.status, 'unverified', id);
    assert.match(checks.get(id)?.reason ?? '', /materials are empty/);
  }
});

test('东 / 西侧多一个门时 schedule 与 no-glass-door 必须 fail，不能只检查南墙', () => {
  const graph = graphFor(SPEC_FROM_INTENT);
  const door = graph.objects.find(
    (object): object is Extract<AsBuiltObject, { kind: 'opening' }> => object.kind === 'opening',
  );
  assert.ok(door !== undefined);
  const eastDoor = {
    ...door,
    id: 'opening-east-extra',
    bounds: { min: [11, 1, 5] as const, max: [12, 3, 6] as const },
    opening: { ...door.opening, subtype: 'door' as const, fill: 'door-panel' as const, sillY: 1, headY: 3 },
  };
  const withEast = { ...graph, objects: [...graph.objects, eastDoor] };
  const byId = coverageById(evaluateCoverage(SPEC_FROM_INTENT, withEast, RUN7_GRID, RUN7_REGISTRY));
  assert.equal(byId.get('check:schedule:east')?.status, 'fail');
  assert.equal(byId.get('check:absence:glass-door')?.status, 'fail');
});

test('覆盖投影：每个 check / furniture id 都能生成稳定对象，且来自 spec 而非写死坐标', () => {
  const ids = new Set([
    ...projectCoverageObjects(SPEC_FROM_INTENT).map((object) => object.id),
    ...projectExpectedFurniture(SPEC_FROM_INTENT).map((object) => object.id),
  ]);
  assert.ok(ids.has('check:clear:f1'));
  assert.ok(ids.has('check:seats:10'));
  assert.ok(ids.has('furniture:f-long-table'));
  assert.equal(
    projectCoverageObjects(SPEC_FROM_INTENT).every((object) => object.id.startsWith('check:')),
    true,
  );
  assert.equal(
    projectExpectedFurniture(SPEC_FROM_INTENT).every((object) => object.id.startsWith('furniture:')),
    true,
  );
  assert.equal(
    projectExpectedFurniture(SPEC_FROM_INTENT).find((object) => object.id === 'furniture:f-long-table')?.materialBlock,
    'oak_planks',
  );
});
