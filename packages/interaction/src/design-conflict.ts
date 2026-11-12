/**
 * DesignConflict：设计 / 展开 / 语义检查共用的冲突形状。
 *
 * 负责：把 B1 gate issue、C1 datum 冲突、室外分区重叠与家具 shrink / relocate / drop
 * 统一成可持久化、可选择的 conflict；每个 conflict 都有 options，不替用户静默决定。
 * 不负责：修改几何、运行检查或 UI；本文件是纯函数。
 */
import { z } from 'zod';

import type { FloorDatumConflict } from './floor-datum.ts';
import { Identifier, Label, Text } from './primitives.ts';
import type { DesignWarning } from './design-expand-types.ts';
import type { SchemeGateIssue } from './scheme-gate.ts';

export const DesignConflictKind = z.enum([
  'gate',
  'datum',
  'outdoor-zone-overlap',
  'furniture-shrink',
  'furniture-relocate',
  'furniture-drop',
  'furniture-zone-drop',
  'normalization',
  'other',
]);
export type DesignConflictKind = z.infer<typeof DesignConflictKind>;

export const DesignConflictSeverity = z.enum(['blocking', 'warning']);
export type DesignConflictSeverity = z.infer<typeof DesignConflictSeverity>;

export const DesignConflictOptionAction = z.enum([
  'repair',
  'accept',
  'waive',
  'redesign',
  'raise-site',
  'accept-step',
]);
export type DesignConflictOptionAction = z.infer<typeof DesignConflictOptionAction>;

export const DesignConflictOption = z
  .strictObject({
    id: Identifier,
    label: Label,
    action: DesignConflictOptionAction,
  })
  .readonly();
export type DesignConflictOption = z.infer<typeof DesignConflictOption>;

export const DesignConflictStatus = z.enum(['open', 'resolved']);
export type DesignConflictStatus = z.infer<typeof DesignConflictStatus>;

export const DesignConflictChoice = z
  .strictObject({
    optionId: Identifier,
    note: Text.nullable(),
  })
  .readonly();
export type DesignConflictChoice = z.infer<typeof DesignConflictChoice>;

export const DesignConflict = z
  .strictObject({
    id: Identifier,
    code: z.string().min(1).max(64),
    kind: DesignConflictKind,
    severity: DesignConflictSeverity,
    title: Label,
    message: Text,
    mustIds: z.array(Identifier).max(50).readonly(),
    expected: Text.nullable(),
    actual: Text.nullable(),
    location: Text.nullable(),
    options: z.array(DesignConflictOption).min(1).max(8).readonly(),
    status: DesignConflictStatus,
    choice: DesignConflictChoice.nullable(),
  })
  .readonly();
export type DesignConflict = z.infer<typeof DesignConflict>;

function conflictId(code: string, suffix = ''): string {
  const raw = `conflict-${code}${suffix === '' ? '' : `-${suffix}`}`;
  return raw.length <= 64 ? raw : `${raw.slice(0, 63)}~`;
}

export function isOpenBlockingConflict(conflict: DesignConflict): boolean {
  return conflict.severity === 'blocking' && conflict.status === 'open';
}

export function designConflictFromDatum(conflict: FloorDatumConflict): DesignConflict {
  return DesignConflict.parse({
    id: conflict.id,
    code: 'datum-conflict',
    kind: 'datum',
    severity: 'blocking',
    title: '入口标高冲突',
    message: `${conflict.actual}；${conflict.resolution}`,
    mustIds: conflict.mustIds,
    expected: conflict.expected,
    actual: conflict.actual,
    location: 'datum.entryTransition',
    options: conflict.options.map((option) => ({
      id: option.id,
      label: option.label,
      action: option.id,
    })),
    status: 'open',
    choice: null,
  });
}

export function designConflictFromGateIssue(issue: SchemeGateIssue): DesignConflict {
  return DesignConflict.parse({
    id: conflictId(issue.code),
    code: issue.code,
    kind: 'gate',
    severity: issue.severity === 'blocking' ? 'blocking' : 'warning',
    title: issue.code,
    message: issue.message,
    mustIds: issue.mustIds,
    expected: issue.expected,
    actual: issue.actual,
    location: issue.location,
    options: issue.options.map((option) => ({
      id: option.id,
      label: option.label,
      action: option.action,
    })),
    status: 'open',
    choice: null,
  });
}

