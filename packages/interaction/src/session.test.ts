/* eslint-disable max-lines -- accept gate、waiver 状态机与旧 session provenance 回归共用同一组会话 fixture。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { compileBuildBrief } from './brief.ts';
import { designConflictsFromWarnings } from './design-conflict.ts';
import { exampleIntent, exampleRequirements, exampleScheme } from './example.ts';
import { ReviewReport } from './review.ts';
import { ReviewWaiver } from './review-evidence.ts';
import { applyReviewWaivers } from './review-generate.ts';
import {
  createSession,
  currentReview,
  reduceSession,
  reviewAcceptBlockers,
  SessionTransitionError,
} from './session.ts';
import type { SessionState } from './session.ts';
import { loadSession, loadSessionForReviewRevalidation, saveSession } from './store.ts';

function advanceToReview(): SessionState {
  let state = createSession('ses-tea');
  state = reduceSession(state, { kind: 'recordRequirements', graph: exampleRequirements() });
  state = reduceSession(state, {
    kind: 'askQuestions',
    questions: [
      { id: 'q-1', text: '需要柜台和储物吗？' },
      { id: 'q-2', text: '稻田在场地哪一侧？' },
    ],
  });
  state = reduceSession(state, {
    kind: 'answerQuestions',
    answers: [
      { questionId: 'q-1', answer: '需要一个小柜台。' },
      { questionId: 'q-2', answer: '稻田在南侧。' },
    ],
    graph: null,
  });
  state = reduceSession(state, { kind: 'proposeDesign', scheme: exampleScheme() });
  state = reduceSession(state, {
    kind: 'recordCheck',
    designRevision: 1,
    passed: true,
    issues: [],
  });
  return state;
}

function advanceToConfirm(): SessionState {
  let state = advanceToReview();
  state = reduceSession(state, { kind: 'confirmDesign', designRevision: 1 });
  return state;
}

function reportWithMusts(musts: readonly Record<string, unknown>[]): ReviewReport {
  return ReviewReport.parse({
    designVersion: { schemeId: 'scheme-tea', revision: 1 },
    buildRunId: 'run-1',
    objective: { measurements: [], notes: [] },
    visual: { verdict: 'pass', strengths: [], weaknesses: [], notes: [] },
    defects: [],
    verdict: { status: 'satisfied', musts },
    nextAction: {
      kind: 'accept',
      instructions: '按当前构建交付。',
      affectedSpaceIds: [],
      affectedElementIds: [],
    },
    provenance: {
      version: 1,
      evidence: 'verified',
      specSha256: 'a'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      verifiedMustIds: ['req-use', 'req-view'],
    },
  });
}

/** 一条未验证必须项的真实形态：verdict=partial、nextAction=ask-user，accept 必须先豁免。 */
function reportWithUnverifiedMust(mustId = 'req-use'): ReviewReport {
  return ReviewReport.parse({
    designVersion: { schemeId: 'scheme-tea', revision: 1 },
    buildRunId: 'run-1',
    objective: { measurements: [], notes: [] },
    visual: { verdict: 'not-reviewed', strengths: [], weaknesses: [], notes: [] },
    defects: [],
    verdict: { status: 'partial', musts: [{ requirementId: mustId, status: 'unverified' }] },
    nextAction: {
      kind: 'ask-user',
      instructions: '请确认必须项。',
      affectedSpaceIds: [],
      affectedElementIds: [],
    },
    provenance: {
      version: 1,
      evidence: 'verified',
      specSha256: 'a'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      verifiedMustIds: [mustId],
    },
  });
}

