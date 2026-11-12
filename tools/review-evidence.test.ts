/**
 * R1 评审证据回归：真实 Build Lead 证据（H1–H4 verified、run-9 v1/v2 hard fail、
 * scheme 作用域及 50 条链接上限）与网页评审 call-site。
 * 只读 fixture / 写临时目录，不联网、不跑 live / build。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { writeArchive } from '@pg/core/archive';
import { API_VERSION } from '@pg/geometry';
import type { ReviewReport } from '@pg/interaction/review';
import type { ReviewEvidenceFile } from '@pg/interaction/review-evidence';
import {
  parseReviewEvidenceFile,
  resolveReviewMusts,
  reviewEvidenceMatchesArtifacts,
  summarizeReviewMusts,
} from '@pg/interaction/review-evidence';
import { buildReviewReport } from '@pg/interaction/review-generate';
import type { ReviewRunFacts } from '@pg/interaction/review-generate';
import { BuildSpec } from '@pg/interaction/schema';

import { adoptVerifiedMustMapping, buildBuildSheet, buildVerifiedMustMapping } from './build-sheet.ts';
import type { ConformanceDiffReport } from './conformance-diff.ts';
import { buildFixture } from './conformance-matrix-fixtures.ts';
import { buildConformanceEvidence, computeShadowConformance, MAX_EVIDENCE_LINKS } from './conformance-shadow.ts';
import type { VerifiedMustMapping } from './conformance-shadow.ts';
import { defaultWebReviewBuilder, readRunReviewEvidence } from './interaction-server-build.ts';

const RUN9_DIR = fileURLToPath(new URL('./fixtures/conformance-run9/', import.meta.url));
const RUN9_V2_DIR = fileURLToPath(new URL('./fixtures/conformance-run9-v2/', import.meta.url));
const MATRIX_MAPPING = fileURLToPath(new URL('./fixtures/conformance-matrix-verified-mapping.json', import.meta.url));

/** 当前 BuildSheet 可重新派生的显式链接；测试不再使用外部 mapping 文件绕过 provenance。 */
function withExplicitLinks(spec: BuildSpec): BuildSpec {
  const door = spec.openings.find((opening) => opening.kind !== 'window');
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
        priority: 'should',
        requirementIds: spec.musts.map((must) => must.id),
        linkScope: 'verified',
      },
    ],
  });
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-review-evidence-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readSpec(path: string): Promise<BuildSpec> {
  return BuildSpec.parse(JSON.parse(await readFile(path, 'utf8')));
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function runFacts(spec: BuildSpec): ReviewRunFacts {
  return {
    runId: 'run-review-evidence',
    designId: spec.schemeId,
    designRevision: spec.schemeRevision,
    status: 'succeeded',
    failure: null,
    delivered: true,
    stopReason: null,
    checkPassed: true,
    cells: null,
    bounds: null,
    renders: 2,
  };
}

function reportFor(spec: BuildSpec, evidence: ReviewEvidenceFile): ReviewReport {
  return buildReviewReport({
    spec,
    run: runFacts(spec),
    visual: { verdict: 'pass', strengths: [], weaknesses: [], notes: ['离线证据测试'] },
    evidence,
    evidenceBinding: { specSha256: evidence.spec.sha256, archiveSha256: evidence.archive.sha256 },
    verifiedMustIds: [],
  });
}

test('run-9 v1 冻结证据：5 个 hard fail 各有一条直接 not-met，家具不被连带判失败', async () => {
  const spec = await readSpec(join(RUN9_DIR, 'build-spec.json'));
  const report = JSON.parse(await readFile(join(RUN9_DIR, 'conformance-report.json'), 'utf8')) as ConformanceDiffReport;
  const hardFails = report.items.filter((item) => item.status === 'fail' && item.severity === 'hard');
  assert.equal(hardFails.length, 5);

  const sheet = buildBuildSheet(spec);
  const evidence = parseReviewEvidenceFile(
    buildConformanceEvidence(spec, sheet, report, report.spec.sha256, report.archive.sha256, report.archive.bytes),
  );
  assert.equal(evidence.mapping, 'heuristic');
  assert.equal(evidence.summary.notMet > 0, true);
  assert.equal(evidence.summary.met, 0);

  const resolved = resolveReviewMusts({
    schemeId: spec.schemeId,
    designRevision: spec.schemeRevision,
    musts: spec.musts,
    evidence,
    specSha256: report.spec.sha256,
    archiveSha256: report.archive.sha256,
    verifiedMustIds: [],
  });
  for (const fail of hardFails) {
    const expectedId = fail.expectedId;
    assert.ok(expectedId !== null, `hard fail ${fail.id} 缺 expectedId`);
    const linked = resolved.filter((must) => must.objects.some((object) => object.expectedId === expectedId));
    assert.ok(linked.length > 0, `${expectedId} 没有映射到任何 must`);
    assert.equal(
      linked.some((must) => must.status === 'not-met'),
      true,
      `${expectedId} 至少有一条直接 must 为 not-met`,
    );
  }
  // 家具必须项只被宽泛链接到墙 / 洞口，不能继承 hard fail。
  for (const furnitureId of ['req-long-table', 'req-counter', 'req-bench-north', 'req-bench-south']) {
    const furniture = resolved.find((must) => must.requirementId === furnitureId);
    assert.ok(furniture !== undefined, `缺少 ${furnitureId}`);
    assert.notEqual(furniture.status, 'not-met', `${furnitureId} 不应被墙 / 洞口 hard fail 连带判失败`);
    assert.equal(furniture.status, 'unverified');
  }
  assert.equal(
    resolved.some((must) => must.status === 'met'),
    false,
  );
  const summary = summarizeReviewMusts(resolved);
  assert.equal(summary.notMet >= 5, true);
  assert.equal(summary.acceptEligible, false);

  const review = reportFor(spec, evidence);
  assert.equal(review.verdict.status, 'not-satisfied');
  assert.notEqual(review.nextAction.kind, 'accept');
  assert.equal(review.nextAction.kind, 'targeted-revision');
  assert.equal(
    review.verdict.musts.some((must) => must.status === 'not-met'),
    true,
  );
});

test('run-9 v2 冻结证据：summary 0/21/20，只有直接归属的 not-met，否定型必须项不连带', async () => {
  const spec = await readSpec(join(RUN9_V2_DIR, 'build-spec.json'));
  const report = JSON.parse(
    await readFile(join(RUN9_V2_DIR, 'conformance-report.json'), 'utf8'),
  ) as ConformanceDiffReport;
  assert.equal(report.items.filter((item) => item.status === 'fail' && item.severity === 'hard').length, 4);

  const sheet = buildBuildSheet(spec);
  const evidence = parseReviewEvidenceFile(
    buildConformanceEvidence(spec, sheet, report, report.spec.sha256, report.archive.sha256, report.archive.bytes),
  );
  assert.equal(evidence.mapping, 'heuristic');
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
  });
  const summary = summarizeReviewMusts(resolved);
  assert.equal(summary.met, 0);
  // 否定型 must 不归因；四条正面、直接链接且全部 hard fail 的 must 仍为 not-met。
  assert.equal(summary.notMet, 4);
  for (const mustId of ['req-door-clear-1m', 'req-window-dim', 'req-gable-tile-roof', 'constraint-con-door-clear-1m']) {
    const must = resolved.find((item) => item.requirementId === mustId);
    assert.ok(must !== undefined, `缺少 ${mustId}`);
    assert.equal(must.status, 'not-met', `${mustId} 应保持直接 hard fail 归因`);
  }

  for (const mustId of ['req-no-sign-ticket-frame', 'req-no-outdoor-zone', 'req-no-steps', 'req-eave-only']) {
    const must = resolved.find((item) => item.requirementId === mustId);
    assert.ok(must !== undefined, `缺少 ${mustId}`);
    assert.equal(must.status, 'unverified', `${mustId} 不应因无关 hard fail 变成 not-met`);
  }

  for (const must of resolved.filter((item) => item.status === 'not-met')) {
    assert.ok(must.objects.length > 0, `${must.requirementId} 没有关联对象`);
    assert.equal(
      must.objects.every((object) => object.status === 'fail' && object.severity === 'hard'),
      true,
      `${must.requirementId} 的 not-met 不是全部 hard fail 直接归属`,
    );
  }
});

