/**
 * MustClause：把一条 must 拆成可独立测量 / 可独立报告的 clause。
 *
 * 负责：clause 的 schema、状态聚合与编译器输出摘要。计划里不存 status：evaluator 必须拿实际
 * 几何 / 报告与 clause.target 比较后才能给出 met / not-met / unverified / waived。
 * 不负责：读取 BuildSpec、调用检查器或生成证据；本文件是纯 schema / 纯函数，不 import tools / fs。
 */
import { z } from 'zod';

import { Identifier, Text } from './primitives.ts';

export const MUST_CLAUSE_PLAN_SCHEMA_VERSION = 1 as const;
export const MUST_CLAUSE_EVALUATION_SCHEMA_VERSION = 1 as const;

export const MUST_CLAUSE_KINDS = [
  'dimension',
  'count',
  'kind',
  'relation',
  'absence',
  'material',
  'budget',
  'form',
  'qualitative',
  'program',
  'site',
  'visual',
] as const;
export const MustClauseKind = z.enum(MUST_CLAUSE_KINDS);
export type MustClauseKind = z.infer<typeof MustClauseKind>;

export const MUST_CLAUSE_STATUSES = ['met', 'not-met', 'unverified', 'waived'] as const;
export const MustClauseStatus = z.enum(MUST_CLAUSE_STATUSES);
export type MustClauseStatus = z.infer<typeof MustClauseStatus>;

export const MUST_CLAUSE_CHECK_KINDS = [
  'envelope',
  'coverage',
  'opening',
  'furniture',
  'roof',
  'budget',
  'report',
  'qualitative',
] as const;
export const MustClauseCheckKind = z.enum(MUST_CLAUSE_CHECK_KINDS);
export type MustClauseCheckKind = z.infer<typeof MustClauseCheckKind>;

/** JSON-safe 值：number 只接受有限值（z.number() 拒绝 NaN / Infinity）。 */
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonScalarSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

export const ClauseTarget = z.strictObject({
  metric: z.string().min(1).max(64),
  value: JsonValueSchema,
  unit: z.string().min(1).max(32).nullable(),
  relation: z.string().min(1).max(64).nullable(),
});
export type ClauseTarget = z.infer<typeof ClauseTarget>;

export const ClauseCheck = z.strictObject({
  kind: MustClauseCheckKind,
  id: z.string().min(1).max(160),
  objectRefs: z.array(z.string().min(1).max(160)).max(50),
  params: z.record(z.string().min(1).max(64), JsonScalarSchema),
});
export type ClauseCheck = z.infer<typeof ClauseCheck>;

export const ClauseConflict = z.strictObject({
  mustTarget: JsonValueSchema,
  specTarget: JsonValueSchema,
  message: z.string().min(1).max(400),
});
export type ClauseConflict = z.infer<typeof ClauseConflict>;

export const MustClausePlan = z.strictObject({
  schemaVersion: z.literal(MUST_CLAUSE_PLAN_SCHEMA_VERSION),
  clauseId: z.string().min(1).max(160),
  mustId: Identifier,
  parentMustId: Identifier,
  text: Text,
  kind: MustClauseKind,
  target: ClauseTarget.nullable(),
  check: ClauseCheck,
  specTarget: JsonValueSchema.nullable(),
  conflict: ClauseConflict.nullable(),
  waiverable: z.boolean(),
  reason: z.string().min(1).max(400).nullable(),
});
export type MustClausePlan = z.infer<typeof MustClausePlan>;

export const MustClauseGroup = z.strictObject({
  mustId: Identifier,
  text: Text,
  leaves: z.array(MustClausePlan).min(1).max(100),
});
export type MustClauseGroup = z.infer<typeof MustClauseGroup>;

export const MustClausePlanSummary = z.strictObject({
  musts: z.int().nonnegative(),
  leaves: z.int().nonnegative(),
  byKind: z.record(MustClauseKind, z.int().nonnegative()),
  qualitative: z.int().nonnegative(),
  conflicts: z.int().nonnegative(),
});
export type MustClausePlanSummary = z.infer<typeof MustClausePlanSummary>;

export const MUST_CLAUSE_PLAN_TOOL = 'must-clause-compiler' as const;

export const MustClausePlanFile = z.strictObject({
  schemaVersion: z.literal(MUST_CLAUSE_PLAN_SCHEMA_VERSION),
  tool: z.literal(MUST_CLAUSE_PLAN_TOOL),
  compilerVersion: z.string().min(1).max(64),
  groups: z.array(MustClauseGroup).max(300),
  summary: MustClausePlanSummary,
});
export type MustClausePlanFile = z.infer<typeof MustClausePlanFile>;

export const MustClauseEvidenceRef = z.strictObject({
  kind: z.enum(['geometry', 'diff', 'check', 'render']),
  ref: z.string().min(1).max(160),
  summary: z.string().min(1).max(400),
});
export type MustClauseEvidenceRef = z.infer<typeof MustClauseEvidenceRef>;

