/* eslint-disable max-lines -- 逐 must 视觉 / waiver / 截断回归共用同一组 fixture，集中在一个生成器测试文件里便于横向对照。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileBuildBrief } from './brief.ts';
import type { BuildSpec } from './build.ts';
import { exampleRequirements, exampleScheme } from './example.ts';
import { ReviewReport } from './review.ts';
import type { ReviewMeasurement, VisualReview } from './review.ts';
import type { ReviewEvidenceFile, ReviewWaiver } from './review-evidence.ts';
import { parseReviewEvidenceFile } from './review-evidence.ts';
import {
  applyReviewWaivers,
  buildReviewReport as buildReviewReportRaw,
  mustRequiresVisual,
} from './review-generate.ts';
import type { BuildReviewInput, ReviewRunFacts } from './review-generate.ts';
import { DesignScheme } from './scheme.ts';

const exampleBrief = compileBuildBrief(exampleScheme(), exampleRequirements());
const exampleSpec = exampleBrief.spec;
const TEST_BINDING = { specSha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64) };

/** 测试替身把当前 spec 的全部 must 当作已验证；生产由 defaultWebReviewBuilder 从 BuildSheet 派生。 */
function buildReviewReport(input: BuildReviewInput): ReturnType<typeof buildReviewReportRaw> {
  return buildReviewReportRaw({
    ...(input.evidence === undefined || input.evidence === null
      ? {}
      : { evidenceBinding: TEST_BINDING, verifiedMustIds: input.spec.musts.map((must) => must.id) }),
    ...input,
  });
}

function runFacts(spec: BuildSpec, overrides: Partial<ReviewRunFacts> = {}): ReviewRunFacts {
  return {
    runId: 'run-review-test',
    designId: spec.schemeId,
    designRevision: spec.schemeRevision,
    status: 'succeeded',
    failure: null,
    delivered: true,
    stopReason: null,
    checkPassed: true,
    cells: 9000,
    // RunSummary.bounds 是闭区间：4..15 / 4..13 → 12 × 10，与 buildingBounds 的 max - min 一致。
    bounds: [4, 1, 4, 15, 8, 13],
    renders: 3,
    ...overrides,
  };
}

function review(spec: BuildSpec, overrides: Partial<ReviewRunFacts> = {}, visual?: VisualReview): ReviewReport {
  const input: BuildReviewInput = {
    spec,
    run: runFacts(spec, overrides),
    ...(visual === undefined ? {} : { visual }),
  };
  return buildReviewReport(input);
}

function measurement(report: ReviewReport, name: string): ReviewMeasurement {
  const found = report.objective.measurements.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`缺少测量：${name}`);
  return found;
}

const PASS_VISUAL: VisualReview = {
  verdict: 'pass',
  strengths: ['比例与檐口成立'],
  weaknesses: [],
  notes: ['离线审核'],
};

const FAIL_VISUAL: VisualReview = {
  verdict: 'fail',
  strengths: ['檐口比例成立'],
  weaknesses: ['入口门槛缺失'],
  notes: ['南立面渲染图'],
};

/** 一条明确要求视觉证据的必须项，用于验证 visual 只在显式要求时参与判定。 */
function specWithVisualMust(): BuildSpec {
  return {
    ...exampleSpec,
    musts: [
      { id: 'must-visual-entry', text: '入口需看图确认视觉比例与方案一致。', source: 'detail' },
      ...exampleSpec.musts.slice(1),
    ],
  };
}

function evidenceFor(
  spec: BuildSpec,
  options: {
    readonly mapping?: 'heuristic' | 'verified';
    readonly status?: (index: number) => 'met' | 'not-met' | 'unverified' | 'waived';
  } = {},
): ReviewEvidenceFile {
  // conformance-evidence.json 的 musts 上限是 300；超过时只能为前 300 条提供证据。
  const covered = spec.musts.slice(0, 300);
  const statuses = covered.map((_, index) => options.status?.(index) ?? 'met');
  const count = (wanted: string): number => statuses.filter((status) => status === wanted).length;
  return parseReviewEvidenceFile({
    schemaVersion: 2,
    tool: 'conformance-evidence',
    mode: 'report-only',
    generatedBy: 'review-generate-test',
    mapping: options.mapping ?? 'verified',
    spec: { schemeId: spec.schemeId, schemeRevision: spec.schemeRevision, sha256: 'a'.repeat(64) },
    archive: { sha256: 'b'.repeat(64), bytes: 10 },
    datum: {
      slabTopY: 0,
      standingY: 1,
      gradeY: 1,
      entryTransition: 'flush',
      floorThickness: 1,
      source: 'build-spec',
    },
    musts: covered.map((must, index) => ({
      mustId: must.id,
      text: must.text,
      source: must.source,
      status: statuses[index],
      confidence: 'high',
      objects: [
        {
          expectedId: `object-${must.id}`,
          actualId: `object-${must.id}`,
          status: statuses[index] === 'not-met' ? 'fail' : 'pass',
          severity: 'hard',
        },
      ],
      evidence: [
        {
          kind: 'diff',
          ref: `conformance-diff.json#${must.id}`,
          summary: `${statuses[index] ?? 'unverified'}/hard`,
        },
      ],
      waiver: null,
      reason: null,
    })),
    summary: {
      met: count('met'),
      notMet: count('not-met'),
      waived: count('waived'),
      unverified: count('unverified'),
      acceptEligible: count('not-met') === 0 && count('unverified') === 0,
    },
  });
}

test('成功构建：客观测量通过，musts 未看图时要求人工确认', () => {
  const report = review(exampleSpec);

  for (const name of ['交付', '停止原因', '构建检查', '方块数', '占地（X × Z）', '渲染图']) {
    assert.equal(measurement(report, name).status, 'pass', `${name} 应通过`);
  }
  assert.equal(report.objective.measurements.length, 6);
  assert.equal(report.visual.verdict, 'not-reviewed');
  assert.deepEqual(report.visual.strengths, []);
  assert.deepEqual(report.visual.weaknesses, []);
  assert.deepEqual(report.visual.notes, ['未接入看图评审']);

  assert.equal(exampleSpec.musts.length > 0, true);
  assert.equal(report.verdict.musts.length, exampleSpec.musts.length);
  assert.equal(
    report.verdict.musts.every((must) => must.status === 'unverified'),
    true,
  );
  assert.equal(
    report.verdict.musts.every((must) => must.note?.includes('需看图 / 人工确认')),
    true,
  );
  assert.equal(report.verdict.status, 'partial');
  assert.equal(report.defects.length, 0);
  assert.equal(report.nextAction.kind, 'ask-user');
  assert.match(report.nextAction.instructions, /必须项仍需看图 \/ 人工确认/);
  assert.equal(ReviewReport.safeParse(report).success, true);
});