test('verified mapping 按 scheme 生效：空 schemes / 其他 scheme 不改变 run-9 v2 的 heuristic 计数', async () => {
  const spec = await readSpec(join(RUN9_V2_DIR, 'build-spec.json'));
  const report = JSON.parse(
    await readFile(join(RUN9_V2_DIR, 'conformance-report.json'), 'utf8'),
  ) as ConformanceDiffReport;
  const sheet = buildBuildSheet(spec);
  const build = (verifiedMapping?: VerifiedMustMapping): ReturnType<typeof buildConformanceEvidence> =>
    buildConformanceEvidence(
      spec,
      sheet,
      report,
      report.spec.sha256,
      report.archive.sha256,
      report.archive.bytes,
      verifiedMapping,
    );

  const heuristic = build();
  assert.equal(heuristic.mapping, 'heuristic');
  assert.equal(heuristic.summary.notMet, 21);

  const emptySchemes: VerifiedMustMapping = {
    schemaVersion: 1,
    tool: 'verified-must-map',
    mapping: 'verified',
    schemeRevision: 1,
    schemes: {},
  };
  const empty = build(emptySchemes);
  assert.equal(empty.mapping, 'heuristic');
  assert.deepEqual(empty.summary, heuristic.summary);
  assert.deepEqual(empty.musts, heuristic.musts);

  const otherScheme: VerifiedMustMapping = {
    ...emptySchemes,
    schemes: { 'scheme-other': {} },
  };
  const other = build(otherScheme);
  assert.equal(other.mapping, 'heuristic');
  assert.deepEqual(other.summary, heuristic.summary);
  assert.deepEqual(other.musts, heuristic.musts);
});