function advanceToPostReview(review: ReviewReport): SessionState {
  let state = advanceToConfirm();
  state = reduceSession(state, {
    kind: 'compileBrief',
    brief: compileBuildBrief(exampleScheme(), exampleRequirements()),
  });
  state = reduceSession(state, { kind: 'startBuild', runId: 'run-1' });
  state = reduceSession(state, { kind: 'finishBuild', runId: 'run-1', status: 'succeeded', failure: null });
  return reduceSession(state, { kind: 'recordReview', report: review });
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-session-r2-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function report(runId = 'run-1', revision = 1): ReviewReport {
  return ReviewReport.parse({
    designVersion: { schemeId: 'scheme-tea', revision },
    buildRunId: runId,
    objective: { measurements: [], notes: [] },
    visual: { verdict: 'pass', strengths: [], weaknesses: [], notes: [] },
    defects: [],
    verdict: { status: 'satisfied', musts: [] },
    nextAction: {
      kind: 'accept',
      instructions: '按当前构建交付。',
      affectedSpaceIds: [],
      affectedElementIds: [],
    },
    provenance: {
      version: 1,
      evidence: 'verified',
      specSha256: 'a'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      verifiedMustIds: [],
    },
  });
}

test('正常路径：intake → … → accept，事件 seq 连续', () => {
  let state = advanceToReview();
  assert.equal(state.stage, 'review');
  state = reduceSession(state, { kind: 'confirmDesign', designRevision: 1 });
  assert.equal(state.stage, 'confirm');
  assert.equal(state.confirmedDesignRevision, 1);
  assert.equal(state.designs[0]?.meta.status, 'confirmed');

  const brief = compileBuildBrief(exampleScheme(), exampleRequirements());
  state = reduceSession(state, { kind: 'compileBrief', brief });
  assert.equal(state.stage, 'compile');
  state = reduceSession(state, { kind: 'startBuild', runId: 'run-1' });
  assert.equal(state.stage, 'build');
  state = reduceSession(state, {
    kind: 'finishBuild',
    runId: 'run-1',
    status: 'succeeded',
    failure: null,
  });
  assert.equal(state.stage, 'post-review');
  state = reduceSession(state, { kind: 'recordReview', report: report() });
  assert.equal(state.review?.designVersion.revision, 1);
  state = reduceSession(state, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' });
  assert.equal(state.stage, 'accept');
  assert.equal(state.events[state.events.length - 1]?.type, 'session.outcome');
  state.events.forEach((event, index) => {
    assert.equal(event.seq, index);
  });
});

test('用户改主意：review → revise → 新 revision，旧版本保留', () => {
  let state = advanceToReview();
  state = reduceSession(state, { kind: 'requestRevision', reason: '屋檐再深一点，别太像旅游景点' });
  assert.equal(state.stage, 'revise');
  state = reduceSession(state, { kind: 'proposeDesign', scheme: exampleScheme(2) });
  assert.equal(state.stage, 'check');
  assert.equal(state.designs.length, 2);
  assert.equal(state.designs[0]?.meta.status, 'superseded');
  assert.equal(state.currentDesignRevision, 2);
  state = reduceSession(state, {
    kind: 'recordCheck',
    designRevision: 2,
    passed: true,
    issues: [],
  });
  state = reduceSession(state, { kind: 'confirmDesign', designRevision: 2 });
  assert.equal(state.stage, 'confirm');
  assert.equal(state.confirmedDesignRevision, 2);
  assert.equal(state.designs[1]?.meta.status, 'confirmed');
});

test('proposeDesign 携带 intent 时按 revision 与方案一起保留，旧 intent 不被覆盖', () => {
  let state = createSession('ses-intents');
  state = reduceSession(state, { kind: 'recordRequirements', graph: exampleRequirements() });
  state = reduceSession(state, { kind: 'skipClarify' });
  state = reduceSession(state, { kind: 'proposeDesign', scheme: exampleScheme(), intent: exampleIntent() });
  const firstIntents = state.intents ?? [];
  assert.equal(firstIntents.length, 1);
  assert.equal(firstIntents[0]!.meta.title, '稻田茶亭');
  state = reduceSession(state, { kind: 'recordCheck', designRevision: 1, passed: true, issues: [] });
  state = reduceSession(state, { kind: 'requestRevision', reason: '屋檐再深一点' });
  state = reduceSession(state, { kind: 'proposeDesign', scheme: exampleScheme(2), intent: exampleIntent() });
  const intents = state.intents ?? [];
  assert.equal(intents.length, 2);
  assert.equal(state.designs.length, 2);
  assert.equal(state.designs[0]?.meta.status, 'superseded');
  assert.equal(intents[0]!.meta.title, '稻田茶亭');
});

test('确认后不能静默修改：必须显式 requestRevision', () => {
  const state = advanceToConfirm();
  assert.throws(
    () => reduceSession(state, { kind: 'proposeDesign', scheme: exampleScheme(2) }),
    SessionTransitionError,
  );
  assert.throws(
    () => reduceSession(state, { kind: 'recordRequirements', graph: exampleRequirements(2) }),
    SessionTransitionError,
  );
  assert.throws(
    () =>
      reduceSession(state, {
        kind: 'compileBrief',
        brief: compileBuildBrief(exampleScheme(2), exampleRequirements(2)),
      }),
    /不一致/,
  );
});

test('构建失败回到 compile 可重试，并保留失败原因', () => {
  let state = advanceToConfirm();
  state = reduceSession(state, {
    kind: 'compileBrief',
    brief: compileBuildBrief(exampleScheme(), exampleRequirements()),
  });
  state = reduceSession(state, { kind: 'startBuild', runId: 'run-fail' });
  state = reduceSession(state, {
    kind: 'finishBuild',
    runId: 'run-fail',
    status: 'failed',
    failure: '沙箱执行超时',
  });
  assert.equal(state.stage, 'compile');
  const failedBuild = state.build;
  assert.ok(failedBuild);
  assert.equal(failedBuild.status, 'failed');
  assert.equal(failedBuild.failure, '沙箱执行超时');
  state = reduceSession(state, { kind: 'startBuild', runId: 'run-retry' });
  assert.equal(state.stage, 'build');
  assert.equal(state.build?.runId, 'run-retry');
});

test('构建失败必须给原因；评审必须匹配 buildRunId 与 revision', () => {
  let state = advanceToConfirm();
  state = reduceSession(state, {
    kind: 'compileBrief',
    brief: compileBuildBrief(exampleScheme(), exampleRequirements()),
  });
  state = reduceSession(state, { kind: 'startBuild', runId: 'run-1' });
  assert.throws(
    () => reduceSession(state, { kind: 'finishBuild', runId: 'run-1', status: 'failed', failure: null }),
    /失败原因/,
  );
  state = reduceSession(state, {
    kind: 'finishBuild',
    runId: 'run-1',
    status: 'succeeded',
    failure: null,
  });
  assert.throws(() => reduceSession(state, { kind: 'recordReview', report: report('run-other') }), /runId/);
  assert.throws(() => reduceSession(state, { kind: 'recordReview', report: report('run-1', 2) }), /设计版本/);
});

test('adoptBuildReview：新 run 的评审替换旧评审，旧评审标记 stale 且可重复采纳', () => {
  const reviewA = report('run-1', 1);
  const waiver = ReviewWaiver.parse({
    mustId: 'req-use',
    designRevision: 1,
    by: 'user',
    choice: '接受现状',
    conflictId: null,
    note: null,
  });
  const staleWaiver = ReviewWaiver.parse({ ...waiver, mustId: 'req-view', designRevision: 2 });
  const seeded = {
    ...advanceToPostReview(reviewA),
    reviewWaivers: [waiver, staleWaiver],
  };
  assert.deepEqual(seeded.review, reviewA);

  const reviewB = report('run-2', 1);
  const adopted = reduceSession(seeded, { kind: 'adoptBuildReview', runId: 'run-2', report: reviewB });
  assert.equal(adopted.stage, 'post-review');
  assert.deepEqual(adopted.review, reviewB);
  const build = adopted.build;
  assert.ok(build);
  assert.equal(build.runId, 'run-2');
  assert.equal(build.designId, 'scheme-tea');
  assert.equal(build.designRevision, 1);
  assert.equal(build.status, 'succeeded');
  assert.equal(build.failure, null);
  assert.deepEqual(adopted.reviewWaivers, [waiver]);

  const history = adopted.reviewHistory ?? [];
  assert.equal(history.length, 1);
  const firstStale = history[0];
  assert.ok(firstStale);
  assert.deepEqual(firstStale.review, reviewA);
  assert.equal(firstStale.stale, true);
  assert.equal(firstStale.supersededByRunId, 'run-2');

  const event = adopted.events[adopted.events.length - 1];
  assert.ok(event);
  assert.equal(event.type, 'review.completed');
  assert.deepEqual(event.report, reviewB);

  // 同一个 run / 同一份报告再次采纳：不重复把当前评审标记为 stale。
  const readopted = reduceSession(adopted, { kind: 'adoptBuildReview', runId: 'run-2', report: reviewB });
  assert.equal(readopted.reviewHistory?.length, 1);
  assert.deepEqual(readopted.reviewHistory, history);
});

test('recordReview：第二次评审替换旧评审，旧评审进入 reviewHistory 且 stale', () => {
  const reviewA = report('run-1');
  const state = advanceToPostReview(reviewA);
  assert.equal((state.reviewHistory ?? []).length, 0);
  const build = state.build;
  assert.ok(build !== null);
  const withRunB = {
    ...state,
    build: { ...build, runId: 'run-2' },
  };
  const reviewB = report('run-2');
  const next = reduceSession(withRunB, { kind: 'recordReview', report: reviewB });
  assert.equal(next.review?.buildRunId, 'run-2');
  const history = next.reviewHistory ?? [];
  assert.equal(history.length, 1);
  const [first] = history;
  assert.ok(first !== undefined);
  assert.equal(first.stale, true);
  assert.equal(first.review.buildRunId, 'run-1');
  assert.equal(first.supersededByRunId, 'run-2');
  // 同一 run 的重试不重复写 stale。
  const retried = reduceSession(next, { kind: 'recordReview', report: reviewB });
  assert.equal((retried.reviewHistory ?? []).length, 1);
});

test('resolveReview accept：库级调用拒绝 report.runId 与当前 build 不一致', () => {
  const base = reportWithMusts([{ requirementId: 'req-use', status: 'met' }]);
  const state = advanceToPostReview(base);
  // 同一 run 可以 accept，证明拒绝来自 run 绑定而不是其他门槛。
  assert.equal(
    reduceSession(state, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }).stage,
    'accept',
  );
  const build = state.build;
  assert.ok(build !== null);
  const mismatch = { ...state, build: { ...build, runId: 'run-2' } };
  assert.throws(
    () => reduceSession(mismatch, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }),
    /评审 runId=run-1 与当前 build=run-2 不一致/,
  );
});

