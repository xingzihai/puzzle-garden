/**
 * Must Clause Evidence 回归：run-7 完美网格、run-9 v2 hard fail 归因，以及
 * slab / 家具 / 窗宽 / 屋面形式 / 方位 / 类型 / 预算的 actual-vs-target acid。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import type { AsBuiltObjectGraph } from '@pg/analysis/as-built';
import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { writeArchive } from '@pg/core/archive';
import { API_VERSION } from '@pg/geometry';
import { compileBuildSpec } from '@pg/interaction/brief';
import { expandDesignIntent } from '@pg/interaction/design-expand';
import { createIntentHost } from '@pg/interaction/generate-intent';
import { BuildSpec, DesignScheme, RequirementGraph } from '@pg/interaction/schema';

import { computeShadowConformance } from './conformance-shadow.ts';
import { buildConformanceDiffReport, loadArchive, loadSpec } from './conformance-diff.ts';
import { evaluateCoverage } from './coverage-evidence.ts';
import { evaluateRoof } from './design-conformance.ts';
import { buildRun7PerfectGrid } from './fixtures/run7-perfect-grid.ts';
import { evaluateMustClauses, flattenClauseLeaves, type MustClauseEvaluationInput } from './must-clause-evidence.ts';
import type { MustClauseEvaluation, MustClauseEvidence } from '../packages/interaction/src/must-clause.ts';

const RUN7_REQUIREMENTS = new URL('../packages/interaction/fixtures/run7-requirements.json', import.meta.url);
const RUN7_INTENT = new URL('../packages/interaction/fixtures/run7-rev2-intent.json', import.meta.url);
const RUN7_SCHEME = new URL('../packages/interaction/fixtures/run7-rev2-scheme.json', import.meta.url);
const RUN9_SPEC_PATH = new URL('./fixtures/conformance-run9-v2/build-spec.json', import.meta.url).pathname;
const RUN9_ARCHIVE_PATH = new URL('./fixtures/conformance-run9-v2/building.pgar', import.meta.url).pathname;
const HARD_FAIL_IDS = ['slab:f1', 'roof', 'opening:op-entry-north', 'opening:op-south-window'] as const;

function readJson(path: URL): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const REQUIREMENTS = RequirementGraph.parse(readJson(RUN7_REQUIREMENTS));
const DESIGN = DesignScheme.parse(readJson(RUN7_SCHEME));
const EXPANDED = expandDesignIntent(
  readJson(RUN7_INTENT),
  createIntentHost(REQUIREMENTS, {
    schemeId: DESIGN.meta.id,
    revision: DESIGN.meta.revision,
    status: 'confirmed',
  }),
).scheme;
const RUN7_SPEC = BuildSpec.parse(compileBuildSpec(EXPANDED, REQUIREMENTS));
const REGISTRY = loadRegistry();

function evaluate(spec: BuildSpec, grid: ReturnType<typeof buildRun7PerfectGrid>): MustClauseEvaluation {
  const graph = extractAsBuiltObjects(grid, REGISTRY);
  const report = buildConformanceDiffReport({
    spec,
    grid,
    registry: REGISTRY,
    graph,
    specPath: 'test-spec.json',
    specSha256: '0'.repeat(64),
    archivePath: 'test-building.pgar',
    archiveSha256: '0'.repeat(64),
    archiveBytes: 0,
  });
  const coverage = evaluateCoverage(spec, graph, grid, REGISTRY);
  const input: MustClauseEvaluationInput = { spec, graph, grid, registry: REGISTRY, report, coverage };
  return evaluateMustClauses(input);
}

function evaluateGraph(
  spec: BuildSpec,
  graph: AsBuiltObjectGraph,
  grid: ReturnType<typeof buildRun7PerfectGrid>,
): MustClauseEvaluation {
  const report = buildConformanceDiffReport({
    spec,
    grid,
    registry: REGISTRY,
    graph,
    specPath: 'test-spec.json',
    specSha256: '0'.repeat(64),
    archivePath: 'test-building.pgar',
    archiveSha256: '0'.repeat(64),
    archiveBytes: 0,
  });
  const coverage = evaluateCoverage(spec, graph, grid, REGISTRY);
  return evaluateMustClauses({ spec, graph, grid, registry: REGISTRY, report, coverage });
}

function leaf(evaluation: MustClauseEvaluation, clauseId: string): MustClauseEvidence {
  for (const group of evaluation.groups) {
    for (const candidate of group.leaves) {
      if (candidate.clauseId === clauseId) return candidate;
    }
  }
  assert.fail(`missing clause ${clauseId}`);
}

function groupStatus(evaluation: MustClauseEvaluation, mustId: string): string {
  const group = evaluation.groups.find((candidate) => candidate.mustId === mustId);
  assert.ok(group !== undefined, `missing must group ${mustId}`);
  return group.status;
}

function hasEvidence(evaluation: MustClauseEvaluation, expectedId: string): boolean {
  const ref = `conformance-diff.json#expected:${expectedId}`;
  return flattenClauseLeaves(evaluation).some(
    (candidate) => candidate.status === 'not-met' && candidate.evidence.some((item) => item.ref === ref),
  );
}

function buildRun9(): {
  readonly spec: BuildSpec;
  readonly grid: ReturnType<typeof loadArchive>['grid'];
  readonly graph: AsBuiltObjectGraph;
  readonly evaluation: MustClauseEvaluation;
} {
  const { spec } = loadSpec(RUN9_SPEC_PATH);
  const { grid } = loadArchive(RUN9_ARCHIVE_PATH, REGISTRY);
  const graph = extractAsBuiltObjects(grid, REGISTRY);
  return { spec, grid, graph, evaluation: evaluate(spec, grid) };
}

function cloneRun7(overrides: Partial<BuildSpec>): BuildSpec {
  return BuildSpec.parse({ ...RUN7_SPEC, ...overrides });
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pg-clause-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('must-clause evidence：run-7 完美网格', () => {
  it('41 个 must group；可测 dimension / furniture / roof / budget leaves 为 met；定性 leaves 全部 unverified', () => {
    const grid = buildRun7PerfectGrid(RUN7_SPEC);
    const evaluation = evaluate(RUN7_SPEC, grid);
    assert.equal(evaluation.groups.length, 41);
    assert.equal(evaluation.summary.musts, 41);
    assert.equal(evaluation.summary.leaves, 109);
    assert.equal(evaluation.unattributedHardFails.length, 0);
    assert.equal(evaluation.summary.notMet, 0);

    for (const clauseId of [
      'req-outer-10x8#envelope-width',
      'req-outer-10x8#envelope-depth',
      'req-single-storey#storey-levels',
      'req-interior-8x6#clear-width',
      'req-interior-8x6#clear-depth',
      'req-interior-8x6#clear-area',
      'req-wall-thick-1m#thickness',
      'req-door-north-west#door-width',
      'req-door-north-west#door-side',
      'req-door-north-west#door-west-of-center',
      'req-window-dim#window-sill',
      'req-window-dim#window-height',
      'req-window-dim#window-head',
      'req-long-table#table-length',
      'req-long-table#table-depth',
      'req-long-table#table-kind',
      'req-long-table#table-east-wall',
      'req-bench-north#north-bench-length',
      'req-bench-north#north-bench-depth',
      'req-bench-north#north-bench-kind',
      'req-bench-north#north-bench-relation',
      'req-bench-north#north-bench-west-of-door-clear',
      'req-bench-south#south-bench-length',
      'req-bench-south#south-bench-depth',
      'req-bench-south#south-bench-kind',
      'req-bench-south#south-bench-relation',
      'req-seats-10#seat-count',
      'req-seats-10#seat-per-bench',
      'req-counter#counter-length',
      'req-counter#counter-depth',
      'req-counter#counter-kind',
      'req-counter#counter-west-wall',
      'req-gable-tile-roof#roof-form',
      'req-block-budget#budget-max',
      'req-stone-base#report-slab',
    ]) {
      assert.equal(leaf(evaluation, clauseId).status, 'met', clauseId);
    }

    const qualitative = flattenClauseLeaves(evaluation).filter((candidate) => candidate.check.kind === 'qualitative');
    assert.ok(qualitative.length > 0);
    assert.equal(
      qualitative.every((candidate) => candidate.status === 'unverified'),
      true,
    );
    const nonGeometric = flattenClauseLeaves(evaluation).filter((candidate) =>
      ['material', 'site', 'program', 'visual'].includes(candidate.kind),
    );
    assert.equal(
      nonGeometric.every((candidate) => candidate.status === 'unverified'),
      true,
    );
  });
});

describe('must-clause evidence：run-9 v2 hard fail 归因', () => {
  it('4 个 report hard fail 全部落到 not-met leaf；无 must 覆盖的家具缺失进入显式全局阻断', () => {
    const { evaluation } = buildRun9();
    assert.equal(evaluation.groups.length, 41);
    assert.equal(evaluation.summary.leaves, 109);
    // material hard fail 已归因到材料 must；两盏吊灯没有对应 must，必须是带理由的全局阻断。
    // mezzanine 已不在未归因列表：as-built 把单层水平铺面从墙脚排除后，该检查不再把厚楼板误报成夹层。
    assert.equal(evaluation.unattributedHardFails.length, 0);
    assert.equal(evaluation.summary.globalBlockers.length, 2);
    assert.equal(evaluation.summary.globalBlockers.filter((id) => id.startsWith('furniture:f-light-ridge-')).length, 2);
    assert.equal(
      evaluation.unattributedHardFails.some((id) => id.startsWith('furniture:') || id.startsWith('check:material:')),
      false,
    );
    assert.equal(
      evaluation.summary.attributedHardFails.some((item) => item.checkId === 'check:material:structure'),
      true,
    );
    assert.equal(
      evaluation.summary.attributedHardFails
        .find((item) => item.checkId === 'check:material:structure')
        ?.mustIds.includes('req-wood-wall-column'),
      true,
    );
    const roofAttribution = evaluation.summary.attributedHardFails.find(
      (item) => item.checkId === 'check:material:roof',
    );
    assert.deepEqual([...(roofAttribution?.mustIds ?? [])].sort(), [
      'constraint-con-material-selection',
      'req-gable-tile-roof',
    ]);
    // 材料 hard fail 落到 roof-material，而不是 roof-form；roof diff 失败不含 form delta 时 form leaf 不连带。
    const roofLeaves = evaluation.groups.find((candidate) => candidate.mustId === 'req-gable-tile-roof')?.leaves ?? [];
    assert.equal(roofLeaves.find((leaf) => leaf.clauseId === 'req-gable-tile-roof#roof-material')?.status, 'not-met');
    assert.equal(roofLeaves.find((leaf) => leaf.clauseId === 'req-gable-tile-roof#roof-form')?.status, 'unverified');
    // run-9 v2 还有缺失家具 / 覆盖检查失败，因此 not-met 父 must 多于 4 个；
    // 这里锁定四个 hard-fail 类别都确实被归因，而不是只看总数。
    for (const expectedId of HARD_FAIL_IDS) {
      assert.equal(hasEvidence(evaluation, expectedId), true, expectedId);
    }
    for (const mustId of ['req-stone-base', 'req-gable-tile-roof', 'req-door-north-west', 'req-window-south-4m']) {
      assert.equal(groupStatus(evaluation, mustId), 'not-met', mustId);
    }
    assert.ok(evaluation.summary.notMet >= HARD_FAIL_IDS.length);
    assert.ok(evaluation.summary.unverified > 0);
  });

  it('家具实际低 confidence（unverified）且无 must 覆盖：进入全局阻断，不进入未归因', () => {
    const { spec, grid, graph } = buildRun9();
    const coverage = evaluateCoverage(spec, graph, grid, REGISTRY);
    const light = coverage.furnitureItems.find((item) => item.expectedId?.includes('f-light-ridge-e'));
    assert.ok(light !== undefined);
    const fakeCoverage = {
      checks: coverage.checks,
      furnitureItems: [
        { ...light, status: 'unverified' as const, severity: 'hard' as const, reason: 'low confidence furniture' },
      ],
    };
    const report = buildConformanceDiffReport({
      spec,
      grid,
      registry: REGISTRY,
      graph,
      specPath: 'test-spec.json',
      specSha256: '0'.repeat(64),
      archivePath: 'test-building.pgar',
      archiveSha256: '1'.repeat(64),
      archiveBytes: 0,
    });
    const evaluation = evaluateMustClauses({ spec, graph, grid, registry: REGISTRY, report, coverage: fakeCoverage });
    assert.equal(
      evaluation.summary.globalBlockers.some((id) => id.startsWith('furniture:f-light-ridge-e:')),
      true,
    );
    assert.equal(
      evaluation.unattributedHardFails.some((id) => id.startsWith('furniture:')),
      false,
    );
  });

  it('从 conformance-diff 报告重新计算时仍保留未归因 hard fail 与显式全局阻断', () => {
    const { spec, grid } = buildRun9();
    const evaluation = evaluate(spec, grid);
    // 楼板不再被当成墙脚 → check:absence:mezzanine 不再误报夹层，未归因 hard fail 归零。
    assert.equal(evaluation.unattributedHardFails.length, 0);
    assert.equal(evaluation.summary.globalBlockers.length, 2);
    assert.equal(
      evaluation.summary.notMet,
      evaluation.summary.musts - evaluation.summary.met - evaluation.summary.unverified,
    );
  });
});

describe('must-clause evidence：actual acid', () => {
  it('删掉一条楼板 x 行：slab report leaf 与 stone-base 父 must 都 not-met', () => {
    const grid = buildRun7PerfectGrid(RUN7_SPEC);
    const slab = RUN7_SPEC.elements.find((element) => element.kind === 'slab');
    assert.ok(slab !== undefined);
    const air = parseState(REGISTRY.table, 'air');
    for (let y = slab.bounds.min[1]; y < slab.bounds.max[1]; y += 1) {
      for (let x = slab.bounds.min[0]; x < slab.bounds.max[0]; x += 1) {
        grid.set(x, y, slab.bounds.min[2], air, 0, 0);
      }
    }
    const evaluation = evaluate(RUN7_SPEC, grid);
    assert.equal(leaf(evaluation, 'req-stone-base#report-slab').status, 'not-met');
    assert.equal(groupStatus(evaluation, 'req-stone-base'), 'not-met');
    assert.equal(hasEvidence(evaluation, 'slab:f1'), true);
  });

  it('实际 3m 长桌而 must 仍写 4m：table-length leaf 与 req-long-table 都 not-met', () => {
    const grid = buildRun7PerfectGrid(RUN7_SPEC);
    const table = RUN7_SPEC.interiors
      .flatMap((interior) => interior.furnitureSpecs)
      .find((furniture) => furniture.id === 'f-long-table');
    assert.ok(table !== undefined);
    const air = parseState(REGISTRY.table, 'air');
    for (let y = table.bounds.min[1]; y < table.bounds.max[1]; y += 1) {
      for (let z = table.bounds.min[2]; z < table.bounds.max[2]; z += 1) {
        grid.set(table.bounds.min[0], y, z, air, 0, 0);
      }
    }
    const evaluation = evaluate(RUN7_SPEC, grid);
    assert.equal(leaf(evaluation, 'req-long-table#table-length').status, 'not-met');
    assert.equal(groupStatus(evaluation, 'req-long-table'), 'not-met');
  });

  it('实际 2m 南窗而 must 仍写 4m：window-width leaf 与 req-window-south-4m 都 not-met', () => {
    const grid = buildRun7PerfectGrid(RUN7_SPEC);
    const window = RUN7_SPEC.openings.find((opening) => opening.id === 'op-south-window');
    const wall = RUN7_SPEC.elements.find((element) => element.kind === 'wall');
    assert.ok(window !== undefined);
    assert.ok(wall !== undefined);
    const block = RUN7_SPEC.materials.find((material) => material.id === wall.material)?.block;
    assert.ok(block !== undefined);
    const wallState = parseState(REGISTRY.table, block);
    for (let x = window.bounds.min[0]; x < window.bounds.min[0] + 2; x += 1) {
      for (let y = window.bounds.min[1]; y < window.bounds.max[1]; y += 1) {
        for (let z = window.bounds.min[2]; z < window.bounds.max[2]; z += 1) {
          grid.set(x, y, z, wallState, 0, 0);
        }
      }
    }
    const evaluation = evaluate(RUN7_SPEC, grid);
    assert.equal(leaf(evaluation, 'req-window-south-4m#window-width').status, 'not-met');
    assert.equal(groupStatus(evaluation, 'req-window-south-4m'), 'not-met');
  });

  it('gable must 对 shed / flat 实际：roof-form leaf 用 evaluateRoof 分类后 not-met', () => {
    const shedSpec = cloneRun7({ roof: { ...RUN7_SPEC.roof, form: 'shed' } });
    const grid = buildRun7PerfectGrid(shedSpec);
    const roofForm = evaluateRoof(RUN7_SPEC, grid).actual.form;
    assert.ok(roofForm === 'shed' || roofForm === 'flat');
    const evaluation = evaluate(RUN7_SPEC, grid);
    assert.equal(leaf(evaluation, 'req-gable-tile-roof#roof-form').status, 'not-met');
    assert.equal(groupStatus(evaluation, 'req-gable-tile-roof'), 'not-met');
  });

  it('交换两条完全相同的长凳：compiler 关系与 spec 冲突，relation leaf 不得静默通过', () => {
    const north = RUN7_SPEC.interiors
      .flatMap((interior) => interior.furnitureSpecs)
      .find((furniture) => furniture.id === 'f-bench-north');
    const south = RUN7_SPEC.interiors
      .flatMap((interior) => interior.furnitureSpecs)
      .find((furniture) => furniture.id === 'f-bench-south');
    assert.ok(north !== undefined && south !== undefined);
    const swapped = cloneRun7({
      interiors: RUN7_SPEC.interiors.map((interior) => ({
        ...interior,
        furnitureSpecs: interior.furnitureSpecs.map((furniture) =>
          furniture.id === 'f-bench-north'
            ? { ...furniture, bounds: south.bounds }
            : furniture.id === 'f-bench-south'
              ? { ...furniture, bounds: north.bounds }
              : furniture,
        ),
      })),
    });
    // 两条凳子几何完全相同，纯交换后的 grid 与原 grid 一致；必须用交换后的 spec 编译，
    // 才能看到目标关系与 spec 派生关系冲突。evaluator 对 conflict 一律 not-met。
    const evaluation = evaluate(swapped, buildRun7PerfectGrid(swapped));
    const relation = leaf(evaluation, 'req-bench-north#north-bench-relation');
    assert.equal(relation.status, 'not-met');
    assert.match(relation.reason ?? '', /conflict:/);
    assert.equal(groupStatus(evaluation, 'req-bench-north'), 'not-met');
  });

  it('实际 subtype 从 table 变成 bench：table-kind leaf 与 req-long-table 都 not-met', () => {
    const grid = buildRun7PerfectGrid(RUN7_SPEC);
    const graph = extractAsBuiltObjects(grid, REGISTRY);
    const mutated: AsBuiltObjectGraph = {
      ...graph,
      objects: graph.objects.map((object) =>
        object.kind === 'furniture' && object.furniture.subtype === 'table'
          ? { ...object, furniture: { ...object.furniture, subtype: 'bench' as const } }
          : object,
      ),
    };
    const evaluation = evaluateGraph(RUN7_SPEC, mutated, grid);
    assert.equal(leaf(evaluation, 'req-long-table#table-kind').status, 'not-met');
    assert.equal(groupStatus(evaluation, 'req-long-table'), 'not-met');
  });

  it('预算 100 对实际 418 方块：budget leaf 与 req-block-budget 都 not-met', () => {
    const budgetText = RUN7_SPEC.musts.map((must) => ({ ...must, text: must.text.replaceAll('20000', '100') }));
    const budgetSpec = cloneRun7({
      budget: { ...RUN7_SPEC.budget, maxBlocks: 100 },
      musts: budgetText,
    });
    const evaluation = evaluate(budgetSpec, buildRun7PerfectGrid(RUN7_SPEC));
    const budget = leaf(evaluation, 'req-block-budget#budget-max');
    assert.equal(budget.status, 'not-met');
    assert.equal(budget.status, 'not-met');
    assert.equal(groupStatus(evaluation, 'req-block-budget'), 'not-met');
  });
});

describe('conformance-shadow：clause 集成', () => {
  it('run-7 完美网格：clauses 非空，clauseSummary.musts=41，父 summary 与 clause summary 一致', () => {
    withTempDir((dir) => {
      const specPath = join(dir, 'build-spec.json');
      const archivePath = join(dir, 'building.pgar');
      writeFileSync(specPath, `${JSON.stringify(RUN7_SPEC, null, 2)}\n`, 'utf8');
      writeFileSync(archivePath, writeArchive(buildRun7PerfectGrid(RUN7_SPEC), API_VERSION));
      const result = computeShadowConformance({ specPath, archivePath, outDir: dir });
      assert.equal(result.error, null);
      const evidence = result.evidence;
      assert.ok(evidence !== null);
      assert.ok(evidence.clauses.length > 0);
      assert.equal(evidence.clauseSummary.musts, 41);
      assert.equal(evidence.clauseGroups.length, 41);
      assert.equal(evidence.summary.met, evidence.clauseSummary.met);
      assert.equal(evidence.summary.notMet, evidence.clauseSummary.notMet);
      assert.equal(evidence.summary.waived, evidence.clauseSummary.waived);
      assert.equal(evidence.summary.unverified, evidence.clauseSummary.unverified);
      assert.equal(evidence.summary.notMet, 0);
      assert.equal(evidence.summary.acceptEligible, evidence.summary.unverified === 0);
    });
  });

  it('run-9 v2：父 summary 与 clause summary 一致，4 个 hard fail 都有 not-met clause', () => {
    withTempDir((dir) => {
      const result = computeShadowConformance({
        specPath: RUN9_SPEC_PATH,
        archivePath: RUN9_ARCHIVE_PATH,
        outDir: dir,
      });
      assert.equal(result.error, null);
      const evidence = result.evidence;
      assert.ok(evidence !== null);
      assert.equal(evidence.clauseSummary.musts, 41);
      assert.equal(evidence.summary.notMet, evidence.clauseSummary.notMet);
      assert.equal(evidence.summary.unverified, evidence.clauseSummary.unverified);
      assert.ok(evidence.clauseSummary.notMet >= HARD_FAIL_IDS.length);
      for (const expectedId of HARD_FAIL_IDS) {
        assert.equal(
          evidence.clauses.some(
            (clause) =>
              clause.status === 'not-met' &&
              clause.evidence.some((item) => item.ref === `conformance-diff.json#expected:${expectedId}`),
          ),
          true,
          expectedId,
        );
      }
    });
  });
});

describe('must-clause evidence：reviewer regression acids', () => {
  it('door-clear target 2m 不能被固定 1m 检查假 met', () => {
    const spec = BuildSpec.parse({
      ...RUN7_SPEC,
      musts: [{ id: 'constraint-con-door-clear-1m', text: '门内侧保留 2m 宽净空。', source: 'constraint' }],
    });
    const evaluation = evaluate(spec, buildRun7PerfectGrid(spec));
    assert.equal(leaf(evaluation, 'constraint-con-door-clear-1m#door-clear').status, 'not-met');
  });

  it('覆盖检查 hard fail（东墙多窗）进入全局未归因，不会消失', () => {
    const grid = buildRun7PerfectGrid(RUN7_SPEC);
    const glass = parseState(REGISTRY.table, 'glass');
    for (let y = 2; y <= 3; y += 1) {
      for (let z = 5; z <= 6; z += 1) grid.set(11, y, z, glass, 0, 0);
    }
    const evaluation = evaluate(RUN7_SPEC, grid);
    assert.equal(
      evaluation.unattributedHardFails.some((id) => id.startsWith('check:schedule:east')),
      true,
    );
  });

  it('长桌实际旋转 90°（2×4）时 axis leaf not-met，即使 length/depth 都是 4/2', () => {
    const grid = buildRun7PerfectGrid(RUN7_SPEC);
    const graph = extractAsBuiltObjects(grid, REGISTRY);
    const report = buildConformanceDiffReport({
      spec: RUN7_SPEC,
      grid,
      registry: REGISTRY,
      graph,
      specPath: 'test-spec.json',
      specSha256: '0'.repeat(64),
      archivePath: 'test-building.pgar',
      archiveSha256: '0'.repeat(64),
      archiveBytes: 0,
    });
    const coverage = evaluateCoverage(RUN7_SPEC, graph, grid, REGISTRY);
    const rotated = {
      ...coverage,
      furnitureItems: coverage.furnitureItems.map((item) =>
        item.expectedId === 'furniture:f-long-table'
          ? {
              ...item,
              status: 'pass' as const,
              actual: { ...item.actual, bounds: { min: [7, 1, 5], max: [9, 2, 9] } },
            }
          : item,
      ),
    };
    const evaluation = evaluateMustClauses({
      spec: RUN7_SPEC,
      graph,
      grid,
      registry: REGISTRY,
      report,
      coverage: rotated,
    });
    assert.equal(leaf(evaluation, 'req-long-table#table-long-axis').status, 'not-met');
    assert.equal(leaf(evaluation, 'req-long-table#table-length').status, 'met');
    assert.equal(leaf(evaluation, 'req-long-table#table-depth').status, 'met');
  });
});

describe('must-clause evidence：3m table numeric target', () => {
  it('matched 3×2 actual vs 4m must：length leaf 量到 3 并 not-met，depth 仍 met', () => {
    const grid = buildRun7PerfectGrid(RUN7_SPEC);
    const graph = extractAsBuiltObjects(grid, REGISTRY);
    const report = buildConformanceDiffReport({
      spec: RUN7_SPEC,
      grid,
      registry: REGISTRY,
      graph,
      specPath: 'test-spec.json',
      specSha256: '0'.repeat(64),
      archivePath: 'test-building.pgar',
      archiveSha256: '0'.repeat(64),
      archiveBytes: 0,
    });
    const coverage = evaluateCoverage(RUN7_SPEC, graph, grid, REGISTRY);
    const shortened = {
      ...coverage,
      furnitureItems: coverage.furnitureItems.map((item) =>
        item.expectedId === 'furniture:f-long-table'
          ? {
              ...item,
              status: 'pass' as const,
              actual: { ...item.actual, bounds: { min: [7, 1, 5], max: [10, 2, 7] } },
            }
          : item,
      ),
    };
    const evaluation = evaluateMustClauses({
      spec: RUN7_SPEC,
      graph,
      grid,
      registry: REGISTRY,
      report,
      coverage: shortened,
    });
    const length = leaf(evaluation, 'req-long-table#table-length');
    assert.equal(length.status, 'not-met');
    assert.match(length.reason ?? '', /actual 3/);
    assert.equal(leaf(evaluation, 'req-long-table#table-depth').status, 'met');
  });
});