function warningOptions(code: string): readonly DesignConflictOption[] {
  if (code === 'outdoor-zone-overlap-dropped') {
    return [
      { id: 'restore-zone', label: '保留原室外分区并生成新 revision', action: 'repair' },
      { id: 'accept-drop', label: '明确接受移除该分区', action: 'accept' },
      { id: 'redesign', label: '回到设计修改分区', action: 'redesign' },
    ];
  }
  if (code === 'furniture-zone-dropped') {
    return [
      { id: 'restore-furniture', label: '保留家具并生成新 revision', action: 'repair' },
      { id: 'accept-drop', label: '明确接受移除该家具', action: 'accept' },
      { id: 'redesign', label: '回到设计修改家具', action: 'redesign' },
    ];
  }
  if (code === 'furniture-shrunk') {
    return [
      { id: 'restore-size', label: '恢复 must 原尺寸并生成新 revision', action: 'repair' },
      { id: 'accept-shrink', label: '明确接受缩小后的尺寸', action: 'accept' },
      { id: 'redesign', label: '回到设计修改家具', action: 'redesign' },
    ];
  }
  if (code === 'furniture-relocated') {
    return [
      { id: 'restore-anchor', label: '恢复原锚点并生成新 revision', action: 'repair' },
      { id: 'accept-relocate', label: '明确接受新位置', action: 'accept' },
      { id: 'redesign', label: '回到设计修改家具', action: 'redesign' },
    ];
  }
  if (code === 'furniture-dropped') {
    return [
      { id: 'restore-furniture', label: '补回家具并生成新 revision', action: 'repair' },
      { id: 'accept-drop', label: '明确接受移除该家具', action: 'accept' },
      { id: 'redesign', label: '回到设计修改家具', action: 'redesign' },
    ];
  }
  return [{ id: 'acknowledge', label: '明确知悉该 warning', action: 'accept' }];
}

function warningKind(code: string): DesignConflictKind {
  if (code === 'outdoor-zone-overlap-dropped') return 'outdoor-zone-overlap';
  if (code === 'furniture-zone-dropped') return 'furniture-zone-drop';
  if (code === 'furniture-shrunk') return 'furniture-shrink';
  if (code === 'furniture-relocated') return 'furniture-relocate';
  if (code === 'furniture-dropped') return 'furniture-drop';
  return 'normalization';
}

export function designConflictFromWarning(warning: DesignWarning, index: number): DesignConflict {
  const blocking =
    warning.code === 'outdoor-zone-overlap-dropped' ||
    warning.code === 'furniture-zone-dropped' ||
    warning.code === 'furniture-shrunk' ||
    warning.code === 'furniture-relocated' ||
    warning.code === 'furniture-dropped';
  return DesignConflict.parse({
    id: conflictId(warning.code, String(index)),
    code: warning.code,
    kind: warningKind(warning.code),
    severity: blocking ? 'blocking' : 'warning',
    title: warning.code,
    message: warning.message,
    mustIds: [],
    expected: null,
    actual: warning.message,
    location: warning.path ?? null,
    options: warningOptions(warning.code),
    status: 'open',
    choice: null,
  });
}

/** 只把会悄悄改几何的 warning 转成 conflict；notes/alias 等普通 warning 保持 warning。 */
const CONFLICT_WARNING_CODES = new Set([
  'outdoor-zone-overlap-dropped',
  'furniture-zone-dropped',
  'furniture-shrunk',
  'furniture-relocated',
  'furniture-dropped',
]);

export function designConflictsFromWarnings(warnings: readonly DesignWarning[]): DesignConflict[] {
  return warnings
    .filter((warning) => CONFLICT_WARNING_CODES.has(warning.code))
    .map((warning, index) => designConflictFromWarning(warning, index));
}

export function mergeDesignConflicts(
  existing: readonly DesignConflict[],
  incoming: readonly DesignConflict[],
): DesignConflict[] {
  const byId = new Map<string, DesignConflict>();
  for (const conflict of existing) byId.set(conflict.id, conflict);
  for (const conflict of incoming) {
    const previous = byId.get(conflict.id);
    byId.set(conflict.id, previous?.status === 'resolved' ? previous : conflict);
  }
  return [...byId.values()];
}

export function resolveDesignConflict(
  conflicts: readonly DesignConflict[],
  conflictIdValue: string,
  optionId: string,
  note: string | null,
): DesignConflict[] {
  const target = conflicts.find((conflict) => conflict.id === conflictIdValue);
  if (target === undefined) return [...conflicts];
  const option = target.options.find((candidate) => candidate.id === optionId);
  if (option === undefined) return [...conflicts];
  const resolved = option.action === 'accept' || option.action === 'waive' || option.action === 'accept-step';
  return conflicts.map((conflict) =>
    conflict.id === conflictIdValue
      ? { ...conflict, status: resolved ? 'resolved' : 'open', choice: { optionId, note } }
      : conflict,
  );
}