test('单个 must 超过 50 条链接：状态按全部链接计算，objects / evidence 截断到 50 且文件可解析', async () => {
  const spec = await readSpec(join(RUN9_V2_DIR, 'build-spec.json'));
  const sheet = buildBuildSheet(spec);
  const target = sheet.musts.find((must) => must.objectIds.length > 0);
  assert.ok(target !== undefined, 'run-9 v2 应至少有一个启发式链接的 must');

  const linkId = target.objectIds[0];
  assert.ok(linkId !== undefined);
  const linkedIds = Array.from({ length: MAX_EVIDENCE_LINKS + 10 }, () => linkId);
  const report = {
    items: linkedIds.map((expectedId) => ({
      id: `expected:${expectedId}`,
      kind: 'wall' as const,
      expectedId,
      actualId: expectedId,
      status: 'pass' as const,
      severity: 'hard' as const,
      expected: null,
      actual: null,
      delta: {},
      evidence: [],
      reason: null,
    })),
  } as unknown as ConformanceDiffReport;
  const mapping: VerifiedMustMapping = adoptVerifiedMustMapping({
    schemaVersion: 1,
    tool: 'verified-must-map',
    mapping: 'verified',
    schemeRevision: spec.schemeRevision,
    schemes: { [spec.schemeId]: { [target.id]: linkedIds } },
  });

  const evidence = parseReviewEvidenceFile(
    buildConformanceEvidence(spec, sheet, report, 'a'.repeat(64), 'b'.repeat(64), 123, mapping),
  );
  const entry = evidence.musts.find((must) => must.mustId === target.id);
  assert.ok(entry !== undefined);
  // 无 coverage 的低层调用只验证链接截断；产品证据路径会传入 coverage。
  assert.equal(entry.status, 'unverified');
  assert.equal(entry.objects.length, MAX_EVIDENCE_LINKS);
  assert.equal(entry.evidence.length, MAX_EVIDENCE_LINKS);
  assert.equal(MAX_EVIDENCE_LINKS, 50);
});

test('H1–H4 手写 linkScope verified 不再产生 verified；证据读取与网页评审都 fail closed', async () => {
  for (const house of ['H1', 'H2', 'H3', 'H4'] as const) {
    await withTempDir(async (dir) => {
      const fixture = buildFixture(house, 'good');
      const spec = withExplicitLinks(fixture.spec);
      assert.deepEqual(buildVerifiedMustMapping(spec).schemes, {});
      const specPath = join(dir, 'build-spec.json');
      const archivePath = join(dir, 'building.pgar');
      const specBytes = `${JSON.stringify(spec, null, 2)}\n`;
      const archiveBytes = writeArchive(fixture.grid, API_VERSION);
      await writeFile(specPath, specBytes, 'utf8');
      await writeFile(archivePath, archiveBytes);

      const shadow = computeShadowConformance({ specPath, archivePath, outDir: dir });
      assert.equal(shadow.error, null, `${house} 影子证据失败：${shadow.error ?? ''}`);
      assert.equal(shadow.evidence?.mapping, 'heuristic');

      const evidence = await readRunReviewEvidence(dir, {
        specSha256: sha256Bytes(specBytes),
        archiveSha256: sha256Bytes(archiveBytes),
      });
      assert.ok(evidence !== null, `${house} 应能读取 conformance-evidence.json`);
      const resolved = resolveReviewMusts({
        schemeId: spec.schemeId,
        designRevision: spec.schemeRevision,
        musts: spec.musts,
        evidence,
        specSha256: sha256Bytes(specBytes),
        archiveSha256: sha256Bytes(archiveBytes),
        verifiedMustIds: [],
      });
      assert.equal(
        resolved.every((must) => must.status === 'unverified' || (must.status === 'met' && must.clauses.length > 0)),
        true,
        `${house} 手写 details 不能变成 verified；met 只能来自 clause 实测`,
      );
      assert.equal(summarizeReviewMusts(resolved).acceptEligible, false);
    });
  }
});

