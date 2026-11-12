/** 路线验证的好坏样本：脚下支承、头顶净空、未验证空档、两级断坎、浮点拒绝与报告形状。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Blueprint } from './schema.ts';
import type { Element } from './schema.ts';
import { Route, validateRoute } from './routes.ts';

function solid(
  id: string,
  kind: Element['kind'],
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  shape: Element['shape'] = 'box',
): Element {
  return { id, name: id, level: 'lv', kind, bounds: { min, max }, color: '#112233', shape, direction: 1 };
}

function makeBlueprint(elements: readonly Element[]): Blueprint {
  return Blueprint.parse({
    id: 'bp',
    revision: 1,
    title: '路线测试',
    description: '路线测试',
    levels: [{ id: 'lv', name: 'L', elevation: 0 }],
    spaces: [],
    elements,
    clearances: [],
    notes: [],
  });
}

function stand(x: number, z: number, y: number): Record<string, unknown> {
  return { kind: 'stand', x, y, z };
}

function route(steps: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { id: 'rt-test', name: '测试路线', steps };
}

/** 地面板：顶面 top，覆盖水平 footprint。 */
function floorSlab(
  id: string,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  top: number,
  kind: Element['kind'] = 'slab',
  shape: Element['shape'] = 'box',
): Element {
  return solid(id, kind, [x0, top - 1, z0], [x1, top, z1], shape);
}

test('Route schema 接受整数坐标，拒绝浮点、step 越界、未知字段与空步骤', () => {
  assert.equal(Route.safeParse(route([stand(0, 0, 0)])).success, true);
  assert.equal(Route.safeParse(route([stand(1.5, 0, 0)])).success, false, '浮点坐标不接受');
  assert.equal(
    Route.safeParse(route([{ kind: 'run', axis: 'x', from: 0, to: 3, cross: 0, startY: 0, step: 0.5 }])).success,
    false,
    '分段步长必须是整数',
  );
  assert.equal(
    Route.safeParse(route([{ kind: 'run', axis: 'x', from: 0, to: 3, cross: 0, startY: 0, step: 2 }])).success,
    false,
    'step 不能超过 1',
  );
  assert.equal(Route.safeParse({ id: 'rt', name: 'n', steps: [], extra: 1 }).success, false);
  assert.equal(Route.safeParse({ id: 'rt', name: 'n', steps: [] }).success, false);
});

test('非法路线返回 route-schema 报告而不是抛错，报告冻结且可读', () => {
  const blueprint = makeBlueprint([floorSlab('el-floor', 0, 2, 0, 1, 0)]);
  const report = validateRoute(blueprint, route([stand(0.5, 0, 0)]));
  assert.equal(report.status, 'issues');
  assert.equal(report.firstIssue!.code, 'route-schema');
  assert.equal(report.cellsChecked, 0);
  assert.match(report.firstIssue!.message, /schema/);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.issues), true);
});

test('脚下有实体盒且头顶净空时通过，同高水平相邻一格允许', () => {
  const blueprint = makeBlueprint([floorSlab('el-floor', 0, 3, 0, 1, 0)]);
  const report = validateRoute(blueprint, route([stand(0, 0, 0), stand(1, 0, 0), stand(2, 0, 0)]));
  assert.equal(report.status, 'pass');
  assert.equal(report.cellsChecked, 3);
  assert.deepEqual(report.issues, []);
  assert.equal(report.firstIssue, null);
});

test('逐级上升 ≤1 的梯段通过（分段辅助展开）', () => {
  const blueprint = makeBlueprint([
    floorSlab('el-floor', 0, 1, 0, 1, 0),
    solid('el-step-1', 'stair', [1, 0, 0], [2, 1, 1]),
    solid('el-step-2', 'stair', [2, 0, 0], [3, 2, 1]),
  ]);
  const report = validateRoute(
    blueprint,
    route([{ kind: 'run', axis: 'x', from: 0, to: 2, cross: 0, startY: 0, step: 1 }]),
  );
  assert.equal(report.status, 'pass');
  assert.equal(report.cellsChecked, 3);
});

test('只有 glazing / marker / 非盒形覆盖顶面时算无支承，并列出被排除实体', () => {
  for (const [id, kind, shape] of [
    ['el-glass', 'glazing', 'box'],
    ['el-mark', 'marker', 'box'],
    ['el-wedge', 'slab', 'wedge-x'],
  ] as const) {
    const element = floorSlab(id, 0, 2, 0, 1, 0, kind, shape);
    const report = validateRoute(makeBlueprint([element]), route([stand(0, 0, 0)]));
    assert.equal(report.status, 'issues', `${id} 不应被当作踏面`);
    assert.equal(report.firstIssue!.code, 'unsupported-stand');
    assert.deepEqual(report.firstIssue!.elementIds, [id]);
    assert.match(report.firstIssue!.message, /不计为踏面/);
  }
});

