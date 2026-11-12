/**
 * Wave 4 acceptance: the real run-7 design path (intent → scheme → BuildSpec → grid)
 * must emit honest must→object links, prove only verified links with geometry evidence,
 * and reach accept only after explicit user waivers for the honestly unverifiable musts.
 *
 * The grid is rebuilt from the compiled spec by `fixtures/run7-perfect-grid.ts`; no frozen
 * conformance report is used, and run-9 v2 remains a no-accept regression.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { writeArchive } from '@pg/core/archive';
import { API_VERSION } from '@pg/geometry';
import { compileBuildSpec } from '@pg/interaction/brief';
import { expandDesignIntent } from '@pg/interaction/design-expand';
import { createIntentHost } from '@pg/interaction/generate-intent';
import { planVerifiedObjectMap } from '@pg/interaction/must-links';
import {
  parseReviewEvidenceFile,
  resolveReviewMusts,
  reviewEvidenceMatchesArtifacts,
  summarizeReviewMusts,
} from '@pg/interaction/review-evidence';
import { buildReviewReport } from '@pg/interaction/review-generate';
import type { ReviewRunFacts } from '@pg/interaction/review-generate';
import { BuildSpec, buildMustLedger, DesignScheme, RequirementGraph } from '@pg/interaction/schema';

import { defaultWebReviewBuilder, readRunReviewEvidence } from './interaction-server-build.ts';

import { buildBuildSheet, buildVerifiedMustMapping, writeVerifiedMustMapArtifact } from './build-sheet.ts';
import type { ConformanceDiffReport } from './conformance-diff.ts';
import { buildConformanceEvidence, computeShadowConformance } from './conformance-shadow.ts';
import { buildRun7PerfectGrid } from './fixtures/run7-perfect-grid.ts';

const INTENT_FIXTURE = new URL('../packages/interaction/fixtures/run7-rev2-intent.json', import.meta.url);
const REQUIREMENTS_FIXTURE = new URL('../packages/interaction/fixtures/run7-requirements.json', import.meta.url);
const SCHEME_FIXTURE = new URL('../packages/interaction/fixtures/run7-rev2-scheme.json', import.meta.url);
const OLD_SPEC_FIXTURE = new URL('./fixtures/run7-old-build-spec.json', import.meta.url);
const LEGACY_UNSCOPED_FIXTURE = new URL('./fixtures/legacy-ses-check-example-build-spec.json', import.meta.url);
const RUN9_V2_DIR = new URL('./fixtures/conformance-run9-v2/', import.meta.url);
const REVISION = 2;
const SCHEME_ID = 'scheme-draft';

function readJson(path: URL): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-run7-links-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const RUN7 = RequirementGraph.parse(readJson(REQUIREMENTS_FIXTURE));
const REV2_SCHEME = DesignScheme.parse(readJson(SCHEME_FIXTURE));
const INTENT = readJson(INTENT_FIXTURE);
const resolved = expandDesignIntent(
  INTENT,
  createIntentHost(RUN7, { schemeId: SCHEME_ID, revision: REVISION, status: 'confirmed' }),
);
const scheme = resolved.scheme;
const spec = compileBuildSpec(scheme, RUN7);
const mustLinks = resolved.facts.mustLinks;
const TRUSTED = planVerifiedObjectMap(buildMustLedger(RUN7).entries, scheme);

function perfectRunFacts(input: BuildSpec): ReviewRunFacts {
  return {
    runId: `run-${input.schemeId}-perfect`,
    designId: input.schemeId,
    designRevision: input.schemeRevision,
    status: 'succeeded',
    failure: null,
    delivered: true,
    stopReason: null,
    checkPassed: true,
    cells: 500,
    bounds: [1, 1, 1, input.counts.footprintX, 4, input.counts.footprintZ],
    renders: 1,
  };
}

function detailFamilies(schemeValue: DesignScheme): {
  readonly objects: ReadonlySet<string>;
  readonly furniture: ReadonlySet<string>;
  readonly materials: ReadonlySet<string>;
  readonly sites: ReadonlySet<string>;
} {
  return {
    objects: new Set([
      ...schemeValue.elements.map((element) => element.id),
      ...schemeValue.openings.map((opening) => opening.id),
    ]),
    furniture: new Set(
      schemeValue.interiors.flatMap((interior) =>
        interior.furnitureSpecs.map((furniture) => `furniture:${furniture.id}`),
      ),
    ),
    materials: new Set(schemeValue.materials.map((material) => `material:${material.id}`)),
    sites: new Set(schemeValue.site.outdoorZones.map((zone) => `site:${zone.id}`)),
  };
}

test('1. real run-7 intent expands deterministically to the committed rev2 scheme (details excluded)', () => {
  assert.equal(scheme.meta.id, SCHEME_ID);
  assert.equal(scheme.meta.revision, REVISION);
  assert.equal(scheme.meta.status, 'confirmed');
  assert.deepEqual(scheme.elements, REV2_SCHEME.elements);
  assert.deepEqual(scheme.openings, REV2_SCHEME.openings);
  assert.deepEqual(scheme.interiors, REV2_SCHEME.interiors);
  assert.deepEqual(scheme.site, REV2_SCHEME.site);
});

test('2. design path emits real link details with requirement ids and resolvable refs', () => {
  assert.ok(scheme.details.length > 0, 'scheme.details 不能为空：链接必须进入真实设计路径');
  const families = detailFamilies(scheme);
  for (const detail of scheme.details) {
    assert.ok(detail.requirementIds.length > 0, `detail ${detail.id} 缺少 requirementIds`);
    assert.ok(detail.elementIds.length > 0, `detail ${detail.id} 缺少 elementIds`);
    for (const reference of detail.elementIds) {
      assert.ok(
        families.objects.has(reference) ||
          families.furniture.has(reference) ||
          families.materials.has(reference) ||
          families.sites.has(reference),
        `detail ${detail.id} 引用了方案中不存在的对象 ${reference}`,
      );
    }
  }
  assert.equal(
    scheme.details.every((detail) => detail.priority === 'should'),
    true,
    '链接 detail 不应升级成 must，否则会重复生成 detail-* must',
  );
});

test('3. compileBuildSpec keeps 41 musts, adds link details, reports exact coverage', () => {
  assert.equal(spec.musts.length, 41);
  assert.equal(spec.details.length, scheme.details.length);
  assert.ok(spec.details.length > 0, 'spec.details 不能为空');
  assert.equal(
    spec.musts.some((must) => must.id.startsWith('detail-')),
    false,
    'should 级 link detail 不能生成 detail-* must',
  );
  assert.ok(spec.musts.some((must) => must.id.startsWith('constraint-')));
  assert.equal(mustLinks.total, 41);
  assert.equal(mustLinks.entries.length, 41);
  assert.equal(mustLinks.explicit, 19);
  assert.equal(mustLinks.verified, 19);
  assert.equal(mustLinks.declaredOnly, 0);
  assert.equal(mustLinks.unlinked, 22);
  assert.equal(mustLinks.total, mustLinks.verified + mustLinks.declaredOnly + mustLinks.unlinked);
  assert.equal(mustLinks.explicit, mustLinks.verified + mustLinks.declaredOnly);

  const mustIds = new Set(spec.musts.map((must) => must.id));
  for (const entry of mustLinks.entries) {
    assert.ok(mustIds.has(entry.mustId), `coverage 引用了不存在的 must ${entry.mustId}`);
    if (entry.scope !== 'verified') {
      assert.ok(
        entry.reason !== null && entry.reason.trim() !== '',
        `${entry.mustId} scope=${entry.scope} 必须给出非空 reason`,
      );
    }
    if (entry.scope === 'verified') {
      assert.ok(entry.reason === null || entry.reason.trim() === '');
      assert.ok(entry.verifiedRefs.length > 0, `verified link ${entry.mustId} 没有 verifiedRefs`);
    } else {
      assert.equal(entry.verifiedRefs.length, 0, `${entry.mustId} 非 verified 不得携带 verifiedRefs`);
    }
    if (entry.scope === 'none') assert.equal(entry.objectRefs.length, 0, `${entry.mustId} unlinked 不得携带对象`);
    for (const reference of entry.objectRefs) assert.ok(reference.length > 0);
  }

  const sheet = buildBuildSheet(spec, TRUSTED);
  assert.equal(sheet.musts.length, 41);
  assert.equal(sheet.mustLinkage.verified, 19);
  assert.equal(sheet.mustLinkage.explicit, 19);
  assert.equal(sheet.mustLinkage.declared, 8);
  assert.equal(sheet.mustLinkage.explicitLinks, 19);
  assert.equal(sheet.mustLinkage.noDeclaredLinks, 22);
  assert.equal(sheet.mustLinkage.unlinked, 6);
  assert.equal(sheet.mustLinkage.linked, 35);
  assert.equal(sheet.mustLinkage.heuristicOnly, 16);
  assert.equal(
    sheet.mustLinkage.linked,
    sheet.mustLinkage.explicitLinks + sheet.mustLinkage.heuristicOnly,
    'linked 必须等于 explicitLinks + heuristicOnly',
  );

  const explicitLinkMusts = sheet.musts.filter(
    (must) => must.explicitObjectIds.length > 0 || must.declaredObjectIds.length > 0,
  );
  const declaredOnlyMusts = sheet.musts.filter((must) => must.linkScope === 'declared');
  const heuristicOnlyMusts = sheet.musts.filter((must) => must.linkScope === 'none' && must.objectIds.length > 0);
  const noExplicitMusts = sheet.musts.filter((must) => must.linkScope === 'none');
  const trulyUnlinked = sheet.musts.filter(
    (must) => must.linkScope === 'none' && must.objectIds.length === 0 && must.declaredObjectIds.length === 0,
  );
  assert.equal(explicitLinkMusts.length, 19);
  assert.equal(declaredOnlyMusts.length, 0);
  assert.equal(heuristicOnlyMusts.length, 16);
  assert.equal(noExplicitMusts.length, 22);
  assert.equal(trulyUnlinked.length, 6);
  assert.equal(explicitLinkMusts.length + heuristicOnlyMusts.length, sheet.mustLinkage.linked);
  assert.equal(
    heuristicOnlyMusts.some((must) => must.id === 'req-no-outdoor-zone'),
    true,
    'req-no-outdoor-zone 应只有启发式关键词链接，不能进入显式链接',
  );
  for (const must of heuristicOnlyMusts) {
    assert.equal(must.explicitObjectIds.length, 0);
    assert.equal(must.declaredObjectIds.length, 0);
    assert.equal(must.linkReason, 'heuristic-only');
  }
  for (const must of trulyUnlinked) assert.equal(must.linkReason, 'no-object-link');

  const byId = new Map(sheet.musts.map((must) => [must.id, must]));
  for (const entry of mustLinks.entries) {
    const must = byId.get(entry.mustId);
    assert.ok(must !== undefined, `BuildSheet 缺 must ${entry.mustId}`);
    if (entry.scope === 'verified') {
      assert.equal(must.linkScope, 'verified');
      assert.ok(must.explicitObjectIds.length > 0, `verified must ${entry.mustId} 没有 explicitObjectIds`);
    } else if (entry.scope === 'declared') {
      assert.equal(must.linkScope, 'declared');
      assert.equal(must.explicitObjectIds.length, 0, `declared must ${entry.mustId} 不得进入 explicitObjectIds`);
      assert.ok(must.declaredObjectIds.length > 0);
    } else {
      assert.equal(must.linkScope, 'none');
      assert.ok(must.linkReason !== null && must.linkReason.length > 0);
    }
  }
  console.log(
    `run-7 coverage: total=${String(mustLinks.total)} explicit=${String(mustLinks.explicit)} verified=${String(mustLinks.verified)} declaredOnly=${String(mustLinks.declaredOnly)} unlinked=${String(mustLinks.unlinked)}`,
  );
});

test('3b. forged verified map cannot produce met/accept in the real run-7 flow', () => {
  const forged = Object.fromEntries(spec.musts.map((must) => [must.id, ['wall:f1']]));
  const forgedSheet = buildBuildSheet(spec, forged);
  assert.equal(forgedSheet.mustLinkage.verified, 0);
  assert.deepEqual(buildVerifiedMustMapping(spec, forged).schemes, {});

  // 用一个全部期望对象 pass 的报告替代真实网格，只验证 trust boundary：伪造 map 不产生 met。
  const passItems = forgedSheet.expectedObjects.map((object, index) => ({
    id: `pass-${String(index)}`,
    expectedId: object.id,
    actualId: object.id,
    status: 'pass',
    severity: 'hard',
    reason: null,
  }));
  const report = { items: passItems } as unknown as ConformanceDiffReport;
  const specSha = '0'.repeat(64);
  const archiveSha = '1'.repeat(64);
  const forgedEvidence = buildConformanceEvidence(
    spec,
    forgedSheet,
    report,
    specSha,
    archiveSha,
    1,
    buildVerifiedMustMapping(spec, forged),
  );
  assert.equal(forgedEvidence.summary.met, 0);
  assert.equal(forgedEvidence.summary.acceptEligible, false);

  const trustedSheet = buildBuildSheet(spec, TRUSTED);
  const trustedEvidence = buildConformanceEvidence(
    spec,
    trustedSheet,
    report,
    specSha,
    archiveSha,
    1,
    buildVerifiedMustMapping(spec, TRUSTED),
  );
  assert.ok(Object.keys(buildVerifiedMustMapping(spec, TRUSTED).schemes[spec.schemeId] ?? {}).length > 0);
  assert.equal(trustedEvidence.summary.acceptEligible, false, '未豁免的 declared must 仍阻止 accept');
});

test('4. perfect run-7 grid recomputes shadow evidence from the real spec and verified mapping', async () => {
  await withTempDir(async (dir) => {
    const mapping = buildVerifiedMustMapping(spec, TRUSTED);
    const schemeMapping = mapping.schemes[spec.schemeId] ?? {};
    const verifiedIds = mustLinks.entries
      .filter((entry) => entry.scope === 'verified')
      .map((entry) => entry.mustId)
      .sort();
    assert.deepEqual(Object.keys(schemeMapping).sort(), verifiedIds, 'verified mapping 必须逐条对应 verified links');
    for (const [mustId, objectIds] of Object.entries(schemeMapping)) {
      assert.ok(objectIds.length > 0, `verified mapping ${mustId} 为空`);
    }

    const grid = buildRun7PerfectGrid(spec);
    const specPath = join(dir, 'build-spec.json');
    const archivePath = join(dir, 'building.pgar');
    const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
    await writeFile(specPath, specBytes);
    await writeFile(archivePath, writeArchive(grid, API_VERSION));
    const mappingPath = writeVerifiedMustMapArtifact(dir, mapping);
    const shadow = computeShadowConformance({ specPath, archivePath, outDir: dir, mappingPath });
    assert.equal(shadow.error, null, `shadow conformance 失败：${shadow.error ?? ''}`);
    assert.ok(shadow.report !== null);
    const report = shadow.report;
    const nonPass = report.items.filter((item) => item.status !== 'pass');
    assert.equal(
      nonPass.length,
      0,
      `perfect grid 仍有非 pass 几何项：${nonPass
        .map((item) => `${item.id}=${item.status}/${item.severity}${item.reason === null ? '' : `(${item.reason})`}`)
        .join(', ')}`,
    );
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.blocking, false);

    assert.ok(shadow.evidence !== null);
    const evidence = parseReviewEvidenceFile(shadow.evidence);
    assert.equal(evidence.mapping, 'verified');
    // Wave6：父 must 状态来自 clause 实测，不再等于旧的 verified-link 数。
    assert.equal(evidence.summary.met, 21);
    assert.equal(evidence.summary.notMet, 0);
    assert.equal(evidence.summary.waived, 0);
    assert.equal(evidence.summary.unverified, 20);
    assert.equal(evidence.clauseSummary?.musts, 41);
    assert.equal(evidence.summary.acceptEligible, false);
    console.log(
      `perfect evidence: met=${String(evidence.summary.met)} notMet=${String(evidence.summary.notMet)} unverified=${String(evidence.summary.unverified)} acceptEligible=${String(evidence.summary.acceptEligible)}`,
    );
  });
});

test('4b. unmodeled extra opening stays a soft extra and makes compound south-window musts not-met', async () => {
  await withTempDir(async (dir) => {
    const mapping = buildVerifiedMustMapping(spec, TRUSTED);
    const schemeMapping = mapping.schemes[spec.schemeId] ?? {};
    assert.equal('constraint-con-window-south' in schemeMapping, true);
    assert.equal('req-window-south-4m' in schemeMapping, false);

    const grid = buildRun7PerfectGrid(spec, { extraSouthWindow: true });
    const specPath = join(dir, 'build-spec.json');
    const archivePath = join(dir, 'building.pgar');
    const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
    await writeFile(specPath, specBytes);
    await writeFile(archivePath, writeArchive(grid, API_VERSION));
    const mappingPath = writeVerifiedMustMapArtifact(dir, mapping);
    const shadow = computeShadowConformance({ specPath, archivePath, outDir: dir, mappingPath });
    assert.equal(shadow.error, null, `negative-control shadow 失败：${shadow.error ?? ''}`);
    assert.ok(shadow.report !== null);
    const report = shadow.report;
    const extras = report.items.filter((item) => item.status === 'extra' && item.kind === 'opening');
    assert.equal(extras.length, 1, '应恰好有一条未建模洞口被报告为 extra');
    const extra = extras[0];
    assert.ok(extra !== undefined);
    assert.equal(extra.severity, 'soft');
    assert.equal(extra.expectedId, null);
    const extraActual = extra.actual as {
      readonly confidence?: string;
      readonly subtype?: string;
      readonly bounds?: { readonly min: readonly number[] };
    };
    assert.equal(extraActual.confidence, 'high');
    assert.equal(extraActual.subtype, 'window');
    assert.equal(extraActual.bounds?.min[2], spec.bounds.max[2] - 1, 'extra opening 应位于南墙');
    assert.equal(report.summary.extra, 1);
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.pass, 5);
    assert.equal(report.summary.blocking, false);

    assert.ok(shadow.evidence !== null);
    const evidence = parseReviewEvidenceFile(shadow.evidence);
    // extra south opening：两条“南墙唯一洞口”must 必须 not-met；其余父 must 不再被连带降级。
    assert.equal(evidence.summary.met, 20);
    assert.equal(evidence.summary.notMet, 2);
    assert.equal(evidence.summary.unverified, 19);
    assert.equal(evidence.summary.acceptEligible, false);
    const byId = new Map(evidence.musts.map((must) => [must.mustId, must]));
    assert.equal(byId.get('constraint-con-window-south')?.status, 'not-met');
    assert.equal(byId.get('req-window-south-4m')?.status, 'not-met');
    console.log(
      `extra-opening control: extra=${String(report.summary.extra)} blocking=${String(report.summary.blocking)} met=${String(evidence.summary.met)} unverified=${String(evidence.summary.unverified)}`,
    );
  });
});

test('5. accept path needs explicit user waivers for exactly the unverified musts; no false accept', async () => {
  await withTempDir(async (dir) => {
    const mapping = buildVerifiedMustMapping(spec, TRUSTED);
    const grid = buildRun7PerfectGrid(spec);
    const specPath = join(dir, 'build-spec.json');
    const archivePath = join(dir, 'building.pgar');
    const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
    const archiveBytes = writeArchive(grid, API_VERSION);
    await writeFile(specPath, specBytes);
    await writeFile(archivePath, archiveBytes);
    const mappingPath = writeVerifiedMustMapArtifact(dir, mapping);
    const shadow = computeShadowConformance({ specPath, archivePath, outDir: dir, mappingPath });
    assert.equal(shadow.error, null);
    assert.ok(shadow.evidence !== null);
    const evidence = parseReviewEvidenceFile(shadow.evidence);
    const binding = { specSha256: sha256(specBytes), archiveSha256: sha256(archiveBytes) };

    const verifiedIds = new Set(
      mustLinks.entries.filter((entry) => entry.scope === 'verified').map((entry) => entry.mustId),
    );
    const unverified = evidence.musts.filter((must) => must.status === 'unverified');
    assert.equal(unverified.length, 20);
    assert.equal(verifiedIds.size, 19);
    const waivers = unverified.map((must) => {
      return {
        mustId: must.mustId,
        designRevision: REVISION,
        by: 'user' as const,
        choice: '接受该必须项无法由几何差异证据验证，由用户明确豁免',
        conflictId: null,
        note: 'run-7 perfect-grid acceptance fixture',
      };
    });
    assert.equal(waivers.length, 20);
    assert.equal(new Set(waivers.map((waiver) => waiver.mustId)).size, waivers.length);

    const verifiedMustIds = Object.keys(mapping.schemes[spec.schemeId] ?? {});
    const noWaiver = buildReviewReport({
      spec,
      run: perfectRunFacts(spec),
      evidence,
      evidenceBinding: binding,
      verifiedMustIds,
    });
    assert.notEqual(noWaiver.nextAction.kind, 'accept', '没有豁免时不得 accept');
    assert.equal(noWaiver.verdict.status, 'partial');
    assert.equal(noWaiver.nextAction.kind, 'ask-user');
    assert.equal(
      noWaiver.verdict.musts.some((must) => must.status === 'unverified'),
      true,
    );

    const accepted = buildReviewReport({
      spec,
      run: perfectRunFacts(spec),
      evidence,
      evidenceBinding: binding,
      verifiedMustIds,
      waivers,
    });
    assert.equal(accepted.verdict.status, 'satisfied');
    assert.equal(accepted.nextAction.kind, 'accept');
    assert.equal(
      accepted.verdict.musts.every((must) => must.status === 'met' || must.status === 'waived'),
      true,
    );
    const acceptedById = new Map(accepted.verdict.musts.map((must) => [must.requirementId, must]));
    // 目标绑定实测的 must 保持 met；旧 verified-link 不再是 met 的唯一来源。
    assert.equal(acceptedById.get('req-long-table')?.status, 'met');
    assert.equal(acceptedById.get('req-window-dim')?.status, 'met');
    for (const waiver of waivers) {
      assert.equal(acceptedById.get(waiver.mustId)?.status, 'waived');
    }
    assert.equal(accepted.verdict.mustsTruncated, false);
  });
});

test('6. same schemeId/revision with a different spec or archive hash rejects evidence', async () => {
  await withTempDir(async (dir) => {
    const mapping = buildVerifiedMustMapping(spec, TRUSTED);
    const grid = buildRun7PerfectGrid(spec);
    const specPath = join(dir, 'build-spec.json');
    const archivePath = join(dir, 'building.pgar');
    const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
    const archiveBytes = writeArchive(grid, API_VERSION);
    await writeFile(specPath, specBytes);
    await writeFile(archivePath, archiveBytes);
    const mappingPath = writeVerifiedMustMapArtifact(dir, mapping);
    const shadow = computeShadowConformance({ specPath, archivePath, outDir: dir, mappingPath });
    assert.equal(shadow.error, null);
    assert.ok(shadow.evidence !== null);
    const evidence = parseReviewEvidenceFile(shadow.evidence);
    const specSha = sha256(specBytes);
    const archiveSha = sha256(archiveBytes);

    // Same schemeId / revision, different title bytes: the artifact hash must still bind.
    const changedSpec = { ...spec, title: `${spec.title}（未授权改动）` };
    const changedSpecBytes = Buffer.from(`${JSON.stringify(changedSpec, null, 2)}\n`);
    assert.equal(changedSpec.schemeId, spec.schemeId);
    assert.equal(changedSpec.schemeRevision, spec.schemeRevision);
    const changedSpecSha = sha256(changedSpecBytes);
    assert.notEqual(changedSpecSha, specSha);
    const wrongArchiveSha = `${archiveSha.startsWith('0') ? '1' : '0'}${archiveSha.slice(1)}`;
    assert.notEqual(wrongArchiveSha, archiveSha);

    assert.equal(reviewEvidenceMatchesArtifacts(evidence, { specSha256: specSha, archiveSha256: archiveSha }), true);
    assert.equal(
      reviewEvidenceMatchesArtifacts(evidence, { specSha256: changedSpecSha, archiveSha256: archiveSha }),
      false,
    );
    assert.equal(
      reviewEvidenceMatchesArtifacts(evidence, { specSha256: specSha, archiveSha256: wrongArchiveSha }),
      false,
    );

    const rejectedSpec = resolveReviewMusts({
      schemeId: spec.schemeId,
      designRevision: spec.schemeRevision,
      musts: spec.musts,
      evidence,
      specSha256: changedSpecSha,
      archiveSha256: archiveSha,
    });
    assert.equal(rejectedSpec.length, 41);
    assert.equal(
      rejectedSpec.every((must) => must.status === 'unverified'),
      true,
      'spec hash 不一致时全部 must 必须 unverified',
    );

    const rejectedArchive = resolveReviewMusts({
      schemeId: spec.schemeId,
      designRevision: spec.schemeRevision,
      musts: spec.musts,
      evidence,
      specSha256: specSha,
      archiveSha256: wrongArchiveSha,
    });
    assert.equal(
      rejectedArchive.every((must) => must.status === 'unverified'),
      true,
    );

    assert.deepEqual(
      await readRunReviewEvidence(dir, { specSha256: specSha, archiveSha256: archiveSha }, specPath, TRUSTED),
      evidence,
    );
    assert.equal(
      await readRunReviewEvidence(dir, { specSha256: changedSpecSha, archiveSha256: archiveSha }, specPath, TRUSTED),
      null,
    );
    assert.equal(
      await readRunReviewEvidence(dir, { specSha256: specSha, archiveSha256: wrongArchiveSha }, specPath, TRUSTED),
      null,
    );

    const rejectedReport = buildReviewReport({
      spec,
      run: perfectRunFacts(spec),
      evidence,
      evidenceBinding: { specSha256: changedSpecSha, archiveSha256: archiveSha },
    });
    assert.equal(
      rejectedReport.verdict.musts.every((must) => must.status === 'unverified'),
      true,
    );
    assert.notEqual(rejectedReport.nextAction.kind, 'accept');
  });
});

test('7. old run-7 scheme/build-spec with 0 details still parse and keep verified mapping empty', async () => {
  const oldSpec = BuildSpec.parse(JSON.parse(await readFile(OLD_SPEC_FIXTURE, 'utf8')));
  assert.equal(oldSpec.details.length, 0);
  assert.equal(oldSpec.musts.length, 41);
  const sheet = buildBuildSheet(oldSpec);
  assert.equal(sheet.musts.length, 41);
  assert.equal(sheet.mustLinkage.explicit, 0);
  assert.equal(sheet.mustLinkage.verified, 0);
  assert.equal(sheet.mustLinkage.declared, 0);
  assert.equal(sheet.mustLinkage.unlinked > 0, true);
  assert.deepEqual(buildVerifiedMustMapping(oldSpec).schemes, {});
  assert.equal(REV2_SCHEME.details.length, 0);
});

test('7b. legacy unscoped details are declared only: 0 verified / 41 unverified / no accept', async () => {
  const oldSpec = BuildSpec.parse(JSON.parse(await readFile(OLD_SPEC_FIXTURE, 'utf8')));
  const wall = oldSpec.elements.find((element) => element.kind === 'wall');
  assert.ok(wall !== undefined);
  const legacyDetails = oldSpec.musts.map((must, index) => ({
    id: `legacy-link-${String(index)}`,
    name: `legacy ${must.id}`,
    where: 'legacy unscoped detail',
    elementIds: [wall.id],
    count: null,
    description: must.text,
    priority: 'should' as const,
    requirementIds: [must.id],
  }));
  const unscoped = BuildSpec.parse({ ...oldSpec, details: legacyDetails });
  const sheet = buildBuildSheet(unscoped);
  assert.equal(sheet.schemaVersion, 2);
  assert.equal(sheet.mustLinkage.verified, 0);
  assert.equal(sheet.mustLinkage.explicit, 41);
  assert.equal(sheet.mustLinkage.declared, 41);
  assert.equal(
    sheet.musts.every((must) => must.linkScope === 'declared'),
    true,
  );
  assert.deepEqual(buildVerifiedMustMapping(unscoped).schemes, {});

  await withTempDir(async (dir) => {
    const specPath = join(dir, 'build-spec.json');
    const archivePath = join(dir, 'building.pgar');
    await writeFile(specPath, `${JSON.stringify(unscoped, null, 2)}\n`, 'utf8');
    await writeFile(archivePath, writeArchive(buildRun7PerfectGrid(unscoped), API_VERSION));
    const shadow = computeShadowConformance({
      specPath,
      archivePath,
      outDir: dir,
      verifiedMapping: buildVerifiedMustMapping(unscoped),
    });
    assert.equal(shadow.error, null, shadow.error ?? '');
    assert.ok(shadow.evidence !== null);
    const evidence = parseReviewEvidenceFile(shadow.evidence);
    assert.equal(evidence.mapping, 'heuristic');
    // 旧 details 不能产生 verified；但 clause 实测仍可独立证明可测 must。
    assert.equal(evidence.summary.met, 21);
    assert.equal(evidence.summary.unverified, 20);
    assert.equal(evidence.summary.notMet, 0);
    assert.equal(evidence.summary.acceptEligible, false);
    const furniture = evidence.musts.find((must) => must.mustId === 'req-long-table');
    assert.ok(furniture !== undefined);
    assert.equal(furniture.status, 'met');
    const qualitative = evidence.musts.find((must) => must.mustId === 'req-single-hall');
    assert.ok(qualitative !== undefined);
    assert.equal(qualitative.status, 'unverified');

    const review = buildReviewReport({
      spec: unscoped,
      run: perfectRunFacts(unscoped),
      evidence,
      evidenceBinding: { specSha256: evidence.spec.sha256, archiveSha256: evidence.archive.sha256 },
      verifiedMustIds: [],
    });
    assert.notEqual(review.verdict.status, 'satisfied');
    assert.notEqual(review.nextAction.kind, 'accept');
  });

  // 已知旧会话 ses-check-example：3 条未标 linkScope 的 details 曾让 4 条 must 变成 verified。
  const knownLegacy = BuildSpec.parse(JSON.parse(await readFile(LEGACY_UNSCOPED_FIXTURE, 'utf8')));
  const knownSheet = buildBuildSheet(knownLegacy);
  assert.equal(
    knownLegacy.details.every((detail) => detail.linkScope === undefined),
    true,
  );
  assert.equal(knownSheet.mustLinkage.verified, 0);
  assert.equal(knownSheet.mustLinkage.explicit, 4);
  assert.deepEqual(buildVerifiedMustMapping(knownLegacy).schemes, {});
});

test('9. hand-authored 41-met evidence with the same hashes is rejected; no accept', async () => {
  await withTempDir(async (dir) => {
    const mapping = buildVerifiedMustMapping(spec, TRUSTED);
    const grid = buildRun7PerfectGrid(spec);
    const specPath = join(dir, 'build-spec.json');
    const archivePath = join(dir, 'building.pgar');
    const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
    const archiveBytes = writeArchive(grid, API_VERSION);
    await writeFile(specPath, specBytes);
    await writeFile(archivePath, archiveBytes);
    const shadow = computeShadowConformance({ specPath, archivePath, outDir: dir, verifiedMapping: mapping });
    assert.equal(shadow.error, null);
    assert.ok(shadow.evidence !== null);
    const fabricated = JSON.parse(await readFile(join(dir, 'conformance-evidence.json'), 'utf8')) as {
      mapping: string;
      musts: { status: string; confidence: string; objects: unknown[]; evidence: unknown[]; reason: unknown }[];
      summary: Record<string, unknown>;
    };
    fabricated.mapping = 'verified';
    for (const must of fabricated.musts) {
      must.status = 'met';
      must.confidence = 'high';
      must.objects = [{ expectedId: 'fabricated', actualId: 'fabricated', status: 'pass', severity: 'hard' }];
      must.evidence = [{ kind: 'diff', ref: 'fabricated', summary: 'pass/hard' }];
      must.reason = null;
    }
    fabricated.summary = { met: 41, notMet: 0, waived: 0, unverified: 0, acceptEligible: true };
    // 手工 41-met 文件同时抹掉 clause 证据，走旧 must 级 fail-closed 路径。
    const legacyFabricated = fabricated as Record<string, unknown>;
    delete legacyFabricated['clauses'];
    delete legacyFabricated['clauseGroups'];
    delete legacyFabricated['clauseSummary'];
    await writeFile(join(dir, 'conformance-evidence.json'), `${JSON.stringify(fabricated, null, 2)}\n`, 'utf8');
    const binding = { specSha256: sha256(specBytes), archiveSha256: sha256(archiveBytes) };
    assert.equal(await readRunReviewEvidence(dir, binding, specPath, TRUSTED), null);
    const parsed = parseReviewEvidenceFile(fabricated);
    const resolved = resolveReviewMusts({
      schemeId: spec.schemeId,
      designRevision: spec.schemeRevision,
      musts: spec.musts,
      evidence: parsed,
      ...binding,
      verifiedMustIds: Object.keys(mapping.schemes[spec.schemeId] ?? {}),
    });
    assert.equal(
      resolved.every((must) => must.status === 'unverified'),
      true,
    );
    assert.equal(summarizeReviewMusts(resolved).acceptEligible, false);

    await writeFile(join(dir, 'events.jsonl'), '', 'utf8');
    const review = await defaultWebReviewBuilder({
      spec,
      specPath,
      verifiedMustObjects: TRUSTED,
      result: {
        outcome: {
          runId: 'run-fabricated-evidence',
          dir,
          stopReason: null,
          delivery: { codeVersion: 1, hash: 'fixture-hash' },
          costCny: 0,
          turns: 1,
        },
        runDir: dir,
        delivery: { codeVersion: 1, hash: 'fixture-hash' },
        renders: ['render.png'],
        shadow: { summary: 'fixture', diffPath: null, evidencePath: null, error: null },
      },
    });
    assert.equal(
      review.verdict.musts.every((must) => must.status === 'unverified'),
      true,
    );
    assert.notEqual(review.nextAction.kind, 'accept');
  });
});

test('8. run-9 v2 frozen evidence stays 4 hard fails / no accept with correct hash binding', async () => {
  const run9SpecBytes = await readFile(new URL('build-spec.json', RUN9_V2_DIR));
  const run9ArchiveBytes = await readFile(new URL('building.pgar', RUN9_V2_DIR));
  const run9SpecSha = sha256(run9SpecBytes);
  const run9ArchiveSha = sha256(run9ArchiveBytes);
  const run9Spec = BuildSpec.parse(JSON.parse(run9SpecBytes.toString('utf8')));
  const report = JSON.parse(
    await readFile(new URL('conformance-report.json', RUN9_V2_DIR), 'utf8'),
  ) as ConformanceDiffReport;
  assert.equal(run9SpecSha, report.spec.sha256, 'fixture spec 字节哈希必须等于冻结报告哈希');
  assert.equal(run9ArchiveSha, report.archive.sha256, 'fixture archive 字节哈希必须等于冻结报告哈希');
  assert.equal(run9ArchiveBytes.byteLength, report.archive.bytes, 'fixture archive 字节数必须等于冻结报告');
  const hardFails = report.items.filter((item) => item.status === 'fail' && item.severity === 'hard');
  assert.equal(hardFails.length, 4);
  const sheet = buildBuildSheet(run9Spec);
  const evidence = parseReviewEvidenceFile(
    buildConformanceEvidence(run9Spec, sheet, report, run9SpecSha, run9ArchiveSha, run9ArchiveBytes.byteLength),
  );
  assert.equal(
    reviewEvidenceMatchesArtifacts(evidence, {
      specSha256: run9SpecSha,
      archiveSha256: run9ArchiveSha,
    }),
    true,
  );
  const resolvedRun9 = resolveReviewMusts({
    schemeId: run9Spec.schemeId,
    designRevision: run9Spec.schemeRevision,
    musts: run9Spec.musts,
    evidence,
    specSha256: run9SpecSha,
    archiveSha256: run9ArchiveSha,
  });
  const summary = summarizeReviewMusts(resolvedRun9);
  assert.deepEqual(
    {
      met: summary.met,
      notMet: summary.notMet,
      unverified: summary.unverified,
      acceptEligible: summary.acceptEligible,
    },
    { met: 0, notMet: 4, unverified: 37, acceptEligible: false },
  );
  const review = buildReviewReport({
    spec: run9Spec,
    run: {
      runId: 'run-9-v2',
      designId: run9Spec.schemeId,
      designRevision: run9Spec.schemeRevision,
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
    evidenceBinding: { specSha256: run9SpecSha, archiveSha256: run9ArchiveSha },
    verifiedMustIds: [],
  });
  assert.notEqual(review.nextAction.kind, 'accept');
  assert.notEqual(review.verdict.status, 'satisfied');
});
