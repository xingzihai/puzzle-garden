/**
 * FloorDatum：室内地面 / 室外地面 / 入口门槛的同一套标高事实。
 *
 * 负责：从 DesignScheme + 需求图派生 gradeY / standingY / slabTopY / 入口门槛，明确 flush、
 * one-step 或 unknown；当 must 要求无台阶而实际存在高差时，返回可持久化的 conflict。
 * 不负责：改方案几何、抬高场地、渲染或读文件；本文件是纯函数。
 *
 * 口径（与 tools/build-sheet.ts 的 siteTopY / datum 对齐；标高只以 gradeY / standingY / slabTopY 表达）：
 * - standingY 是室内站立面（y1）；slabTopY 是楼板体块起始格（y0）；三者不另设兼容别名。
 * - gradeY 取场地顶面：max 落在站立面及以下时取 max，否则取 min[1]+1。
 * - raise-site 是默认建议，不在派生阶段偷偷修改 scheme；由用户选择或后续 repair 执行。
 */
import { z } from 'zod';

import { isFlushMustText } from './flush-text.ts';
import { buildMustLedger } from './must-ledger.ts';
import type { MustLedgerEntry } from './must-ledger.ts';
import { Identifier, Label, Text } from './primitives.ts';
import type { RequirementGraph } from './requirements.ts';
import type { DesignScheme } from './scheme.ts';

export const FloorDatumTransition = z.enum(['flush', 'one-step', 'unknown']);
export type FloorDatumTransition = z.infer<typeof FloorDatumTransition>;

export const FloorDatumSource = z.enum(['raise-site', 'lower-floor', 'actual', 'unresolved']);
export type FloorDatumSource = z.infer<typeof FloorDatumSource>;

/** 标高冲突的显式用户选择；所有选项都持久化，不替用户默认。 */
export const FloorDatumAction = z.enum(['raise-site', 'accept-step', 'waive', 'redesign']);
export type FloorDatumAction = z.infer<typeof FloorDatumAction>;

export const FloorDatumOption = z
  .strictObject({
    id: FloorDatumAction,
    label: Label,
  })
  .readonly();
export type FloorDatumOption = z.infer<typeof FloorDatumOption>;

export const FloorDatumChoice = z
  .strictObject({
    conflictId: Identifier,
    action: FloorDatumAction,
    note: Text.nullable(),
  })
  .readonly();
export type FloorDatumChoice = z.infer<typeof FloorDatumChoice>;

export const FLOOR_DATUM_OPTIONS: readonly FloorDatumOption[] = [
  { id: 'raise-site', label: '抬高场地/基座到楼面标高' },
  { id: 'accept-step', label: '明确接受现状一格高差' },
  { id: 'waive', label: '明确豁免无台阶 / 齐平 must' },
  { id: 'redesign', label: '回到设计修改入口或场地' },
] as const;

export const FloorDatumBand = z
  .strictObject({
    id: Identifier,
    minY: z.int(),
    /** 闭区间上界，与 BuildSheet datum 的 y1..2 口径一致。 */
    maxY: z.int(),
  })
  .readonly();
export type FloorDatumBand = z.infer<typeof FloorDatumBand>;

export const FloorDatum = z
  .strictObject({
    /** 室外可站立地面标高；与 BuildSheet 的 site top 同一口径。 */
    gradeY: z.int(),
    /** 室内站立面标高（步行面）。 */
    standingY: z.int(),
    /** 结构楼板顶所在格（y0）；楼板占 [slabTopY, standingY)。 */
    slabTopY: z.int(),
    /** 入口洞口底标高。 */
    entryThresholdY: z.int(),
    entryTransition: FloorDatumTransition,
    source: FloorDatumSource,
    /** 需要修复时推荐的宿主动作；已经满足时为 null。 */
    recommendedSource: z.enum(['raise-site', 'lower-floor']).nullable(),
    /** 推荐抬到哪个室外标高；已经满足时为 null。 */
    targetGradeY: z.int().nullable(),
    /** 所有非窗洞口（不只入口侧），与 BuildSheet 的 doors 同口径。 */
    doors: z.array(FloorDatumBand).max(50).readonly(),
    windows: z.array(FloorDatumBand).max(50).readonly(),
    evidence: z.array(Text).max(20).readonly(),
  })
  .readonly();
export type FloorDatum = z.infer<typeof FloorDatum>;

export const FloorDatumConflict = z
  .strictObject({
    id: Identifier,
    kind: z.literal('flush-entry'),
    mustIds: z.array(Identifier).max(50).readonly(),
    expected: Text,
    actual: Text,
    recommendedSource: z.enum(['raise-site', 'lower-floor']),
    targetGradeY: z.int(),
    resolution: Text,
    options: z.array(FloorDatumOption).min(1).max(8).readonly(),
  })
  .readonly();
export type FloorDatumConflict = z.infer<typeof FloorDatumConflict>;

export interface FloorDatumResult {
  readonly datum: FloorDatum;
  readonly conflict: FloorDatumConflict | null;
  readonly flushRequired: boolean;
  readonly flushMustIds: readonly string[];
}

export interface FloorDatumOptions {
  readonly flushRequired?: boolean;
  readonly flushMustIds?: readonly string[];
  readonly recommendedSource?: 'raise-site' | 'lower-floor';
}

/** 旧调用可从 floor-datum 继续取到共享 matcher；实现与正则只在 flush-text.ts。 */
export { isFlushMustText } from './flush-text.ts';

