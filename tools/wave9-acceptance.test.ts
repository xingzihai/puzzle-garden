/**
 * Wave 9 验收：第三次真实诊断构建（20261022-061757 / v13 1c2586d3）的离线重放。
 *
 * 锁定：12 met / 17 unverified / 12 not-met / 无 accept；北门 threshold 仍 unverified；
 * 两盏 ridge light 没有 must 覆盖，只能是带理由的显式全局阻断，且进入 review.nextAction；
 * 未归因 hard fail 必须为空。只读 fixture，不依赖 .work、不联网、不构建。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '@pg/blocks/load';
import { ReviewReport } from '@pg/interaction/review';

import { buildConformanceDiffReport, loadArchive, loadSpec } from './conformance-diff.ts';
import { computeShadowConformance, loadVerifiedMapping } from './conformance-shadow.ts';
import { buildRunReview } from './run-review.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/live-run-ec0ae9/', import.meta.url));
const SPEC = join(FIXTURE, 'build-spec.json');
const ARCHIVE = join(FIXTURE, 'building.pgar');
const MAPPING = join(FIXTURE, 'verified-must-map.json');
const RUN_ID = '20261022-061757-build-task-ec0ae9';

const NOT_MET = [
  'constraint-con-material-selection',
  'constraint-con-single-storey',
  'req-bench-north',
  'req-bench-south',
  'req-long-table',
  'req-no-glass-door',
  'req-no-outdoor-zone',
  'req-no-partitions',
  'req-seats-10',
  'req-single-storey',
  'req-stone-base',
  'req-wood-wall-column',
] as const;

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as unknown;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function replay(): ReturnType<typeof computeShadowConformance> {
  const out = mkdtempSync(join(tmpdir(), 'pg-wave9-live-'));
  try {
    return computeShadowConformance({ specPath: SPEC, archivePath: ARCHIVE, outDir: out, mappingPath: MAPPING });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test('ec0ae9 离线重放：12 met / 17 unverified / 12 not-met / acceptEligible=false', () => {
  assert.equal(sha256(SPEC), 'ea37e5b22c45d61c2121692a3995a9cb7cf2f318d790eefdb9204cdbca201ca6');
  assert.equal(sha256(ARCHIVE), 'bbd6954008e2f202cf1704323dd1be6406aa74d9b6a0a8af5bbfafb5cf780f6e');
  const shadow = replay();
  assert.equal(shadow.error, null, shadow.error ?? '');
  assert.ok(shadow.report !== null && shadow.evidence !== null);
  assert.deepEqual(shadow.evidence.summary, {
    met: 12,
    notMet: 12,
    waived: 0,
    unverified: 17,
    acceptEligible: false,
  });
  assert.deepEqual(
    shadow.evidence.clauseGroups
      .filter((group) => group.status === 'not-met')
      .map((group) => group.mustId)
      .sort(),
    [...NOT_MET].sort(),
  );
  const summary = shadow.evidence.clauseSummary;
  assert.equal(summary.met, 12);
  assert.equal(summary.notMet, 12);
  assert.equal(summary.unverified, 17);
  assert.equal(summary.waived, 0);
  assert.equal(shadow.report.summary.blocking, true);
  assert.equal(shadow.report.summary.blockingCount, 2);

  // no false met：父 must 只有全部 leaf met/waived 才能 met；not-met 必须带 leaf 证据。
  for (const group of shadow.evidence.clauseGroups) {
    if (group.status === 'met') {
      assert.equal(
        group.leaves.every((leaf) => leaf.status === 'met' || leaf.status === 'waived'),
        true,
        group.mustId,
      );
    }
    if (group.status === 'not-met') {
      assert.equal(
        group.leaves.some((leaf) => leaf.status === 'not-met' && (leaf.evidence.length > 0 || leaf.reason !== null)),
        true,
        group.mustId,
      );
    }
  }
  const roof = shadow.evidence.clauseGroups.find((group) => group.mustId === 'req-gable-tile-roof');
  assert.ok(roof !== undefined);
  assert.equal(roof.status, 'unverified');
  assert.match(roof.leaves.find((leaf) => leaf.clauseId === 'req-gable-tile-roof#roof-form')?.reason ?? '', /stepped/);
});

test('ridge light：没有 must 覆盖，进入带理由的 globalBlockers 而不是 unattributed', () => {
  const shadow = replay();
  const summary = shadow.evidence?.clauseSummary;
  assert.ok(summary !== undefined);
  assert.deepEqual(summary.unattributedHardFails, []);
  assert.equal(summary.globalBlockers.length, 2);
  for (const id of ['f-light-ridge-e', 'f-light-ridge-w']) {
    const blocker = summary.globalBlockers.find((entry) => entry.startsWith(`furniture:${id}:`));
    assert.ok(blocker !== undefined, id);
    assert.match(blocker, /no must covers/);
    assert.match(blocker, /build it exactly or waive it in design/);
  }
  assert.equal(summary.attributedHardFails.length, 2);
});

test('评审：not-satisfied / targeted-revision，nextAction 含 12 个 not-met 与两盏灯全局阻断', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-wave9-run-'));
  try {
    const runDir = join(root, RUN_ID);
    mkdirSync(join(runDir, 'delivery'), { recursive: true });
    copyFileSync(SPEC, join(runDir, 'build-spec.json'));
    copyFileSync(ARCHIVE, join(runDir, 'delivery', 'building.pgar'));
    copyFileSync(join(FIXTURE, 'conformance-evidence.json'), join(runDir, 'conformance-evidence.json'));
    copyFileSync(join(FIXTURE, 'events.jsonl'), join(runDir, 'events.jsonl'));
    const { spec } = loadSpec(SPEC);
    const review = ReviewReport.parse(readJson('review.json'));
    const rebuilt = await buildRunReview({
      spec,
      specPath: join(runDir, 'build-spec.json'),
      runDir,
      verifiedMapping: loadVerifiedMapping(MAPPING),
    });
    assert.deepEqual(rebuilt, review);
    assert.equal(rebuilt.verdict.status, 'not-satisfied');
    assert.equal(rebuilt.nextAction.kind, 'targeted-revision');
    for (const mustId of NOT_MET) assert.match(rebuilt.nextAction.instructions, new RegExp(mustId));
    for (const id of ['f-light-ridge-e', 'f-light-ridge-w']) {
      assert.match(rebuilt.nextAction.instructions, new RegExp(id));
    }
    assert.match(rebuilt.nextAction.instructions, /全局阻断/);
    assert.ok(rebuilt.provenance !== undefined);
    assert.deepEqual(rebuilt.provenance.unattributedHardFails, []);
    assert.equal(rebuilt.provenance.globalBlockers?.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('报告与注记绑定：diff 可重放，note 写明 12 not-met、无未归因、两盏灯全局阻断', () => {
  const fixtureReport = readJson('conformance-diff.json') as ReturnType<typeof buildConformanceDiffReport>;
  const { spec } = loadSpec(SPEC);
  const registry = loadRegistry();
  const { grid, sha256: archiveSha256, bytes } = loadArchive(ARCHIVE, registry);
  const rebuilt = buildConformanceDiffReport({
    spec,
    grid,
    registry,
    specPath: fixtureReport.spec.path,
    specSha256: fixtureReport.spec.sha256,
    archivePath: fixtureReport.archive.path,
    archiveSha256,
    archiveBytes: bytes,
  });
  assert.deepEqual(rebuilt, fixtureReport);
  assert.equal(rebuilt.items.find((item) => item.expectedId === 'slab:f1')?.status, 'fail');
  assert.equal(rebuilt.items.find((item) => item.expectedId === 'opening:op-entry-north')?.status, 'unverified');

  const note = readFileSync(join(FIXTURE, 'note.md'), 'utf8');
  for (const mustId of NOT_MET) assert.match(note, new RegExp(`\\\`${mustId}\\\``));
  assert.match(note, /未归因 hard fail\n\n- 无/);
  assert.match(note, /f-light-ridge-e/);
  assert.match(note, /f-light-ridge-w/);
  assert.match(note, /acceptEligible=false/);
  const delivery = readJson('delivery.json') as { noteSource?: string; note?: string };
  assert.equal(delivery.noteSource, 'conformance-evidence');
  assert.equal(delivery.note, note);
});
