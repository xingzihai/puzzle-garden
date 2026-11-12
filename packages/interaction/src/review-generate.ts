/* eslint-disable max-lines -- 逐 must 证据映射与旧客观测量判定同处一个纯生成器，拆分反而增加跨文件状态。 */
/**
 * 确定性评审生成器：把 BuildSpec 与一次构建 run 的事实拼成 ReviewReport。
 *
 * 负责：客观交付 / 停止原因 / 检查结果 / 方块数 / 占地 / 渲染图测量，musts 逐条证据，
 * 失败测量转 defects，以及 accept / targeted-revision / redesign / ask-user 的机械判定。
 * 不负责：读文件、看图、调用模型、联网或修正方案；本文件是纯函数。
 *
 * 口径：
 * - 没有 conformance 证据时 musts 一律 unverified，不根据整体视觉结论推断单条必须项；
 * - verified 证据才允许 met；启发式 hard fail 只按直接对象归属 not-met；
 * - 看图评审默认只作建议；只有必须项文本显式要求视觉证据（视觉 / 看图 / 观感 / 渲染 / visual）
 *   时，visual 的 fail / 未评审才影响该必须项；
 * - run bounds 可能包含屋面挑檐 / 场地构件，占地不符必须保留这一限制说明；
 * - ReviewReport 的 musts 上限是 300，与 BuildSpec 对齐；一旦截断，verdict.mustsTruncated=true，
 *   报告 note 标记 accept-blocking，nextAction 永不 accept。
 */
import type { BuildSpec } from './build.ts';
import { aggregateMustClauseStatus } from './must-clause.ts';
import type { MustClauseEvidence, MustClauseEvaluationSummary } from './must-clause.ts';
import { ReviewReport } from './review.ts';
import type {
  MustVerdict,
  ReviewDefect,
  ReviewMeasurement,
  ReviewNextAction,
  ReviewVerdict,
  VisualReview,
} from './review.ts';
import type { ReviewEvidenceArtifacts, ReviewEvidenceFile } from './review-evidence.ts';
import {
  ReviewWaiver,
  resolveReviewMusts,
  reviewClauseNote,
  reviewClauseReason,
  reviewEvidenceMatchesArtifacts,
  reviewEvidenceMatchesDesign,
  reviewMustsAcceptEligible,
  summarizeReviewMusts,
} from './review-evidence.ts';

const ID_MAX = 64;
const LABEL_MAX = 128;
const TEXT_MAX = 4000;
const VISUAL_ITEMS_MAX = 50;
const MUSTS_MAX = 300;
const DEFAULT_MUST_NOTE = '需看图 / 人工确认（未提供逐条必须项证据）';
/**
 * 只有“要求视觉证据”的明确短语才把必须项与看图绑定：
 * - “视觉中心 / 视觉效果不错”这类描述不算；
 * - “看图 / 视觉证据 / 效果图确认 / 渲染图确认”等才算。
 */
const VISUAL_REQUIREMENT_PATTERNS: readonly RegExp[] = [
  /看图/u,
  /视觉(?:证据|确认|评审|验收|检查|上)/u,
  /(?:效果图|渲染图)(?:确认|核对|核实|评审|验收|检查|证据)?/u,
  /(?:照片|截图)(?:确认|核对|比对|证据)/u,
  /\bvisual\s+(?:evidence|review|check|confirmation|composition|appearance)\b/iu,
];

export interface ReviewRunFacts {
  readonly runId: string;
  readonly designId: string;
  readonly designRevision: number;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly failure: string | null;
  readonly delivered: boolean;
  readonly stopReason: string | null;
  readonly checkPassed: boolean | null;
  readonly cells: number | null;
  /** 实体格闭区间 [x0,y0,z0,x1,y1,z1]；宽度 = max - min + 1。 */
  readonly bounds: readonly [number, number, number, number, number, number] | null;
  readonly renders: number;
}

export interface BuildReviewInput {
  readonly spec: BuildSpec;
  readonly run: ReviewRunFacts;
  readonly visual?: VisualReview;
  /** conformance-evidence.json；缺省表示没有证据文件，全部 must 保持 unverified。 */
  readonly evidence?: ReviewEvidenceFile | null;
  /** 显式用户豁免；可与证据文件里的 waiver 同时使用。 */
  readonly waivers?: readonly ReviewWaiver[];
  /** 当前 spec / archive 字节哈希；提供时证据必须同时匹配，否则全部 unverified。 */
  readonly evidenceBinding?: ReviewEvidenceArtifacts;
  /** 当前 BuildSheet 重新派生的 verified must id；缺省时 verified 证据一律不信任。 */
  readonly verifiedMustIds?: readonly string[];
}

type FindingKey = 'delivery' | 'stop-reason' | 'check' | 'blocks' | 'footprint' | 'renders';

interface MeasurementFinding {
  readonly key: FindingKey;
  readonly measurement: ReviewMeasurement;
  readonly defect: ReviewDefect | null;
}

/** 输入字符串可能来自日志而不是 schema，这里统一截断，保证最终 Report.parse 不因超长失败。 */
function cleanText(value: string, max = TEXT_MAX): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function textOr(value: string, fallback: string, max = TEXT_MAX): string {
  return cleanText(value, max) ?? fallback;
}

function idOr(value: string, fallback: string): string {
  return cleanText(value, ID_MAX) ?? fallback;
}

function measurement(params: {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly unit: string | null;
  readonly status: ReviewMeasurement['status'];
  readonly evidence?: string | null;
}): ReviewMeasurement {
  const evidence = params.evidence ?? null;
  return {
    name: textOr(params.name, '测量', LABEL_MAX),
    expected: textOr(params.expected, '未提供期望'),
    actual: textOr(params.actual, '未提供实测'),
    unit: params.unit === null ? null : textOr(params.unit, '—', LABEL_MAX),
    status: params.status,
    evidence: evidence === null ? null : cleanText(evidence),
  };
}