test('存在停止原因时优先 redesign，即使结果已交付', () => {
  const report = review(exampleSpec, { stopReason: '预算不足，停止在屋面施工' });

  assert.equal(measurement(report, '交付').status, 'pass');
  const stopped = measurement(report, '停止原因');
  assert.equal(stopped.status, 'fail');
  assert.match(stopped.actual, /预算不足/);
  assert.equal(report.verdict.status, 'not-satisfied');
  assert.equal(report.nextAction.kind, 'redesign');
  assert.match(report.nextAction.instructions, /预算不足/);

  const stoppedDefect = report.defects.find((entry) => entry.id === 'def-stop-reason');
  assert.ok(stoppedDefect);
  assert.equal(stoppedDefect.category, 'capability');
  assert.equal(stoppedDefect.severity, 'blocker');
  assert.match(stoppedDefect.evidence, /stopReason=预算不足/);
});

test('无交付时 redesign；用户取消且无原因时 ask-user', () => {
  const failed = review(exampleSpec, {
    status: 'failed',
    delivered: false,
    failure: 'runner crashed',
  });
  assert.equal(measurement(failed, '交付').status, 'fail');
  assert.equal(measurement(failed, '交付').actual, '未交付（status=failed）');
  assert.equal(failed.nextAction.kind, 'redesign');
  assert.match(failed.nextAction.instructions, /构建未形成可用交付/);
  assert.match(failed.nextAction.instructions, /runner crashed/);

  const deliveryDefect = failed.defects.find((entry) => entry.id === 'def-delivery');
  assert.ok(deliveryDefect);
  assert.equal(deliveryDefect.category, 'capability');
  assert.equal(deliveryDefect.severity, 'blocker');
  assert.match(deliveryDefect.evidence, /failure=runner crashed/);

  const cancelled = review(exampleSpec, {
    status: 'cancelled',
    delivered: false,
    failure: null,
  });
  assert.equal(cancelled.nextAction.kind, 'ask-user');
  assert.match(cancelled.nextAction.instructions, /构建已取消/);
});

test('超预算生成 construction 缺陷并要求定向修改', () => {
  const report = review(exampleSpec, { cells: 25_000 });

  const blocks = measurement(report, '方块数');
  assert.equal(blocks.status, 'fail');
  assert.match(blocks.expected, /20000/);
  assert.match(blocks.actual, /25000/);

  const blocksDefect = report.defects.find((entry) => entry.id === 'def-blocks');
  assert.ok(blocksDefect);
  assert.equal(blocksDefect.category, 'construction');
  assert.equal(blocksDefect.severity, 'major');
  assert.match(blocksDefect.evidence, /25000/);
  assert.match(blocksDefect.evidence, /20000/);
  assert.equal(report.verdict.status, 'not-satisfied');
  assert.equal(report.nextAction.kind, 'targeted-revision');
  assert.match(report.nextAction.instructions, /方块数/);
});

test('精确 12 × 10 的闭区间包围盒通过，不因半开 / 闭区间口径误判', () => {
  const report = review(exampleSpec, { bounds: [4, 1, 4, 15, 8, 13] });

  assert.equal(exampleSpec.counts.footprintX, 12);
  assert.equal(exampleSpec.counts.footprintZ, 10);
  const footprint = measurement(report, '占地（X × Z）');
  assert.equal(footprint.status, 'pass');
  assert.equal(footprint.actual, '12 × 10 格');
  assert.equal(footprint.evidence, null);
  assert.equal(
    report.defects.some((entry) => entry.id === 'def-footprint'),
    false,
  );
  assert.doesNotMatch(report.objective.notes.join('；'), /挑檐/);
});

test('占地偏大说明包围盒可能含挑檐 / 场地构件，标记 not-checked 而不误报失败', () => {
  const report = review(exampleSpec, { bounds: [3, 5, 3, 17, 8, 15] });

  const footprint = measurement(report, '占地（X × Z）');
  assert.equal(footprint.status, 'not-checked');
  assert.match(footprint.actual, /15 × 13/);
  assert.match(footprint.evidence ?? '', /运行包围盒可能含屋面挑檐 \/ 场地构件/);

  assert.equal(
    report.defects.some((entry) => entry.id === 'def-footprint'),
    false,
  );
  assert.match(report.objective.notes.join('；'), /挑檐/);
  assert.equal(report.verdict.status, 'partial');
  assert.equal(report.nextAction.kind, 'ask-user');
  assert.match(report.nextAction.instructions, /人工对照渲染图确认是否包含挑檐 \/ 场地构件/);
  assert.doesNotMatch(report.nextAction.instructions, /客观事实不足/);
});

test('占地小于方案时判失败并生成缺陷，不再保留挑檐 caveat', () => {
  const report = review(exampleSpec, { bounds: [8, 1, 8, 11, 5, 11] });

  const footprint = measurement(report, '占地（X × Z）');
  assert.equal(footprint.status, 'fail');
  assert.match(footprint.actual, /4 × 4/);
  assert.match(footprint.evidence ?? '', /小于方案建筑范围/);

  const footprintDefect = report.defects.find((entry) => entry.id === 'def-footprint');
  assert.ok(footprintDefect);
  assert.equal(footprintDefect.severity, 'major');
  assert.doesNotMatch(report.objective.notes.join('；'), /挑檐/);
  assert.equal(report.verdict.status, 'not-satisfied');
  assert.equal(report.nextAction.kind, 'targeted-revision');
  assert.match(report.nextAction.instructions, /占地/);
});

test('单格建筑：闭区间 [x..x, z..z] 是合法的 1 × 1，而不是无效包围盒', () => {
  const singleCellSpec: BuildSpec = {
    ...exampleSpec,
    counts: { ...exampleSpec.counts, footprintX: 1, footprintZ: 1, footprintAreaM2: 1 },
  };
  const report = review(singleCellSpec, { cells: 1, bounds: [5, 1, 5, 5, 1, 5] });

  const footprint = measurement(report, '占地（X × Z）');
  assert.equal(footprint.status, 'pass');
  assert.equal(footprint.actual, '1 × 1 格');
  assert.equal(footprint.evidence, null);
  assert.equal(
    report.defects.some((entry) => entry.id === 'def-footprint'),
    false,
  );
});

