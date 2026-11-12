/**
 * End-to-end accept gate through SessionManager on the real run-7 planner path:
 * perfect grid + planner mapping + unverified-must waivers -> accept;
 * tampered archive / session.json planner inputs -> 409.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { writeArchive } from '@pg/core/archive';
import { API_VERSION } from '@pg/geometry';
import { compileBuildBrief } from '@pg/interaction/brief';
import { expandDesignIntent } from '@pg/interaction/design-expand';
import { createIntentHost } from '@pg/interaction/generate-intent';
import { planVerifiedObjectMap } from '@pg/interaction/must-links';
import { parseReviewEvidenceFile, resolveReviewMusts, type ReviewWaiver } from '@pg/interaction/review-evidence';
import { ReviewReport } from '@pg/interaction/review';
import { buildReviewReport } from '@pg/interaction/review-generate';
import type { ReviewRunFacts } from '@pg/interaction/review-generate';
import { BuildSpec, buildMustLedger, DesignScheme, RequirementGraph } from '@pg/interaction/schema';
import { saveSession } from '@pg/interaction/store';
import type { SessionState } from '@pg/interaction/session';

import { buildVerifiedMustMapping } from './build-sheet.ts';
import { buildRun7PerfectGrid } from './fixtures/run7-perfect-grid.ts';
import { computeShadowConformance } from './conformance-shadow.ts';
import { SessionManager } from './interaction-server-session.ts';

const REQUIREMENTS = new URL('../packages/interaction/fixtures/run7-requirements.json', import.meta.url);
const INTENT = new URL('../packages/interaction/fixtures/run7-rev2-intent.json', import.meta.url);
const REVISION = 2;
const RUN_ID = 'run-run7-e2e';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readFixture(path: URL): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-run7-session-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createManager(sessionRoot: string, buildRunRoot: string): SessionManager {
  return new SessionManager({
    mode: 'mock',
    sessionRoot,
    buildRunRoot,
    clientFactory: () => {
      throw new Error('not used');
    },
    buildLog: () => undefined,
  });
}

/** 测试专用：拿到内存里的会话记录，模拟服务已从被篡改的 session.json 载入。 */
function mutableRecord(manager: SessionManager, id: string): { state: SessionState | null } {
  const sessions = (manager as unknown as { sessions: Map<string, { state: SessionState | null }> }).sessions;
  const record = sessions.get(id);
  assert.ok(record !== undefined);
  return record;
}

async function rejectsAccept(manager: SessionManager, id: string): Promise<void> {
  await assert.rejects(
    () => manager.reviewDecision(id, { action: 'accept', instructions: '篡改后接受。' }),
    (error: unknown) => {
      assert.equal((error as { readonly status?: unknown }).status, 409);
      return true;
    },
  );
}

/** session.json 里能影响 planner / spec 的三类输入；文件本体（spec/archive/evidence）保持不动。 */
const PLANNER_TAMPER_VARIANTS: readonly {
  readonly name: string;
  readonly tamper: (state: SessionState) => SessionState;
}[] = [
  {
    name: 'requirements',
    tamper: (state) => {
      const requirements = state.requirements;
      assert.ok(requirements !== null);
      return {
        ...state,
        requirements: {
          ...requirements,
          requirements: requirements.requirements.map((entry, index) =>
            index === 0 ? { ...entry, text: `${entry.text}（被篡改）` } : entry,
          ),
        },
      };
    },
  },
  {
    name: 'design',
    tamper: (state) => ({
      ...state,
      designs: state.designs.map((design) =>
        design.meta.status === 'confirmed'
          ? { ...design, meta: { ...design.meta, title: `${design.meta.title}（被篡改）` } }
          : design,
      ),
    }),
  },
  {
    name: 'brief.spec',
    tamper: (state) => {
      const brief = state.brief;
      assert.ok(brief !== null);
      return {
        ...state,
        brief: { ...brief, spec: { ...brief.spec, title: `${brief.spec.title}（被篡改）` } },
      };
    },
  },
];