function defect(params: {
  readonly id: string;
  readonly category: ReviewDefect['category'];
  readonly severity: ReviewDefect['severity'];
  readonly description: string;
  readonly evidence: string;
  readonly suggestedAction: string;
}): ReviewDefect {
  return {
    id: idOr(params.id, 'def-review'),
    category: params.category,
    severity: params.severity,
    description: textOr(params.description, '评审未通过'),
    evidence: textOr(params.evidence, '未提供证据'),
    requirementIds: [],
    suggestedAction: textOr(params.suggestedAction, '按评审结果修正后重跑'),
  };
}

function formatBounds(bounds: readonly [number, number, number, number, number, number]): string {
  return `[${bounds.join(', ')}]`;
}

function buildBlocked(run: ReviewRunFacts): boolean {
  return !run.delivered || run.stopReason !== null || run.status !== 'succeeded';
}

function shortReason(run: ReviewRunFacts): string {
  if (run.stopReason !== null) return textOr(run.stopReason, '未说明停止原因', 200);
  if (run.failure !== null) return textOr(run.failure, '未说明失败原因', 200);
  return `status=${run.status}`;
}

function buildDeliveryFinding(run: ReviewRunFacts): MeasurementFinding {
  const passed = run.delivered && run.status === 'succeeded';
  const evidence = [
    `status=${run.status}`,
    `delivered=${String(run.delivered)}`,
    `failure=${run.failure === null ? 'null' : textOr(run.failure, '未说明失败原因', 500)}`,
    `stopReason=${run.stopReason === null ? 'null' : textOr(run.stopReason, '未说明停止原因', 500)}`,
  ].join('；');
  const actual = run.delivered
    ? run.status === 'succeeded'
      ? '已交付（status=succeeded）'
      : `已交付但构建状态为 ${run.status}`
    : `未交付（status=${run.status}）`;
  return {
    key: 'delivery',
    measurement: measurement({
      name: '交付',
      expected: '构建成功且交付可用结果',
      actual,
      unit: null,
      status: passed ? 'pass' : 'fail',
      evidence: passed ? null : evidence,
    }),
    defect: passed
      ? null
      : defect({
          id: 'def-delivery',
          category: 'capability',
          severity: 'blocker',
          description: run.delivered ? '构建未成功完成' : '构建未交付可用结果',
          evidence,
          suggestedAction: '先排除构建失败或取消原因并重新运行；不要基于缺失结果接受方案',
        }),
  };
}

function buildStopReasonFinding(run: ReviewRunFacts): MeasurementFinding {
  const passed = run.stopReason === null;
  const evidence = `status=${run.status}；failure=${run.failure === null ? 'null' : textOr(run.failure, '未说明失败原因', 500)}`;
  return {
    key: 'stop-reason',
    measurement: measurement({
      name: '停止原因',
      expected: '无停止原因',
      actual: run.stopReason === null ? '无' : textOr(run.stopReason, '未说明停止原因'),
      unit: null,
      status: passed ? 'pass' : 'fail',
      evidence: passed ? null : evidence,
    }),
    defect: passed
      ? null
      : defect({
          id: 'def-stop-reason',
          category: 'capability',
          severity: 'blocker',
          description: '构建在完成前停止',
          evidence: `stopReason=${textOr(run.stopReason, '未说明停止原因')}；${evidence}`,
          suggestedAction: '确认停止原因属于能力 / 预算 / 方案冲突；调整范围后重新构建，必要时向用户确认',
        }),
  };
}

function buildCheckFinding(run: ReviewRunFacts): MeasurementFinding {
  const status = run.checkPassed === null ? 'not-checked' : run.checkPassed ? 'pass' : 'fail';
  const actual = run.checkPassed === null ? '未提供检查结果' : run.checkPassed ? '通过' : '未通过';
  const evidence = `checkPassed=false；status=${run.status}；runId=${idOr(run.runId, 'run-unknown')}`;
  return {
    key: 'check',
    measurement: measurement({
      name: '构建检查',
      expected: '检查通过',
      actual,
      unit: null,
      status,
      evidence: status === 'fail' ? evidence : null,
    }),
    defect:
      status === 'fail'
        ? defect({
            id: 'def-check',
            category: 'construction',
            severity: 'blocker',
            description: '构建检查未通过',
            evidence,
            suggestedAction: '按构建检查报告修正结构 / 可达 / 悬空等问题后重跑',
          })
        : null,
  };
}

function buildBlocksFinding(spec: BuildSpec, run: ReviewRunFacts): MeasurementFinding {
  if (run.cells === null) {
    return {
      key: 'blocks',
      measurement: measurement({
        name: '方块数',
        expected: `≤ ${String(spec.budget.maxBlocks)} 块`,
        actual: '未提供方块数',
        unit: '块',
        status: 'not-checked',
        evidence: null,
      }),
      defect: null,
    };
  }

  const valid = Number.isFinite(run.cells) && run.cells >= 0;
  const passed = valid && run.cells <= spec.budget.maxBlocks;
  const evidence = valid
    ? `实测 ${String(run.cells)} 块，预算上限 ${String(spec.budget.maxBlocks)} 块，超出 ${String(run.cells - spec.budget.maxBlocks)} 块`
    : `cells=${String(run.cells)} 不是有效方块数`;
  return {
    key: 'blocks',
    measurement: measurement({
      name: '方块数',
      expected: `≤ ${String(spec.budget.maxBlocks)} 块`,
      actual: valid ? `${String(run.cells)} 块` : `无效值 ${String(run.cells)}`,
      unit: '块',
      status: passed ? 'pass' : 'fail',
      evidence: passed ? null : evidence,
    }),
    defect: passed
      ? null
      : defect({
          id: 'def-blocks',
          category: 'construction',
          severity: 'major',
          description: '方块数超出预算上限',
          evidence,
          suggestedAction: `压缩体量或简化装饰，把方块数降到 ${String(spec.budget.maxBlocks)} 块以内；上限来自 BuildSpec.budget.maxBlocks`,
        }),
  };
}

