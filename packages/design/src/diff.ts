/**
 * 版本差异：对同一稳定编号的两份 Blueprint 做元素与空间对照（MASSING-SPEC §2）。
 *
 * 负责：按 id 比较元素完整字段，给出增加 / 删除 / 修改的元素 id 与修改的空间 id，数组按 id 排序。
 * 不负责：schema 校验、把差异应用回方案、生成新版本。
 *
 * 口径：元素用完整字段比较（含 bounds / color / shape / direction / 可选 spaceId）；
 * 空间用完整字段比较，`spacesChanged` 覆盖新增、删除与字段变化三类 id。
 */
import type { Blueprint } from './schema.ts';

export interface BlueprintDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly spacesChanged: readonly string[];
}

/** id 的显式排序：不用 localeCompare（docs/STANDARDS.md §5）。 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 结构相等：数组与对象逐层比较，对象跳过值为 undefined 的可选键，
 * 因此显式 undefined 与整个缺省视为相同。用于比较元素 / 空间的完整字段。
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (isUnknownArray(left) && isUnknownArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => rightKeys.includes(key) && sameValue(left[key], right[key]))
    );
  }
  return false;
}

/** 对照 before / after：数组按 id 排序，元素比较完整字段。 */
export function diffBlueprint(before: Blueprint, after: Blueprint): BlueprintDiff {
  const beforeElements = new Map(before.elements.map((element) => [element.id, element]));
  const afterElements = new Map(after.elements.map((element) => [element.id, element]));

  const added: string[] = [...afterElements.keys()].filter((id) => !beforeElements.has(id));
  const removed: string[] = [...beforeElements.keys()].filter((id) => !afterElements.has(id));
  const changed: string[] = [];
  for (const [id, element] of beforeElements) {
    const next = afterElements.get(id);
    if (next !== undefined && !sameValue(element, next)) changed.push(id);
  }

  const beforeSpaces = new Map(before.spaces.map((space) => [space.id, space]));
  const afterSpaces = new Map(after.spaces.map((space) => [space.id, space]));
  const spacesChanged: string[] = [];
  for (const [id, space] of beforeSpaces) {
    const next = afterSpaces.get(id);
    if (next === undefined || !sameValue(space, next)) spacesChanged.push(id);
  }
  for (const id of afterSpaces.keys()) {
    if (!beforeSpaces.has(id)) spacesChanged.push(id);
  }

  added.sort(compareIds);
  removed.sort(compareIds);
  changed.sort(compareIds);
  spacesChanged.sort(compareIds);
  return { added, removed, changed, spacesChanged };
}
