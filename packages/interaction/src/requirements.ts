/**
 * RequirementGraph：把用户原话、代理推断、默认值与用户确认分开记录的需求图。
 *
 * 负责：结构化需求 / 功能空间 / 场地 / 约束 / 偏好 / 歧义 / 冲突 / 缺失 / 能力边界 / 决策，
 * 并校验各集合内 id 唯一、涉及需求的引用能解析。
 * 不负责：抽取文本（后续 LLM 结构化输出）、提问排序、方案生成或任何 I/O。
 *
 * 规则：代理拟定的尺寸不能自动升级成用户硬要求 —— 用 status=proposed / assumed 表达；
 * 用户原话放 quote，推断依据放 evidence，两者都可为 null，但字段必须存在。
 */
import { z } from 'zod';

import { Bounds, Identifier, Label, Note, Text } from './primitives.ts';

const REQUIREMENTS_MAX = 500;
const SPACES_MAX = 100;
const CONSTRAINTS_MAX = 200;
const PREFERENCES_MAX = 200;
const AMBIGUITIES_MAX = 100;
const CONFLICTS_MAX = 100;
const MISSING_MAX = 100;
const CAPABILITIES_MAX = 100;
const DECISIONS_MAX = 200;
const REFERENCES_MAX = 50;

/** 需求来源：用户原话、代理推断、默认建议、外部资料。 */
export const RequirementSource = z.enum(['user', 'agent', 'default', 'imported']);
export type RequirementSource = z.infer<typeof RequirementSource>;

/** 需求类别；与 affects 分开：kind 说明“是什么”，affects 说明“改哪里”。 */
export const RequirementKind = z.enum([
  'function',
  'space',
  'site',
  'dimension',
  'aesthetic',
  'constraint',
  'capability',
  'operation',
]);
export type RequirementKind = z.infer<typeof RequirementKind>;

export const RequirementPriority = z.enum(['must', 'should', 'could']);
export type RequirementPriority = z.infer<typeof RequirementPriority>;

export const RequirementStatus = z.enum(['proposed', 'assumed', 'confirmed', 'rejected', 'unresolved']);
export type RequirementStatus = z.infer<typeof RequirementStatus>;

/** 需求影响的方案部位。 */
export const RequirementAffect = z.enum([
  'site',
  'plan',
  'section',
  'facade',
  'roof',
  'structure',
  'circulation',
  'interior',
  'material',
  'budget',
  'experience',
  'scope',
]);
export type RequirementAffect = z.infer<typeof RequirementAffect>;

/** 单条需求；quote / evidence 缺失时写 null，不允许省略字段。 */
export const RequirementItem = z
  .strictObject({
    id: Identifier,
    text: Text,
    quote: z.string().min(1).max(2000).nullable(),
    source: RequirementSource,
    kind: RequirementKind,
    priority: RequirementPriority,
    status: RequirementStatus,
    confidence: z.number().min(0).max(1),
    affects: z.array(RequirementAffect).min(1).max(12).readonly(),
    evidence: z.string().min(1).max(2000).nullable(),
  })
  .readonly();
export type RequirementItem = z.infer<typeof RequirementItem>;

/** 功能空间的需求（不是几何空间；几何在 DesignScheme.spaces）。 */
export const RequirementSpace = z
  .strictObject({
    id: Identifier,
    name: Label,
    purpose: Text,
    quantity: z.int().min(1).max(100),
    areaM2: z.number().positive().max(1_000_000).nullable(),
    levelHint: z.enum(['ground', 'upper', 'basement', 'any']),
    adjacency: z.array(Identifier).max(REFERENCES_MAX).readonly(),
    daylight: z.enum(['required', 'preferred', 'none']),
    privacy: z.enum(['public', 'semi-public', 'private']),
    notes: Note,
  })
  .readonly();
export type RequirementSpace = z.infer<typeof RequirementSpace>;

/** 场地室外分区。 */
export const SiteZone = z
  .strictObject({
    id: Identifier,
    name: Label,
    kind: z.enum(['garden', 'terrace', 'path', 'parking', 'service', 'water', 'other']),
    bounds: Bounds,
    notes: Note,
  })
  .readonly();
export type SiteZone = z.infer<typeof SiteZone>;

/** 场地需求；未知项写 null / unknown，不猜数字。 */
export const SiteRequirements = z
  .strictObject({
    widthM: z.number().positive().max(10_000).nullable(),
    depthM: z.number().positive().max(10_000).nullable(),
    orientation: z.enum(['north', 'east', 'south', 'west', 'unknown']),
    slope: z.enum(['flat', 'gentle', 'steep', 'unknown']),
    entrance: Label.nullable(),
    setbacksM: z
      .strictObject({
        north: z.number().min(0).max(1000),
        east: z.number().min(0).max(1000),
        south: z.number().min(0).max(1000),
        west: z.number().min(0).max(1000),
      })
      .readonly()
      .nullable(),
    outdoorZones: z.array(SiteZone).max(50).readonly(),
    surroundings: z.array(Label).max(30).readonly(),
    notes: Note,
  })
  .readonly();