test('visual fail 没有视觉必须项时只作建议，不生成 def-visual', () => {
  const report = review(exampleSpec, {}, FAIL_VISUAL);

  assert.equal(report.visual.verdict, 'fail');
  // 没有 conformance 证据：musts 仍全部 unverified，accept 仍被阻断（安全）。
  assert.equal(
    report.verdict.musts.every((must) => must.status === 'unverified'),
    true,
  );
  assert.equal(report.verdict.status, 'partial');
  assert.equal(report.nextAction.kind, 'ask-user');
  assert.equal(
    report.defects.some((entry) => entry.id === 'def-visual'),
    false,
  );
  assert.match(report.objective.notes.join('；'), /视觉失败仅作建议/);

  // 几何 / 客观全部通过且没有必须项时，纯视觉 fail 不阻断 accept。
  const emptyMustSpec = compileBuildBrief(DesignScheme.parse({ ...exampleScheme(), details: [] })).spec;
  const advisory = review(emptyMustSpec, {}, FAIL_VISUAL);
  assert.equal(advisory.verdict.status, 'satisfied');
  assert.equal(advisory.nextAction.kind, 'accept');
  assert.equal(
    advisory.defects.some((entry) => entry.id === 'def-visual'),
    false,
  );

  const partialVisual = review(
    emptyMustSpec,
    {},
    {
      verdict: 'partial',
      strengths: [],
      weaknesses: ['窗框过厚'],
      notes: [],
    },
  );
  assert.equal(partialVisual.verdict.status, 'satisfied');
  assert.equal(partialVisual.nextAction.kind, 'accept');
});

test('mustRequiresVisual 只认显式视觉词，不把外观 / 风格当视觉要求', () => {
  assert.equal(mustRequiresVisual('入口需看图确认比例'), true);
  assert.equal(mustRequiresVisual('渲染图里的檐口比例'), true);
  assert.equal(mustRequiresVisual('视觉上不要遮挡稻田'), true);
  assert.equal(mustRequiresVisual('visual composition'), true);
  assert.equal(mustRequiresVisual('外立面须以效果图确认'), true);
  assert.equal(mustRequiresVisual('外观克制，风格统一'), false);
  assert.equal(mustRequiresVisual('入口比例协调'), false);
  // run-9 的“主厅视觉中心”只是设计描述，不是要求视觉证据。
  assert.equal(mustRequiresVisual('南墙 4m 大窗作为溪景取景框，是主厅的视觉中心。'), false);
});

test('spec.musts 为空且全部通过时 accept', () => {
  const emptyMustSpec = compileBuildBrief(DesignScheme.parse({ ...exampleScheme(), details: [] })).spec;
  assert.equal(emptyMustSpec.musts.length, 0);

  const report = review(
    emptyMustSpec,
    {},
    {
      verdict: 'pass',
      strengths: ['比例与檐口成立'],
      weaknesses: [],
      notes: ['离线审核'],
    },
  );

  assert.equal(report.verdict.musts.length, 0);
  assert.equal(report.verdict.status, 'satisfied');
  assert.equal(report.nextAction.kind, 'accept');
  assert.equal(report.defects.length, 0);
  assert.equal(ReviewReport.safeParse(report).success, true);
});

test('检查失败与缺渲染图分别生成缺陷', () => {
  const report = review(exampleSpec, { checkPassed: false, renders: 0 });

  assert.equal(measurement(report, '构建检查').status, 'fail');
  assert.equal(measurement(report, '渲染图').status, 'fail');
  assert.equal(report.nextAction.kind, 'targeted-revision');

  const checkDefect = report.defects.find((entry) => entry.id === 'def-check');
  assert.ok(checkDefect);
  assert.equal(checkDefect.category, 'construction');
  assert.equal(checkDefect.severity, 'blocker');

  const renderDefect = report.defects.find((entry) => entry.id === 'def-renders');
  assert.ok(renderDefect);
  assert.equal(renderDefect.category, 'capability');
  assert.equal(renderDefect.severity, 'minor');
});

test('缺失客观事实标记 not-checked 并询问用户', () => {
  const report = review(exampleSpec, {
    checkPassed: null,
    cells: null,
    bounds: null,
  });

  assert.equal(measurement(report, '构建检查').status, 'not-checked');
  assert.equal(measurement(report, '方块数').status, 'not-checked');
  assert.equal(measurement(report, '占地（X × Z）').status, 'not-checked');
  assert.equal(report.verdict.status, 'partial');
  assert.equal(report.nextAction.kind, 'ask-user');
  assert.match(report.nextAction.instructions, /客观事实不足/);
  assert.match(report.objective.notes.join('；'), /not-checked/);
});

test('verified 证据全部 met：必须项通过并允许 accept', () => {
  const report = buildReviewReport({
    spec: exampleSpec,
    run: runFacts(exampleSpec),
    visual: PASS_VISUAL,
    evidence: evidenceFor(exampleSpec),
  });

  assert.equal(exampleSpec.musts.length > 0, true);
  assert.equal(
    report.verdict.musts.every((must) => must.status === 'met'),
    true,
  );
  assert.equal(report.verdict.status, 'satisfied');
  assert.equal(report.nextAction.kind, 'accept');
  assert.equal(report.objective.notes.join('；').includes('mapping=verified'), true);
  assert.equal(
    report.verdict.musts.every((must) => (must.evidence[0]?.ref ?? '').startsWith('conformance-diff.json#')),
    true,
  );
  assert.equal(ReviewReport.safeParse(report).success, true);
});

test('evidenceBinding 正确哈希：保持 met / accept；spec 或 archive 哈希不符则全部 unverified', () => {
  const accepted = buildReviewReport({
    spec: exampleSpec,
    run: runFacts(exampleSpec),
    visual: PASS_VISUAL,
    evidence: evidenceFor(exampleSpec),
    evidenceBinding: { specSha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64) },
  });
  assert.equal(
    accepted.verdict.musts.every((must) => must.status === 'met'),
    true,
  );
  assert.equal(accepted.nextAction.kind, 'accept');

  for (const binding of [
    { specSha256: 'c'.repeat(64), archiveSha256: 'b'.repeat(64) },
    { specSha256: 'a'.repeat(64), archiveSha256: 'd'.repeat(64) },
  ]) {
    const stale = buildReviewReport({
      spec: exampleSpec,
      run: runFacts(exampleSpec),
      visual: PASS_VISUAL,
      evidence: evidenceFor(exampleSpec),
      evidenceBinding: binding,
    });
    assert.equal(
      stale.verdict.musts.every((must) => must.status === 'unverified'),
      true,
    );
    assert.match(stale.verdict.musts[0]?.note ?? '', /哈希不一致/);
    assert.match(stale.objective.notes.join('；'), /spec \/ archive 哈希/);
    assert.equal(stale.verdict.status, 'partial');
    assert.equal(stale.nextAction.kind, 'ask-user');
  }
});