function buildFootprintFinding(spec: BuildSpec, run: ReviewRunFacts): MeasurementFinding {
  const expectedX = spec.counts.footprintX;
  const expectedZ = spec.counts.footprintZ;
  if (run.bounds === null) {
    return {
      key: 'footprint',
      measurement: measurement({
        name: '占地（X × Z）',
        expected: `${String(expectedX)} × ${String(expectedZ)} 格`,
        actual: '未提供运行包围盒',
        unit: '格',
        status: 'not-checked',
        evidence: null,
      }),
      defect: null,
    };
  }

  const [x0, y0, z0, x1, y1, z1] = run.bounds;
  // run bounds 是实体格的闭区间（包含 max 坐标）；BuildSpec.counts.footprintX/Z 来自半开区间
  // buildingBounds 的 max - min，因此这里要 +1 才能与方案同为“格数”。
  const validBounds = [x0, y0, z0, x1, y1, z1].every((value) => Number.isFinite(value)) && x1 >= x0 && z1 >= z0;
  const actualX = x1 - x0 + 1;
  const actualZ = z1 - z0 + 1;
  const exact = validBounds && actualX === expectedX && actualZ === expectedZ;
  // 运行包围盒包含屋面挑檐 / 场地构件时通常会比建筑 footprint 大；这不能直接判失败。
  const undersized = validBounds && (actualX < expectedX || actualZ < expectedZ);
  const largerEvidence = `运行包围盒尺寸 ${String(actualX)} × ${String(actualZ)} 格，大于方案建筑范围 ${String(expectedX)} × ${String(expectedZ)} 格；运行包围盒可能含屋面挑檐 / 场地构件，需对照渲染图或实测确认，不能仅凭该差异判定方案错误。`;
  const undersizedEvidence = `运行包围盒尺寸 ${String(actualX)} × ${String(actualZ)} 格，小于方案建筑范围 ${String(expectedX)} × ${String(expectedZ)} 格；构建结果可能缺体量或未按方案施工。`;
  const evidence = exact
    ? null
    : validBounds
      ? undersized
        ? undersizedEvidence
        : largerEvidence
      : `运行包围盒 ${formatBounds(run.bounds)} 的 X/Z 范围无效（要求 min ≤ max）`;
  const status = exact ? 'pass' : undersized || !validBounds ? 'fail' : 'not-checked';
  return {
    key: 'footprint',
    measurement: measurement({
      name: '占地（X × Z）',
      expected: `${String(expectedX)} × ${String(expectedZ)} 格`,
      actual: validBounds ? `${String(actualX)} × ${String(actualZ)} 格` : '无效包围盒',
      unit: '格',
      status,
      evidence,
    }),
    defect:
      status === 'pass' || status === 'not-checked'
        ? null
        : defect({
            id: 'def-footprint',
            category: 'construction',
            severity: 'major',
            description: '运行占地小于方案建筑范围',
            evidence: evidence ?? undersizedEvidence,
            suggestedAction: `核对是否缺体量 / 未按方案施工；按 ${String(expectedX)} × ${String(expectedZ)} 格补齐`,
          }),
  };
}

function buildRendersFinding(run: ReviewRunFacts): MeasurementFinding {
  const valid = Number.isFinite(run.renders) && run.renders >= 1;
  const actual = Number.isFinite(run.renders) ? `${String(run.renders)} 张` : `无效值 ${String(run.renders)}`;
  const evidence = `run.renders=${String(run.renders)}；看图评审至少需要 1 张渲染图`;
  return {
    key: 'renders',
    measurement: measurement({
      name: '渲染图',
      expected: '至少 1 张',
      actual,
      unit: '张',
      status: valid ? 'pass' : 'fail',
      evidence: valid ? null : evidence,
    }),
    defect: valid
      ? null
      : defect({
          id: 'def-renders',
          category: 'capability',
          severity: 'minor',
          description: '缺少渲染图，无法完成看图评审',
          evidence,
          suggestedAction: '重新生成至少 1 张渲染图后再评审；不要在没有图像证据时接受方案',
        }),
  };
}

function buildFindings(spec: BuildSpec, run: ReviewRunFacts): readonly MeasurementFinding[] {
  return [
    buildDeliveryFinding(run),
    buildStopReasonFinding(run),
    buildCheckFinding(run),
    buildBlocksFinding(spec, run),
    buildFootprintFinding(spec, run),
    buildRendersFinding(run),
  ];
}

function sanitizeTexts(values: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    if (cleaned !== null) out.push(cleaned);
    if (out.length === VISUAL_ITEMS_MAX) break;
  }
  return out;
}

function normalizeVisual(visual: VisualReview | undefined): VisualReview {
  if (visual === undefined) {
    return {
      verdict: 'not-reviewed',
      strengths: [],
      weaknesses: [],
      notes: ['未接入看图评审'],
    };
  }
  return {
    verdict: visual.verdict,
    strengths: sanitizeTexts(visual.strengths),
    weaknesses: sanitizeTexts(visual.weaknesses),
    notes: sanitizeTexts(visual.notes),
  };
}

/**
 * 必须项是否显式要求视觉证据。只认明确的词，避免把“外观好看 / 风格克制”这类
 * 泛化描述误判成必须看图；只有 true 时 visual 结论才参与该 must 的判定。
 */
export function mustRequiresVisual(text: string): boolean {
  return VISUAL_REQUIREMENT_PATTERNS.some((pattern) => pattern.test(text));
}

function appendNote(note: string | null, extra: string): string {
  const combined = note === null || note.trim() === '' ? extra : `${note.trim()}；${extra}`;
  return textOr(combined, extra);
}

function visualMustNote(visual: VisualReview, status: 'not-met' | 'unverified'): string {
  const detail = visualEvidence(visual);
  return status === 'not-met'
    ? textOr(`视觉评审未通过，该必须项按未满足处理：${detail}`, '视觉评审未通过，该必须项按未满足处理。')
    : textOr(
        `该必须项要求视觉证据，但视觉评审为 ${visual.verdict}：${detail}`,
        '该必须项要求视觉证据，但尚未形成视觉结论。',
      );
}