export type SiteRequirements = z.infer<typeof SiteRequirements>;

export const ConstraintKind = z.enum([
  'dimension',
  'budget',
  'material',
  'forbidden',
  'regulation',
  'accessibility',
  'other',
]);
export type ConstraintKind = z.infer<typeof ConstraintKind>;

export const RequirementConstraint = z
  .strictObject({
    id: Identifier,
    text: Text,
    kind: ConstraintKind,
    source: RequirementSource,
    /** true 表示用户明确的硬约束；代理推断的“建议上限”应为 false。 */
    hard: z.boolean(),
    value: Label.nullable(),
  })
  .readonly();
export type RequirementConstraint = z.infer<typeof RequirementConstraint>;

export const PreferenceKind = z.enum(['style', 'material', 'color', 'atmosphere', 'reference', 'other']);
export type PreferenceKind = z.infer<typeof PreferenceKind>;

export const RequirementPreference = z
  .strictObject({
    id: Identifier,
    text: Text,
    kind: PreferenceKind,
    source: RequirementSource,
    strength: z.enum(['strong', 'medium', 'weak']),
    status: z.enum(['proposed', 'confirmed', 'rejected']),
  })
  .readonly();
export type RequirementPreference = z.infer<typeof RequirementPreference>;

export const RequirementAmbiguity = z
  .strictObject({
    id: Identifier,
    question: Text,
    options: z.array(Label).min(1).max(8).readonly(),
    impact: z.enum(['high', 'medium', 'low']),
    suggestedDefault: Text.nullable(),
    status: z.enum(['open', 'resolved', 'assumed']),
    requirementIds: z.array(Identifier).max(REFERENCES_MAX).readonly(),
  })
  .readonly();
export type RequirementAmbiguity = z.infer<typeof RequirementAmbiguity>;

export const RequirementConflict = z
  .strictObject({
    id: Identifier,
    summary: Text,
    requirementIds: z.array(Identifier).min(2).max(REFERENCES_MAX).readonly(),
    options: z.array(Text).min(1).max(8).readonly(),
    status: z.enum(['open', 'resolved', 'deferred']),
  })
  .readonly();
export type RequirementConflict = z.infer<typeof RequirementConflict>;

export const RequirementMissing = z
  .strictObject({
    id: Identifier,
    topic: Label,
    why: Text,
    blocking: z.boolean(),
    suggestedDefault: Text.nullable(),
    status: z.enum(['open', 'answered', 'waived']),
  })
  .readonly();
export type RequirementMissing = z.infer<typeof RequirementMissing>;

export const RequirementCapability = z
  .strictObject({
    id: Identifier,
    topic: Label,
    status: z.enum(['supported', 'partial', 'unsupported', 'workaround']),
    detail: Text,
    workaround: Text.nullable(),
    requirementIds: z.array(Identifier).max(REFERENCES_MAX).readonly(),
  })
  .readonly();
export type RequirementCapability = z.infer<typeof RequirementCapability>;

export const RequirementDecision = z
  .strictObject({
    id: Identifier,
    topic: Label,
    choice: Text,
    rationale: Text,
    source: z.enum(['user', 'agent', 'default']),
    status: z.enum(['proposed', 'confirmed', 'rejected']),
    /**
     * 方案决策的落点：可以引用同一图里的需求（req-*）、约束（con-*）或能力项（cap-*）。
     * 只校验 id 存在；具体集合由 RequirementGraph.superRefine 统一检查。
     */
    requirementIds: z.array(Identifier).max(REFERENCES_MAX).readonly(),
  })
  .readonly();
export type RequirementDecision = z.infer<typeof RequirementDecision>;

