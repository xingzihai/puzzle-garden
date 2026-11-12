/**
 * Wave 3C 接受路径集成回归：生产派生 verified mapping + 几何证据，无视觉评审也能 accept；
 * 缺证据 / run-9 v2 仍不能 accept。全部离线，只写临时目录。
 */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ReviewReport } from '@pg/interaction/review';
import { parseReviewEvidenceFile, resolveReviewMusts, summarizeReviewMusts } from '@pg/interaction/review-evidence';
import { buildReviewReport } from '@pg/interaction/review-generate';
import type { ReviewRunFacts } from '@pg/interaction/review-generate';
import { BuildSpec } from '@pg/interaction/schema';

import { readRunReviewEvidence } from './interaction-server-build.ts';

import { buildBuildSheet, buildVerifiedMustMapping } from './build-sheet.ts';
import type { ConformanceDiffReport } from './conformance-diff.ts';
import { buildConformanceEvidence } from './conformance-shadow.ts';
import { buildFixture } from './conformance-matrix-fixtures.ts';

const RUN9_V2_DIR = new URL('./fixtures/conformance-run9-v2/', import.meta.url);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-accept-path-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 给矩阵 fixture 加一条显式 details 链接；这是生产 BuildSheet 的 verified 映射来源。 */
function withExplicitLinks(spec: BuildSpec): BuildSpec {
  const door = spec.openings.find((opening) => opening.kind === 'door');
  assert.ok(door !== undefined, `${spec.schemeId} 缺门洞`);
  return BuildSpec.parse({
    ...spec,
    details: [
      {
        id: 'explicit-door',
        name: '入口门',
        where: '北侧入口',
        elementIds: [door.id],
        count: null,
        description: '入口门与门内净空',
        priority: 'must',
        requirementIds: spec.musts.map((must) => must.id),
        linkScope: 'verified',
      },
    ],
  });
}

function perfectRun(spec: BuildSpec): ReviewRunFacts {
  const x = spec.counts.footprintX;
  const z = spec.counts.footprintZ;
  return {
    runId: `run-${spec.schemeId}-perfect`,
    designId: spec.schemeId,
    designRevision: spec.schemeRevision,
    status: 'succeeded',
    failure: null,
    delivered: true,
    stopReason: null,
    checkPassed: true,
    cells: 500,
    bounds: [1, 1, 1, x, 4, z],
    renders: 1,
  };
}

test('H1–H4 手写 linkScope verified 不再产生 mapping，也不能 accept', () => {
  for (const house of ['H1', 'H2', 'H3', 'H4'] as const) {
    const fixture = buildFixture(house, 'good');
    const spec = withExplicitLinks(fixture.spec);
    assert.deepEqual(buildVerifiedMustMapping(spec).schemes, {}, `${house} details 不能产生 verified`);
    const sheet = buildBuildSheet(spec);
    assert.equal(sheet.mustLinkage.verified, 0, `${house} 不能有 verified must`);
    const report = buildReviewReport({ spec, run: perfectRun(spec) });
    assert.notEqual(report.nextAction.kind, 'accept');
    assert.equal(ReviewReport.safeParse(report).success, true);
  }
});

test('完美几何但缺证据：全部 must unverified，不能 accept', () => {
  const fixture = buildFixture('H1', 'good');
  const spec = withExplicitLinks(fixture.spec);
  const report = buildReviewReport({ spec, run: perfectRun(spec) });
  assert.equal(
    report.verdict.musts.every((must) => must.status === 'unverified'),
    true,
  );
  assert.equal(report.verdict.status, 'partial');
  assert.equal(report.nextAction.kind, 'ask-user');
});

test('损坏的 conformance-evidence.json：按缺证据处理，不能 accept', async () => {
  await withTempDir(async (dir) => {
    const fixture = buildFixture('H1', 'good');
    const spec = withExplicitLinks(fixture.spec);
    await writeFile(join(dir, 'conformance-evidence.json'), '{"musts": 3}', 'utf8');
    assert.equal(await readRunReviewEvidence(dir), null);
    const report = buildReviewReport({ spec, run: perfectRun(spec) });
    assert.equal(
      report.verdict.musts.every((must) => must.status === 'unverified'),
      true,
    );
    assert.equal(report.verdict.status, 'partial');
    assert.equal(report.nextAction.kind, 'ask-user');
  });
});

test('run-9 v2 冻结证据：4 hard fail / 0 met / 21 not-met / 20 unverified，仍不能 accept', async () => {
  const spec = BuildSpec.parse(JSON.parse(await readFile(new URL('build-spec.json', RUN9_V2_DIR), 'utf8')));
  const report = JSON.parse(
    await readFile(new URL('conformance-report.json', RUN9_V2_DIR), 'utf8'),
  ) as ConformanceDiffReport;
  const sheet = buildBuildSheet(spec);
  const evidence = parseReviewEvidenceFile(
    buildConformanceEvidence(spec, sheet, report, report.spec.sha256, report.archive.sha256, report.archive.bytes),
  );
  assert.equal(report.items.filter((item) => item.status === 'fail' && item.severity === 'hard').length, 4);
  assert.deepEqual(evidence.summary, {
    met: 0,
    notMet: 21,
    waived: 0,
    unverified: 20,
    acceptEligible: false,
  });

  const resolved = resolveReviewMusts({
    schemeId: spec.schemeId,
    designRevision: spec.schemeRevision,
    musts: spec.musts,
    evidence,
    specSha256: report.spec.sha256,
    archiveSha256: report.archive.sha256,
    verifiedMustIds: [],
  });
  assert.equal(summarizeReviewMusts(resolved).notMet, 4);
  assert.equal(summarizeReviewMusts(resolved).met, 0);

  const review = buildReviewReport({
    spec,
    run: {
      runId: 'run-9-v2',
      designId: spec.schemeId,
      designRevision: spec.schemeRevision,
      status: 'succeeded',
      failure: null,
      delivered: true,
      stopReason: null,
      checkPassed: true,
      cells: null,
      bounds: null,
      renders: 1,
    },
    evidence,
    evidenceBinding: { specSha256: report.spec.sha256, archiveSha256: report.archive.sha256 },
    verifiedMustIds: [],
  });
  assert.notEqual(review.nextAction.kind, 'accept');
  assert.notEqual(review.verdict.status, 'satisfied');
});
