/**
 * Wave 7 验收：真实诊断构建（20261022-033507 / v8 273b6f60）的离线重放。
 *
 * 覆盖：14 met / 22 unverified / 5 not-met / 无 accept；material hard fail 归因；
 * roof object diff 与 clause 一致；北门 threshold 保持 unverified；交付注记诚实；
 * run review 生成 + session 二次 run 替换旧 review 并标 stale。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ReviewReport } from '@pg/interaction/review';
import { loadSessionForReviewRevalidation } from '@pg/interaction/store';

import { loadSpec } from './conformance-diff.ts';
import { computeShadowConformance, loadVerifiedMapping } from './conformance-shadow.ts';
import { buildRunReview, readPersistedRunReview, writeRunReview } from './run-review.ts';
import { adoptRunReviewIntoSession } from './session-review.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/live-run-20261022/', import.meta.url));
const SPEC = join(FIXTURE, 'build-spec.json');
const ARCHIVE = join(FIXTURE, 'building.pgar');
const MAPPING = join(FIXTURE, 'verified-must-map.json');
const LIVE_EVIDENCE = JSON.parse(readFileSync(join(FIXTURE, 'conformance-evidence.live.json'), 'utf8')) as {
  datum: { slabTopY: number; standingY: number; gradeY: number; entryTransition: 'flush' | 'one-step' | 'unknown' };
};
const EXPECTED_SPEC_SHA = 'ea37e5b22c45d61c2121692a3995a9cb7cf2f318d790eefdb9204cdbca201ca6';
const EXPECTED_ARCHIVE_SHA = 'eceeccdf52935af56c19fd2280fa41e4c78dc70fbd1b4a8b591afa369fb31795';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function required<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, what);
  return value;
}

function replay() {
  const out = mkdtempSync(join(tmpdir(), 'pg-wave7-live-'));
  const shadow = computeShadowConformance({
    specPath: SPEC,
    archivePath: ARCHIVE,
    outDir: out,
    mappingPath: MAPPING,
    datum: LIVE_EVIDENCE.datum,
  });
  assert.equal(shadow.error, null, shadow.error ?? '');
  return {
    report: required(shadow.report ?? undefined, 'report'),
    evidence: required(shadow.evidence ?? undefined, 'evidence'),
  };
}

test('live replay：14 met / 22 unverified / 5 not-met / acceptEligible=false', () => {
  assert.equal(sha256(SPEC), EXPECTED_SPEC_SHA);
  assert.equal(sha256(ARCHIVE), EXPECTED_ARCHIVE_SHA);
  const { report, evidence } = replay();
  assert.deepEqual(evidence.summary, {
    met: 14,
    notMet: 5,
    waived: 0,
    unverified: 22,
    acceptEligible: false,
  });
  assert.deepEqual(
    evidence.musts
      .filter((must) => must.status === 'not-met')
      .map((must) => must.mustId)
      .sort(),
    ['constraint-con-material-selection', 'req-bench-north', 'req-bench-south', 'req-seats-10', 'req-wood-wall-column'],
  );
  assert.equal(report.summary.blockingCount, 1);
  assert.equal(report.summary.blocking, true);
});

test('live replay：material hard fail 归因到 wood-wall-column / material-selection，无未归因', () => {
  const { evidence } = replay();
  const clause = evidence.clauseSummary;
  assert.deepEqual(clause.unattributedHardFails, []);
  for (const checkId of ['check:material:structure', 'check:material:wall']) {
    const attribution = required(
      clause.attributedHardFails.find((item) => item.checkId === checkId),
      checkId,
    );
    assert.deepEqual([...attribution.mustIds].sort(), ['constraint-con-material-selection', 'req-wood-wall-column']);
  }
  const wood = required(
    evidence.clauseGroups.find((group) => group.mustId === 'req-wood-wall-column'),
    'wood group',
  );
  assert.equal(wood.status, 'not-met');
  const constraint = required(
    evidence.clauseGroups.find((group) => group.mustId === 'constraint-con-material-selection'),
    'constraint group',
  );
  assert.equal(constraint.status, 'not-met');
  assert.match(constraint.leaves[0]?.reason ?? '', /attributed-hard-fail/);
  const partitions = required(
    evidence.clauseGroups.find((group) => group.mustId === 'req-no-partitions'),
    'partition group',
  );
  assert.equal(partitions.status, 'unverified');
});

test('live replay：roof object diff 与 clause 一致，北门 threshold 保持 unverified', () => {
  const { report, evidence } = replay();
  const roofItem = required(
    report.items.find((item) => item.expectedId === 'roof'),
    'roof item',
  );
  assert.equal(roofItem.status, 'pass');
  const roof = required(
    evidence.clauseGroups.find((group) => group.mustId === 'req-gable-tile-roof'),
    'roof group',
  );
  assert.equal(roof.status, 'unverified');
  const form = required(
    roof.leaves.find((leaf) => leaf.clauseId === 'req-gable-tile-roof#roof-form'),
    'roof form',
  );
  assert.equal(form.status, 'unverified');
  assert.equal(form.evidence[0]?.ref, 'conformance-diff.json#expected:roof');
  assert.match(form.reason ?? '', /form classifier reports stepped/);
  assert.equal(
    roof.leaves.some((leaf) => leaf.status === 'not-met'),
    false,
  );

  const doorItem = required(
    report.items.find((item) => item.expectedId === 'opening:op-entry-north'),
    'door item',
  );
  assert.equal(doorItem.status, 'unverified');
  const doorChecks = required(
    (doorItem.actual as { checks?: readonly { id: string; status: string; detail?: string }[] } | null)?.checks,
    'door checks',
  );
  const threshold = required(
    doorChecks.find((check) => check.id === 'door.threshold.op-entry-north'),
    'threshold',
  );
  assert.equal(threshold.status, 'unverified');
  assert.match(threshold.detail ?? '', /室外相邻地面|outdoor ground/);
  for (const id of ['door.width.op-entry-north', 'door.height.op-entry-north', 'door.clearance.op-entry-north']) {
    assert.equal(
      required(
        doorChecks.find((check) => check.id === id),
        id,
      ).status,
      'pass',
      id,
    );
  }
  const door = required(
    evidence.clauseGroups.find((group) => group.mustId === 'req-door-north-west'),
    'door group',
  );
  assert.equal(door.status, 'unverified');
  assert.equal(
    required(
      door.leaves.find((leaf) => leaf.clauseId === 'req-door-north-west#door-width'),
      'door width',
    ).status,
    'met',
  );
  const openingReport = required(
    door.leaves.find((leaf) => leaf.clauseId === 'req-door-north-west#report-opening'),
    'opening report',
  );
  assert.equal(openingReport.status, 'unverified');
});

test('交付注记：由证据生成，blockingCount=1 / 5 个 not-met，不转载 5/5 PASS', () => {
  const delivery = readJson(join(FIXTURE, 'delivery.json')) as {
    note: string;
    noteSource?: string;
    selfNote?: string;
  };
  assert.equal(delivery.noteSource, 'conformance-evidence');
  assert.equal(delivery.selfNote, undefined);
  assert.match(delivery.note, /blockingCount=1/);
  assert.match(delivery.note, /acceptEligible=false/);
  for (const mustId of [
    'constraint-con-material-selection',
    'req-bench-north',
    'req-bench-south',
    'req-seats-10',
    'req-wood-wall-column',
  ]) {
    assert.match(delivery.note, new RegExp(`\`${mustId}\``), mustId);
  }
  assert.doesNotMatch(delivery.note, /5\/5 PASS|blocking 0/);
  assert.match(readFileSync(join(FIXTURE, 'designer-note.txt'), 'utf8'), /5\/5 PASS/);
  const events = readFileSync(join(FIXTURE, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; body: { note?: string; noteSource?: string } });
  const eventNote = required(events.find((event) => event.type === 'delivery')?.body, 'delivery event');
  assert.equal(eventNote.noteSource, 'conformance-evidence');
  assert.match(eventNote.note ?? '', /blockingCount=1/);
  assert.doesNotMatch(eventNote.note ?? '', /5\/5 PASS|blocking 0/);
});

test('run review：从 run 目录（events + evidence）重建与 fixture 相同的评审', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-wave7-run-'));
  const runDir = join(root, '20261022-033507-build-task-48aba6');
  await mkdir(join(runDir, 'delivery'), { recursive: true });
  copyFileSync(SPEC, join(runDir, 'build-spec.json'));
  copyFileSync(join(FIXTURE, 'conformance-evidence.json'), join(runDir, 'conformance-evidence.json'));
  copyFileSync(join(FIXTURE, 'events.jsonl'), join(runDir, 'events.jsonl'));
  copyFileSync(ARCHIVE, join(runDir, 'delivery', 'building.pgar'));
  const { spec } = loadSpec(join(runDir, 'build-spec.json'));
  const mapping = readJson(join(FIXTURE, 'verified-must-map.json')) as {
    schemes: Record<string, Record<string, readonly string[]>>;
  };
  const verifiedMustObjects = mapping.schemes[spec.schemeId] ?? {};
  const verifiedMapping = loadVerifiedMapping(MAPPING);
  const review = await buildRunReview({
    spec,
    specPath: join(runDir, 'build-spec.json'),
    runDir,
    verifiedMustObjects,
    verifiedMustIds: Object.keys(verifiedMustObjects),
    verifiedMapping,
  });
  const fixture = ReviewReport.parse(readJson(join(FIXTURE, 'review.json')));
  assert.equal(review.buildRunId, fixture.buildRunId);
  assert.equal(review.verdict.status, 'not-satisfied');
  assert.equal(review.nextAction.kind, 'targeted-revision');
  assert.deepEqual(review.provenance?.unattributedHardFails, []);
  assert.deepEqual(
    review.verdict.musts.map((must) => [must.requirementId, must.status]),
    fixture.verdict.musts.map((must) => [must.requirementId, must.status]),
  );
  assert.equal(review.objective.measurements.find((m) => m.name === '方块数')?.actual, '364 块');
});

test('run review：fixture review 为 not-satisfied / targeted-revision，写读一致；session 二次 run 替换旧 review', async () => {
  const expected = ReviewReport.parse(readJson(join(FIXTURE, 'review.json')));
  assert.equal(expected.verdict.status, 'not-satisfied');
  assert.equal(expected.nextAction.kind, 'targeted-revision');
  assert.equal(expected.buildRunId, '20261022-033507-build-task-48aba6');
  assert.deepEqual(expected.provenance?.unattributedHardFails, []);
  assert.equal(expected.verdict.musts.find((must) => must.requirementId === 'req-wood-wall-column')?.status, 'not-met');
  assert.equal(
    expected.verdict.musts.find((must) => must.requirementId === 'req-gable-tile-roof')?.status,
    'unverified',
  );
  assert.equal(
    expected.verdict.musts.find((must) => must.requirementId === 'constraint-con-material-selection')?.status,
    'not-met',
  );
  assert.notEqual(expected.nextAction.kind, 'accept');

  const runDir = mkdtempSync(join(tmpdir(), 'pg-wave7-review-'));
  await writeRunReview(runDir, expected);
  assert.deepEqual(await readPersistedRunReview(runDir), expected);

  const oldReport = ReviewReport.parse({
    ...expected,
    buildRunId: '20261020-112925-build-task-c9736e',
  });
  const root = mkdtempSync(join(tmpdir(), 'pg-wave7-session-'));
  const id = 'ses-wave7-review';
  const sessionDir = join(root, id);
  await mkdir(sessionDir, { recursive: true });
  const seedState = {
    sessionId: id,
    stage: 'post-review',
    failure: null,
    requirements: null,
    designs: [{ meta: { id: 'scheme-draft', revision: 2, status: 'confirmed' } }],
    intents: [],
    currentDesignRevision: 2,
    confirmedDesignRevision: 2,
    questions: [],
    answers: [],
    check: { designRevision: 2, passed: true, issues: [] },
    brief: null,
    build: {
      runId: '20261020-112925-build-task-c9736e',
      designId: 'scheme-draft',
      designRevision: 2,
      status: 'succeeded',
      failure: null,
    },
    review: oldReport,
    reviewHistory: [],
    reviewWaivers: [],
    revisionReason: null,
    events: [],
    nextEventSeq: 0,
  };
  writeFileSync(join(sessionDir, 'session.json'), `${JSON.stringify(seedState, null, 2)}\n`, 'utf8');
  assert.equal(await adoptRunReviewIntoSession(sessionDir, expected), true);
  const loaded = await loadSessionForReviewRevalidation(id, () => true, { root });
  assert.ok(loaded !== null);
  assert.equal(loaded.review?.buildRunId, '20261022-033507-build-task-48aba6');
  assert.equal(loaded.build?.runId, '20261022-033507-build-task-48aba6');
  const history = required(loaded.reviewHistory, 'review history');
  assert.equal(history.length, 1);
  const stale = required(history[0], 'stale review');
  assert.equal(stale.review.buildRunId, '20261020-112925-build-task-c9736e');
  assert.equal(stale.stale, true);
  assert.equal(stale.supersededByRunId, '20261022-033507-build-task-48aba6');
  // re-adoption is idempotent: current review is the same run, no duplicate stale entry.
  assert.equal(await adoptRunReviewIntoSession(sessionDir, expected), true);
  const again = await loadSessionForReviewRevalidation(id, () => true, { root });
  assert.equal(again?.reviewHistory?.length, 1);
});