function buildMustVerdicts(input: BuildReviewInput, visual: VisualReview): readonly MustVerdict[] {
  const { spec, run } = input;
  const revision =
    Number.isInteger(run.designRevision) && run.designRevision > 0 ? run.designRevision : spec.schemeRevision;
  const evidence = input.evidence ?? null;
  // 没有证据文件时保留旧文案，避免把“缺证据”说成必须项本身有问题。
  const legacyNote = visual.verdict === 'not-reviewed' ? '需看图 / 人工确认（未接入看图评审）' : DEFAULT_MUST_NOTE;
  const binding = input.evidenceBinding;
  const resolved = resolveReviewMusts({
    schemeId: spec.schemeId,
    designRevision: revision,
    musts: spec.musts,
    evidence,
    ...(input.waivers === undefined ? {} : { waivers: input.waivers }),
    ...(binding?.specSha256 === undefined ? {} : { specSha256: binding.specSha256 }),
    ...(binding?.archiveSha256 === undefined ? {} : { archiveSha256: binding.archiveSha256 }),
    ...(input.verifiedMustIds === undefined ? {} : { verifiedMustIds: input.verifiedMustIds }),
  });
  return resolved.map((must) => {
    const base = evidence === null && must.status === 'unverified' ? { ...must, note: legacyNote } : must;
    // 用户显式豁免优先；已有 hard fail 也不能被“未看图”降级成 unverified。
    if (!mustRequiresVisual(base.text) || base.status === 'waived' || base.status === 'not-met') return base;
    if (visual.verdict === 'fail') {
      return { ...base, status: 'not-met' as const, note: appendNote(base.note, visualMustNote(visual, 'not-met')) };
    }
    if (visual.verdict !== 'pass') {
      return {
        ...base,
        status: 'unverified' as const,
        note: appendNote(base.note, visualMustNote(visual, 'unverified')),
      };
    }
    return base;
  });
}

function visualEvidence(visual: VisualReview): string {
  const parts = [`visual.verdict=${visual.verdict}`];
  if (visual.weaknesses.length > 0) parts.push(`weaknesses=${visual.weaknesses.join('；')}`);
  if (visual.notes.length > 0) parts.push(`notes=${visual.notes.join('；')}`);
  return parts.join('；');
}

function buildDefects(
  findings: readonly MeasurementFinding[],
  visual: VisualReview,
  visualRequired: boolean,
): readonly ReviewDefect[] {
  const defects = findings.flatMap((finding) => (finding.defect === null ? [] : [finding.defect]));
  // 只有明确要求视觉证据的必须项才把 visual=fail 升级成缺陷；否则只作建议记录。
  if (visualRequired && visual.verdict === 'fail') {
    defects.push(
      defect({
        id: 'def-visual',
        category: 'design',
        severity: 'major',
        description: '看图评审未通过',
        evidence: visualEvidence(visual),
        suggestedAction: '按看图评审的弱点做定向修改；保持已确认布局、层数、外部尺寸、屋面形式与主要材质不变',
      }),
    );
  }
  return defects.slice(0, 200);
}

function buildVerdict(
  run: ReviewRunFacts,
  findings: readonly MeasurementFinding[],
  musts: readonly MustVerdict[],
  allMusts: readonly MustVerdict[],
  truncated: boolean,
  unattributedHardFails: readonly string[],
  staleEvidence = false,
  globalBlockers: readonly string[] = [],
): ReviewVerdict {
  const objectiveFailed = findings.some((finding) => finding.measurement.status === 'fail');
  const objectiveUnchecked = findings.some((finding) => finding.measurement.status === 'not-checked');
  const unverifiedMusts = allMusts.some((must) => must.status === 'unverified');
  const failedMusts = allMusts.some((must) => must.status === 'not-met');

  let status: ReviewVerdict['status'];
  if (
    buildBlocked(run) ||
    objectiveFailed ||
    failedMusts ||
    unattributedHardFails.length > 0 ||
    globalBlockers.length > 0
  ) {
    status = 'not-satisfied';
  } else if (objectiveUnchecked || unverifiedMusts || truncated || staleEvidence) {
    status = 'partial';
  } else {
    status = 'satisfied';
  }
  return { status, musts, mustsTruncated: truncated };
}

function shortList(values: readonly string[], maxItems = 8): string {
  if (values.length === 0) return '无';
  const shown = values.slice(0, maxItems).join('、');
  return values.length > maxItems ? `${shown} 等 ${String(values.length)} 项` : shown;
}

