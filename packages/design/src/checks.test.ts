/** 净空检查的好坏样本：实体全部参与、marker 与 ignore 排除、楔体保守判定、半开区间。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkBlueprint } from './checks.ts';
import { Blueprint } from './schema.ts';

type ParsedBlueprint = ReturnType<typeof Blueprint.parse>;

function element(
  id: string,
  kind: string,
  shape: string,
  bounds: Record<string, unknown>,
  direction = 1,
): Record<string, unknown> {
  return { id, name: id, level: 'lv', kind, bounds, color: '#112233', shape, direction };
}

function box(min: number[], max: number[]): Record<string, unknown> {
  return { min, max };
}

function make(
  elements: readonly Record<string, unknown>[],
  clearances: readonly Record<string, unknown>[],
): ParsedBlueprint {
  return Blueprint.parse({
    id: 'bp',
    revision: 1,
    title: '测试',
    description: '测试',
    levels: [{ id: 'lv', name: 'L', elevation: 0 }],
    spaces: [],
    elements,
    clearances,
    notes: [],
  });
}

test('净空与实体面贴面按半开区间不算相交', () => {
  // 元素 [0,0,0)-[2,2,2) 与净空 [2,0,0)-[3,2,2) 只贴 x 面
  const touching = make(
    [element('el-wall', 'wall', 'box', box([0, 0, 0], [2, 2, 2]))],
    [{ id: 'cl', name: '净空', bounds: box([2, 0, 0], [3, 2, 2]), ignoreElementIds: [] }],
  );
  assert.equal(checkBlueprint(touching).status, 'pass');
  // 只差一格的净空（[3,2,2) 起）也不相交
  const corner = make(
    [element('el-wall', 'wall', 'box', box([0, 0, 0], [2, 2, 2]))],
    [{ id: 'cl', name: '净空', bounds: box([2, 2, 2], [3, 3, 3]), ignoreElementIds: [] }],
  );
  assert.equal(checkBlueprint(corner).status, 'pass');
});

test('净空未相交时通过，并报告检查数量', () => {
  const blueprint = make(
    [element('el-wall', 'wall', 'box', box([0, 0, 0], [1, 4, 4]))],
    [{ id: 'cl', name: '净空', bounds: box([10, 0, 0], [11, 4, 4]), ignoreElementIds: [] }],
  );
  const report = checkBlueprint(blueprint);
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.issues, []);
  assert.equal(report.checkedClearances, 1);
});

test('墙体侵入净空报问题，elementIds 指向该实体', () => {
  const blueprint = make(
    [element('el-wall', 'wall', 'box', box([0, 0, 0], [2, 2, 2]))],
    [{ id: 'cl', name: '净空', bounds: box([1, 1, 1], [3, 3, 3]), ignoreElementIds: [] }],
  );
  const report = checkBlueprint(blueprint);
  assert.equal(report.status, 'issues');
  assert.equal(report.issues.length, 1);
  const issue = report.issues[0];
  assert.ok(issue);
  assert.equal(issue.code, 'clearance-intrusion');
  assert.deepEqual(issue.elementIds, ['el-wall']);
  assert.match(issue.message, /净空 cl（净空）被 el-wall 侵入/);
});

test('marker 是标注点不参与，仅 marker 落在净空内时仍通过', () => {
  const blueprint = make(
    [element('el-mark', 'marker', 'box', box([1, 1, 1], [2, 2, 2]))],
    [{ id: 'cl', name: '净空', bounds: box([0, 0, 0], [4, 4, 4]), ignoreElementIds: [] }],
  );
  const report = checkBlueprint(blueprint);
  assert.equal(report.status, 'pass');
});

test('ignoreElementIds 里的实体不参与判定', () => {
  const blueprint = make(
    [element('el-wall', 'wall', 'box', box([1, 1, 1], [2, 2, 2]))],
    [{ id: 'cl', name: '净空', bounds: box([0, 0, 0], [4, 4, 4]), ignoreElementIds: ['el-wall'] }],
  );
  assert.equal(checkBlueprint(blueprint).status, 'pass');
});

test('楔体按包围盒保守判定并在消息里注明', () => {
  // 楔体实际只占包围盒一部分，按保守口径仍应报出，并带"保守判定"说明
  const blueprint = make(
    [element('el-wedge', 'slab', 'wedge-x', box([0, 0, 0], [3, 3, 3]))],
    [{ id: 'cl', name: '净空', bounds: box([2, 2, 2], [4, 4, 4]), ignoreElementIds: [] }],
  );
  const report = checkBlueprint(blueprint);
  assert.equal(report.status, 'issues');
  const issue = report.issues[0];
  assert.ok(issue);
  assert.deepEqual(issue.elementIds, ['el-wedge']);
  assert.match(issue.message, /楔体 el-wedge 按包围盒保守判定/);
});

test('旋转薄壳 lathe 按包围盒保守判定，消息注明不承诺精确外形', () => {
  const blueprint = make(
    [
      {
        id: 'el-lathe',
        name: '旋转壳',
        level: 'lv',
        kind: 'slab',
        bounds: box([0, 0, 0], [4, 8, 4]),
        color: '#112233',
        shape: 'lathe',
        direction: 1,
        profile: { kind: 'linear', curvature: 0, heightSegments: 8, radialSegments: 8 },
      },
    ],
    [{ id: 'cl', name: '净空', bounds: box([3, 3, 3], [5, 5, 5]), ignoreElementIds: [] }],
  );
  const report = checkBlueprint(blueprint);
  assert.equal(report.status, 'issues');
  const issue = report.issues[0];
  assert.ok(issue);
  assert.deepEqual(issue.elementIds, ['el-lathe']);
  assert.match(issue.message, /旋转薄壳 el-lathe 按包围盒保守判定，不承诺精确外形/);
});

test('地表景观（landscape）是实体，参与判定', () => {
  const blueprint = make(
    [element('el-hill', 'landscape', 'box', box([0, 0, 0], [5, 5, 5]))],
    [{ id: 'cl', name: '净空', bounds: box([1, 1, 1], [2, 2, 2]), ignoreElementIds: [] }],
  );
  const report = checkBlueprint(blueprint);
  assert.equal(report.status, 'issues');
  assert.deepEqual(report.issues[0]?.elementIds, ['el-hill']);
});

test('墙 / 板 / 台阶 / 家具 / glazing / landscape 都参与判定', () => {
  const kinds = ['wall', 'slab', 'stair', 'furnishing', 'glazing', 'landscape'];
  for (const kind of kinds) {
    const blueprint = make(
      [element(`el-${kind}`, kind, 'box', box([1, 1, 1], [2, 2, 2]))],
      [{ id: 'cl', name: '净空', bounds: box([0, 0, 0], [3, 3, 3]), ignoreElementIds: [] }],
    );
    const report = checkBlueprint(blueprint);
    assert.equal(report.status, 'issues', `${kind} 应当参与判定`);
    assert.deepEqual(report.issues[0]?.elementIds, [`el-${kind}`]);
  }
});

test('多个侵入元素的 elementIds 按 id 排序', () => {
  const blueprint = make(
    [
      element('el-b', 'wall', 'box', box([0, 0, 0], [2, 2, 2])),
      element('el-a', 'furnishing', 'box', box([1, 1, 1], [3, 3, 3])),
      element('el-c', 'glazing', 'box', box([100, 100, 100], [101, 101, 101])),
    ],
    [{ id: 'cl', name: '净空', bounds: box([0, 0, 0], [4, 4, 4]), ignoreElementIds: [] }],
  );
  const report = checkBlueprint(blueprint);
  assert.deepEqual(report.issues[0]?.elementIds, ['el-a', 'el-b']);
});

test('没有净空时通过且 checkedClearances 为 0', () => {
  const blueprint = make([], []);
  const report = checkBlueprint(blueprint);
  assert.equal(report.status, 'pass');
  assert.equal(report.checkedClearances, 0);
});