test('只要一条必须项 unverified，就不能 accept', () => {
  const report = buildReviewReport({
    spec: exampleSpec,
    run: runFacts(exampleSpec),
    visual: PASS_VISUAL,
    evidence: evidenceFor(exampleSpec, { status: (index) => (index === 0 ? 'unverified' : 'met') }),
  });

  assert.equal(report.verdict.musts[0]?.status, 'unverified');
  assert.equal(report.verdict.status, 'partial');
  assert.equal(report.nextAction.kind, 'ask-user');
  assert.match(report.nextAction.instructions, /必须项仍需看图 \/ 人工确认/);
});

test('verified 证据全部 met + 没有 visual：视觉是建议，评审 satisfied / accept', () => {
  const report = buildReviewReport({
    spec: exampleSpec,
    run: runFacts(exampleSpec),
    evidence: evidenceFor(exampleSpec),
  });

  assert.equal(report.visual.verdict, 'not-reviewed');
  assert.equal(
    report.verdict.musts.every((must) => must.status === 'met'),
    true,
  );
  assert.equal(report.verdict.status, 'satisfied');
  assert.equal(report.nextAction.kind, 'accept');
  assert.match(report.objective.notes.join('；'), /visual=not-reviewed 仅作建议/);
  assert.equal(ReviewReport.safeParse(report).success, true);
});

test('必须项显式要求视觉证据但未看图：降级 unverified，评审 partial / ask-user', () => {
  const spec = specWithVisualMust();
  const report = buildReviewReport({
    spec,
    run: runFacts(spec),
    evidence: evidenceFor(spec),
  });

  const visualMust = report.verdict.musts.find((must) => must.requirementId === 'must-visual-entry');
  assert.equal(visualMust?.status, 'unverified');
  assert.match(visualMust.note ?? '', /视觉证据/);
  assert.equal(
    report.verdict.musts
      .filter((must) => must.requirementId !== 'must-visual-entry')
      .every((must) => must.status === 'met'),
    true,
  );
  assert.equal(report.verdict.status, 'partial');
  assert.equal(report.nextAction.kind, 'ask-user');
  assert.match(report.objective.notes.join('；'), /1 条必须项明确要求视觉证据/);
  assert.equal(
    report.defects.some((entry) => entry.id === 'def-visual'),
    false,
  );
});

test('必须项显式要求视觉证据且 visual pass：保留 met，satisfied / accept', () => {
  const spec = specWithVisualMust();
  const report = buildReviewReport({
    spec,
    run: runFacts(spec),
    visual: PASS_VISUAL,
    evidence: evidenceFor(spec),
  });

  const visualMust = report.verdict.musts.find((must) => must.requirementId === 'must-visual-entry');
  assert.equal(visualMust?.status, 'met');
  assert.equal(report.verdict.status, 'satisfied');
  assert.equal(report.nextAction.kind, 'accept');
});

test('必须项显式要求视觉证据且 visual fail：降级 not-met，targeted-revision', () => {
  const spec = specWithVisualMust();
  const report = buildReviewReport({
    spec,
    run: runFacts(spec),
    visual: FAIL_VISUAL,
    evidence: evidenceFor(spec),
  });

  const visualMust = report.verdict.musts.find((must) => must.requirementId === 'must-visual-entry');
  assert.equal(visualMust?.status, 'not-met');
  assert.match(visualMust.note ?? '', /视觉评审未通过/);
  assert.equal(report.verdict.status, 'not-satisfied');
  assert.equal(report.nextAction.kind, 'targeted-revision');
  assert.match(report.nextAction.instructions, /must-visual-entry/);

  const visualDefect = report.defects.find((entry) => entry.id === 'def-visual');
  assert.ok(visualDefect);
  assert.equal(visualDefect.category, 'design');
  assert.equal(visualDefect.severity, 'major');
  assert.match(visualDefect.evidence, /weaknesses=入口门槛缺失/);
});

test('视觉必须项已有 hard fail：未看图不能把 not-met 降级成 unverified', () => {
  const spec = specWithVisualMust();
  const report = buildReviewReport({
    spec,
    run: runFacts(spec),
    evidence: evidenceFor(spec, { status: (index) => (index === 0 ? 'not-met' : 'met') }),
  });
  const visualMust = report.verdict.musts.find((must) => must.requirementId === 'must-visual-entry');
  assert.equal(visualMust?.status, 'not-met');
  assert.equal(report.verdict.status, 'not-satisfied');
  assert.equal(report.nextAction.kind, 'targeted-revision');
});

test('豁免视觉必须项后移除 stale def-visual 与“按未验证处理”说明', () => {
  const spec = specWithVisualMust();
  const report = buildReviewReport({
    spec,
    run: runFacts(spec),
    visual: FAIL_VISUAL,
    evidence: evidenceFor(spec),
  });
  assert.ok(report.defects.some((entry) => entry.id === 'def-visual'));

  const waived = applyReviewWaivers(report, [
    {
      mustId: 'must-visual-entry',
      designRevision: spec.schemeRevision,
      by: 'user',
      choice: '接受当前视觉比例',
      conflictId: null,
      note: null,
    },
  ]);
  // 视觉失败已经把该 must 判成 not-met；豁免只能覆盖 unverified，不能改写硬结论。
  assert.equal(waived.verdict.musts[0]?.status, 'not-met');
  assert.equal(
    waived.defects.some((entry) => entry.id === 'def-visual'),
    true,
  );
  assert.equal(waived.verdict.status, 'not-satisfied');
  assert.equal(waived.nextAction.kind, 'targeted-revision');
});

test('视觉必须项的用户豁免优先于 visual 缺失', () => {
  const spec = specWithVisualMust();
  const waiver: ReviewWaiver = {
    mustId: 'must-visual-entry',
    designRevision: spec.schemeRevision,
    by: 'user',
    choice: '接受当前视觉比例',
    conflictId: null,
    note: '甲方确认',
  };
  const report = buildReviewReport({
    spec,
    run: runFacts(spec),
    evidence: evidenceFor(spec, { status: (index) => (index === 0 ? 'unverified' : 'met') }),
    waivers: [waiver],
  });

  const visualMust = report.verdict.musts.find((must) => must.requirementId === 'must-visual-entry');
  assert.equal(visualMust?.status, 'waived');
  assert.equal(report.verdict.status, 'satisfied');
  assert.equal(report.nextAction.kind, 'accept');
});

test('verified 证据全部 met + visual fail 且无视觉必须项：只记建议，仍 satisfied / accept', () => {
  const report = buildReviewReport({
    spec: exampleSpec,
    run: runFacts(exampleSpec),
    visual: FAIL_VISUAL,
    evidence: evidenceFor(exampleSpec),
  });

  assert.equal(
    report.verdict.musts.every((must) => must.status === 'met'),
    true,
  );
  assert.equal(report.verdict.status, 'satisfied');
  assert.equal(report.nextAction.kind, 'accept');
  assert.equal(
    report.defects.some((entry) => entry.id === 'def-visual'),
    false,
  );
  assert.match(report.objective.notes.join('；'), /视觉失败仅作建议/);
});