test('currentReview：review 与 build.runId 不一致时 API 不可见', () => {
  const reviewA = report('run-1', 1);
  const state = advanceToPostReview(reviewA);
  assert.deepEqual(currentReview(state), reviewA);
  const mismatched = { ...state, build: { ...state.build!, runId: 'run-2' } };
  assert.equal(currentReview(mismatched), null);
  const noBuild = { ...state, build: null };
  assert.equal(currentReview(noBuild), null);
});

test('adoptBuildReview：replacesRunId 防止旧评审把新 run 回滚', () => {
  const reviewB = report('run-2', 1);
  const seeded = reduceSession(advanceToPostReview(report('run-1', 1)), {
    kind: 'adoptBuildReview',
    runId: 'run-2',
    report: reviewB,
    replacesRunId: 'run-1',
  });
  assert.equal(seeded.build?.runId, 'run-2');
  assert.throws(
    () =>
      reduceSession(seeded, {
        kind: 'adoptBuildReview',
        runId: 'run-1',
        report: report('run-1', 1),
        replacesRunId: 'run-2',
      }),
    /评审已 stale，不能回滚成当前评审/,
  );
  // 旧报告不能回滚当前 build / review。
  assert.equal(seeded.build.runId, 'run-2');
  const seededReview = seeded.review;
  assert.ok(seededReview !== null);
  assert.equal(seededReview.buildRunId, 'run-2');
});

test('adoptBuildReview：compile / build 阶段可直接采纳已确认 revision 的新 run', () => {
  let compileState = advanceToConfirm();
  compileState = reduceSession(compileState, {
    kind: 'compileBrief',
    brief: compileBuildBrief(exampleScheme(), exampleRequirements()),
  });
  const buildState = reduceSession(compileState, { kind: 'startBuild', runId: 'run-1' });
  for (const state of [compileState, buildState]) {
    const adopted = reduceSession(state, {
      kind: 'adoptBuildReview',
      runId: 'run-9',
      report: report('run-9', 1),
    });
    assert.equal(adopted.stage, 'post-review');
    const adoptedBuild = adopted.build;
    assert.ok(adoptedBuild);
    assert.equal(adoptedBuild.runId, 'run-9');
    assert.equal(adoptedBuild.status, 'succeeded');
    const adoptedReview = adopted.review;
    assert.ok(adoptedReview);
    assert.equal(adoptedReview.buildRunId, 'run-9');
    assert.deepEqual(adopted.reviewHistory, []);
  }
});

test('adoptBuildReview：runId 或已确认方案版本不匹配时拒绝', () => {
  const state = advanceToPostReview(report('run-1', 1));
  assert.throws(
    () => reduceSession(state, { kind: 'adoptBuildReview', runId: 'run-2', report: report('run-1', 1) }),
    SessionTransitionError,
  );
  assert.throws(
    () => reduceSession(state, { kind: 'adoptBuildReview', runId: 'run-2', report: report('run-2', 2) }),
    SessionTransitionError,
  );
  const wrongScheme = ReviewReport.parse({
    ...report('run-2', 1),
    designVersion: { schemeId: 'scheme-other', revision: 1 },
  });
  assert.throws(
    () => reduceSession(state, { kind: 'adoptBuildReview', runId: 'run-2', report: wrongScheme }),
    SessionTransitionError,
  );
  assert.throws(
    () => reduceSession(advanceToReview(), { kind: 'adoptBuildReview', runId: 'run-2', report: report('run-2', 1) }),
    /不能在阶段/,
  );
});