function buildNextAction(
  run: ReviewRunFacts,
  findings: readonly MeasurementFinding[],
  allMusts: readonly MustVerdict[],
  visual: VisualReview,
  truncated: boolean,
  unattributedHardFails: readonly string[],
  staleEvidence = false,
  globalBlockers: readonly string[] = [],
): ReviewNextAction {
  const next = (kind: ReviewNextAction['kind'], instructions: string): ReviewNextAction => ({
    kind,
    instructions: textOr(instructions, '按评审结果处理'),
    affectedSpaceIds: [],
    affectedElementIds: [],
  });

  const failedNames = findings
    .filter((finding) => finding.measurement.status === 'fail')
    .map((finding) => finding.measurement.name);
  const uncheckedNames = findings
    .filter((finding) => finding.measurement.status === 'not-checked')
    .map((finding) => finding.measurement.name);
  const notMetIds = allMusts.filter((must) => must.status === 'not-met').map((must) => must.requirementId);
  const unverifiedIds = allMusts.filter((must) => must.status === 'unverified').map((must) => must.requirementId);
  const hiddenMusts = allMusts.slice(MUSTS_MAX);

  if (buildBlocked(run)) {
    if (run.status === 'cancelled' && run.stopReason === null && run.failure === null) {
      return next('ask-user', '构建已取消，未形成交付。请确认是否重跑、缩小范围或结束本次设计后再继续。');
    }
    return next(
      'redesign',
      `构建未形成可用交付（${shortReason(run)}）。请重新设计构建策略或缩小范围后重跑；不要在当前结果上做局部修补。`,
    );
  }

  if (failedNames.length > 0) {
    const visualPart =
      visual.verdict === 'fail' && visual.weaknesses.length > 0
        ? `同时按看图评审的弱点修正：${shortList(
            visual.weaknesses.map((weakness) => textOr(weakness, '未说明弱点', 120)),
            5,
          )}。`
        : '';
    return next(
      'targeted-revision',
      `只针对以下客观失败项做定向修改：${shortList(failedNames)}。${visualPart}保持已确认布局、层数、外部尺寸、屋面形式与主要材质不变。`,
    );
  }

  if (notMetIds.length > 0) {
    const blockerPart =
      globalBlockers.length > 0
        ? `另有无必须项覆盖的全局阻断：${shortList(globalBlockers, 12)}；请按 BuildSheet 补齐或在方案中明确豁免。`
        : '';
    return next(
      'targeted-revision',
      `以下必须项有 conformance 硬失败证据：${shortList(notMetIds, 12)}。请只针对这些必须项做定向修改并重新构建；不要接受当前结果。${blockerPart}`,
    );
  }

  if (globalBlockers.length > 0) {
    return next(
      'targeted-revision',
      `存在无必须项覆盖的全局阻断：${shortList(globalBlockers, 12)}。请按 BuildSheet 补齐这些对象，或先在方案中明确豁免；不能接受当前结果。`,
    );
  }

  if (unattributedHardFails.length > 0) {
    return next(
      'targeted-revision',
      `存在未归因到任何必须项的全局 hard fail：${shortList(unattributedHardFails, 12)}。请先定位并修正这些硬失败后重新构建；不能接受当前结果。`,
    );
  }

  if (truncated) {
    const hidden = summarizeReviewMusts(hiddenMusts);
    return next(
      'ask-user',
      `必须项截断（mustsTruncated=true）：BuildSpec 含 ${String(allMusts.length)} 条，ReviewReport 最多 ${String(
        MUSTS_MAX,
      )} 条；第 ${String(MUSTS_MAX + 1)} 条起共 ${String(hiddenMusts.length)} 条未进入列表（not-met ${String(
        hidden.notMet,
      )} / unverified ${String(hidden.unverified)}）。不能接受本次构建；请拆分必须项或人工核对隐藏项后重试。`,
    );
  }

  if (uncheckedNames.length > 0) {
    const uncheckedFindings = findings.filter((finding) => finding.measurement.status === 'not-checked');
    // 占地 not-checked 但 bounds 已提供，说明只是包围盒更大（可能含挑檐 / 场地），事实已齐，
    // 不应再让评审者补采 run events / 包围盒。
    const largerFootprint = run.bounds !== null && uncheckedFindings.some((finding) => finding.key === 'footprint');
    const missingFacts = uncheckedFindings
      .filter((finding) => !largerFootprint || finding.key !== 'footprint')
      .map((finding) => finding.measurement.name);
    const missing =
      missingFacts.length > 0
        ? `客观事实不足，以下测量无法判定：${shortList(missingFacts)}。请补齐 run events / 方块数 / 包围盒 / 检查结果 / 渲染图后再评审。`
        : '';
    const larger = largerFootprint
      ? '运行包围盒大于方案建筑范围，事实已齐；请人工对照渲染图确认是否包含挑檐 / 场地构件，不要重采已有事实。'
      : '';
    return next('ask-user', `${missing}${larger}` || `以下测量无法判定：${shortList(uncheckedNames)}。`);
  }

  if (unverifiedIds.length > 0) {
    return next(
      'ask-user',
      `客观测量已通过，但必须项仍需看图 / 人工确认：${shortList(unverifiedIds, 12)}。请确认后再决定接受或定向修改。`,
    );
  }

  if (!reviewMustsAcceptEligible(allMusts)) {
    return next('ask-user', '仍有必须项未满足或未验证；只有全部必须项 met 或由用户显式 waived 后才能接受本次构建。');
  }

  if (staleEvidence) {
    return next('ask-user', 'conformance 证据与当前方案 / spec / archive 不一致；不能接受，请重新生成证据。');
  }

  return next('accept', '客观测量与必须项均已通过，可以接受本次构建。');
}

function clauseSummaryNote(summary: MustClauseEvaluationSummary): string {
  return `clause 汇总：must 组 ${String(summary.musts)}（met ${String(summary.met)} / not-met ${String(
    summary.notMet,
  )} / waived ${String(summary.waived)} / unverified ${String(summary.unverified)}），leaf 共 ${String(
    summary.leaves,
  )} 个，未归因 hard fail ${String(summary.unattributedHardFails.length)} 个，全局阻断 ${String(
    summary.globalBlockers.length,
  )} 个。`;
}

const UNATTRIBUTED_HARD_FAIL_NOTE_PREFIX = '全局 hard failure 未归因到任何必须项：';
const GLOBAL_BLOCKER_NOTE_PREFIX = '无必须项覆盖的全局阻断：';

function reportHasUnattributedHardFails(report: ReviewReport): boolean {
  if ((report.provenance?.unattributedHardFails ?? []).length > 0) return true;
  if ((report.provenance?.globalBlockers ?? []).length > 0) return true;
  // 兼容旧报告：只有 note 时仍按原有 sentinel 阻断。
  return report.objective.notes.some(
    (note) => note.startsWith(UNATTRIBUTED_HARD_FAIL_NOTE_PREFIX) || note.startsWith(GLOBAL_BLOCKER_NOTE_PREFIX),
  );
}

function clauseLeafBlockNote(evidence: ReviewEvidenceFile): string | null {
  const unverified = (evidence.clauses ?? []).filter((clause) => clause.status === 'unverified');
  if (unverified.length === 0) return null;
  const ids = unverified
    .map((clause) => clause.clauseId)
    .slice(0, 8)
    .join('、');
  return `clause 证据仍有 ${String(unverified.length)} 个 unverified leaf（${ids}）；未验证 leaf 仍然阻断接受。`;
}