test('显式用户豁免允许 accept，即使没有逐条证据', () => {
  const singleMustSpec: BuildSpec = { ...exampleSpec, musts: [exampleSpec.musts[0]!] };
  const waiver: ReviewWaiver = {
    mustId: singleMustSpec.musts[0]!.id,
    designRevision: singleMustSpec.schemeRevision,
    by: 'user',
    choice: '保留现状',
    conflictId: null,
    note: '甲方确认',
  };
  const report = buildReviewReport({
    spec: singleMustSpec,
    run: runFacts(singleMustSpec),
    visual: PASS_VISUAL,
    evidence: evidenceFor(singleMustSpec, { status: () => 'unverified' }),
    waivers: [waiver],
  });

  assert.equal(report.verdict.musts[0]?.status, 'waived');
  assert.equal(report.verdict.musts[0].waiver?.choice, '保留现状');
  assert.equal(report.verdict.status, 'satisfied');
  assert.equal(report.nextAction.kind, 'accept');
});

test('heuristic 证据的 pass 永不产生 met', () => {
  const report = buildReviewReport({
    spec: exampleSpec,
    run: runFacts(exampleSpec),
    visual: PASS_VISUAL,
    evidence: evidenceFor(exampleSpec, { mapping: 'heuristic' }),
  });

  assert.equal(
    report.verdict.musts.every((must) => must.status === 'unverified'),
    true,
  );
  assert.equal(report.verdict.status, 'partial');
  assert.equal(report.nextAction.kind, 'ask-user');
  assert.match(report.objective.notes.join('；'), /heuristic/);
});

test('缺失证据文件回退为全部 unverified，不产生 met / accept', () => {
  const report = buildReviewReport({
    spec: exampleSpec,
    run: runFacts(exampleSpec),
    visual: PASS_VISUAL,
  });

  assert.equal(
    report.verdict.musts.every((must) => must.status === 'unverified'),
    true,
  );
  assert.equal(report.verdict.status, 'partial');
  assert.equal(report.nextAction.kind, 'ask-user');
  assert.match(report.verdict.musts[0]?.note ?? '', /需看图 \/ 人工确认/);
});

test('超过 MUSTS_MAX：301 条时截断，mustsTruncated 是明确 gate 信号', () => {
  const hugeMusts = Array.from({ length: 301 }, (_, index) => ({
    id: `must-bulk-${String(index + 1)}`,
    text: `批量必须项 ${String(index + 1)}`,
    source: 'detail' as const,
  }));
  const hugeSpec: BuildSpec = { ...exampleSpec, musts: hugeMusts };
  const hiddenId = hugeMusts[300]!.id;

  // conformance 证据最多 300 条：第 301 条没有证据，保持 unverified；截断本身也必须阻断 accept。
  const hiddenUnverified = buildReviewReport({
    spec: hugeSpec,
    run: runFacts(hugeSpec),
    visual: PASS_VISUAL,
    evidence: evidenceFor(hugeSpec),
  });
  assert.equal(hiddenUnverified.verdict.musts.length, 300);
  assert.equal(hiddenUnverified.verdict.mustsTruncated, true);
  assert.equal(hiddenUnverified.verdict.status, 'partial');
  assert.notEqual(hiddenUnverified.nextAction.kind, 'accept');
  assert.equal(hiddenUnverified.nextAction.kind, 'ask-user');
  assert.match(hiddenUnverified.nextAction.instructions, /必须项截断/);
  assert.match(hiddenUnverified.nextAction.instructions, /unverified 1/);
  assert.match(hiddenUnverified.objective.notes.join('；'), /mustsTruncated=true/);
  assert.match(hiddenUnverified.objective.notes.join('；'), /不能接受/);
  assert.equal(
    hiddenUnverified.verdict.musts.some((must) => must.requirementId === hiddenId),
    false,
  );
  assert.equal(ReviewReport.safeParse(hiddenUnverified).success, true);

  // 即使隐藏项有用户 waiver，截断也不能被绕过。
  const hiddenWaived = buildReviewReport({
    spec: hugeSpec,
    run: runFacts(hugeSpec),
    visual: PASS_VISUAL,
    evidence: evidenceFor(hugeSpec),
    waivers: [
      {
        mustId: hiddenId,
        designRevision: hugeSpec.schemeRevision,
        by: 'user',
        choice: '豁免隐藏项',
        conflictId: null,
        note: null,
      },
    ],
  });
  assert.equal(hiddenWaived.verdict.mustsTruncated, true);
  assert.equal(hiddenWaived.verdict.status, 'partial');
  assert.equal(hiddenWaived.nextAction.kind, 'ask-user');
  assert.match(hiddenWaived.nextAction.instructions, /必须项截断/);
  assert.notEqual(hiddenWaived.nextAction.kind, 'accept');
});

test('恰好 300 条必须项且全部 met：不截断，satisfied / accept', () => {
  const maxMusts = Array.from({ length: 300 }, (_, index) => ({
    id: `must-max-${String(index + 1)}`,
    text: `上限批量必须项 ${String(index + 1)}`,
    source: 'detail' as const,
  }));
  const maxSpec: BuildSpec = { ...exampleSpec, musts: maxMusts };
  const report = buildReviewReport({
    spec: maxSpec,
    run: runFacts(maxSpec),
    evidence: evidenceFor(maxSpec),
  });

  assert.equal(report.verdict.musts.length, 300);
  assert.equal(
    report.verdict.musts.every((must) => must.status === 'met'),
    true,
  );
  assert.equal(report.verdict.mustsTruncated, false);
  assert.equal(report.verdict.status, 'satisfied');
  assert.equal(report.nextAction.kind, 'accept');
  assert.equal(ReviewReport.safeParse(report).success, true);
});