test('SessionManager run-7：完美构建 + 未验证 must waivers accept；篡改 archive / session.json 输入后 409', async () => {
  const requirements = RequirementGraph.parse(await readFixture(REQUIREMENTS));
  const resolved = expandDesignIntent(
    await readFixture(INTENT),
    createIntentHost(requirements, { schemeId: 'scheme-draft', revision: REVISION, status: 'confirmed' }),
  );
  const scheme = resolved.scheme;
  assert.equal(DesignScheme.safeParse(scheme).success, true);
  const spec = BuildSpec.parse(compileBuildBrief(scheme, requirements).spec);
  const trusted = planVerifiedObjectMap(buildMustLedger(requirements).entries, scheme);
  const mapping = Object.fromEntries(Object.entries(trusted).map(([mustId, ids]) => [mustId, [...ids]]));

  await withTempDir(async (root) => {
    const sessionRoot = join(root, 'sessions');
    const buildRunRoot = join(root, 'runs');
    const sessionId = 'ses-run7-accept';
    const dir = join(sessionRoot, sessionId);
    await mkdir(dir, { recursive: true });
    const brief = compileBuildBrief(scheme, requirements);
    const specPath = join(dir, 'build-spec.json');
    const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
    await writeFile(specPath, specBytes);
    await writeFile(join(dir, 'design.md'), brief.designMarkdown);
    await writeFile(join(dir, 'build-task.md'), brief.taskMarkdown);
    await writeFile(join(dir, 'gates.json'), `${JSON.stringify(brief.gates, null, 2)}\n`);

    const runDir = join(buildRunRoot, RUN_ID);
    await mkdir(join(runDir, 'delivery'), { recursive: true });
    const archiveBytes = writeArchive(buildRun7PerfectGrid(spec), API_VERSION);
    await writeFile(join(runDir, 'delivery', 'building.pgar'), archiveBytes);
    const shadow = computeShadowConformance({
      specPath,
      archivePath: join(runDir, 'delivery', 'building.pgar'),
      outDir: runDir,
      verifiedMapping: buildVerifiedMustMapping(spec, trusted),
    });
    assert.equal(shadow.error, null, shadow.error ?? '');
    assert.ok(shadow.evidence !== null);
    const evidence = parseReviewEvidenceFile(shadow.evidence);
    const binding = { specSha256: sha256(specBytes), archiveSha256: sha256(archiveBytes) };
    const verifiedMustIds = Object.keys(mapping);
    const resolvedMusts = resolveReviewMusts({
      schemeId: spec.schemeId,
      designRevision: spec.schemeRevision,
      musts: spec.musts,
      evidence,
      ...binding,
      verifiedMustIds,
    });
    const unverified = resolvedMusts.filter((must) => must.status === 'unverified');
    const waivers: ReviewWaiver[] = unverified.map((must) => ({
      mustId: must.requirementId,
      designRevision: REVISION,
      by: 'user',
      choice: '接受非几何必须项',
      conflictId: null,
      note: null,
    }));
    const run: ReviewRunFacts = {
      runId: RUN_ID,
      designId: spec.schemeId,
      designRevision: REVISION,
      status: 'succeeded',
      failure: null,
      delivered: true,
      stopReason: null,
      checkPassed: true,
      cells: 500,
      bounds: [2, 0, 2, 11, 7, 9],
      renders: 1,
    };
    const review = buildReviewReport({ spec, run, evidence, evidenceBinding: binding, verifiedMustIds, waivers });
    assert.equal(review.verdict.status, 'satisfied');
    assert.equal(review.nextAction.kind, 'accept');
    assert.equal(waivers.length, unverified.length);
    assert.ok(waivers.length > 0);

    const state: SessionState = {
      sessionId,
      stage: 'post-review',
      requirements,
      designs: [{ ...scheme, meta: { ...scheme.meta, status: 'confirmed' } }],
      currentDesignRevision: REVISION,
      confirmedDesignRevision: REVISION,
      questions: [],
      answers: [],
      check: null,
      brief,
      build: { runId: RUN_ID, designId: scheme.meta.id, designRevision: REVISION, status: 'succeeded', failure: null },
      review,
      reviewWaivers: waivers,
      revisionReason: null,
      events: [{ seq: 0, type: 'session.start', sessionId }],
      nextEventSeq: 1,
    };
    await saveSession(state, { root: sessionRoot });
    const manager = new SessionManager({
      mode: 'mock',
      sessionRoot,
      buildRunRoot,
      clientFactory: () => {
        throw new Error('not used');
      },
      buildLog: () => undefined,
    });
    await manager.loadPersisted();
    const accepted = await manager.reviewDecision(sessionId, {
      action: 'accept',
      instructions: '接受 run-7 完美构建。',
    });
    assert.equal(accepted.stage, 'accept');

    // 种一份“全部 met”的伪评审，hashes 与当前工件一致；restore 必须拒绝恢复。
    const forgedId = 'ses-run7-forged';
    const forged = ReviewReport.parse({
      ...review,
      verdict: {
        ...review.verdict,
        musts: review.verdict.musts.map((must) => ({ ...must, status: 'met', waiver: null })),
      },
    });
    await saveSession({ ...state, sessionId: forgedId, review: forged, reviewWaivers: [] }, { root: sessionRoot });
    const managerForged = new SessionManager({
      mode: 'mock',
      sessionRoot,
      buildRunRoot,
      clientFactory: () => {
        throw new Error('not used');
      },
      buildLog: () => undefined,
    });
    await managerForged.loadPersisted();
    assert.throws(() => managerForged.get(forgedId), /不存在|没有/);

    // 重新种一份状态，替换 archive 后 accept 必须被 reviewDecision 的实时重验拒绝。
    await saveSession(state, { root: sessionRoot });
    const manager2 = new SessionManager({
      mode: 'mock',
      sessionRoot,
      buildRunRoot,
      clientFactory: () => {
        throw new Error('not used');
      },
      buildLog: () => undefined,
    });
    await manager2.loadPersisted();
    await writeFile(
      join(runDir, 'delivery', 'building.pgar'),
      await readFile(new URL('./fixtures/conformance-run9-v2/building.pgar', import.meta.url)),
    );
    await assert.rejects(
      () => manager2.reviewDecision(sessionId, { action: 'accept', instructions: '篡改后接受。' }),
      /spec \/ archive \/ evidence 已变化|spec \/ archive|哈希/,
    );

    // 恢复原 archive，只篡改 session.json 的 planner 输入；spec/archive/evidence 保持不动。
    await writeFile(join(runDir, 'delivery', 'building.pgar'), archiveBytes);
    await saveSession(state, { root: sessionRoot });

    for (const variant of PLANNER_TAMPER_VARIANTS) {
      const manager = createManager(sessionRoot, buildRunRoot);
      await manager.loadPersisted();
      const record = mutableRecord(manager, sessionId);
      const tampered = variant.tamper(state);
      record.state = tampered;
      await saveSession(tampered, { root: sessionRoot });

      // 已载入的会话在 accept 时重编译失败 → 409。
      await rejectsAccept(manager, sessionId);

      // 重启后同一份被篡改的 session.json 也不能恢复出可接受的评审。
      const restarted = createManager(sessionRoot, buildRunRoot);
      await restarted.loadPersisted();
      assert.throws(() => restarted.get(sessionId), /不存在|没有/, `${variant.name} 篡改后不应恢复`);

      await saveSession(state, { root: sessionRoot });
    }

    // 伪造 waived must：报告仍带有效-looking waiver，但状态里没有对应用户 waiver。
    const waivedMust = state.review?.verdict.musts.find((must) => must.status === 'waived');
    assert.ok(waivedMust !== undefined);
    const forgedWaiverState: SessionState = {
      ...state,
      reviewWaivers: (state.reviewWaivers ?? []).filter((waiver) => waiver.mustId !== waivedMust.requirementId),
    };
    const managerForgedWaiver = createManager(sessionRoot, buildRunRoot);
    await managerForgedWaiver.loadPersisted();
    mutableRecord(managerForgedWaiver, sessionId).state = forgedWaiverState;
    await saveSession(forgedWaiverState, { root: sessionRoot });
    await rejectsAccept(managerForgedWaiver, sessionId);

    const restartedForgedWaiver = createManager(sessionRoot, buildRunRoot);
    await restartedForgedWaiver.loadPersisted();
    assert.throws(() => restartedForgedWaiver.get(sessionId), /不存在|没有/);
    await saveSession(state, { root: sessionRoot });
  });
});