function buildNotes(
  spec: BuildSpec,
  findings: readonly MeasurementFinding[],
  visual: VisualReview,
  allMusts: readonly MustVerdict[],
  evidence: ReviewEvidenceFile | null,
  evidenceBinding: ReviewEvidenceArtifacts | undefined,
  revision: number,
  truncated: boolean,
): readonly string[] {
  const notes: string[] = [
    evidence === null
      ? '客观测量只对比 BuildSpec 与运行事实；没有逐条证据的 musts 保持 unverified。'
      : '客观测量只对比 BuildSpec 与运行事实；musts 逐条引用 conformance-evidence.json。',
  ];
  const visualRequiredMusts = allMusts.filter(
    (must) => mustRequiresVisual(must.text ?? '') && must.status !== 'waived',
  );

  if (findings.some((finding) => finding.measurement.status === 'not-checked')) {
    notes.push('部分测量为 not-checked（缺少事实或需人工对照）；不能据此判定通过。');
  }
  const footprint = findings.find((finding) => finding.key === 'footprint');
  // 只有实际更大（not-checked）才需要挑檐 caveat；undersized 已判 fail 并生成缺陷，
  // 再写“不能只凭该差异判定方案错误”会与缺陷 / nextAction 自相矛盾。
  if (footprint?.measurement.status === 'not-checked') {
    notes.push(
      '运行包围盒大于方案建筑范围，可能包含屋面挑檐 / 场地构件；需结合渲染图或实测确认，不能只凭该差异判定方案错误。',
    );
  }
  if (visual.verdict === 'not-reviewed') {
    notes.push(
      visualRequiredMusts.length === 0
        ? '未接入看图评审：visual=not-reviewed 仅作建议，不阻断接受；没有必须项明确要求视觉证据。'
        : `未接入看图评审：visual=not-reviewed；${String(
            visualRequiredMusts.length,
          )} 条必须项明确要求视觉证据，已按未验证处理。`,
    );
  }
  if (visual.verdict === 'fail' && visualRequiredMusts.length === 0) {
    notes.push('看图评审为 fail，但没有必须项明确要求视觉证据；视觉失败仅作建议记录，不作为接受门槛。');
  }
  if (visual.verdict === 'partial' && visualRequiredMusts.length === 0) {
    notes.push('看图评审为 partial；没有必须项要求视觉证据，视觉结论仅作建议，不单独阻断接受。');
  }
  if (evidence !== null) {
    const summary = summarizeReviewMusts(allMusts);
    if (!reviewEvidenceMatchesDesign(evidence, spec.schemeId, revision)) {
      notes.push('conformance 证据的 schemeId / revision 与本次构建不一致，必须项全部按未验证处理。');
    } else if (evidenceBinding !== undefined && !reviewEvidenceMatchesArtifacts(evidence, evidenceBinding)) {
      notes.push('conformance 证据的 spec / archive 哈希与本次构建不一致，必须项全部按未验证处理。');
    } else {
      notes.push(
        `必须项证据 mapping=${evidence.mapping}：met ${String(summary.met)} / not-met ${String(
          summary.notMet,
        )} / waived ${String(summary.waived)} / unverified ${String(summary.unverified)}。`,
      );
      if (evidence.mapping === 'heuristic') {
        notes.push('conformance 映射为启发式（heuristic）：链接 pass 只能保持 unverified，不能判定必须项 met。');
      }
      if (evidence.clauseSummary !== undefined) {
        const summary = evidence.clauseSummary;
        notes.push(clauseSummaryNote(summary));
        const leafBlock = clauseLeafBlockNote(evidence);
        if (leafBlock !== null) notes.push(leafBlock);
        if (summary.unattributedHardFails.length > 0) {
          notes.push(
            `${UNATTRIBUTED_HARD_FAIL_NOTE_PREFIX}${shortList(summary.unattributedHardFails, 12)}；接受被阻断。`,
          );
        }
        if (summary.globalBlockers.length > 0) {
          notes.push(`${GLOBAL_BLOCKER_NOTE_PREFIX}${shortList(summary.globalBlockers, 12)}；接受被阻断。`);
        }
      }
    }
  }
  if (truncated) {
    const hidden = summarizeReviewMusts(allMusts.slice(MUSTS_MAX));
    notes.push(
      `必须项截断（mustsTruncated=true，accept-blocking）：BuildSpec 含 ${String(
        allMusts.length,
      )} 条，ReviewReport 最多 ${String(MUSTS_MAX)} 条；本报告只列入前 ${String(
        MUSTS_MAX,
      )} 条，其余 ${String(hidden.total)} 条未进入逐条列表（met ${String(hidden.met)} / not-met ${String(
        hidden.notMet,
      )} / waived ${String(hidden.waived)} / unverified ${String(hidden.unverified)}）。本次评审不能接受。`,
    );
  } else if (spec.musts.length > MUSTS_MAX) {
    // 防御：即使调用方传入的 must 列表与 spec 不一致，也不能隐藏截断事实。
    notes.push(
      `必须项截断（mustsTruncated=true，accept-blocking）：BuildSpec 含 ${String(
        spec.musts.length,
      )} 条，ReviewReport 最多 ${String(MUSTS_MAX)} 条；本次评审不能接受。`,
    );
  }
  return notes.slice(0, 50);
}

export function buildReviewReport(input: BuildReviewInput): ReviewReport {
  const { spec, run } = input;
  const visual = normalizeVisual(input.visual);
  const findings = buildFindings(spec, run);
  const allMusts = buildMustVerdicts(input, visual);
  const musts = allMusts.slice(0, MUSTS_MAX);
  const truncated = allMusts.length > MUSTS_MAX || spec.musts.length > MUSTS_MAX;
  const revision =
    Number.isInteger(run.designRevision) && run.designRevision > 0 ? run.designRevision : spec.schemeRevision;
  const evidence = input.evidence ?? null;
  const binding = input.evidenceBinding;
  // 只有与当前设计 / 工件完全绑定的 clause 摘要才能阻断接受；旧 / 错绑证据仍按全部 unverified 处理。
  const evidenceUsable =
    evidence !== null &&
    reviewEvidenceMatchesDesign(evidence, spec.schemeId, revision) &&
    binding?.specSha256 !== undefined &&
    binding.archiveSha256 !== undefined &&
    reviewEvidenceMatchesArtifacts(evidence, binding);
  const unattributedHardFails = evidenceUsable ? (evidence.clauseSummary?.unattributedHardFails ?? []) : [];
  const globalBlockers = evidenceUsable ? (evidence.clauseSummary?.globalBlockers ?? []) : [];
  const visualRequired = allMusts.some((must) => mustRequiresVisual(must.text ?? '') && must.status !== 'waived');
  const defects = buildDefects(findings, visual, visualRequired);
  const verdict = buildVerdict(
    run,
    findings,
    musts,
    allMusts,
    truncated,
    unattributedHardFails,
    evidence !== null && !evidenceUsable,
    globalBlockers,
  );
  const nextAction = buildNextAction(
    run,
    findings,
    allMusts,
    visual,
    truncated,
    unattributedHardFails,
    evidence !== null && !evidenceUsable,
    globalBlockers,
  );
  const notes = buildNotes(
    spec,
    findings,
    visual,
    allMusts,
    input.evidence ?? null,
    input.evidenceBinding,
    revision,
    truncated,
  );
  const provenance =
    evidence !== null && evidenceUsable && input.verifiedMustIds !== undefined
      ? {
          version: 1 as const,
          evidence: evidence.mapping,
          specSha256: binding.specSha256,
          archiveSha256: binding.archiveSha256,
          verifiedMustIds: [...input.verifiedMustIds],
          unattributedHardFails: [...unattributedHardFails],
          globalBlockers: [...globalBlockers],
        }
      : {
          version: 1 as const,
          evidence: 'none' as const,
          specSha256: null,
          archiveSha256: null,
          verifiedMustIds: [] as string[],
          unattributedHardFails: [] as string[],
          globalBlockers: [] as string[],
        };
  return ReviewReport.parse({
    designVersion: {
      schemeId: idOr(run.designId, spec.schemeId),
      revision,
    },
    buildRunId: idOr(run.runId, 'run-unknown'),
    objective: {
      measurements: findings.map((finding) => finding.measurement),
      notes,
    },
    visual,
    defects,
    verdict,
    nextAction,
    provenance,
  });
}

