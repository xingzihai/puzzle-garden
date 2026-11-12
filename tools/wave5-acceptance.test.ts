/**
 * Wave 5 验收：run-7 可测覆盖 → 15 个诚实 waiver；run-9 v2 仍 4 hard fail；
 * 伪造 map / 定性文本 / 8 个历史 promotion 均不能变成 met。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { writeArchive } from '@pg/core/archive';
import { parseState } from '@pg/core/block-state';
import { loadRegistry } from '@pg/blocks/load';
import { API_VERSION } from '@pg/geometry';
import { compileBuildBrief } from '@pg/interaction/brief';
import { expandDesignIntent } from '@pg/interaction/design-expand';
import { createIntentHost } from '@pg/interaction/generate-intent';
import { planMustObjectLinks, planVerifiedObjectMap } from '@pg/interaction/must-links';
import {
  parseReviewEvidenceFile,
  resolveReviewMusts,
  summarizeReviewMusts,
  type ReviewWaiver,
} from '@pg/interaction/review-evidence';
import { buildReviewReport } from '@pg/interaction/review-generate';
import { BuildSpec, buildMustLedger, MustLedgerEntry, RequirementGraph } from '@pg/interaction/schema';

import { buildBuildSheet, buildVerifiedMustMapping } from './build-sheet.ts';
import { buildConformanceEvidence, computeShadowConformance } from './conformance-shadow.ts';
import { buildRun7PerfectGrid } from './fixtures/run7-perfect-grid.ts';

const REQUIREMENTS = new URL('../packages/interaction/fixtures/run7-requirements.json', import.meta.url);
const INTENT = new URL('../packages/interaction/fixtures/run7-rev2-intent.json', import.meta.url);
const RUN9 = new URL('./fixtures/conformance-run9-v2/', import.meta.url);
const REVISION = 2;
const PROMOTIONS = [
  'req-no-steps',
  'constraint-con-entry-flush',
  'req-no-outdoor-zone',
  'req-no-sign-ticket-frame',
  'req-entrance-from-north',
] as const;

function readJson(path: URL): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const REQUIREMENTS_GRAPH = RequirementGraph.parse(readJson(REQUIREMENTS));
const SCHEME = expandDesignIntent(
  readJson(INTENT),
  createIntentHost(REQUIREMENTS_GRAPH, { schemeId: 'scheme-draft', revision: REVISION, status: 'confirmed' }),
).scheme;
const SPEC = BuildSpec.parse(compileBuildBrief(SCHEME, REQUIREMENTS_GRAPH).spec);
const TRUSTED = planVerifiedObjectMap(buildMustLedger(REQUIREMENTS_GRAPH).entries, SCHEME);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-wave5-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('real run-7 perfect：21 met / 20 unverified，20 waivers 才能 accept；5 个历史 promotion 仍 unverified', async () => {
  await withTempDir(async (dir) => {
    const specPath = join(dir, 'build-spec.json');
    const archivePath = join(dir, 'building.pgar');
    const specBytes = Buffer.from(`${JSON.stringify(SPEC, null, 2)}\n`);
    const archiveBytes = writeArchive(buildRun7PerfectGrid(SPEC), API_VERSION);
    await writeFile(specPath, specBytes);
    await writeFile(archivePath, archiveBytes);
    const mapping = buildVerifiedMustMapping(SPEC, TRUSTED);
    const shadow = computeShadowConformance({ specPath, archivePath, outDir: dir, verifiedMapping: mapping });
    assert.equal(shadow.error, null, shadow.error ?? '');
    assert.ok(shadow.evidence !== null);
    const evidence = parseReviewEvidenceFile(shadow.evidence);
    const binding = { specSha256: sha256(specBytes), archiveSha256: sha256(archiveBytes) };
    const verifiedMustIds = Object.keys(mapping.schemes[SPEC.schemeId] ?? {});

    assert.equal(evidence.summary.met, 21);
    assert.equal(evidence.summary.notMet, 0);
    assert.equal(evidence.summary.unverified, 20);
    assert.ok(evidence.clauseSummary !== undefined);
    assert.equal(evidence.clauseSummary.musts, 41);

    const resolved = resolveReviewMusts({
      schemeId: SPEC.schemeId,
      designRevision: REVISION,
      musts: SPEC.musts,
      evidence,
      ...binding,
      verifiedMustIds,
    });
    // door-clear 现在由专用 check:door-clear 实测，不再属于“历史 promotion”禁 met 名单。
    assert.equal(resolved.find((must) => must.requirementId === 'req-door-clear-1m')?.status, 'met');
    for (const mustId of PROMOTIONS) {
      const must = resolved.find((entry) => entry.requirementId === mustId);
      assert.ok(must !== undefined, mustId);
      assert.notEqual(must.status, 'met', `${mustId} 是历史 promotion，不能 met`);
      assert.equal(must.status, 'unverified', mustId);
    }
    // 0 根柱子时不能声称“木柱”已验证。
    assert.equal(resolved.find((entry) => entry.requirementId === 'req-wood-wall-column')?.status, 'unverified');

    const noWaiver = buildReviewReport({
      spec: SPEC,
      run: runFacts(SPEC, 'run-wave5-run7'),
      evidence,
      evidenceBinding: binding,
      verifiedMustIds,
    });
    assert.equal(noWaiver.nextAction.kind, 'ask-user');
    assert.equal(noWaiver.verdict.status, 'partial');

    const unverified = resolved.filter((must) => must.status === 'unverified');
    const waivers: ReviewWaiver[] = unverified.map((must) => ({
      mustId: must.requirementId,
      designRevision: REVISION,
      by: 'user',
      choice: '接受无法由几何 / 家具 / 材料 / 标高证据验证的剩余项',
      conflictId: null,
      note: 'wave5 acceptance',
    }));
    assert.equal(waivers.length, 20);
    // Wave6：旧 verifiedMustIds 不再是 met 的唯一来源；被 clause 判 unverified 的 must 可被 leaf 级豁免。

    const accepted = buildReviewReport({
      spec: SPEC,
      run: runFacts(SPEC, 'run-wave5-run7'),
      evidence,
      evidenceBinding: binding,
      verifiedMustIds,
      waivers,
    });
    assert.equal(accepted.verdict.status, 'satisfied');
    assert.equal(accepted.nextAction.kind, 'accept');
    assert.equal(accepted.verdict.musts.filter((must) => must.status === 'met').length, 21);
    assert.equal(accepted.verdict.musts.filter((must) => must.status === 'waived').length, 20);
    assert.equal(summarizeReviewMusts(accepted.verdict.musts).acceptEligible, true);
  });
});

test('run-9 v2：4 hard fails；即使 41 条全部 waive 仍不能 accept', async () => {
  const specBytes = await readFile(new URL('build-spec.json', RUN9));
  const spec = BuildSpec.parse(JSON.parse(specBytes.toString('utf8')));
  const report = JSON.parse(await readFile(new URL('conformance-report.json', RUN9), 'utf8')) as {
    readonly items: readonly { readonly status: string; readonly severity: string }[];
    readonly spec: { readonly sha256: string };
    readonly archive: { readonly sha256: string; readonly bytes: number };
  };
  assert.equal(report.items.filter((item) => item.status === 'fail' && item.severity === 'hard').length, 4);
  const sheet = buildBuildSheet(spec);
  const evidence = parseReviewEvidenceFile(
    buildConformanceEvidence(
      spec,
      sheet,
      report as never,
      report.spec.sha256,
      report.archive.sha256,
      report.archive.bytes,
    ),
  );
  const waivers: ReviewWaiver[] = spec.musts.map((must) => ({
    mustId: must.id,
    designRevision: spec.schemeRevision,
    by: 'user',
    choice: 'try all waivers',
    conflictId: null,
    note: null,
  }));
  const review = buildReviewReport({
    spec,
    run: runFacts(spec, 'run-9-v2'),
    evidence,
    evidenceBinding: { specSha256: report.spec.sha256, archiveSha256: report.archive.sha256 },
    verifiedMustIds: [],
    waivers,
  });
  assert.equal(review.verdict.musts.filter((must) => must.status === 'not-met').length, 4);
  assert.equal(review.verdict.musts.filter((must) => must.status === 'waived').length, 37);
  assert.notEqual(review.verdict.status, 'satisfied');
  assert.notEqual(review.nextAction.kind, 'accept');
});

test('P0 allowlist：stone base / material selection / negative furniture / 未列形容词都不 verified', () => {
  for (const mustId of ['req-stone-base', 'constraint-con-material-selection', 'req-wood-wall-column']) {
    assert.equal(Object.hasOwn(TRUSTED, mustId), false, mustId);
  }

  const entries = [
    ['req-neg-table', '室内不设 4m 长桌。'],
    ['req-neg-bench', '不做 4m 长凳。'],
    ['req-posh-table', '长桌造型优雅，比例协调。'],
    ['req-posh-roof', '屋面轮廓优美。'],
  ].map(([id, text]) =>
    MustLedgerEntry.parse({
      id,
      sourceId: id,
      text,
      source: 'requirement',
      kind: 'function',
      check: 'geometry',
      targets: [],
      value: null,
      status: 'unverified',
      evidence: [],
    }),
  );
  const plan = planMustObjectLinks(entries, SCHEME);
  assert.equal(plan.coverage.verified, 0);
  for (const link of plan.coverage.entries) assert.notEqual(link.scope, 'verified', link.mustId);
});

test('P0 fail propagation：oak_stairs / 2-cell partition 即使全量 waiver 也不能 accept', async () => {
  const registry = loadRegistry();
  const stone = parseState(registry.table, 'stone_bricks');
  const stairs = parseState(registry.table, 'oak_stairs');
  const cases: readonly [string, (grid: ReturnType<typeof buildRun7PerfectGrid>) => void, string][] = [
    [
      'partition',
      (grid) => {
        grid.set(4, 1, 4, stone, 0, 0);
      },
      'req-no-partitions',
    ],
    [
      'stairs',
      (grid) => {
        grid.set(4, 1, 4, stairs, 0, 0);
      },
      'req-single-storey',
    ],
  ];
  for (const [name, mutate, mustId] of cases) {
    await withTempDir(async (dir) => {
      const grid = buildRun7PerfectGrid(SPEC);
      mutate(grid);
      if (name === 'partition') grid.set(5, 1, 4, stone, 0, 0);
      const specPath = join(dir, 'build-spec.json');
      const archivePath = join(dir, 'building.pgar');
      const specBytes = Buffer.from(`${JSON.stringify(SPEC, null, 2)}\n`);
      const archiveBytes = writeArchive(grid, API_VERSION);
      await writeFile(specPath, specBytes);
      await writeFile(archivePath, archiveBytes);
      const shadow = computeShadowConformance({
        specPath,
        archivePath,
        outDir: dir,
        verifiedMapping: buildVerifiedMustMapping(SPEC, TRUSTED),
      });
      assert.equal(shadow.error, null, shadow.error ?? '');
      assert.ok(shadow.evidence !== null);
      const evidence = parseReviewEvidenceFile(shadow.evidence);
      const binding = { specSha256: sha256(specBytes), archiveSha256: sha256(archiveBytes) };
      const resolved = resolveReviewMusts({
        schemeId: SPEC.schemeId,
        designRevision: REVISION,
        musts: SPEC.musts,
        evidence,
        ...binding,
        verifiedMustIds: Object.keys(TRUSTED),
      });
      assert.equal(resolved.find((must) => must.requirementId === mustId)?.status, 'not-met', name);
      const waivers = resolved
        .filter((must) => must.status === 'unverified')
        .map((must) => ({
          mustId: must.requirementId,
          designRevision: REVISION,
          by: 'user' as const,
          choice: 'accept rest',
          conflictId: null,
          note: null,
        }));
      const review = buildReviewReport({
        spec: SPEC,
        run: runFacts(SPEC, `run-${name}`),
        evidence,
        evidenceBinding: binding,
        verifiedMustIds: Object.keys(TRUSTED),
        waivers,
      });
      assert.equal(review.verdict.status, 'not-satisfied');
      assert.notEqual(review.nextAction.kind, 'accept');
    });
  }
});

test('plain caller map / 复制 map 不产生 verified，也不能让评审 accept', () => {
  const forged = Object.fromEntries(SPEC.musts.map((must) => [must.id, ['wall:f1']]));
  assert.equal(buildBuildSheet(SPEC, forged).mustLinkage.verified, 0);
  assert.deepEqual(buildVerifiedMustMapping(SPEC, forged).schemes, {});
  const copied = Object.fromEntries(Object.entries(TRUSTED).map(([mustId, refs]) => [mustId, [...refs]]));
  assert.equal(buildBuildSheet(SPEC, copied).mustLinkage.verified, 0);
  assert.deepEqual(buildVerifiedMustMapping(SPEC, copied).schemes, {});
});

test('定性 / 性能 / 外观 / 耐久短语不会 verified', () => {
  const phrases = [
    '屋面排水良好，雨后不积水',
    '外墙外观整洁',
    '采光良好',
    '耐久',
    '屋面不漏水',
    '屋面防水',
    '屋面排水',
    '屋面防渗',
    '屋面隔热',
    '屋面排水坡度 2%',
    '屋面排水沟',
    '屋面排水管',
    '屋面排水系统',
    '屋面雨水管',
    '屋面防潮层',
  ];
  const entries = phrases.map((text, index) =>
    MustLedgerEntry.parse({
      id: `req-wave5-qual-${String(index)}`,
      sourceId: `req-wave5-qual-${String(index)}`,
      text,
      source: 'requirement',
      kind: 'aesthetic',
      check: 'geometry',
      targets: [],
      value: null,
      status: 'unverified',
      evidence: [],
    }),
  );
  const plan = planMustObjectLinks(entries, SCHEME);
  assert.equal(plan.coverage.verified, 0);
  for (const link of plan.coverage.entries) {
    assert.notEqual(link.scope, 'verified', link.mustId);
    assert.equal(link.reason, 'qualitative-not-object-verifiable', link.mustId);
  }
});
