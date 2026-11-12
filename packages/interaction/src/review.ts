/**
 * ReviewReport：构建完成后，方案版本 / 构建 run 与客观测量、看图评审、缺陷、结论、下一步绑定在一起。
 *
 * 负责：只定义可序列化的评审结构；objective 只放实测与期望，visual 只放看图结论。
 * 不负责：跑测量、渲染、看图或修改方案；这些由后续评审编排注入。
 */
import { z } from 'zod';

import { MustClauseEvidence } from './must-clause.ts';
import { Identifier, Label, Text } from './primitives.ts';
import { ReviewEvidenceObject, ReviewEvidenceRef, ReviewMustStatus, ReviewWaiver } from './review-evidence.ts';

const DEFECTS_MAX = 200;
const MEASUREMENTS_MAX = 200;
const MUSTS_MAX = 300;

export const ReviewDesignVersion = z
  .strictObject({
    schemeId: Identifier,
    revision: z.int().positive(),
  })
  .readonly();
export type ReviewDesignVersion = z.infer<typeof ReviewDesignVersion>;

export const MeasurementStatus = z.enum(['pass', 'fail', 'not-checked']);
export type MeasurementStatus = z.infer<typeof MeasurementStatus>;

/** 一条客观实测：期望 / 实际原样记录，报告不替读者下“好看”结论。 */
export const ReviewMeasurement = z
  .strictObject({
    name: Label,
    expected: Text,
    actual: Text,
    unit: Label.nullable(),
    status: MeasurementStatus,
    evidence: Text.nullable(),
  })
  .readonly();
export type ReviewMeasurement = z.infer<typeof ReviewMeasurement>;

export const ObjectiveReview = z
  .strictObject({
    measurements: z.array(ReviewMeasurement).max(MEASUREMENTS_MAX).readonly(),
    notes: z.array(Text).max(50).readonly(),
  })
  .readonly();
export type ObjectiveReview = z.infer<typeof ObjectiveReview>;

export const VisualVerdict = z.enum(['pass', 'partial', 'fail', 'not-reviewed']);
export type VisualVerdict = z.infer<typeof VisualVerdict>;

export const VisualReview = z
  .strictObject({
    verdict: VisualVerdict,
    strengths: z.array(Text).max(50).readonly(),
    weaknesses: z.array(Text).max(50).readonly(),
    notes: z.array(Text).max(50).readonly(),
  })
  .readonly();
export type VisualReview = z.infer<typeof VisualReview>;

export const DefectCategory = z.enum(['design', 'construction', 'preference', 'capability']);
export type DefectCategory = z.infer<typeof DefectCategory>;

export const DefectSeverity = z.enum(['blocker', 'major', 'minor']);
export type DefectSeverity = z.infer<typeof DefectSeverity>;

export const ReviewDefect = z
  .strictObject({
    id: Identifier,
    category: DefectCategory,
    severity: DefectSeverity,
    description: Text,
    evidence: Text,
    requirementIds: z.array(Identifier).max(50).readonly(),
    suggestedAction: Text,
  })
  .readonly();
export type ReviewDefect = z.infer<typeof ReviewDefect>;

export const MustVerdictStatus = ReviewMustStatus;
export type MustVerdictStatus = z.infer<typeof MustVerdictStatus>;

/** 逐条必须项证据；新增字段都有默认值，旧版 ReviewReport 仍可解析。 */
export const MustVerdict = z
  .strictObject({
    requirementId: Identifier,
    status: MustVerdictStatus,
    note: Text.nullable().default(null),
    text: Text.nullable().default(null),
    source: z.string().min(1).max(64).nullable().default(null),
    confidence: z.enum(['high', 'medium', 'low']).nullable().default(null),
    objects: z.array(ReviewEvidenceObject).max(50).readonly().default([]),
    evidence: z.array(ReviewEvidenceRef).max(50).readonly().default([]),
    waiver: ReviewWaiver.nullable().default(null),
    reason: Text.nullable().default(null),
    /** clause 级证据；旧报告缺省为空数组。 */
    clauses: z.array(MustClauseEvidence).max(2000).readonly().default([]),
  })
  .readonly();
export type MustVerdict = z.infer<typeof MustVerdict>;

/** 结论按“必须项逐条 + 总体状态”记录，不合并成单一审美分。 */
export const ReviewVerdict = z
  .strictObject({
    status: z.enum(['satisfied', 'partial', 'not-satisfied']),
    musts: z.array(MustVerdict).max(MUSTS_MAX).readonly(),
    /** BuildSpec.musts 超过 ReviewReport 上限时为 true；此状态永远不能接受。 */
    mustsTruncated: z.boolean().default(false),
  })
  .readonly();
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const ReviewNextActionKind = z.enum(['accept', 'targeted-revision', 'redesign', 'ask-user']);
export type ReviewNextActionKind = z.infer<typeof ReviewNextActionKind>;

export const ReviewNextAction = z
  .strictObject({
    kind: ReviewNextActionKind,
    instructions: Text,
    affectedSpaceIds: z.array(Identifier).max(50).readonly(),
    affectedElementIds: z.array(Identifier).max(50).readonly(),
  })
  .readonly();
export type ReviewNextAction = z.infer<typeof ReviewNextAction>;

/** 新评审的机器来源；旧 session.json 没有该字段，按 legacy 处理。 */
export const ReviewProvenance = z
  .strictObject({
    version: z.literal(1),
    evidence: z.enum(['verified', 'heuristic', 'none']),
    specSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    archiveSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    verifiedMustIds: z.array(Identifier).max(500).readonly(),
    /** 没有 must clause 可归因的全局 hard fail；有值时 accept 必须阻断。 */
    unattributedHardFails: z.array(z.string().min(1).max(160)).max(100).readonly().optional(),
    /** 明确说明理由的全局阻断（如无 must 覆盖的家具缺失）；有值时 accept 必须阻断。 */
    globalBlockers: z.array(z.string().min(1).max(160)).max(100).readonly().optional(),
  })
  .readonly();
export type ReviewProvenance = z.infer<typeof ReviewProvenance>;

export const ReviewReport = z
  .strictObject({
    designVersion: ReviewDesignVersion,
    buildRunId: Identifier,
    objective: ObjectiveReview,
    visual: VisualReview,
    defects: z.array(ReviewDefect).max(DEFECTS_MAX).readonly(),
    verdict: ReviewVerdict,
    nextAction: ReviewNextAction,
    /** 只有当前生成器写；旧报告缺省，不能用于 accept。 */
    provenance: ReviewProvenance.optional(),
  })
  .readonly();
export type ReviewReport = z.infer<typeof ReviewReport>;