function waiverMustNote(waiver: ReviewWaiver): string {
  const note = waiver.note === null ? '' : `；说明：${waiver.note}`;
  return textOr(`用户已豁免：${waiver.choice}${note}`, '用户已豁免');
}

function joinMustNote(note: string | null, waiver: ReviewWaiver): string {
  return appendNote(note, waiverMustNote(waiver));
}

function notMetClauseRefs(musts: readonly MustVerdict[]): readonly string[] {
  return musts.flatMap((must) =>
    must.clauses
      .filter((clause) => clause.status === 'not-met')
      .map((clause) => `${must.requirementId}/${clause.clauseId}`),
  );
}

function clauseParentIds(refs: readonly string[]): readonly string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    const slash = ref.indexOf('/');
    ids.add(slash < 0 ? ref : ref.slice(0, slash));
  }
  return [...ids];
}

function applyWaiverNextAction(
  report: ReviewReport,
  musts: readonly MustVerdict[],
  truncated: boolean,
  unattributedHardFail: boolean,
): ReviewNextAction {
  const next = (kind: ReviewNextAction['kind'], instructions: string): ReviewNextAction => ({
    kind,
    instructions: textOr(instructions, '按评审结果处理'),
    affectedSpaceIds: report.nextAction.affectedSpaceIds,
    affectedElementIds: report.nextAction.affectedElementIds,
  });
  const measurements = report.objective.measurements;
  const failedNames = measurements.filter((entry) => entry.status === 'fail').map((entry) => entry.name);
  const uncheckedNames = measurements.filter((entry) => entry.status === 'not-checked').map((entry) => entry.name);
  const notMetIds = musts.filter((must) => must.status === 'not-met').map((must) => must.requirementId);
  const notMetClauses = notMetClauseRefs(musts);
  const unverifiedIds = musts.filter((must) => must.status === 'unverified').map((must) => must.requirementId);

  if (failedNames.length > 0) {
    return next(
      'targeted-revision',
      `以下客观测量未通过：${shortList(failedNames)}。请只针对这些测量做定向修改并重新构建；用户豁免只覆盖必须项，不能修复客观失败。`,
    );
  }
  if (unattributedHardFail) {
    return next(
      'targeted-revision',
      '存在未归因到任何必须项的全局 hard fail；用户豁免只能覆盖逐条必须项，不能修复这些硬失败。请先定位并修正后重新构建；不能接受当前结果。',
    );
  }
  if (notMetIds.length > 0 || notMetClauses.length > 0) {
    const parents = [...new Set([...notMetIds, ...clauseParentIds(notMetClauses)])];
    const clausePart =
      notMetClauses.length === 0 ? '' : ` clause 硬失败：${shortList(notMetClauses, 12)}；豁免不能改写 not-met leaf。`;
    return next(
      'targeted-revision',
      `以下必须项仍未满足：${shortList(parents, 12)}。请只针对这些必须项做定向修改并重新构建；不要接受当前结果。${clausePart}`,
    );
  }
  if (truncated) {
    return next(
      'ask-user',
      `必须项截断（mustsTruncated=true）：报告只列入 ${String(
        musts.length,
      )} 条，其余必须项未进入逐条列表。不能接受本次构建；请拆分必须项或人工核对隐藏项后重试。`,
    );
  }
  if (uncheckedNames.length > 0) {
    return next('ask-user', `客观事实不足，以下测量无法判定：${shortList(uncheckedNames)}。请补齐事实后再评审。`);
  }
  if (unverifiedIds.length > 0) {
    return next(
      'ask-user',
      `客观测量已通过，但必须项仍需看图 / 人工确认：${shortList(unverifiedIds, 12)}。请确认后再决定接受或定向修改。`,
    );
  }
  return next('accept', '客观测量与必须项均已通过（含用户显式豁免），可以接受本次构建。');
}

function clauseWaiverKey(waiver: ReviewWaiver): string {
  return `${waiver.mustId}\u0000${waiver.clauseId ?? '*'}`;
}

function isUnboundWaiver(waiver: ReviewWaiver): boolean {
  return waiver.clauseId === null || waiver.clauseId === undefined;
}

function replaceClauseNote(note: string | null, clauses: readonly MustClauseEvidence[]): string | null {
  if (note === null || note.trim() === '') return reviewClauseNote(clauses);
  // reviewClauseNote 是单段（不含分号）；豁免后替换它，保留视觉等附加说明。
  const without = note.replace(/^clause 证据：[^；]*(?:；)?/u, '').trim();
  return without === '' ? reviewClauseNote(clauses) : `${reviewClauseNote(clauses)}；${without}`;
}

