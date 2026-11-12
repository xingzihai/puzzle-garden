/**
 * Wave 6 验收：Must Clause Compiler 的端到端 acid。
 *
 * 覆盖：run-9 v2 全量 waiver 仍不能 accept；复合 must 的定性 leaf 单独豁免；
 * program 文本不被提升成 seat；kind 变更、隔断 P0、合法柜子、gable→shed。
 * 细粒度 actual-vs-target 由 must-clause-evidence.test.ts 覆盖。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import type { AsBuiltObject, AsBuiltObjectGraph } from '@pg/analysis/as-built';
import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { writeArchive } from '@pg/core/archive';
import { API_VERSION } from '@pg/geometry';
import { compileBuildSpec } from '@pg/interaction/brief';
import { expandDesignIntent } from '@pg/interaction/design-expand';
import { createIntentHost } from '@pg/interaction/generate-intent';
import { parseReviewEvidenceFile, summarizeReviewMusts, type ReviewWaiver } from '@pg/interaction/review-evidence';
import { buildReviewReport } from '@pg/interaction/review-generate';
import { BuildSpec, DesignScheme, RequirementGraph } from '@pg/interaction/schema';

import { computeShadowConformance } from './conformance-shadow.ts';
import { buildConformanceDiffReport } from './conformance-diff.ts';
import { evaluateCoverage } from './coverage-evidence.ts';
import { buildRun7PerfectGrid } from './fixtures/run7-perfect-grid.ts';
import { evaluateMustClauses } from './must-clause-evidence.ts';
import type { MustClauseEvaluation } from '../packages/interaction/src/must-clause.ts';

const REQUIREMENTS = new URL('../packages/interaction/fixtures/run7-requirements.json', import.meta.url);
const INTENT = new URL('../packages/interaction/fixtures/run7-rev2-intent.json', import.meta.url);
const SCHEME = new URL('../packages/interaction/fixtures/run7-rev2-scheme.json', import.meta.url);
const RUN9 = new URL('./fixtures/conformance-run9-v2/', import.meta.url);
const REGISTRY = loadRegistry();

function readJson(path: URL): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const GRAPH = RequirementGraph.parse(readJson(REQUIREMENTS));
const DESIGN = DesignScheme.parse(readJson(SCHEME));
const RUN7 = BuildSpec.parse(
  compileBuildSpec(
    expandDesignIntent(
      readJson(INTENT),
      createIntentHost(GRAPH, { schemeId: DESIGN.meta.id, revision: DESIGN.meta.revision, status: 'confirmed' }),
    ).scheme,
    GRAPH,
  ),
);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function evaluate(spec: BuildSpec, grid: ReturnType<typeof buildRun7PerfectGrid>): MustClauseEvaluation {
  const graph = extractAsBuiltObjects(grid, REGISTRY);
  return evaluateGraph(spec, graph, grid);
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
    specPath: 'wave6-spec.json',
    specSha256: '0'.repeat(64),
    archivePath: 'wave6-building.pgar',
    archiveSha256: '0'.repeat(64),
    archiveBytes: 0,
  });
  const coverage = evaluateCoverage(spec, graph, grid, REGISTRY);
  return evaluateMustClauses({ spec, graph, grid, registry: REGISTRY, report, coverage });
}

function group(evaluation: MustClauseEvaluation, mustId: string) {
  const found = evaluation.groups.find((candidate) => candidate.mustId === mustId);
  assert.ok(found !== undefined, `missing must group ${mustId}`);
  return found;
}

function leafStatus(evaluation: MustClauseEvaluation, mustId: string, clauseId: string): string {
  const found = group(evaluation, mustId).leaves.find((candidate) => candidate.clauseId === clauseId);
  assert.ok(found !== undefined, `missing clause ${clauseId}`);
  return found.status;
}

function addCells(
  grid: ReturnType<typeof buildRun7PerfectGrid>,
  cells: readonly (readonly [number, number, number, string])[],
): ReturnType<typeof buildRun7PerfectGrid> {
  for (const [x, y, z, block] of cells) {
    grid.set(x, y, z, parseState(REGISTRY.table, block), 0, 0);
  }
  return grid;
}

function runFacts(spec: BuildSpec, runId: string) {
  return {
    runId,
    designId: spec.schemeId,
    designRevision: spec.schemeRevision,
    status: 'succeeded' as const,
    failure: null,
    delivered: true,
    stopReason: null,
    checkPassed: true,
    cells: 500,
    bounds: [2, 0, 2, 11, 7, 9] as const,
    renders: 1,
  };
}

test('acid：run-9 v2 全量 41 waiver 也不能 accept，4 类 hard fail 仍 not-met', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-wave6-run9-'));
  try {
    const specBytes = await readFile(new URL('build-spec.json', RUN9));
    const archiveBytes = await readFile(new URL('building.pgar', RUN9));
    const specPath = join(dir, 'build-spec.json');
    const archivePath = join(dir, 'building.pgar');
    await writeFile(specPath, specBytes);
    await writeFile(archivePath, archiveBytes);
    const shadow = computeShadowConformance({ specPath, archivePath, outDir: dir });
    assert.equal(shadow.error, null, shadow.error ?? '');
    assert.ok(shadow.evidence !== null);
    const evidence = parseReviewEvidenceFile(shadow.evidence);
    const spec = BuildSpec.parse(JSON.parse(specBytes.toString('utf8')));
    const binding = { specSha256: sha256(specBytes), archiveSha256: sha256(archiveBytes) };
    assert.ok(evidence.clauses !== undefined);

    for (const expectedId of ['slab:f1', 'roof', 'opening:op-entry-north', 'opening:op-south-window']) {
      assert.equal(
        evidence.clauses.some(
          (clause) =>
            clause.status === 'not-met' &&
            clause.evidence.some((ref) => ref.ref === `conformance-diff.json#expected:${expectedId}`),
        ),
        true,
        expectedId,
      );
    }
    // material 已归因；两盏灯没有必须项，必须作为带理由的显式全局阻断。
    // mezzanine 不再出现在未归因列表：as-built 已把单层水平铺面（楼板 / 平台）从墙脚排除，
    // check:absence:mezzanine 不再把厚楼板误报成夹层（配套测试见 as-built.test.ts）。
    assert.ok(evidence.clauseSummary !== undefined);
    assert.equal(evidence.clauseSummary.unattributedHardFails.length, 0);
    assert.equal(evidence.clauseSummary.globalBlockers.length, 2);
    assert.equal(evidence.clauseSummary.globalBlockers.filter((id) => id.includes('f-light-ridge-')).length, 2);
    assert.equal(
      evidence.clauseSummary.unattributedHardFails.some((id) => id.includes('check:material:')),
      false,
    );
    assert.equal(
      evidence.clauseSummary.attributedHardFails.some((item) => item.checkId === 'check:material:structure'),
      true,
    );
    assert.equal(evidence.summary.acceptEligible, false);

    const waivers: ReviewWaiver[] = spec.musts.map((must) => ({
      mustId: must.id,
      designRevision: spec.schemeRevision,
      by: 'user',
      choice: 'try all 41 waivers',
      conflictId: null,
      note: null,
    }));
    const review = buildReviewReport({
      spec,
      run: runFacts(spec, 'wave6-run9-all-waivers'),
      evidence,
      evidenceBinding: binding,
      verifiedMustIds: [],
      waivers,
    });
    assert.notEqual(review.verdict.status, 'satisfied');
    assert.notEqual(review.nextAction.kind, 'accept');
    assert.equal(review.verdict.musts.filter((must) => must.status === 'not-met').length >= 4, true);
    for (const mustId of ['req-stone-base', 'req-gable-tile-roof', 'req-door-north-west', 'req-window-south-4m']) {
      assert.equal(review.verdict.musts.find((must) => must.requirementId === mustId)?.status, 'not-met', mustId);
    }
    assert.equal(summarizeReviewMusts(review.verdict.musts).acceptEligible, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acid：外墙厚1m + 造型优雅 → thickness met、qualitative unverified；leaf 豁免后才能 accept', async () => {
  const must = { id: 'constraint-con-wall-1m', text: '外墙厚1m，造型优雅。', source: 'constraint' as const };
  const spec = BuildSpec.parse({ ...RUN7, musts: [must] });
  const grid = buildRun7PerfectGrid(spec);
  const evaluation = evaluate(spec, grid);
  assert.equal(leafStatus(evaluation, must.id, `${must.id}#thickness`), 'met');
  assert.equal(leafStatus(evaluation, must.id, `${must.id}#qualitative-tail`), 'unverified');
  assert.equal(group(evaluation, must.id).status, 'unverified');

  const dir = mkdtempSync(join(tmpdir(), 'pg-wave6-qual-'));
  try {
    const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
    const archiveBytes = writeArchive(grid, API_VERSION);
    await writeFile(join(dir, 'build-spec.json'), specBytes);
    await writeFile(join(dir, 'building.pgar'), archiveBytes);
    const shadow = computeShadowConformance({
      specPath: join(dir, 'build-spec.json'),
      archivePath: join(dir, 'building.pgar'),
      outDir: dir,
    });
    assert.equal(shadow.error, null, shadow.error ?? '');
    const evidence = parseReviewEvidenceFile(shadow.evidence);
    const binding = { specSha256: sha256(specBytes), archiveSha256: sha256(archiveBytes) };
    const noWaiver = buildReviewReport({
      spec,
      run: runFacts(spec, 'wave6-qual-no-waiver'),
      evidence,
      evidenceBinding: binding,
      verifiedMustIds: [],
    });
    assert.notEqual(noWaiver.nextAction.kind, 'accept');
    assert.equal(noWaiver.verdict.musts[0]?.status, 'unverified');

    const accepted = buildReviewReport({
      spec,
      run: runFacts(spec, 'wave6-qual-waived'),
      evidence,
      evidenceBinding: binding,
      verifiedMustIds: [],
      waivers: [
        {
          mustId: must.id,
          clauseId: `${must.id}#qualitative-tail`,
          designRevision: spec.schemeRevision,
          by: 'user',
          choice: '接受无法几何验证的造型描述',
          conflictId: null,
          note: 'wave6 acid',
        },
      ],
    });
    assert.equal(accepted.verdict.musts[0]?.status, 'waived');
    assert.equal(accepted.nextAction.kind, 'accept');
    assert.equal(accepted.verdict.musts[0].clauses.find((clause) => clause.status === 'met') !== undefined, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acid：program 文本“茶亭提供 10 座饮茶空间”不生成 seat clause，也不 met', () => {
  const must = { id: 'req-teahouse-seating-program', text: '茶亭提供 10 座饮茶空间。', source: 'requirement' as const };
  const spec = BuildSpec.parse({ ...RUN7, musts: [must] });
  const evaluation = evaluate(spec, buildRun7PerfectGrid(spec));
  const leaves = group(evaluation, must.id).leaves;
  assert.equal(
    leaves.some((candidate) => candidate.check.id.includes('seats') || candidate.target?.metric === 'count'),
    false,
  );
  assert.equal(
    leaves.every((candidate) => candidate.check.kind === 'qualitative'),
    true,
  );
  assert.equal(group(evaluation, must.id).status, 'unverified');
});

test('acid：table→bench / counter→table kind 变更都让 kind leaf not-met', () => {
  const grid = buildRun7PerfectGrid(RUN7);
  const original = extractAsBuiltObjects(grid, REGISTRY);
  const mutateKind = (subtype: 'bench' | 'table'): AsBuiltObjectGraph => ({
    ...original,
    objects: original.objects.map((object): AsBuiltObject => {
      if (object.kind !== 'furniture') return object;
      const furniture = object;
      const isTable = furniture.bounds.min[0] === 7 && furniture.bounds.min[2] === 5;
      const isCounter = furniture.bounds.min[0] === 3 && furniture.bounds.min[2] === 5;
      if ((subtype === 'bench' && isTable) || (subtype === 'table' && isCounter)) {
        return { ...furniture, furniture: { ...furniture.furniture, subtype } };
      }
      return object;
    }),
  });
  const tableMutated = evaluateGraph(RUN7, mutateKind('bench'), grid);
  assert.equal(leafStatus(tableMutated, 'req-long-table', 'req-long-table#table-kind'), 'not-met');
  assert.equal(group(tableMutated, 'req-long-table').status, 'not-met');

  const counterMutated = evaluateGraph(RUN7, mutateKind('table'), grid);
  assert.equal(leafStatus(counterMutated, 'req-counter', 'req-counter#counter-kind'), 'not-met');
  assert.equal(group(counterMutated, 'req-counter').status, 'not-met');
});

test('acid：gable→shed 同时产生 target conflict 与 roof-form not-met', () => {
  const spec = BuildSpec.parse({ ...RUN7, roof: { ...RUN7.roof, form: 'shed' } });
  const evaluation = evaluate(spec, buildRun7PerfectGrid(spec));
  const leaf = group(evaluation, 'req-gable-tile-roof').leaves.find(
    (candidate) => candidate.clauseId === 'req-gable-tile-roof#roof-form',
  );
  assert.ok(leaf !== undefined);
  assert.equal(leaf.status, 'not-met');
  assert.notEqual(leaf.conflict, null);
  assert.equal(group(evaluation, 'req-gable-tile-roof').status, 'not-met');
});

test('acid：7 个 partition P0 变体不 met；合法 3m 柜子 pass', () => {
  const variants: readonly (readonly [string, (grid: ReturnType<typeof buildRun7PerfectGrid>) => void])[] = [
    [
      'knee',
      (grid) => {
        addCells(grid, [
          [4, 1, 7, 'stone_bricks'],
          [5, 1, 7, 'stone_bricks'],
        ]);
      },
    ],
    [
      'split',
      (grid) => {
        for (let y = 1; y <= 3; y += 1) {
          addCells(grid, [
            [4, y, 4, 'glass'],
            [5, y, 4, 'glass'],
            [7, y, 4, 'glass'],
            [8, y, 4, 'glass'],
          ]);
        }
      },
    ],
    [
      'diagonal',
      (grid) => {
        addCells(grid, [
          [4, 1, 4, 'stone_bricks'],
          [5, 1, 5, 'stone_bricks'],
          [6, 1, 4, 'stone_bricks'],
          [7, 1, 5, 'stone_bricks'],
        ]);
      },
    ],
    [
      'chest',
      (grid) => {
        addCells(grid, [
          [4, 1, 4, 'chest'],
          [5, 1, 4, 'chest'],
          [6, 1, 4, 'chest'],
          [7, 1, 4, 'chest'],
        ]);
      },
    ],
    [
      'fence',
      (grid) => {
        addCells(grid, [
          [4, 1, 4, 'oak_fence'],
          [5, 1, 4, 'oak_fence'],
          [6, 1, 4, 'oak_fence'],
        ]);
      },
    ],
    [
      'glass-above-table',
      (grid) => {
        for (let x = 7; x <= 10; x += 1) addCells(grid, [[x, 2, 5, 'glass']]);
      },
    ],
    [
      'glass-in-cabinet',
      (grid) => {
        // 合法柜子本身 pass；柜内加玻璃后必须 fail。
        for (let x = 5; x <= 7; x += 1) {
          for (let y = 1; y <= 3; y += 1) addCells(grid, [[x, y, 8, 'glass']]);
        }
      },
    ],
  ];
  const interior = RUN7.interiors[0];
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
    ...RUN7,
    interiors: [{ ...interior, furnitureSpecs: [...interior.furnitureSpecs, cabinet] }],
  });
  for (const [name, mutate] of variants) {
    const spec = name === 'glass-in-cabinet' ? withCabinet : RUN7;
    const grid = buildRun7PerfectGrid(spec);
    mutate(grid);
    const evaluation = evaluate(spec, grid);
    assert.notEqual(group(evaluation, 'req-no-partitions').status, 'met', name);
    const partition = group(evaluation, 'req-no-partitions').leaves[0];
    assert.ok(partition !== undefined);
    assert.notEqual(partition.status, 'met', name);
  }

  const legit = evaluate(withCabinet, buildRun7PerfectGrid(withCabinet));
  assert.equal(group(legit, 'req-no-partitions').status, 'met');
  assert.equal(group(legit, 'req-no-partitions').leaves[0]?.status, 'met');
});