function webReviewAcceptPredicate(): (report: unknown) => boolean {
  const source = readFileSync(new URL('./interaction-web/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function reviewAcceptEligible');
  const end = source.indexOf('\nfunction syncReviewControls', start);
  assert.ok(start >= 0 && end > start, 'app.js 缺 reviewAcceptEligible');
  const sandbox = {
    isRecord: (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value),
    reviewText: (value: unknown): string => (typeof value === 'string' ? value : ''),
    reviewReport: () => null,
  };
  return runInNewContext(`${source.slice(start, end)}\nreviewAcceptEligible;`, sandbox) as (report: unknown) => boolean;
}

test('Web 评审接受谓词与 server 门槛一致：partial / ask-user / 截断 / 无效豁免都不能接受', () => {
  const accept = webReviewAcceptPredicate();
  const met = { requirementId: 'must-a', status: 'met', waiver: null };
  const waived = {
    requirementId: 'must-b',
    status: 'waived',
    waiver: { mustId: 'must-b', designRevision: 2, by: 'user', choice: '接受', conflictId: null, note: null },
  };
  const base = {
    designVersion: { schemeId: 'scheme-test', revision: 2 },
    verdict: { status: 'satisfied', musts: [met, waived], mustsTruncated: false },
    nextAction: { kind: 'accept' },
  };
  assert.equal(accept(base), true);
  assert.equal(
    accept({ ...base, verdict: { ...base.verdict, status: 'partial' }, nextAction: { kind: 'ask-user' } }),
    false,
  );
  assert.equal(accept({ ...base, nextAction: { kind: 'ask-user' } }), false);
  assert.equal(accept({ ...base, verdict: { ...base.verdict, mustsTruncated: true } }), false);
  assert.equal(
    accept({
      ...base,
      verdict: {
        ...base.verdict,
        musts: [{ requirementId: 'must-a', status: 'unverified', waiver: null }],
      },
    }),
    false,
  );
  assert.equal(
    accept({
      ...base,
      verdict: {
        ...base.verdict,
        musts: [{ ...waived, waiver: { ...waived.waiver, designRevision: 1 } }],
      },
    }),
    false,
  );
  assert.equal(accept({ ...base, verdict: { ...base.verdict, musts: [{ ...waived, waiver: null }] } }), false);
  assert.equal(accept({ ...base, verdict: { ...base.verdict, musts: [] } }), true);
});

test('readRunReviewEvidence：正确 spec / archive 哈希放行，任一不符或缺少哈希都 fail closed', async () => {
  await withTempDir(async (dir) => {
    const fixture = buildFixture('H1', 'good');
    const spec = withExplicitLinks(fixture.spec);
    const specPath = join(dir, 'build-spec.json');
    const archivePath = join(dir, 'building.pgar');
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    await writeFile(archivePath, writeArchive(fixture.grid, API_VERSION));

    const shadow = computeShadowConformance({
      specPath,
      archivePath,
      outDir: dir,
      verifiedMapping: buildVerifiedMustMapping(spec),
    });
    assert.equal(shadow.error, null, shadow.error ?? '');

    const specSha256 = await sha256File(specPath);
    const archiveSha256 = await sha256File(archivePath);
    const evidence = await readRunReviewEvidence(dir, { specSha256, archiveSha256 });
    assert.ok(evidence !== null);
    assert.equal(reviewEvidenceMatchesArtifacts(evidence, { specSha256, archiveSha256 }), true);
    // 低层 API 不给 hash 绑定必须 fail closed，不能退回“只解析文件”。
    assert.equal(await readRunReviewEvidence(dir), null);

    assert.equal(await readRunReviewEvidence(dir, { specSha256: 'c'.repeat(64), archiveSha256 }), null);
    assert.equal(await readRunReviewEvidence(dir, { specSha256, archiveSha256: 'd'.repeat(64) }), null);

    // schema 要求 spec.sha256；旧文件缺哈希时 parse 失败，读取入口返回 null。
    const raw = JSON.parse(await readFile(join(dir, 'conformance-evidence.json'), 'utf8')) as Record<string, unknown>;
    const rawSpec = raw['spec'] as Record<string, unknown>;
    delete rawSpec['sha256'];
    await writeFile(join(dir, 'conformance-evidence.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    assert.equal(await readRunReviewEvidence(dir), null);
  });
});

test('defaultWebReviewBuilder：同 schemeId + revision 但 spec 哈希过期的证据被忽略，评审 ask-user / partial', async () => {
  await withTempDir(async (dir) => {
    const fixture = buildFixture('H1', 'good');
    const specPath = join(dir, 'build-spec.json');
    const archivePath = join(dir, 'building.pgar');
    await writeFile(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
    await writeFile(archivePath, writeArchive(fixture.grid, API_VERSION));

    const shadow = computeShadowConformance({ specPath, archivePath, outDir: dir, mappingPath: MATRIX_MAPPING });
    assert.equal(shadow.error, null, shadow.error ?? '');
    assert.equal(shadow.evidence?.mapping, 'verified');

    // 只改证据里的 spec.sha256，保留相同的 schemeId / revision：模拟旧构建证据被复用。
    const evidencePath = join(dir, 'conformance-evidence.json');
    const raw = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
    const spec = raw['spec'] as Record<string, unknown>;
    assert.equal(spec['schemeId'], fixture.spec.schemeId);
    assert.equal(spec['schemeRevision'], fixture.spec.schemeRevision);
    spec['sha256'] = 'c'.repeat(64);
    await writeFile(evidencePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    await writeFile(join(dir, 'events.jsonl'), '', 'utf8');
    const review = await defaultWebReviewBuilder({
      spec: fixture.spec,
      specPath,
      result: {
        outcome: {
          runId: 'run-stale-evidence',
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
    assert.equal(
      review.verdict.musts.some((must) => must.status === 'not-met'),
      false,
    );
    assert.equal(review.verdict.status, 'partial');
    assert.equal(review.nextAction.kind, 'ask-user');
  });
});

test('defaultWebReviewBuilder：specPath 可指向 runDir 外的会话工件；缺 specPath 且 runDir 无 spec 时不引用证据', async () => {
  await withTempDir(async (dir) => {
    const fixture = buildFixture('H1', 'good');
    const sessionDir = join(dir, 'session');
    const runDir = join(dir, 'run');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    const specPath = join(sessionDir, 'build-spec.json');
    const archivePath = join(runDir, 'building.pgar');
    const spec = withExplicitLinks(fixture.spec);
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    await writeFile(archivePath, writeArchive(fixture.grid, API_VERSION));

    const shadow = computeShadowConformance({
      specPath,
      archivePath,
      outDir: runDir,
      verifiedMapping: buildVerifiedMustMapping(spec),
    });
    assert.equal(shadow.error, null, shadow.error ?? '');
    await writeFile(join(runDir, 'events.jsonl'), '', 'utf8');

    const result = {
      outcome: {
        runId: 'run-external-spec',
        dir: runDir,
        stopReason: null,
        delivery: { codeVersion: 1, hash: 'fixture-hash' },
        costCny: 0,
        turns: 1,
      },
      runDir,
      delivery: { codeVersion: 1, hash: 'fixture-hash' },
      renders: ['render.png'],
      shadow: { summary: 'fixture', diffPath: null, evidencePath: null, error: null },
    } as const;

    const withSpecPath = await defaultWebReviewBuilder({ spec, specPath, result });
    assert.equal(
      withSpecPath.verdict.musts.every((must) => must.status === 'unverified'),
      true,
      '没有 planner 映射时，手写 details 不能产生 met',
    );
    assert.notEqual(withSpecPath.nextAction.kind, 'accept');

    // archive 工件缺失同样 fail closed：不引用任何证据，全部 unverified。
    await rm(archivePath);
    const missingArchive = await defaultWebReviewBuilder({ spec, specPath, result });
    assert.equal(
      missingArchive.verdict.musts.every((must) => must.status === 'unverified'),
      true,
    );
    assert.equal(missingArchive.nextAction.kind, 'ask-user');

    const withoutSpecPath = await defaultWebReviewBuilder({ spec, result });
    assert.equal(
      withoutSpecPath.verdict.musts.every((must) => must.status === 'unverified'),
      true,
    );
    assert.equal(
      withoutSpecPath.verdict.musts.some((must) => must.status === 'not-met'),
      false,
    );
    assert.equal(withoutSpecPath.nextAction.kind, 'ask-user');
  });
});

test('缺 conformance-evidence.json：调用方回退，全部 must unverified', async () => {
  await withTempDir(async (dir) => {
    const fixture = buildFixture('H1', 'good');
    await writeFile(join(dir, 'events.jsonl'), '', 'utf8');
    assert.equal(await readRunReviewEvidence(dir), null);

    const review = await defaultWebReviewBuilder({
      spec: fixture.spec,
      result: {
        outcome: {
          runId: 'run-no-evidence',
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
    assert.equal(review.nextAction.kind, 'ask-user');
  });
});