test('头顶净空被非 marker 实体侵入时报告，marker 在头顶则不侵入', () => {
  const blocked = makeBlueprint([floorSlab('el-floor', 0, 2, 0, 1, 0), solid('el-wall', 'wall', [0, 0, 0], [1, 3, 1])]);
  const blockedReport = validateRoute(blocked, route([stand(0, 0, 0)]));
  assert.equal(blockedReport.firstIssue!.code, 'headroom-intrusion');
  assert.deepEqual(blockedReport.firstIssue!.elementIds, ['el-wall']);

  const markerAbove = makeBlueprint([
    floorSlab('el-floor', 0, 2, 0, 1, 0),
    solid('el-mark', 'marker', [0, 0, 0], [1, 1, 1]),
  ]);
  assert.equal(validateRoute(markerAbove, route([stand(0, 0, 0)])).status, 'pass');
});

test('跳过的格子按未验证空档报出', () => {
  const blueprint = makeBlueprint([floorSlab('el-floor', 0, 5, 0, 1, 0)]);
  const report = validateRoute(blueprint, route([stand(0, 0, 0), stand(3, 0, 0)]));
  assert.equal(report.firstIssue!.code, 'unverified-gap');
  assert.match(report.firstIssue!.message, /未验证空档/);
});

test('两级断坎报 step-too-tall，去掉中平台后同时报空档与断坎', () => {
  const jump = makeBlueprint([floorSlab('el-floor', 0, 1, 0, 1, 0), solid('el-high', 'slab', [1, 1, 0], [2, 2, 1])]);
  const jumpReport = validateRoute(jump, route([stand(0, 0, 0), stand(1, 0, 2)]));
  assert.equal(jumpReport.firstIssue!.code, 'step-too-tall');

  const stair = makeBlueprint([
    floorSlab('el-floor', 0, 1, 0, 1, 0),
    solid('el-step-1', 'stair', [1, 0, 0], [2, 1, 1]),
    solid('el-mid', 'slab', [2, 1, 0], [3, 2, 1]),
    solid('el-step-2', 'stair', [3, 2, 0], [4, 3, 1]),
  ]);
  const good = validateRoute(stair, route([stand(0, 0, 0), stand(1, 0, 1), stand(2, 0, 2), stand(3, 0, 3)]));
  assert.equal(good.status, 'pass', '含中平台的完整路线应通过');
  const removed = validateRoute(stair, route([stand(0, 0, 0), stand(1, 0, 1), stand(3, 0, 3)]));
  const codes = removed.issues.map((issue) => issue.code).sort();
  assert.deepEqual(codes, ['step-too-tall', 'unverified-gap']);
});

test('展开超过上限时返回 route-schema 报告', () => {
  const blueprint = makeBlueprint([floorSlab('el-floor', 0, 10, 0, 1, 0)]);
  const report = validateRoute(
    blueprint,
    route([{ kind: 'run', axis: 'x', from: 0, to: 5000, cross: 0, startY: 0, step: 0 }]),
  );
  assert.equal(report.status, 'issues');
  assert.equal(report.firstIssue!.code, 'route-schema');
  assert.match(report.firstIssue!.message, /上限/);
});

test('多个侵入实体的 elementIds 按 id 排序', () => {
  const blueprint = makeBlueprint([
    floorSlab('el-floor', 0, 2, 0, 1, 0),
    solid('el-c', 'wall', [0, 0, 0], [1, 3, 1]),
    solid('el-b', 'glazing', [0, 0, 0], [1, 3, 1]),
    solid('el-a', 'furnishing', [0, 0, 0], [1, 3, 1]),
  ]);
  const report = validateRoute(blueprint, route([stand(0, 0, 0)]));
  assert.equal(report.firstIssue!.code, 'headroom-intrusion');
  assert.deepEqual(report.firstIssue!.elementIds, ['el-a', 'el-b', 'el-c']);
});

test('报告里 firstIssue 等于首个 issues，status 与问题数一致', () => {
  const blueprint = makeBlueprint([floorSlab('el-floor', 0, 1, 0, 1, 0)]);
  const report = validateRoute(blueprint, route([stand(0, 0, 0), stand(5, 0, 0)]));
  assert.equal(report.status, 'issues');
  assert.equal(report.issues.length > 0, true);
  assert.deepEqual(report.firstIssue, report.issues[0]);
});
