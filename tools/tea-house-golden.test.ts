/**
 * Golden offline acceptance for the committed 20261022 tea-house BuildSpec.
 *
 * This test builds the building from scratch with `tools/fixtures/tea-house-recipes.ts`
 * (real `@pg/geometry` world API) and replays the same conformance pipeline used by the
 * live run, without reading `.work`, starting Chrome or calling a model.
 *
 * The recipe repairs the construction defects of the first diagnostic build. The must
 * clauses that are qualitative, or that the checkers cannot prove, must stay unverified;
 * the golden never forces a `met` from declarative / unverified evidence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import type { AsBuiltObjectGraph } from '@pg/analysis/as-built';
import { loadRegistry } from '@pg/blocks/load';
import type { Grid } from '@pg/core/grid';

import { buildBuildSheet } from './build-sheet.ts';
import { buildConformanceDiffReport, loadSpec } from './conformance-diff.ts';
import type { ConformanceDiffReport } from './conformance-diff.ts';
import { evaluateCoverage } from './coverage-evidence.ts';
import type { CoverageEvidence } from './coverage-evidence.ts';
import { evaluateRoof } from './design-conformance.ts';
import { buildTeaHouseRecipeGrid } from './fixtures/tea-house-recipes.ts';
import { evaluateMustClauses, flattenClauseLeaves } from './must-clause-evidence.ts';
import type { MustClauseEvaluation, MustClauseEvidence } from '../packages/interaction/src/must-clause.ts';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/live-run-20261022/', import.meta.url));
const SPEC_PATH = join(FIXTURE_DIR, 'build-spec.json');
const REGISTRY = loadRegistry();

const PREVIOUSLY_NOT_MET = [
  'req-single-storey',
  'req-no-partitions',
  'req-no-glass-door',
  'req-long-table',
  'req-bench-north',
  'req-bench-south',
  'req-seats-10',
  'constraint-con-single-storey',
] as const;

const STILL_UNVERIFIED = [
  'req-no-outdoor-zone',
  'req-stone-base',
  'req-wood-wall-column',
  'constraint-con-material-selection',
] as const;

interface Replay {
  readonly spec: ReturnType<typeof loadSpec>['spec'];
  readonly grid: Grid;
  readonly graph: AsBuiltObjectGraph;
  readonly report: ConformanceDiffReport;
  readonly coverage: CoverageEvidence;
  readonly evaluation: MustClauseEvaluation;
}

function replay(): Replay {
  const { spec } = loadSpec(SPEC_PATH);
  const grid = buildTeaHouseRecipeGrid(spec);
  const graph = extractAsBuiltObjects(grid, REGISTRY);
  const report = buildConformanceDiffReport({
    spec,
    grid,
    registry: REGISTRY,
    graph,
    specPath: SPEC_PATH,
    specSha256: '0'.repeat(64),
    archivePath: join(FIXTURE_DIR, 'golden-building.pgar'),
    archiveSha256: '0'.repeat(64),
    archiveBytes: 0,
  });
  const coverage = evaluateCoverage(spec, graph, grid, REGISTRY);
  const evaluation = evaluateMustClauses({ spec, graph, grid, registry: REGISTRY, report, coverage });
  return { spec, grid, graph, report, coverage, evaluation };
}

function required<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, what);
  return value;
}

function groupOf(evaluation: MustClauseEvaluation, mustId: string) {
  return required(
    evaluation.groups.find((group) => group.mustId === mustId),
    `missing must group ${mustId}`,
  );
}

function leafOf(evaluation: MustClauseEvaluation, clauseId: string): MustClauseEvidence {
  return required(
    flattenClauseLeaves(evaluation).find((leaf) => leaf.clauseId === clauseId),
    `missing clause ${clauseId}`,
  );
}

function checkOf(coverage: CoverageEvidence, id: string) {
  return required(
    coverage.checks.find((check) => check.id === id),
    `missing coverage check ${id}`,
  );
}

test('golden tea house: object diff is 5/5 pass with no fail / missing / extra', () => {
  const { report } = replay();
  assert.deepEqual(report.summary, {
    pass: 5,
    fail: 0,
    missing: 0,
    extra: 0,
    unverified: 0,
    blockingCount: 0,
    blocking: false,
    fullyVerified: true,
  });
  assert.deepEqual(report.expected.counts, { wall: 1, slab: 1, roof: 1, opening: 2 });
  for (const item of report.items) {
    assert.equal(item.status, 'pass', `${item.id}: ${item.reason ?? ''}`);
  }
});

test('golden tea house: every furniture diff item passes; 5+5 seats measured', () => {
  const { coverage } = replay();
  assert.equal(coverage.furnitureItems.length, 6);
  for (const item of coverage.furnitureItems) {
    assert.equal(item.status, 'pass', `${item.id}: ${item.reason ?? ''}`);
    assert.deepEqual(item.delta, {}, item.id);
  }
  const seats = checkOf(coverage, 'check:seats:10');
  assert.equal(seats.status, 'pass');
  const actual = seats.actual as { readonly seats?: number; readonly perBench?: Readonly<Record<string, number>> };
  assert.equal(actual.seats, 10);
  assert.deepEqual(actual.perBench, { 'f-bench-north': 5, 'f-bench-south': 5 });
});

test('golden tea house: must summary has no not-met but is not accept-eligible', () => {
  const { evaluation } = replay();
  assert.equal(evaluation.groups.length, 41);
  assert.equal(evaluation.summary.met, 21);
  assert.equal(evaluation.summary.notMet, 0);
  assert.equal(evaluation.summary.unverified, 20);
  assert.deepEqual(evaluation.summary.unattributedHardFails, []);
  assert.deepEqual(evaluation.summary.globalBlockers, []);
  // 20 个 unverified leaf 仍然阻断接受；这里直接锁定门禁输入，不另算 acceptEligible。
});

test('golden tea house: previously not-met musts are met from measured evidence', () => {
  const { evaluation } = replay();
  for (const mustId of PREVIOUSLY_NOT_MET) {
    assert.equal(groupOf(evaluation, mustId).status, 'met', mustId);
  }
});

test('golden tea house: qualitative / unsupported musts stay unverified, never falsely met', () => {
  const { evaluation } = replay();
  for (const mustId of STILL_UNVERIFIED) {
    const group = groupOf(evaluation, mustId);
    assert.equal(group.status, 'unverified', mustId);
    const unverifiedLeaves = group.leaves.filter((leaf) => leaf.status === 'unverified');
    assert.ok(unverifiedLeaves.length > 0, `${mustId} has no unverified leaf`);
    for (const leaf of unverifiedLeaves) {
      assert.equal(typeof leaf.reason, 'string', `${leaf.clauseId} reason type`);
      assert.ok((leaf.reason ?? '').trim().length > 0, `${leaf.clauseId} must carry a reason`);
    }
  }

  // Every qualitative clause is unverified by construction, and no group containing one can
  // be reported as met (otherwise a declarative / unverified fact would leak into `met`).
  const qualitative = flattenClauseLeaves(evaluation).filter((leaf) => leaf.check.kind === 'qualitative');
  assert.ok(qualitative.length > 0);
  for (const leaf of qualitative) {
    assert.equal(leaf.status, 'unverified', leaf.clauseId);
  }
  const qualitativeMusts = new Set(qualitative.map((leaf) => leaf.mustId));
  for (const group of evaluation.groups) {
    if (qualitativeMusts.has(group.mustId)) assert.notEqual(group.status, 'met', group.mustId);
  }

  // Explicit spot checks for the clauses the old build turned not-met / met dishonestly.
  for (const clauseId of [
    'req-no-outdoor-zone#outdoor-zone-compound',
    'req-stone-base#stone-material',
    'req-wood-wall-column#wood-material',
    'req-wood-wall-column#column-checker',
    'constraint-con-material-selection#material-selection',
  ]) {
    const leaf = leafOf(evaluation, clauseId);
    assert.equal(leaf.status, 'unverified', clauseId);
    assert.match(leaf.reason ?? '', /\S/u, clauseId);
  }
});

test('golden tea house: slab is one cell thick, wall material passes, roof diff passes', () => {
  const { spec, grid, graph, report, coverage, evaluation } = replay();
  const slabItem = required(
    report.items.find((item) => item.expectedId === 'slab:f1'),
    'slab diff item',
  );
  assert.equal(slabItem.status, 'pass');
  const slabActual = slabItem.actual as { readonly bounds?: { readonly max?: readonly number[] } } | null;
  assert.equal(slabActual?.bounds?.max?.[1], 1);
  for (const slab of graph.objects.filter((object) => object.kind === 'slab')) {
    assert.equal(slab.slab.thicknessCells, 1, slab.id);
    assert.equal(slab.bounds.max[1], 1, slab.id);
  }

  assert.equal(checkOf(coverage, 'check:material:wall').status, 'pass');
  assert.equal(checkOf(coverage, 'check:material:structure').status, 'pass');
  assert.equal(checkOf(coverage, 'check:material:roof').status, 'pass');
  assert.equal(checkOf(coverage, 'check:material:base').status, 'pass');
  // 模型看到的 BuildSheet 墙材必须就是 checker 期望、配方实际使用的那一种。
  const wallRow = buildBuildSheet(spec).objects.find((object) => object.kind === 'wall');
  assert.ok(wallRow !== undefined);
  assert.equal(wallRow.materialBlock, 'dark_oak_planks');

  const roofItem = required(
    report.items.find((item) => item.expectedId === 'roof'),
    'roof diff item',
  );
  assert.equal(roofItem.status, 'pass');
  assert.equal(Object.hasOwn(roofItem.delta, 'form'), false);

  // Known API detail: the world roof uses an even-span gable, so the apex is two cells wide.
  // The object diff still passes (pitched vs gable), but the design-conformance classifier
  // calls this "stepped"; the form clause must stay unverified rather than be forced to met.
  const roofActual = evaluateRoof(spec, grid).actual;
  if (roofActual.form !== 'gable') {
    assert.equal(roofActual.form, 'stepped');
    assert.equal(roofActual.ridgeWidth, 2);
    const formLeaf = leafOf(evaluation, 'req-gable-tile-roof#roof-form');
    assert.equal(formLeaf.status, 'unverified');
    assert.match(formLeaf.reason ?? '', /form classifier reports stepped/u);
  }

  // No stairs below the eave and no gravel / outdoor decoration blocks.
  assert.equal(
    [...grid.cells()].some((cell) => cell.y < spec.roof.eaveHeight && /stairs?/u.test(cell.state.name)),
    false,
  );
  assert.equal(
    [...grid.cells()].some((cell) => cell.state.name === 'gravel'),
    false,
  );

  // The only ground-level cells outside the wall footprint are the one-cell-deep flush
  // threshold under the entrance; there is no terrace, gravel pad or raised base.
  assert.equal(report.notCompared.site, 1);
  const door = required(
    spec.openings.find((opening) => opening.kind !== 'window' && opening.side === 'north'),
    'north entrance',
  );
  const slabTopY = (spec.levels[0]?.elevation ?? 1) - 1;
  // 检查 y0..站立面（含 y1）的室外格：抬高一格的台阶 / 平台也会被抓住；屋面挑檐从 eave y5 起，不误伤。
  const outsideGround = [...grid.cells()].filter(
    (cell) =>
      cell.y <= slabTopY + 1 &&
      (cell.x < spec.bounds.min[0] ||
        cell.x >= spec.bounds.max[0] ||
        cell.z < spec.bounds.min[2] ||
        cell.z >= spec.bounds.max[2]),
  );
  assert.equal(outsideGround.length, door.width);
  for (const cell of outsideGround) {
    assert.equal(cell.y, slabTopY);
    assert.equal(cell.z, door.bounds.min[2] - 1);
    assert.ok(cell.x >= door.bounds.min[0] && cell.x < door.bounds.max[0], `unexpected x ${String(cell.x)}`);
  }
});

test('golden tea house: original fixture is the committed 41-must spec', () => {
  const bytes = readFileSync(SPEC_PATH);
  assert.ok(bytes.byteLength > 0);
  const { spec } = loadSpec(SPEC_PATH);
  assert.equal(spec.schemeId, 'scheme-draft');
  assert.equal(spec.schemeRevision, 2);
  assert.equal(spec.musts.length, 41);
});