test('applyReviewWaivers：当前 revision 豁免把 partial 提升为 satisfied / accept', () => {
  const base = buildReviewReport({
    spec: exampleSpec,
    run: runFacts(exampleSpec),
    visual: PASS_VISUAL,
    evidence: evidenceFor(exampleSpec, { mapping: 'heuristic', status: () => 'unverified' }),
    evidenceBinding: TEST_BINDING,
    verifiedMustIds: [],
  });
  assert.equal(base.verdict.status, 'partial');
  assert.notEqual(base.nextAction.kind, 'accept');

  const waivers: readonly ReviewWaiver[] = exampleSpec.musts.map((must, index) => ({
    mustId: must.id,
    designRevision: exampleSpec.schemeRevision,
    by: 'user',
    choice: `豁免必须项 ${String(index + 1)}`,
    conflictId: null,
    note: index === 0 ? '甲方确认' : null,
  }));

  const partial = applyReviewWaivers(base, [waivers[0]!]);
  assert.equal(partial.verdict.musts[0]?.status, 'waived');
  assert.equal(
    partial.verdict.musts.slice(1).every((must) => must.status === 'unverified'),
    true,
  );
  assert.equal(partial.verdict.status, 'partial');
  assert.equal(partial.nextAction.kind, 'ask-user');

  const applied = applyReviewWaivers(base, waivers);
  assert.deepEqual(
    applied.verdict.musts.map((must) => must.requirementId),
    base.verdict.musts.map((must) => must.requirementId),
  );
  assert.equal(
    applied.verdict.musts.every((must) => must.status === 'waived'),
    true,
  );
  const first = applied.verdict.musts[0];
  assert.ok(first);
  const firstWaiver = first.waiver;
  assert.ok(firstWaiver);
  assert.equal(firstWaiver.mustId, exampleSpec.musts[0]!.id);
  assert.equal(firstWaiver.designRevision, exampleSpec.schemeRevision);
  assert.match(first.note ?? '', /用户已豁免/);
  assert.equal(applied.verdict.status, 'satisfied');
  assert.equal(applied.nextAction.kind, 'accept');
  assert.match(applied.nextAction.instructions, /显式豁免/);
  assert.equal(ReviewReport.safeParse(applied).success, true);
});

test('applyReviewWaivers：不同 revision / 未知 must / 已 met 的豁免不生效', () => {
  const base = review(exampleSpec);
  const waiver: ReviewWaiver = {
    mustId: exampleSpec.musts[0]!.id,
    designRevision: exampleSpec.schemeRevision,
    by: 'user',
    choice: '接受现状',
    conflictId: null,
    note: null,
  };

  const stale = applyReviewWaivers(base, [{ ...waiver, designRevision: base.designVersion.revision + 1 }]);
  assert.equal(stale, base);
  assert.equal(stale.verdict.status, 'partial');

  const unknown = applyReviewWaivers(base, [{ ...waiver, mustId: 'must-missing' }]);
  assert.equal(unknown, base);

  const met = buildReviewReport({
    spec: exampleSpec,
    run: runFacts(exampleSpec),
    visual: PASS_VISUAL,
    evidence: evidenceFor(exampleSpec),
  });
  const ignored = applyReviewWaivers(met, [
    ...exampleSpec.musts.map((must): ReviewWaiver => ({
      mustId: must.id,
      designRevision: exampleSpec.schemeRevision,
      by: 'user',
      choice: '不需要豁免',
      conflictId: null,
      note: null,
    })),
  ]);
  assert.equal(ignored, met);
  assert.equal(ignored.verdict.status, 'satisfied');
});

test('applyReviewWaivers：客观测量失败不能被豁免修复', () => {
  const failing = review(exampleSpec, { cells: 25_000 });
  const applied = applyReviewWaivers(
    failing,
    exampleSpec.musts.map((must): ReviewWaiver => ({
      mustId: must.id,
      designRevision: exampleSpec.schemeRevision,
      by: 'user',
      choice: '接受必须项',
      conflictId: null,
      note: null,
    })),
  );

  assert.equal(
    applied.verdict.musts.every((must) => must.status === 'waived'),
    true,
  );
  assert.equal(applied.verdict.status, 'not-satisfied');
  assert.equal(applied.nextAction.kind, 'targeted-revision');
  assert.match(applied.nextAction.instructions, /客观测量未通过/);
});

test('applyReviewWaivers：mustsTruncated 不能被豁免绕过', () => {
  const hugeMusts = Array.from({ length: 301 }, (_, index) => ({
    id: `must-trunc-${String(index + 1)}`,
    text: `截断批量必须项 ${String(index + 1)}`,
    source: 'detail' as const,
  }));
  const hugeSpec: BuildSpec = { ...exampleSpec, musts: hugeMusts };
  const base = buildReviewReport({ spec: hugeSpec, run: runFacts(hugeSpec) });
  const applied = applyReviewWaivers(
    base,
    hugeMusts.map((must): ReviewWaiver => ({
      mustId: must.id,
      designRevision: hugeSpec.schemeRevision,
      by: 'user',
      choice: '接受必须项',
      conflictId: null,
      note: null,
    })),
  );

  assert.equal(applied.verdict.musts.length, 300);
  assert.equal(applied.verdict.mustsTruncated, true);
  assert.equal(
    applied.verdict.musts.every((must) => must.status === 'waived'),
    true,
  );
  assert.equal(applied.verdict.status, 'partial');
  assert.equal(applied.nextAction.kind, 'ask-user');
  assert.match(applied.nextAction.instructions, /必须项截断/);
});

test('not-met 必须项阻断 accept 并要求定向修改', () => {
  const report = buildReviewReport({
    spec: exampleSpec,
    run: runFacts(exampleSpec),
    visual: PASS_VISUAL,
    evidence: evidenceFor(exampleSpec, { status: (index) => (index === 0 ? 'not-met' : 'met') }),
  });

  assert.equal(report.verdict.musts[0]?.status, 'not-met');
  assert.match(report.verdict.musts[0].note ?? '', /硬失败/);
  assert.equal(report.verdict.status, 'not-satisfied');
  assert.equal(report.nextAction.kind, 'targeted-revision');
  assert.match(report.nextAction.instructions, new RegExp(exampleSpec.musts[0]!.id));
});

function clauseLeaf(
  mustId: string,
  clauseId: string,
  status: 'met' | 'not-met' | 'unverified' | 'waived',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    clauseId,
    mustId,
    kind: 'dimension',
    target: { metric: 'thickness', value: 1, unit: 'm', relation: '>=' },
    check: { kind: 'envelope', id: `check:${clauseId}`, objectRefs: [`wall:${mustId}`], params: {} },
    status,
    actual: status === 'met' ? 1 : null,
    evidence: [{ kind: 'diff', ref: `conformance-diff.json#${clauseId}`, summary: `${status}/hard` }],
    reason: status === 'not-met' ? 'hard-fail' : status === 'unverified' ? 'missing-measurement' : null,
    conflict: null,
    ...overrides,
  };
}

function qualitativeLeaf(mustId: string, clauseId: string, status: 'unverified' | 'waived'): Record<string, unknown> {
  return clauseLeaf(mustId, clauseId, status, {
    kind: 'qualitative',
    check: { kind: 'qualitative', id: `check:${clauseId}`, objectRefs: [], params: {} },
  });
}

