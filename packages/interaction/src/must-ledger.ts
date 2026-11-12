/**
 * MustLedger：需求图的 must 侧单一清单。
 *
 * 负责：把 req must 与硬约束整理成同一份可序列化清单，保留 BuildSpec 使用的 id、
 * 全文、目标值、检查类别与证据占位；后续 scheme gate / BuildSheet / review 只在这份清单上追加状态。
 * 不负责：语义检查、几何比较、读文件或调用模型；本文件是纯函数。
 *
 * id 口径：`id` 与 `BuildSpec.musts[].id` 完全一致（约束带 `constraint-` 前缀）；
 * `sourceId` 是需求图里的原始 id，供模型在 decisions.requirementIds 中引用。
 * 不在本文件新增、改写或截断任何 must。
 */
import { z } from 'zod';

import { ID_MAX, Identifier, Label, Text } from './primitives.ts';
import type { RequirementConstraint, RequirementGraph, RequirementItem } from './requirements.ts';

export const MUST_LEDGER_VERSION = 1;

export const MustLedgerStatus = z.enum(['met', 'not-met', 'unverified', 'waived']);
export type MustLedgerStatus = z.infer<typeof MustLedgerStatus>;

/** 检查类别只用于分组与后续路由，不代表当前已经有证据。 */
export const MustLedgerCheck = z.enum([
  'geometry',
  'dimension',
  'opening',
  'furniture',
  'material',
  'budget',
  'accessibility',
  'forbidden',
  'unverified',
]);
export type MustLedgerCheck = z.infer<typeof MustLedgerCheck>;

export const MUST_LEDGER_CHECK_LABELS: Readonly<Record<MustLedgerCheck, string>> = {
  geometry: '空间与体量',
  dimension: '尺寸与几何',
  opening: '门窗与洞口',
  furniture: '家具与固定设施',
  material: '材料与做法',
  budget: '预算与方块',
  accessibility: '标高与无障碍',
  forbidden: '禁止项',
  unverified: '其它必须项',
};

export const MustLedgerEntry = z
  .strictObject({
    /** 与 BuildSpec.musts[].id 一致。 */
    id: Identifier,
    /** 需求图原始 id；模型引用 decisions.requirementIds 时用它。 */
    sourceId: Identifier,
    text: Text,
    source: z.enum(['requirement', 'constraint']),
    kind: z.string().min(1).max(32),
    check: MustLedgerCheck,
    /** 从原文抽出的数字短语（4m、10 座、20000 方块等），不是新的设计目标。 */
    targets: z.array(Label).max(32).readonly(),
    /** 约束自带的 value；没有则为 null。 */
    value: Label.nullable(),
    status: MustLedgerStatus,
    evidence: z.array(Text).max(50).readonly(),
  })
  .readonly();
export type MustLedgerEntry = z.infer<typeof MustLedgerEntry>;

export const MustLedgerCounts = z
  .strictObject({
    requirements: z.int().nonnegative(),
    constraints: z.int().nonnegative(),
    total: z.int().nonnegative(),
    met: z.int().nonnegative(),
    notMet: z.int().nonnegative(),
    unverified: z.int().nonnegative(),
    waived: z.int().nonnegative(),
  })
  .readonly();
export type MustLedgerCounts = z.infer<typeof MustLedgerCounts>;

export const MustLedger = z
  .strictObject({
    version: z.literal(MUST_LEDGER_VERSION),
    requirementsGraphId: Identifier,
    requirementsRevision: z.int().positive(),
    entries: z.array(MustLedgerEntry).max(300).readonly(),
    counts: MustLedgerCounts,
  })
  .readonly();
export type MustLedger = z.infer<typeof MustLedger>;

const CONSTRAINT_PREFIX = 'constraint-';

/** 与 brief.ts 的 BuildSpec 约束 id 使用同一规则；截断上限也一致。 */
export function buildMustIdForConstraint(id: string): string {
  return `${CONSTRAINT_PREFIX}${id.slice(0, ID_MAX - CONSTRAINT_PREFIX.length)}`;
}

const TARGET_PATTERN = /\d+(?:\.\d+)?\s*(?:m|米|格|座|人|°|度|方块|blocks?)/giu;
const DIMENSION_PATTERN = /\d+(?:\.\d+)?(?:\s*[×xX]\s*\d+(?:\.\d+)?)+/gu;
const SEAT_PATTERN = /\d+\s*\+\s*\d+/gu;

/** 只抽取原文中已有的数字短语，不推断或补齐目标。 */
export function extractMustTargets(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of [TARGET_PATTERN, DIMENSION_PATTERN, SEAT_PATTERN]) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].replace(/\s+/g, ' ').trim();
      if (value === '' || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
      if (out.length >= 32) return out;
    }
  }
  return out;
}