test('adoptBuildReview：reviewHistory 随 session.json 往返保留，旧状态缺字段按空处理', async () => {
  await withTempDir(async (root) => {
    const adopted = reduceSession(advanceToPostReview(report('run-1', 1)), {
      kind: 'adoptBuildReview',
      runId: 'run-2',
      report: report('run-2', 1),
    });
    await saveSession(adopted, { root });

    const stripped = await loadSession('ses-tea', { root });
    assert.ok(stripped !== null);
    assert.equal(stripped.review, null);
    assert.deepEqual(stripped.reviewHistory, adopted.reviewHistory);

    const revalidated = await loadSessionForReviewRevalidation('ses-tea', () => true, { root });
    assert.ok(revalidated !== null);
    assert.deepEqual(revalidated.review, adopted.review);
    assert.deepEqual(revalidated.reviewHistory, adopted.reviewHistory);

    // 模拟旧 session.json：没有 reviewHistory 字段，但已有 review 仍按空历史处理。
    const { reviewHistory, ...legacy } = adopted;
    assert.ok(reviewHistory !== undefined);
    await saveSession(legacy, { root });
    const legacyLoaded = await loadSessionForReviewRevalidation('ses-tea', () => true, { root });
    assert.ok(legacyLoaded !== null);
    assert.deepEqual(legacyLoaded.reviewHistory, []);
    assert.deepEqual(legacyLoaded.review, adopted.review);
    const next = reduceSession(legacyLoaded, {
      kind: 'adoptBuildReview',
      runId: 'run-3',
      report: report('run-3', 1),
    });
    const nextHistory = next.reviewHistory ?? [];
    assert.equal(nextHistory.length, 1);
    const nextStale = nextHistory[0];
    assert.ok(nextStale);
    assert.deepEqual(nextStale.review, adopted.review);
    assert.equal(nextStale.supersededByRunId, 'run-3');
  });
});

test('adoptBuildReview：reviewHistory 只保留最近 32 条', () => {
  const history = Array.from({ length: 40 }, (_, index) => ({
    review: report(`run-old-${String(index)}`, 1),
    stale: true as const,
    supersededByRunId: `run-old-${String(index + 1)}`,
  }));
  const seeded = { ...advanceToPostReview(report('run-1', 1)), reviewHistory: history };
  const adopted = reduceSession(seeded, {
    kind: 'adoptBuildReview',
    runId: 'run-2',
    report: report('run-2', 1),
  });
  const adoptedHistory = adopted.reviewHistory ?? [];
  assert.equal(adoptedHistory.length, 32);
  const lastStale = adoptedHistory[31];
  assert.ok(lastStale);
  assert.equal(lastStale.supersededByRunId, 'run-2');
});