export const MustClauseEvidence = z.strictObject({
  clauseId: z.string().min(1).max(160),
  mustId: Identifier,
  kind: MustClauseKind,
  target: ClauseTarget.nullable(),
  check: ClauseCheck,
  status: MustClauseStatus,
  actual: JsonValueSchema.nullable(),
  evidence: z.array(MustClauseEvidenceRef).max(50),
  reason: z.string().min(1).max(400).nullable(),
  conflict: ClauseConflict.nullable(),
});
export type MustClauseEvidence = z.infer<typeof MustClauseEvidence>;

export const MustClauseGroupEvidence = z.strictObject({
  mustId: Identifier,
  text: Text,
  status: MustClauseStatus,
  leaves: z.array(MustClauseEvidence).min(1).max(100),
});
export type MustClauseGroupEvidence = z.infer<typeof MustClauseGroupEvidence>;

export const MUST_CLAUSE_EVALUATION_TOOL = 'must-clause-evaluator' as const;

/** 一个全局 hard fail 被显式绑定到哪些 must；`unattributedHardFails` 只保留没有归属的。 */
export const MustClauseHardFailAttribution = z.strictObject({
  checkId: z.string().min(1).max(160),
  mustIds: z.array(Identifier).max(20),
  summary: z.string().min(1).max(400),
});
export type MustClauseHardFailAttribution = z.infer<typeof MustClauseHardFailAttribution>;

export const MustClauseEvaluationSummary = z.strictObject({
  musts: z.int().nonnegative(),
  met: z.int().nonnegative(),
  notMet: z.int().nonnegative(),
  waived: z.int().nonnegative(),
  unverified: z.int().nonnegative(),
  leaves: z.int().nonnegative(),
  conflicts: z.int().nonnegative(),
  unattributedHardFails: z.array(z.string().min(1).max(160)).max(100),
  /**
   * 没有 must 可归属、但语义上仍阻断接受的全局 hard fail（例如设计里声明了家具
   * 但没有任何 must 覆盖它）。与 unattributedHardFails 分开：这里必须有明确理由，
   * 且由评审写进 nextAction。
   */
  globalBlockers: z.array(z.string().min(1).max(160)).max(100).default([]),
  /** 旧证据文件没有该字段；默认空数组，语义为“无显式归因记录”。 */
  attributedHardFails: z.array(MustClauseHardFailAttribution).max(100).default([]),
});
export type MustClauseEvaluationSummary = z.infer<typeof MustClauseEvaluationSummary>;

export const MustClauseEvaluation = z.strictObject({
  schemaVersion: z.literal(MUST_CLAUSE_EVALUATION_SCHEMA_VERSION),
  tool: z.literal(MUST_CLAUSE_EVALUATION_TOOL),
  compilerVersion: z.string().min(1).max(64),
  groups: z.array(MustClauseGroupEvidence).max(300),
  summary: MustClauseEvaluationSummary,
  unattributedHardFails: z.array(z.string().min(1).max(160)).max(100),
  globalBlockers: z.array(z.string().min(1).max(160)).max(100).default([]),
});
export type MustClauseEvaluation = z.infer<typeof MustClauseEvaluation>;

/**
 * clause 状态汇总：hard fail 优先，其次是“还没证据”，再次是显式 waiver。
 * 空数组按 met 处理（没有未满足的 clause）；调用方应为每个 group 至少提供一个 leaf。
 */
export function aggregateMustClauseStatus(statuses: readonly MustClauseStatus[]): MustClauseStatus {
  if (statuses.includes('not-met')) return 'not-met';
  if (statuses.includes('unverified')) return 'unverified';
  if (statuses.includes('waived')) return 'waived';
  return 'met';
}

/** 固定顺序的零值 byKind，避免输出依赖“先遇到哪个 kind”。 */
export function emptyMustClauseKindCounts(): Record<MustClauseKind, number> {
  return {
    dimension: 0,
    count: 0,
    kind: 0,
    relation: 0,
    absence: 0,
    material: 0,
    budget: 0,
    form: 0,
    qualitative: 0,
    program: 0,
    site: 0,
    visual: 0,
  };
}

/** 从 groups 重算摘要；不信任输入里已有的 summary。 */
export function summarizeClausePlan(plan: Pick<MustClausePlanFile, 'groups'>): MustClausePlanSummary {
  const byKind = emptyMustClauseKindCounts();
  let leaves = 0;
  let qualitative = 0;
  let conflicts = 0;
  for (const group of plan.groups) {
    for (const leaf of group.leaves) {
      leaves += 1;
      byKind[leaf.kind] += 1;
      if (leaf.check.kind === 'qualitative') qualitative += 1;
      if (leaf.conflict !== null) conflicts += 1;
    }
  }
  return {
    musts: plan.groups.length,
    leaves,
    byKind,
    qualitative,
    conflicts,
  };
}

/** 一条 clause 在证据文件中的稳定引用；证据表可用它反查 plan。 */
export function clauseEvidenceRef(clause: Pick<MustClausePlan, 'clauseId'>): string {
  return `clause:${clause.clauseId}`;
}