/** 需求图完整结构；数组顺序保留输入顺序，报告按原顺序输出。 */
export const RequirementGraph = z
  .strictObject({
    id: Identifier,
    revision: z.int().positive(),
    summary: Text,
    requirements: z.array(RequirementItem).min(1).max(REQUIREMENTS_MAX).readonly(),
    spaces: z.array(RequirementSpace).max(SPACES_MAX).readonly(),
    site: SiteRequirements.nullable(),
    constraints: z.array(RequirementConstraint).max(CONSTRAINTS_MAX).readonly(),
    preferences: z.array(RequirementPreference).max(PREFERENCES_MAX).readonly(),
    ambiguities: z.array(RequirementAmbiguity).max(AMBIGUITIES_MAX).readonly(),
    conflicts: z.array(RequirementConflict).max(CONFLICTS_MAX).readonly(),
    missing: z.array(RequirementMissing).max(MISSING_MAX).readonly(),
    capabilities: z.array(RequirementCapability).max(CAPABILITIES_MAX).readonly(),
    decisions: z.array(RequirementDecision).max(DECISIONS_MAX).readonly(),
  })
  .superRefine((graph, ctx) => {
    const requirementIds = new Set<string>();
    graph.requirements.forEach((requirement, index) => {
      if (requirementIds.has(requirement.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['requirements', index, 'id'],
          message: `需求 id 重复：${requirement.id}`,
        });
      }
      requirementIds.add(requirement.id);
    });

    const spaceIds = new Set<string>();
    graph.spaces.forEach((space, index) => {
      if (spaceIds.has(space.id)) {
        ctx.addIssue({ code: 'custom', path: ['spaces', index, 'id'], message: `需求空间 id 重复：${space.id}` });
      }
      spaceIds.add(space.id);
    });
    graph.spaces.forEach((space, index) => {
      space.adjacency.forEach((reference, refIndex) => {
        if (!spaceIds.has(reference)) {
          ctx.addIssue({
            code: 'custom',
            path: ['spaces', index, 'adjacency', refIndex],
            message: `需求空间 ${space.id} 引用了不存在的相邻空间 ${reference}`,
          });
        }
      });
    });

    const checkRequirementReferences = (
      refs: readonly string[],
      path: readonly (string | number)[],
      owner: string,
    ): void => {
      refs.forEach((reference, refIndex) => {
        if (!requirementIds.has(reference)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, refIndex],
            message: `${owner} 引用了不存在的需求 ${reference}`,
          });
        }
      });
    };

    const checkUnique = (ids: readonly string[], path: string, label: string): void => {
      const seen = new Set<string>();
      ids.forEach((id, index) => {
        if (seen.has(id)) {
          ctx.addIssue({ code: 'custom', path: [path, index, 'id'], message: `${label} id 重复：${id}` });
        }
        seen.add(id);
      });
    };

    checkUnique(
      graph.constraints.map((item) => item.id),
      'constraints',
      '约束',
    );
    checkUnique(
      graph.preferences.map((item) => item.id),
      'preferences',
      '偏好',
    );
    checkUnique(
      graph.ambiguities.map((item) => item.id),
      'ambiguities',
      '歧义',
    );
    checkUnique(
      graph.conflicts.map((item) => item.id),
      'conflicts',
      '冲突',
    );
    checkUnique(
      graph.missing.map((item) => item.id),
      'missing',
      '缺失项',
    );
    checkUnique(
      graph.capabilities.map((item) => item.id),
      'capabilities',
      '能力项',
    );
    checkUnique(
      graph.decisions.map((item) => item.id),
      'decisions',
      '决策',
    );
    checkUnique(graph.site?.outdoorZones.map((item) => item.id) ?? [], 'site.outdoorZones', '场地区域');

    graph.ambiguities.forEach((ambiguity, index) => {
      checkRequirementReferences(
        ambiguity.requirementIds,
        ['ambiguities', index, 'requirementIds'],
        `歧义 ${ambiguity.id}`,
      );
    });
    graph.conflicts.forEach((conflict, index) => {
      checkRequirementReferences(
        conflict.requirementIds,
        ['conflicts', index, 'requirementIds'],
        `冲突 ${conflict.id}`,
      );
    });
    graph.capabilities.forEach((capability, index) => {
      checkRequirementReferences(
        capability.requirementIds,
        ['capabilities', index, 'requirementIds'],
        `能力项 ${capability.id}`,
      );
    });

    // 决策是方案层面的取舍，落点可以是需求、约束或能力项；其他集合仍只允许引用需求。
    const decisionReferenceIds = new Set([
      ...requirementIds,
      ...graph.constraints.map((constraint) => constraint.id),
      ...graph.capabilities.map((capability) => capability.id),
    ]);
    graph.decisions.forEach((decision, index) => {
      decision.requirementIds.forEach((reference, refIndex) => {
        if (!decisionReferenceIds.has(reference)) {
          ctx.addIssue({
            code: 'custom',
            path: ['decisions', index, 'requirementIds', refIndex],
            message: `决策 ${decision.id} 引用了不存在的 id ${reference}（只允许 requirements / constraints / capabilities）`,
          });
        }
      });
    });
  })
  .readonly();
export type RequirementGraph = z.infer<typeof RequirementGraph>;