function clauseEvidenceFor(
  spec: BuildSpec,
  groups: readonly { readonly mustId: string; readonly leaves: readonly Record<string, unknown>[] }[],
  options: {
    readonly mapping?: 'heuristic' | 'verified';
    readonly unattributedHardFails?: readonly string[];
    readonly globalBlockers?: readonly string[];
    readonly conflicts?: number;
  } = {},
): ReviewEvidenceFile {
  const parentStatus = (leaves: readonly Record<string, unknown>[]): 'met' | 'not-met' | 'unverified' | 'waived' => {
    const statuses = leaves.map((leaf) => leaf['status']);
    if (statuses.includes('not-met')) return 'not-met';
    if (statuses.includes('unverified')) return 'unverified';
    if (statuses.every((status) => status === 'waived')) return 'waived';
    return 'met';
  };
  const byMust = new Map(groups.map((group) => [group.mustId, parentStatus(group.leaves)] as const));
  const allLeaves = groups.flatMap((group) => group.leaves);
  const groupStatuses = groups.map((group) => parentStatus(group.leaves));
  const count = (status: string): number => groupStatuses.filter((candidate) => candidate === status).length;
  return parseReviewEvidenceFile({
    schemaVersion: 2,
    tool: 'conformance-evidence',
    mode: 'report-only',
    generatedBy: 'review-generate-clause-test',
    mapping: options.mapping ?? 'verified',
    spec: { schemeId: spec.schemeId, schemeRevision: spec.schemeRevision, sha256: 'a'.repeat(64) },
    archive: { sha256: 'b'.repeat(64), bytes: 10 },
    datum: {
      slabTopY: 0,
      standingY: 1,
      gradeY: 1,
      entryTransition: 'flush',
      floorThickness: 1,
      source: 'build-spec',
    },
    musts: spec.musts.map((must) => ({
      mustId: must.id,
      text: must.text,
      source: must.source,
      status: byMust.get(must.id) ?? 'unverified',
      confidence: 'high',
      objects: [],
      evidence: [],
      waiver: null,
      reason: null,
    })),
    clauses: allLeaves,
    clauseSummary: {
      musts: groups.length,
      met: count('met'),
      notMet: count('not-met'),
      waived: count('waived'),
      unverified: count('unverified'),
      leaves: allLeaves.length,
      conflicts: options.conflicts ?? 0,
      unattributedHardFails: [...(options.unattributedHardFails ?? [])],
      globalBlockers: [...(options.globalBlockers ?? [])],
    },
    summary: {
      met: count('met'),
      notMet: count('not-met'),
      waived: count('waived'),
      unverified: count('unverified'),
      acceptEligible: count('not-met') === 0 && count('unverified') === 0,
    },
  });
}

function clauseSpec(): BuildSpec {
  return {
    ...exampleSpec,
    musts: [
      { id: 'must-clause-solid', text: '外墙厚度 1m。', source: 'detail' },
      { id: 'must-clause-qual', text: '主厅墙面材质观感与方案一致。', source: 'detail' },
    ],
  };
}

test('clause 评审：met thickness + unverified qualitative 不能 accept，leaf 豁免后 accept', () => {
  const spec = clauseSpec();
  const evidence = clauseEvidenceFor(spec, [
    { mustId: 'must-clause-solid', leaves: [clauseLeaf('must-clause-solid', 'c-thickness', 'met')] },
    {
      mustId: 'must-clause-qual',
      leaves: [
        clauseLeaf('must-clause-qual', 'c-thickness', 'met'),
        qualitativeLeaf('must-clause-qual', 'c-qual', 'unverified'),
      ],
    },
  ]);
  const base = buildReviewReport({
    spec,
    run: runFacts(spec),
    visual: PASS_VISUAL,
    evidence,
  });

  const solid = base.verdict.musts[0];
  const qualitative = base.verdict.musts[1];
  assert.ok(solid);
  assert.ok(qualitative);
  assert.equal(solid.status, 'met');
  assert.equal(solid.clauses.length, 1);
  assert.equal(qualitative.status, 'unverified');
  assert.deepEqual(
    qualitative.clauses.map((leaf) => leaf.status),
    ['met', 'unverified'],
  );
  assert.equal(base.verdict.status, 'partial');
  assert.equal(base.nextAction.kind, 'ask-user');
  assert.match(base.objective.notes.join('；'), /未验证 leaf 仍然阻断接受/);

  const waiver: ReviewWaiver = {
    mustId: 'must-clause-qual',
    designRevision: spec.schemeRevision,
    by: 'user',
    choice: '接受当前材质观感',
    conflictId: null,
    note: '甲方确认',
    clauseId: 'c-qual',
  };
  const waived = applyReviewWaivers(base, [waiver]);
  const waivedSolid = waived.verdict.musts[0];
  const waivedQualitative = waived.verdict.musts[1];
  assert.ok(waivedSolid);
  assert.ok(waivedQualitative);
  assert.equal(waivedSolid.status, 'met');
  assert.equal(waivedQualitative.status, 'waived');
  assert.deepEqual(
    waivedQualitative.clauses.map((leaf) => leaf.status),
    ['met', 'waived'],
  );
  assert.equal(waivedQualitative.waiver?.clauseId, 'c-qual');
  assert.match(waivedQualitative.note ?? '', /用户已豁免/);
  assert.equal(waived.verdict.status, 'satisfied');
  assert.equal(waived.nextAction.kind, 'accept');
  assert.equal(ReviewReport.safeParse(waived).success, true);
});

test('clause 评审：绑定 met leaf 的豁免被拒绝，parent 不变', () => {
  const spec = clauseSpec();
  const evidence = clauseEvidenceFor(spec, [
    { mustId: 'must-clause-solid', leaves: [clauseLeaf('must-clause-solid', 'c-met', 'met')] },
    {
      mustId: 'must-clause-qual',
      leaves: [
        clauseLeaf('must-clause-qual', 'c-met', 'met'),
        qualitativeLeaf('must-clause-qual', 'c-qual', 'unverified'),
      ],
    },
  ]);
  const base = buildReviewReport({ spec, run: runFacts(spec), visual: PASS_VISUAL, evidence });
  const rejected = applyReviewWaivers(base, [
    {
      mustId: 'must-clause-qual',
      designRevision: spec.schemeRevision,
      by: 'user',
      choice: '试图豁免已 met leaf',
      conflictId: null,
      note: null,
      clauseId: 'c-met',
    },
  ]);
  assert.equal(rejected, base);
  assert.equal(rejected.verdict.musts[1]?.status, 'unverified');
});