test('错误分支：澄清、版本递增、检查绑定、编译绑定与评审批次', () => {
  assert.throws(() => createSession(''));
  let state = createSession('ses-errors');
  assert.throws(() => reduceSession(state, { kind: 'userMessage', text: ' ' }), /不能为空/);
  state = reduceSession(state, { kind: 'userMessage', text: '你好' });
  state = reduceSession(state, { kind: 'assistantMessage', text: '你好，请说说需求。' });
  state = reduceSession(state, { kind: 'recordRequirements', graph: exampleRequirements() });
  assert.throws(() => reduceSession(state, { kind: 'recordRequirements', graph: exampleRequirements() }), /递增/);
  assert.throws(() => reduceSession(state, { kind: 'recordRequirements', graph: exampleRequirements(3) }), /递增/);
  assert.throws(
    () =>
      reduceSession(state, {
        kind: 'recordRequirements',
        graph: { ...exampleRequirements(2), id: 'req-other' },
      }),
    /id 不能/,
  );
  assert.throws(() => reduceSession(state, { kind: 'askQuestions', questions: [] }), /最多/);
  assert.throws(
    () =>
      reduceSession(state, {
        kind: 'askQuestions',
        questions: [
          { id: 'q-1', text: 'a' },
          { id: 'q-1', text: 'b' },
        ],
      }),
    /id 重复/,
  );

  state = reduceSession(state, {
    kind: 'askQuestions',
    questions: [
      { id: 'q-1', text: '需要柜台吗？' },
      { id: 'q-2', text: '稻田在哪侧？' },
    ],
  });
  assert.throws(
    () =>
      reduceSession(state, {
        kind: 'answerQuestions',
        answers: [{ questionId: 'q-1', answer: '需要' }],
        graph: null,
      }),
    /数量/,
  );
  assert.throws(
    () =>
      reduceSession(state, {
        kind: 'answerQuestions',
        answers: [
          { questionId: 'q-missing', answer: '需要' },
          { questionId: 'q-2', answer: '南侧' },
        ],
        graph: null,
      }),
    /不存在的问题/,
  );
  assert.throws(
    () =>
      reduceSession(state, {
        kind: 'answerQuestions',
        answers: [
          { questionId: 'q-1', answer: '需要' },
          { questionId: 'q-1', answer: '不需要' },
        ],
        graph: null,
      }),
    /多次/,
  );
  state = reduceSession(state, {
    kind: 'answerQuestions',
    answers: [
      { questionId: 'q-1', answer: '需要' },
      { questionId: 'q-2', answer: '南侧' },
    ],
    graph: exampleRequirements(2),
  });
  assert.equal(state.stage, 'design');
  assert.equal(state.requirements?.revision, 2);

  assert.throws(
    () => reduceSession(state, { kind: 'proposeDesign', scheme: exampleScheme(2) }),
    /首个方案 revision 必须是 1/,
  );
  state = reduceSession(state, { kind: 'proposeDesign', scheme: exampleScheme() });
  assert.throws(
    () => reduceSession(state, { kind: 'recordCheck', designRevision: 2, passed: true, issues: [] }),
    /检查绑定/,
  );
  assert.throws(
    () =>
      reduceSession(state, {
        kind: 'recordCheck',
        designRevision: 1,
        passed: true,
        issues: Array.from({ length: 101 }, () => 'issue'),
      }),
    /上限/,
  );
  const failedCheck = reduceSession(state, {
    kind: 'recordCheck',
    designRevision: 1,
    passed: false,
    issues: ['净高不足'],
  });
  assert.equal(failedCheck.stage, 'design');
  assert.throws(() => reduceSession(failedCheck, { kind: 'proposeDesign', scheme: exampleScheme(3) }), /递增/);
  const changedId = {
    ...exampleScheme(2),
    meta: { ...exampleScheme(2).meta, id: 'scheme-other' },
  };
  assert.throws(() => reduceSession(failedCheck, { kind: 'proposeDesign', scheme: changedId }), /id 不能/);

  state = reduceSession(failedCheck, { kind: 'proposeDesign', scheme: exampleScheme(2) });
  state = reduceSession(state, { kind: 'recordCheck', designRevision: 2, passed: true, issues: [] });
  assert.throws(() => reduceSession(state, { kind: 'confirmDesign', designRevision: 1 }), /确认绑定/);
  assert.throws(
    () =>
      reduceSession(
        { ...state, check: { ...state.check!, passed: false } },
        { kind: 'confirmDesign', designRevision: 2 },
      ),
    /没有通过/,
  );
  state = reduceSession(state, { kind: 'confirmDesign', designRevision: 2 });
  assert.throws(
    () =>
      reduceSession(state, {
        kind: 'compileBrief',
        brief: compileBuildBrief(exampleScheme(), exampleRequirements()),
      }),
    /不一致/,
  );
  state = reduceSession(state, {
    kind: 'compileBrief',
    brief: compileBuildBrief(exampleScheme(2), exampleRequirements(2)),
  });
  assert.throws(() => reduceSession({ ...state, brief: null }, { kind: 'startBuild', runId: 'run-x' }), /没有与当前/);
  state = reduceSession(state, { kind: 'startBuild', runId: 'run-1' });
  assert.throws(
    () => reduceSession(state, { kind: 'finishBuild', runId: 'run-2', status: 'succeeded', failure: null }),
    /不一致/,
  );
  const cancelled = reduceSession(state, {
    kind: 'finishBuild',
    runId: 'run-1',
    status: 'cancelled',
    failure: null,
  });
  assert.equal(cancelled.stage, 'compile');
  assert.equal(cancelled.build?.status, 'cancelled');
  state = reduceSession(cancelled, { kind: 'startBuild', runId: 'run-2' });
  state = reduceSession(state, {
    kind: 'finishBuild',
    runId: 'run-2',
    status: 'succeeded',
    failure: null,
  });
  assert.throws(
    () => reduceSession(state, { kind: 'resolveReview', action: 'accept', instructions: '接受' }),
    /还没有评审/,
  );
  assert.throws(
    () =>
      reduceSession(
        { ...state, build: { ...state.build!, status: 'failed' } },
        { kind: 'recordReview', report: report('run-2', 2) },
      ),
    /没有成功的构建结果/,
  );
  state = reduceSession(state, { kind: 'recordReview', report: report('run-2', 2) });

  const targeted = reduceSession(state, {
    kind: 'resolveReview',
    action: 'targeted-revision',
    instructions: '只改入口',
  });
  assert.equal(targeted.stage, 'targeted-revision');
  assert.throws(() => reduceSession(targeted, { kind: 'requestRevision', reason: '' }), /不能为空/);
  assert.equal(reduceSession(targeted, { kind: 'requestRevision', reason: '只改入口' }).stage, 'revise');

  const redesign = reduceSession(state, {
    kind: 'resolveReview',
    action: 'redesign',
    instructions: '重做方案',
  });
  assert.equal(redesign.stage, 'redesign');
  assert.equal(reduceSession(redesign, { kind: 'requestRevision', reason: '重做' }).stage, 'revise');

  let skipped = createSession('ses-skip');
  skipped = reduceSession(skipped, { kind: 'recordRequirements', graph: exampleRequirements() });
  skipped = reduceSession(skipped, { kind: 'skipClarify' });
  assert.equal(skipped.stage, 'design');
});

test('resolveReview accept：unverified / not-met 与无 waiver 的 waived 都拒绝', () => {
  for (const must of [
    { requirementId: 'req-use', status: 'unverified' },
    { requirementId: 'req-use', status: 'not-met' },
    { requirementId: 'req-use', status: 'waived' },
  ]) {
    const state = advanceToPostReview(reportWithMusts([must]));
    assert.throws(
      () => reduceSession(state, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }),
      (error: unknown) =>
        error instanceof SessionTransitionError &&
        error.message.includes('必须项') &&
        error.message.includes(must.status),
      must.status,
    );
    const revised = reduceSession(state, {
      kind: 'resolveReview',
      action: 'targeted-revision',
      instructions: '先修必须项。',
    });
    assert.equal(revised.stage, 'targeted-revision');
  }
});