function requirementCheck(requirement: RequirementItem): MustLedgerCheck {
  if (requirement.kind === 'dimension') return 'dimension';
  const text = requirement.text;
  if (/(?:室外分区|檐下平台|露台|庭院|铺装|招牌|售票|标识|广告)/u.test(text)) return 'geometry';
  if (/(?:齐平|台阶|坡道|高差|标高|无障碍)/u.test(text)) return 'accessibility';
  if (/(?:桌|凳|椅|柜|家具|座位|座椅|茶座|\d+\s*座|床|书架|灯具|吧台)/u.test(text)) {
    return 'furniture';
  }
  if (/(?:屋面|屋脊|檐口|屋顶|单层|夹层|隔间|隔墙|场地|轮廓|占地|分区|房间)/u.test(text)) {
    return 'geometry';
  }
  if (/(?:门|窗|洞口|开口|入口)/u.test(text)) return 'opening';
  if (/(?:材料|石材|石基|基座|木|瓦|砖|玻璃|墙面|质感|颜色)/u.test(text)) return 'material';
  if (/(?:预算|方块|造价|成本)/u.test(text)) return 'budget';
  if (requirement.affects.includes('material')) return 'material';
  if (requirement.affects.includes('facade')) return 'opening';
  if (
    requirement.affects.includes('site') ||
    requirement.affects.includes('plan') ||
    requirement.affects.includes('section')
  ) {
    return 'geometry';
  }
  return 'unverified';
}

function constraintCheck(constraint: RequirementConstraint): MustLedgerCheck {
  switch (constraint.kind) {
    case 'dimension':
      return 'dimension';
    case 'budget':
      return 'budget';
    case 'material':
      return 'material';
    case 'forbidden':
      return 'forbidden';
    case 'accessibility':
      return 'accessibility';
    case 'regulation':
    case 'other':
      return 'unverified';
  }
}

function targetsForCheck(text: string, check: MustLedgerCheck): string[] {
  const targets = extractMustTargets(text);
  if (check !== 'budget') return targets;
  const budgetTargets = targets.filter((target) => /(?:方块|blocks?|元|万|预算)/iu.test(target));
  return budgetTargets.length === 0 ? targets.slice(0, 4) : budgetTargets;
}

function entryBase(input: {
  readonly id: string;
  readonly sourceId: string;
  readonly text: string;
  readonly source: 'requirement' | 'constraint';
  readonly kind: string;
  readonly check: MustLedgerCheck;
  readonly value: string | null;
}): MustLedgerEntry {
  return MustLedgerEntry.parse({
    ...input,
    targets: targetsForCheck(input.text, input.check),
    status: 'unverified',
    evidence: [],
  });
}

/**
 * 与 `compileBuildSpec` 的 requirement musts 使用同一顺序与 id：
 * 先 requirements（must、未 rejected），再 hard constraints（排除 forbidden）。
 */
export function buildRequirementMustEntries(requirements: RequirementGraph): MustLedgerEntry[] {
  const out: MustLedgerEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: MustLedgerEntry): void => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };

  for (const requirement of requirements.requirements) {
    if (requirement.priority !== 'must' || requirement.status === 'rejected') continue;
    push(
      entryBase({
        id: requirement.id,
        sourceId: requirement.id,
        text: requirement.text,
        source: 'requirement',
        kind: requirement.kind,
        check: requirementCheck(requirement),
        value: null,
      }),
    );
  }

  for (const constraint of requirements.constraints) {
    if (!constraint.hard || constraint.kind === 'forbidden') continue;
    push(
      entryBase({
        id: buildMustIdForConstraint(constraint.id),
        sourceId: constraint.id,
        text: constraint.text,
        source: 'constraint',
        kind: constraint.kind,
        check: constraintCheck(constraint),
        value: constraint.value,
      }),
    );
  }

  return out;
}

/** 生成完整 MustLedger；所有条目初始为 unverified，等待 gate / build / review 追加证据。 */
export function buildMustLedger(requirements: RequirementGraph): MustLedger {
  const entries = buildRequirementMustEntries(requirements);
  const counts = {
    requirements: entries.filter((entry) => entry.source === 'requirement').length,
    constraints: entries.filter((entry) => entry.source === 'constraint').length,
    total: entries.length,
    met: entries.filter((entry) => entry.status === 'met').length,
    notMet: entries.filter((entry) => entry.status === 'not-met').length,
    unverified: entries.filter((entry) => entry.status === 'unverified').length,
    waived: entries.filter((entry) => entry.status === 'waived').length,
  };
  return MustLedger.parse({
    version: MUST_LEDGER_VERSION,
    requirementsGraphId: requirements.id,
    requirementsRevision: requirements.revision,
    entries,
    counts,
  });
}
