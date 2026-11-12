/** 版本差异的好坏样本：相同幂等、字段变更、增加删除、空间变更与排序。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffBlueprint } from './diff.ts';
import { Blueprint } from './schema.ts';

type ParsedBlueprint = ReturnType<typeof Blueprint.parse>;

function element(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    level: 'lv',
    kind: 'wall',
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    color: '#112233',
    shape: 'box',
    direction: 1,
    ...patch,
  };
}

function space(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    level: 'lv',
    bounds: { min: [0, 0, 0], max: [2, 2, 2] },
    role: 'room',
    color: '#445566',
    ...patch,
  };
}

function build(
  elements: readonly Record<string, unknown>[],
  spaces: readonly Record<string, unknown>[] = [],
): ParsedBlueprint {
  return Blueprint.parse({
    id: 'bp',
    revision: 1,
    title: '测试',
    description: '测试',
    levels: [{ id: 'lv', name: 'L', elevation: 0 }],
    spaces,
    elements,
    clearances: [],
    notes: [],
  });
}

test('完全相同的方案差异为空（幂等）', () => {
  const before = build([element('el-a'), element('el-b')], [space('sp-x')]);
  assert.deepEqual(diffBlueprint(before, before), { added: [], removed: [], changed: [], spacesChanged: [] });
  const after = build([element('el-a'), element('el-b')], [space('sp-x')]);
  assert.deepEqual(diffBlueprint(before, after), { added: [], removed: [], changed: [], spacesChanged: [] });
});

test('元素任一完整字段变化都进入 changed', () => {
  const before = build([element('el-a')]);
  assert.deepEqual(
    diffBlueprint(before, build([element('el-a', { bounds: { min: [0, 0, 0], max: [2, 2, 2] } })])).changed,
    ['el-a'],
  );
  assert.deepEqual(diffBlueprint(before, build([element('el-a', { color: '#abcdef' })])).changed, ['el-a']);
  assert.deepEqual(diffBlueprint(before, build([element('el-a', { direction: -1 })])).changed, ['el-a']);
});

test('可选 spaceId 从无到有算变化', () => {
  const before = build([element('el-a')]);
  const after = build([element('el-a', { spaceId: 'sp-1' })], [space('sp-1')]);
  assert.deepEqual(diffBlueprint(before, after).changed, ['el-a']);
});

test('可选字段显式给 undefined 与缺省视为相同', () => {
  const before = build([element('el-a')]);
  const after = build([element('el-a', { spaceId: undefined })]);
  assert.deepEqual(diffBlueprint(before, after).changed, []);
});

test('增加与删除按 id 报告', () => {
  const before = build([element('el-a'), element('el-b')]);
  const after = build([element('el-a'), element('el-c')]);
  assert.deepEqual(diffBlueprint(before, after), {
    added: ['el-c'],
    removed: ['el-b'],
    changed: [],
    spacesChanged: [],
  });
});

test('空间字段变化进入 spacesChanged', () => {
  const before = build([], [space('sp-x'), space('sp-y')]);
  const after = build([], [space('sp-x'), space('sp-y', { name: '改名' })]);
  assert.deepEqual(diffBlueprint(before, after).spacesChanged, ['sp-y']);
});

test('空间新增与删除也进入 spacesChanged，并按 id 排序', () => {
  const before = build([], [space('sp-keep'), space('sp-gone')]);
  const after = build([], [space('sp-keep'), space('sp-new')]);
  assert.deepEqual(diffBlueprint(before, after).spacesChanged, ['sp-gone', 'sp-new']);
  assert.deepEqual(diffBlueprint(before, before).spacesChanged, []);
});

test('各数组按 id 字典序排序', () => {
  const before = build([element('el-m')], [space('sp-m')]);
  const after = build([element('el-m'), element('el-z'), element('el-a')], [space('sp-m')]);
  const diff = diffBlueprint(before, after);
  assert.deepEqual(diff.added, ['el-a', 'el-z']);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.spacesChanged, []);
});

test('元素顺序变化不算差异', () => {
  const before = build([element('el-a'), element('el-b')]);
  const after = build([element('el-b'), element('el-a')]);
  assert.deepEqual(diffBlueprint(before, after), { added: [], removed: [], changed: [], spacesChanged: [] });
});