test('resolveReview accept：全部 met，或 waived 带当前 revision 的用户 waiver 时放行', () => {
  const met = advanceToPostReview(
    reportWithMusts([
      { requirementId: 'req-use', status: 'met' },
      { requirementId: 'req-view', status: 'met' },
    ]),
  );
  assert.equal(
    reduceSession(met, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }).stage,
    'accept',
  );

  const waiver = ReviewWaiver.parse({
    mustId: 'req-use',
    designRevision: 1,
    by: 'user',
    choice: '接受入口一级台阶',
    conflictId: null,
    note: null,
  });
  const explicit = advanceToPostReview(
    reportWithMusts([
      { requirementId: 'req-use', status: 'unverified' },
      { requirementId: 'req-view', status: 'met' },
    ]),
  );
  const waived = reduceSession(explicit, {
    kind: 'waiveReviewMust',
    mustId: 'req-use',
    choice: waiver.choice,
  });
  assert.deepEqual(waived.reviewWaivers, [waiver]);
  assert.equal(
    reduceSession(waived, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }).stage,
    'accept',
  );

  // 报告自称 waived 但没有显式用户命令：不合并进状态 waiver，accept 被拒。
  const reportOnly = advanceToPostReview(reportWithMusts([{ requirementId: 'req-use', status: 'waived', waiver }]));
  assert.deepEqual(reportOnly.reviewWaivers, []);
  assert.throws(
    () => reduceSession(reportOnly, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }),
    /必须项/,
  );

  const staleWaiver = { ...waiver, designRevision: 2 };
  const stale = advanceToPostReview(
    reportWithMusts([{ requirementId: 'req-use', status: 'waived', waiver: staleWaiver }]),
  );
  assert.throws(
    () => reduceSession(stale, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }),
    /必须项/,
  );

  const mismatched = advanceToPostReview(
    reportWithMusts([{ requirementId: 'req-use', status: 'waived', waiver: { ...waiver, mustId: 'req-view' } }]),
  );
  assert.throws(
    () => reduceSession(mismatched, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }),
    /必须项/,
  );
});

test('run-9 41-waiver bypass：not-met 不可豁免，accept 仍被阻断', () => {
  const musts = Array.from({ length: 41 }, (_, index) => ({
    requirementId: index < 4 ? `hard-${String(index)}` : `unverified-${String(index)}`,
    status: index < 4 ? ('not-met' as const) : ('unverified' as const),
  }));
  const base = ReviewReport.parse({
    designVersion: { schemeId: 'scheme-tea', revision: 1 },
    buildRunId: 'run-1',
    objective: { measurements: [], notes: [] },
    visual: { verdict: 'pass', strengths: [], weaknesses: [], notes: [] },
    defects: [],
    verdict: { status: 'not-satisfied', musts },
    nextAction: {
      kind: 'ask-user',
      instructions: '仍有硬失败。',
      affectedSpaceIds: [],
      affectedElementIds: [],
    },
  });
  const waivers = musts.map((must) => ({
    mustId: must.requirementId,
    designRevision: 1,
    by: 'user' as const,
    choice: '全部豁免',
    conflictId: null,
    note: null,
  }));
  const applied = applyReviewWaivers(base, waivers);
  assert.equal(applied.verdict.musts.filter((must) => must.status === 'not-met').length, 4);
  assert.equal(applied.verdict.musts.filter((must) => must.status === 'waived').length, 37);
  assert.equal(applied.verdict.status, 'not-satisfied');
  assert.notEqual(applied.nextAction.kind, 'accept');
  assert.equal(reviewAcceptBlockers(applied, waivers).length, 4);

  let state = advanceToPostReview(base);
  for (const waiver of waivers) {
    state = reduceSession(state, {
      kind: 'waiveReviewMust',
      mustId: waiver.mustId,
      choice: waiver.choice,
    });
  }
  assert.equal(state.reviewWaivers?.length, 41);
  assert.throws(
    () => reduceSession(state, { kind: 'resolveReview', action: 'accept', instructions: '强行接受。' }),
    /必须项/,
  );
});

test('resolveReview accept：all met 但 verdict 非 satisfied / nextAction 非 accept 仍拒绝', () => {
  const base = reportWithMusts([{ requirementId: 'req-use', status: 'met' }]);
  const partial = ReviewReport.parse({
    ...base,
    verdict: { ...base.verdict, status: 'partial' },
  });
  const partialState = advanceToPostReview(partial);
  assert.throws(
    () => reduceSession(partialState, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }),
    /verdict=partial/,
  );

  const nonAccept = ReviewReport.parse({
    ...base,
    nextAction: { ...base.nextAction, kind: 'targeted-revision' },
  });
  const nonAcceptState = advanceToPostReview(nonAccept);
  assert.throws(
    () => reduceSession(nonAcceptState, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }),
    /nextAction=targeted-revision/,
  );

  const waived = ReviewReport.parse({
    ...base,
    verdict: {
      status: 'satisfied',
      musts: [
        {
          requirementId: 'req-use',
          status: 'waived',
          waiver: {
            mustId: 'req-use',
            designRevision: 1,
            by: 'user',
            choice: '接受入口台阶',
            conflictId: null,
            note: null,
          },
        },
      ],
    },
  });
  const waivedState = advanceToPostReview(waived);
  const explicitWaiver = reduceSession(waivedState, {
    kind: 'waiveReviewMust',
    mustId: 'req-use',
    choice: '接受入口台阶',
  });
  assert.equal(
    reduceSession(explicitWaiver, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }).stage,
    'accept',
  );
});

test('resolveReview accept：mustsTruncated=true 即使其余全满足也拒绝', () => {
  const base = reportWithMusts([{ requirementId: 'req-use', status: 'met' }]);
  const truncated = ReviewReport.parse({
    ...base,
    verdict: { ...base.verdict, mustsTruncated: true },
    nextAction: { ...base.nextAction, kind: 'accept' },
  });
  const state = advanceToPostReview(truncated);
  assert.throws(
    () => reduceSession(state, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }),
    /mustsTruncated/,
  );
});