test('clause 评审：41 条 must 级豁免遇到 not-met leaf 仍然 not-satisfied / 不能 accept', () => {
  const baseSpec = clauseSpec();
  const musts41 = Array.from({ length: 41 }, (_, index) => ({
    id: `must-run9-${String(index + 1)}`,
    text: `run-9 条款 ${String(index + 1)}`,
    source: 'detail' as const,
  }));
  const spec: BuildSpec = { ...baseSpec, musts: musts41 };
  const groups = musts41.map((must, index) => ({
    mustId: must.id,
    leaves: [
      clauseLeaf(
        must.id,
        `c-${String(index + 1)}`,
        index === 0 ? 'not-met' : index === 1 ? 'unverified' : 'met',
        index === 0 ? { reason: 'run9-hard-fail' } : {},
      ),
    ],
  }));
  const evidence = clauseEvidenceFor(spec, groups);
  const base = buildReviewReport({ spec, run: runFacts(spec), visual: PASS_VISUAL, evidence });
  assert.equal(base.verdict.musts[0]?.status, 'not-met');
  assert.equal(base.verdict.musts[1]?.status, 'unverified');
  assert.equal(base.verdict.status, 'not-satisfied');
  assert.equal(base.nextAction.kind, 'targeted-revision');

  const waivers: readonly ReviewWaiver[] = musts41.map((must) => ({
    mustId: must.id,
    designRevision: spec.schemeRevision,
    by: 'user',
    choice: `全量豁免 ${must.id}`,
    conflictId: null,
    note: null,
  }));
  const applied = applyReviewWaivers(base, waivers);
  assert.equal(applied.verdict.musts[0]?.status, 'not-met');
  assert.equal(applied.verdict.musts[1]?.status, 'waived');
  assert.equal(applied.verdict.status, 'not-satisfied');
  assert.equal(applied.nextAction.kind, 'targeted-revision');
  assert.match(applied.nextAction.instructions, /must-run9-1\/c-1/);
  assert.match(applied.nextAction.instructions, /not-met leaf/);

  const leafWaiver = applyReviewWaivers(base, [
    {
      mustId: 'must-run9-1',
      designRevision: spec.schemeRevision,
      by: 'user',
      choice: '试图豁免硬失败 leaf',
      conflictId: null,
      note: null,
      clauseId: 'c-1',
    },
  ]);
  assert.equal(leafWaiver, base);
  assert.equal(leafWaiver.verdict.status, 'not-satisfied');
});

test('clause 评审：unattributed hard fail 阻断 accept 并在 note 中说明', () => {
  const spec = clauseSpec();
  const evidence = clauseEvidenceFor(
    spec,
    [
      { mustId: 'must-clause-solid', leaves: [clauseLeaf('must-clause-solid', 'c-1', 'met')] },
      { mustId: 'must-clause-qual', leaves: [clauseLeaf('must-clause-qual', 'c-2', 'met')] },
    ],
    { unattributedHardFails: ['report:global-slab-fail'], conflicts: 1 },
  );
  const report = buildReviewReport({ spec, run: runFacts(spec), visual: PASS_VISUAL, evidence });

  assert.equal(
    report.verdict.musts.every((must) => must.status === 'met'),
    true,
  );
  assert.equal(report.verdict.status, 'not-satisfied');
  assert.equal(report.nextAction.kind, 'targeted-revision');
  assert.match(report.nextAction.instructions, /global-slab-fail/);
  const noteText = report.objective.notes.join('；');
  assert.match(noteText, /clause 汇总/);
  assert.match(noteText, /leaf 共 2 个/);
  assert.match(noteText, /全局阻断 0 个/);
  assert.match(noteText, /未归因/);
  assert.match(noteText, /接受被阻断/);
});

test('clause 评审：无 must 覆盖的全局阻断进入 nextAction 并阻断 accept', () => {
  const spec = clauseSpec();
  const evidence = clauseEvidenceFor(
    spec,
    [
      { mustId: 'must-clause-solid', leaves: [clauseLeaf('must-clause-solid', 'c-1', 'met')] },
      { mustId: 'must-clause-qual', leaves: [clauseLeaf('must-clause-qual', 'c-2', 'met')] },
    ],
    {
      unattributedHardFails: [],
      globalBlockers: ['furniture:f-light-ridge-e: no must covers this expected furniture'],
    },
  );
  const report = buildReviewReport({ spec, run: runFacts(spec), visual: PASS_VISUAL, evidence });
  assert.equal(report.verdict.status, 'not-satisfied');
  assert.equal(report.nextAction.kind, 'targeted-revision');
  assert.match(report.nextAction.instructions, /f-light-ridge-e/);
  assert.match(report.nextAction.instructions, /全局阻断/);
  assert.deepEqual(report.provenance?.globalBlockers, [
    'furniture:f-light-ridge-e: no must covers this expected furniture',
  ]);
  assert.equal(
    report.objective.notes.some((note) => note.includes('无必须项覆盖的全局阻断')),
    true,
  );
});

test('clause 评审：全局 hard fail 不能靠逐条 waiver 绕过', () => {
  const spec = clauseSpec();
  const evidence = clauseEvidenceFor(
    spec,
    [
      { mustId: 'must-clause-solid', leaves: [clauseLeaf('must-clause-solid', 'c-1', 'met')] },
      {
        mustId: 'must-clause-qual',
        leaves: [
          clauseLeaf('must-clause-qual', 'c-2', 'met'),
          qualitativeLeaf('must-clause-qual', 'c-qual', 'unverified'),
        ],
      },
    ],
    { unattributedHardFails: ['report:global-slab-fail'] },
  );
  const base = buildReviewReport({ spec, run: runFacts(spec), visual: PASS_VISUAL, evidence });
  assert.equal(base.verdict.status, 'not-satisfied');

  const waived = applyReviewWaivers(base, [
    {
      mustId: 'must-clause-qual',
      designRevision: spec.schemeRevision,
      by: 'user',
      choice: '豁免 qualitative leaf',
      conflictId: null,
      note: null,
      clauseId: 'c-qual',
    },
  ]);
  assert.equal(waived.verdict.musts[1]?.status, 'waived');
  assert.equal(waived.verdict.status, 'not-satisfied');
  assert.equal(waived.nextAction.kind, 'targeted-revision');
  assert.match(waived.nextAction.instructions, /全局 hard fail/);
});

test('stale 设计版本的证据：provenance 必须 none，全量 waiver 也不能 accept', () => {
  const fresh = evidenceFor(exampleSpec);
  const stale = parseReviewEvidenceFile({
    ...fresh,
    spec: { ...fresh.spec, schemeRevision: fresh.spec.schemeRevision + 1 },
  });
  const waivers: ReviewWaiver[] = exampleSpec.musts.map((must) => ({
    mustId: must.id,
    designRevision: exampleSpec.schemeRevision,
    by: 'user',
    choice: '全量豁免尝试',
    conflictId: null,
    note: null,
  }));
  const report = buildReviewReport({
    spec: exampleSpec,
    run: runFacts(exampleSpec),
    evidence: stale,
    waivers,
  });
  assert.equal(report.provenance?.evidence, 'none');
  assert.notEqual(report.verdict.status, 'satisfied');
  assert.notEqual(report.nextAction.kind, 'accept');
});