/** 返回 MustLedger 中要求入口无高差的条目；id 与 BuildSpec 一致。 */
export function findFlushMustEntries(requirements: RequirementGraph): MustLedgerEntry[] {
  return buildMustLedger(requirements).entries.filter((entry) => isFlushMustText(entry.text));
}

function firstLevel(scheme: DesignScheme) {
  return [...scheme.levels].sort((a, b) => a.elevation - b.elevation)[0];
}

/**
 * 与 tools/build-sheet.ts 的 siteTopY 同一口径：
 * 顶层 max 落在站立面或以下时，它就是实际场地顶面；否则按单层场地 min+1 取顶面。
 * 不能把 site.bounds.min[1]（场地层底）直接当 gradeY，否则会把 y0 的层底误报成室外地面。
 */
function siteTopY(scheme: DesignScheme, standingY: number): number {
  const min = scheme.site.bounds.min[1];
  const max = scheme.site.bounds.max[1];
  return max <= standingY ? max : min + 1;
}

/**
 * 与 tools/build-sheet.ts 的 entranceOpening 同口径：按声明顺序取第一个非窗洞口，
 * 优先 scheme.site.entranceSide，其次北侧，最后第一个非窗洞口；窗口永远不能当入口。
 * R2 的 BuildSpec.entranceSide 由 scheme.site.entranceSide 编译而来，两边输入一致。
 */
function entranceOpening(scheme: DesignScheme) {
  const candidates = scheme.openings.filter((opening) => opening.kind !== 'window');
  return (
    candidates.find((opening) => opening.side === scheme.site.entranceSide) ??
    candidates.find((opening) => opening.side === 'north') ??
    candidates[0]
  );
}

function bandOf(openings: DesignScheme['openings']): FloorDatumBand[] {
  return openings
    .map((opening) => ({ id: opening.id, minY: opening.bounds.min[1], maxY: opening.bounds.max[1] - 1 }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 派生标高事实。requirements 提供时以 MustLedger 识别 flush must；否则可显式传
 * flushRequired / flushMustIds（供 expand 在没有完整图时使用）。
 */
export function deriveFloorDatum(
  scheme: DesignScheme,
  requirements?: RequirementGraph,
  options: FloorDatumOptions = {},
): FloorDatumResult {
  const ledgerFlush = requirements === undefined ? [] : findFlushMustEntries(requirements);
  const flushMustIds = [...(options.flushMustIds ?? ledgerFlush.map((entry) => entry.id))];
  const flushRequired = options.flushRequired ?? flushMustIds.length > 0;
  const level = firstLevel(scheme);
  const standingY = level?.elevation ?? 0;
  const slabTopY = standingY - scheme.structure.floorThickness;
  const gradeY = siteTopY(scheme, standingY);
  const entrance = entranceOpening(scheme);
  const entryThresholdY = entrance?.bounds.min[1] ?? standingY;
  // 与 BuildSheet 一致：doors 列所有非窗洞口，不只入口侧；windows 列所有窗。
  const doors = bandOf(scheme.openings.filter((opening) => opening.kind !== 'window'));
  const windows = bandOf(scheme.openings.filter((opening) => opening.kind === 'window'));

  const entryTransition: FloorDatumTransition =
    entrance === undefined ? 'unknown' : gradeY === standingY ? 'flush' : 'one-step';

  const recommendedSource = options.recommendedSource ?? 'raise-site';
  const unresolved = flushRequired && entryTransition !== 'flush';
  const source: FloorDatumSource =
    entryTransition === 'flush' ? (flushRequired ? 'raise-site' : 'actual') : flushRequired ? 'unresolved' : 'actual';

  const evidence = [
    `level ${level?.id ?? '—'} elevation=${String(standingY)}`,
    `site top y${String(gradeY)} (min=${String(scheme.site.bounds.min[1])}, max=${String(scheme.site.bounds.max[1])})`,
    `slab top y${String(slabTopY)}; standing y${String(standingY)}`,
    entrance === undefined ? 'entrance=missing' : `entrance ${entrance.id} bottom=${String(entryThresholdY)}`,
    entryTransition === 'flush'
      ? `grade and standing both y${String(standingY)}`
      : `grade y${String(gradeY)} vs standing y${String(standingY)}`,
  ];

  const datum = FloorDatum.parse({
    gradeY,
    standingY,
    slabTopY,
    entryThresholdY,
    entryTransition,
    source,
    recommendedSource: unresolved ? recommendedSource : null,
    targetGradeY: unresolved ? standingY : null,
    doors,
    windows,
    evidence,
  });

  if (!unresolved) return { datum, conflict: null, flushRequired, flushMustIds };

  const conflict = FloorDatumConflict.parse({
    id: 'conflict-flush-entry',
    kind: 'flush-entry',
    mustIds: flushMustIds,
    expected: `室外地面与室内地面同高 y${String(standingY)}，入口无高差`,
    actual:
      entrance === undefined
        ? `未识别入口洞口；室外地面 y${String(gradeY)}，室内地面 y${String(standingY)}`
        : `室外地面 y${String(gradeY)}，入口底 y${String(entryThresholdY)}，室内地面 y${String(standingY)}`,
    recommendedSource,
    targetGradeY: standingY,
    resolution: `将场地/基座抬至 y${String(standingY)}；否则由用户明确选择接受高差或豁免 must，不得静默接受。`,
    options: FLOOR_DATUM_OPTIONS,
  });
  return { datum, conflict, flushRequired, flushMustIds };
}