test('waiveReviewMust：豁免持久化、重算评审并可 accept；新 revision 不继承', () => {
  let state = advanceToPostReview(reportWithUnverifiedMust());
  assert.throws(
    () => reduceSession(state, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' }),
    /必须项/,
  );
  assert.throws(
    () => reduceSession(advanceToReview(), { kind: 'waiveReviewMust', mustId: 'req-use', choice: '豁免' }),
    /不能在阶段/,
  );
  assert.throws(
    () => reduceSession({ ...state, review: null }, { kind: 'waiveReviewMust', mustId: 'req-use', choice: '豁免' }),
    /还没有评审报告/,
  );
  assert.throws(
    () => reduceSession(state, { kind: 'waiveReviewMust', mustId: 'must-missing', choice: '豁免' }),
    /没有必须项/,
  );
  assert.throws(
    () =>
      reduceSession(advanceToPostReview(reportWithMusts([{ requirementId: 'req-use', status: 'met' }])), {
        kind: 'waiveReviewMust',
        mustId: 'req-use',
        choice: '豁免',
      }),
    /已 met/,
  );

  state = reduceSession(state, {
    kind: 'waiveReviewMust',
    mustId: 'req-use',
    choice: '接受入口现状',
    note: '甲方确认',
  });
  assert.equal(state.stage, 'post-review');
  assert.equal(state.reviewWaivers?.length, 1);
  const waiver = state.reviewWaivers[0];
  assert.ok(waiver);
  assert.equal(waiver.mustId, 'req-use');
  assert.equal(waiver.designRevision, 1);
  assert.equal(waiver.by, 'user');
  assert.equal(waiver.choice, '接受入口现状');
  assert.equal(waiver.note, '甲方确认');
  assert.equal(waiver.conflictId, null);

  const review = state.review;
  assert.ok(review);
  const must = review.verdict.musts[0];
  assert.ok(must);
  assert.equal(must.status, 'waived');
  assert.equal(must.waiver?.choice, '接受入口现状');
  assert.match(must.note ?? '', /用户已豁免/);
  assert.equal(review.verdict.status, 'satisfied');
  assert.equal(review.nextAction.kind, 'accept');
  assert.match(review.nextAction.instructions, /显式豁免/);

  const event = state.events[state.events.length - 1];
  assert.ok(event);
  if (event.type !== 'review.waived') {
    assert.fail(`期望 review.waived，实际是 ${event.type}`);
  }
  assert.equal(event.mustId, 'req-use');
  assert.equal(event.revision, 1);
  assert.equal(event.choice, '接受入口现状');

  const accepted = reduceSession(state, { kind: 'resolveReview', action: 'accept', instructions: '接受交付。' });
  assert.equal(accepted.stage, 'accept');

  // 新 revision 不继承旧 revision 的豁免。
  const revised = reduceSession(state, { kind: 'requestRevision', reason: '再改一版' });
  const next = reduceSession(revised, { kind: 'proposeDesign', scheme: exampleScheme(2) });
  assert.deepEqual(next.reviewWaivers, []);
});

test('waiveReviewMust：同 revision 重复豁免覆盖旧选择，不重复追加', () => {
  let state = advanceToPostReview(reportWithUnverifiedMust());
  state = reduceSession(state, { kind: 'waiveReviewMust', mustId: 'req-use', choice: '接受现状' });
  // 同 revision 的重复豁免覆盖旧选择，不重复追加。
  state = reduceSession(state, { kind: 'waiveReviewMust', mustId: 'req-use', choice: '改为接受台阶' });
  assert.equal(state.reviewWaivers?.length, 1);
  assert.equal(state.reviewWaivers[0]?.choice, '改为接受台阶');
});

test('旧 session.json 的 satisfied review 无 provenance：读取时清空评审，accept 失败关闭', async () => {
  await withTempDir(async (root) => {
    const current = advanceToPostReview(
      reportWithMusts([
        { requirementId: 'req-use', status: 'met' },
        { requirementId: 'req-view', status: 'met' },
      ]),
    );
    assert.ok(current.review !== null);
    const legacyReview = ReviewReport.parse({ ...current.review, provenance: undefined });
    const state = { ...current, review: legacyReview };
    await saveSession(state, { root });
    const loaded = await loadSession('ses-tea', { root, preserveReview: true });
    assert.ok(loaded !== null);
    assert.equal(loaded.review, null);
    assert.deepEqual(loaded.reviewWaivers, []);
    assert.equal(loaded.stage, 'post-review');
    assert.throws(
      () => reduceSession(loaded, { kind: 'resolveReview', action: 'accept', instructions: '旧评审接受。' }),
      /还没有评审|不能接受/,
    );
  });
});

test('旧 partial review 无 provenance：即使豁免也不能 accept', async () => {
  await withTempDir(async (root) => {
    const current = advanceToPostReview(reportWithUnverifiedMust());
    assert.ok(current.review !== null);
    const legacyReview = ReviewReport.parse({ ...current.review, provenance: undefined });
    await saveSession({ ...current, review: legacyReview }, { root });
    const loaded = await loadSessionForReviewRevalidation('ses-tea', () => true, { root });
    assert.ok(loaded !== null);
    assert.ok(loaded.review !== null);
    const waived = reduceSession(loaded, {
      kind: 'waiveReviewMust',
      mustId: 'req-use',
      choice: '旧评审豁免',
    });
    assert.throws(
      () => reduceSession(waived, { kind: 'resolveReview', action: 'accept', instructions: '旧评审接受。' }),
      /provenance/,
    );
  });
});

test('loadSession 默认也清空无 review 的 stale waivers', async () => {
  await withTempDir(async (root) => {
    const waiver = ReviewWaiver.parse({
      mustId: 'req-use',
      designRevision: 1,
      by: 'user',
      choice: '旧豁免',
      conflictId: null,
      note: null,
    });
    const state = createSession('ses-stale-waivers');
    await saveSession({ ...state, reviewWaivers: [waiver] }, { root });
    const loaded = await loadSession('ses-stale-waivers', { root });
    assert.deepEqual(loaded?.reviewWaivers, []);
  });
});

test('loadSession 不再因 preserveReview 保留 review；显式重验回调通过才返回', async () => {
  await withTempDir(async (root) => {
    const state = advanceToPostReview(
      reportWithMusts([
        { requirementId: 'req-use', status: 'met' },
        { requirementId: 'req-view', status: 'met' },
      ]),
    );
    await saveSession(state, { root });
    const direct = await loadSession('ses-tea', { root });
    assert.ok(direct !== null);
    assert.equal(direct.review, null);
    assert.throws(
      () => reduceSession(direct, { kind: 'resolveReview', action: 'accept', instructions: '直接接受。' }),
      /还没有评审/,
    );
    const bypass = await loadSession('ses-tea', { root, preserveReview: true });
    assert.ok(bypass !== null);
    assert.equal(bypass.review, null);
    assert.deepEqual(bypass.reviewWaivers, []);

    const rejected = await loadSessionForReviewRevalidation('ses-tea', () => false, { root });
    assert.ok(rejected !== null);
    assert.equal(rejected.review, null);
    assert.deepEqual(rejected.reviewWaivers, []);

    const revalidated = await loadSessionForReviewRevalidation('ses-tea', (raw) => raw.review?.buildRunId === 'run-1', {
      root,
    });
    assert.ok(revalidated?.review !== null);
  });
});

test('review 声称 waived 但状态里没有对应 waiver：读取时清空评审，不能 accept', async () => {
  await withTempDir(async (root) => {
    const waiver = ReviewWaiver.parse({
      mustId: 'req-use',
      designRevision: 1,
      by: 'user',
      choice: '豁免',
      conflictId: null,
      note: null,
    });
    const current = advanceToPostReview(
      reportWithMusts([
        { requirementId: 'req-use', status: 'waived', waiver },
        { requirementId: 'req-view', status: 'met' },
      ]),
    );
    // 模拟伪造 session.json：报告保留 waived，但状态 waiver 被删掉。
    await saveSession({ ...current, reviewWaivers: [] }, { root });
    const loaded = await loadSessionForReviewRevalidation('ses-tea', () => true, { root });
    assert.ok(loaded !== null);
    assert.equal(loaded.review, null);
    assert.deepEqual(loaded.reviewWaivers, []);
    assert.throws(
      () => reduceSession(loaded, { kind: 'resolveReview', action: 'accept', instructions: '伪造接受。' }),
      /还没有评审|不能接受/,
    );
  });
});

test('loadSessionForReviewRevalidation：非法 reviewWaiver 被丢弃', async () => {
  await withTempDir(async (root) => {
    const valid = ReviewWaiver.parse({
      mustId: 'req-use',
      designRevision: 1,
      by: 'user',
      choice: '有效豁免',
      conflictId: null,
      note: null,
    });
    const current = advanceToPostReview(
      reportWithMusts([
        { requirementId: 'req-use', status: 'met' },
        { requirementId: 'req-view', status: 'met' },
      ]),
    );
    const invalid = { mustId: 'req-view', by: 'model', choice: '伪造', designRevision: 1 };
    await saveSession({ ...current, reviewWaivers: [valid, invalid] as unknown as readonly ReviewWaiver[] }, { root });
    const loaded = await loadSessionForReviewRevalidation('ses-tea', () => true, { root });
    assert.ok(loaded !== null);
    assert.deepEqual(loaded.reviewWaivers, [valid]);
  });
});

test('session.json 往返保留冲突与 waiver；新 revision 清除 revision-scoped waiver', async () => {
  await withTempDir(async (root) => {
    const conflict = designConflictsFromWarnings([
      { code: 'furniture-dropped', message: '柜台被丢弃', path: 'furniture.f-counter' },
    ])[0];
    assert.ok(conflict);
    const waiver = ReviewWaiver.parse({
      mustId: 'req-use',
      designRevision: 1,
      by: 'user',
      choice: '接受柜台调整',
      conflictId: conflict.id,
      note: '先交付',
    });
    let state = createSession('ses-r2-roundtrip');
    state = reduceSession(state, { kind: 'recordRequirements', graph: exampleRequirements() });
    state = reduceSession(state, { kind: 'skipClarify' });
    state = reduceSession(state, {
      kind: 'proposeDesign',
      scheme: exampleScheme(),
      conflicts: [conflict],
    });
    state = reduceSession(state, { kind: 'recordCheck', designRevision: 1, passed: true, issues: [] });
    state = { ...state, reviewWaivers: [waiver] };

    await saveSession(state, { root });
    const loaded = await loadSessionForReviewRevalidation('ses-r2-roundtrip', () => true, { root });
    assert.ok(loaded !== null);
    assert.deepEqual(loaded.designConflicts, state.designConflicts);
    assert.deepEqual(loaded.reviewWaivers, [waiver]);
    assert.equal(loaded.designConflicts?.[0]?.id, conflict.id);

    const resolved = reduceSession(loaded, {
      kind: 'chooseConflictOption',
      conflictId: conflict.id,
      optionId: 'accept-drop',
    });
    await saveSession(resolved, { root });
    const reloaded = await loadSessionForReviewRevalidation('ses-r2-roundtrip', () => true, { root });
    assert.ok(reloaded !== null);
    const reloadedConflict = reloaded.designConflicts?.[0];
    assert.ok(reloadedConflict);
    assert.equal(reloadedConflict.status, 'resolved');
    assert.ok(reloadedConflict.choice !== null);
    assert.equal(reloadedConflict.choice.optionId, 'accept-drop');

    const revised = reduceSession(reloaded, { kind: 'requestRevision', reason: '换一版柜台' });
    const next = reduceSession(revised, { kind: 'proposeDesign', scheme: exampleScheme(2) });
    assert.deepEqual(next.reviewWaivers, []);
    assert.deepEqual(next.designConflicts, []);
  });
});