function applyClauseWaiversToMust(must: MustVerdict, waivers: readonly ReviewWaiver[]): MustVerdict {
  const byClause = new Map<string, ReviewWaiver>();
  let legacy: ReviewWaiver | null = null;
  for (const waiver of waivers) {
    if (isUnboundWaiver(waiver)) {
      legacy = waiver;
    } else {
      const clauseId = waiver.clauseId;
      if (clauseId !== null && clauseId !== undefined) byClause.set(clauseId, waiver);
    }
  }
  const applied = new Map<string, ReviewWaiver>();
  const clauses = must.clauses.map((leaf): MustClauseEvidence => {
    if (leaf.status !== 'unverified') return leaf;
    const waiver = byClause.get(leaf.clauseId) ?? legacy;
    if (waiver === null) return leaf;
    applied.set(clauseWaiverKey(waiver), waiver);
    const original = leaf.reason === null ? '' : `（原未验证原因：${leaf.reason}）`;
    return {
      ...leaf,
      status: 'waived' as const,
      reason: textOr(`用户已豁免 clause：${waiver.choice}${original}`, '用户已豁免 clause', 400),
    };
  });
  if (applied.size === 0) return must;

  const status = aggregateMustClauseStatus(clauses.map((leaf) => leaf.status));
  const first = [...applied.values()][0] ?? null;
  let note = replaceClauseNote(must.note, clauses);
  for (const waiver of applied.values()) note = appendNote(note, waiverMustNote(waiver));
  return {
    ...must,
    status,
    confidence: status === 'met' ? 'high' : 'medium',
    note,
    clauses,
    waiver: first,
    reason: reviewClauseReason(status, clauses, first),
  };
}

/**
 * 把用户显式豁免合并进已有评审：只接受绑定当前 revision、且目标必须项为 unverified 的 waiver。
 * clause 级豁免只改写 unverified leaf；met / not-met leaf 是实测结论，永不被改写。
 * 变更后按 measurements + 必须项状态 + mustsTruncated 重新计算 verdict / nextAction；
 * 客观测量失败或必须项 not-met 仍阻断 accept，truncated 仍只能 ask-user。
 */
export function applyReviewWaivers(report: ReviewReport, waivers: readonly ReviewWaiver[]): ReviewReport {
  const revision = report.designVersion.revision;
  const grouped = new Map<string, ReviewWaiver[]>();
  for (const raw of waivers) {
    const parsed = ReviewWaiver.safeParse(raw);
    if (!parsed.success || parsed.data.designRevision !== revision) continue;
    const waiver = parsed.data;
    const target = report.verdict.musts.find((must) => must.requirementId === waiver.mustId);
    // 豁免状态机严格为 unverified → waived；met / not-met / 已 waived 不可被用户豁免改写。
    if (target?.status !== 'unverified') continue;

    if (target.clauses.length === 0) {
      // 旧 must 级行为：整条 unverified must → waived。
      grouped.set(waiver.mustId, [waiver]);
      continue;
    }

    if (isUnboundWaiver(waiver)) {
      // legacy 通配只作用于 unverified leaf；若没有可豁免 leaf 则拒绝。
      if (!target.clauses.some((leaf) => leaf.status === 'unverified')) continue;
    } else {
      const leaf = target.clauses.find((candidate) => candidate.clauseId === waiver.clauseId);
      if (leaf?.status !== 'unverified') continue;
    }

    const list = grouped.get(waiver.mustId) ?? [];
    const key = clauseWaiverKey(waiver);
    const existing = list.findIndex((candidate) => clauseWaiverKey(candidate) === key);
    if (existing >= 0) list[existing] = waiver;
    else list.push(waiver);
    grouped.set(waiver.mustId, list);
  }
  if (grouped.size === 0) return report;

  const musts: MustVerdict[] = report.verdict.musts.map((must) => {
    const mustWaivers = grouped.get(must.requirementId);
    if (mustWaivers === undefined) return must;
    if (must.clauses.length === 0) {
      const waiver = mustWaivers[0];
      if (waiver === undefined) return must;
      return {
        ...must,
        status: 'waived' as const,
        waiver,
        note: joinMustNote(must.note, waiver),
      };
    }
    return applyClauseWaiversToMust(must, mustWaivers);
  });
  const measurementFailed = report.objective.measurements.some((entry) => entry.status === 'fail');
  const measurementUnchecked = report.objective.measurements.some((entry) => entry.status !== 'pass');
  const mustNotMet = musts.some((must) => must.status === 'not-met');
  const mustUnverified = musts.some((must) => must.status === 'unverified');
  const truncated = report.verdict.mustsTruncated;
  const unattributedHardFail = reportHasUnattributedHardFails(report);
  const provenance = report.provenance;
  const evidenceMissing =
    provenance === undefined ||
    provenance.evidence === 'none' ||
    provenance.specSha256 === null ||
    provenance.archiveSha256 === null;

  let status: ReviewVerdict['status'];
  if (measurementFailed || mustNotMet || unattributedHardFail) {
    status = 'not-satisfied';
  } else if (measurementUnchecked || mustUnverified || truncated || evidenceMissing) {
    status = 'partial';
  } else {
    status = 'satisfied';
  }
  const wouldOtherwiseAccept =
    !measurementFailed &&
    !measurementUnchecked &&
    !mustNotMet &&
    !mustUnverified &&
    !truncated &&
    !unattributedHardFail;
  const nextAction =
    evidenceMissing && wouldOtherwiseAccept
      ? {
          kind: 'ask-user' as const,
          instructions:
            '当前评审没有绑定 spec / archive / BuildSheet 证据；即使用户豁免全部必须项也不能 accept，请重新构建并生成可验证证据。',
          affectedSpaceIds: [],
          affectedElementIds: [],
        }
      : applyWaiverNextAction(report, musts, truncated, unattributedHardFail);

  // 视觉必须项全部被用户豁免后，旧的 def-visual 与“按未验证处理”说明不再成立。
  const visualStillRequired = musts.some((must) => mustRequiresVisual(must.text ?? '') && must.status !== 'waived');
  const defects = visualStillRequired ? report.defects : report.defects.filter((defect) => defect.id !== 'def-visual');
  const notes = visualStillRequired
    ? report.objective.notes
    : report.objective.notes.filter((note) => !note.includes('明确要求视觉证据'));

  return ReviewReport.parse({
    ...report,
    objective: { ...report.objective, notes },
    defects,
    verdict: {
      status,
      musts,
      mustsTruncated: truncated,
    },
    nextAction,
  });
}
