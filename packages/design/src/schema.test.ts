/** schema 的好坏样本：字段范围、严格对象、id 唯一性与跨集合引用；不测几何与差异。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod';

import { Blueprint, Bounds, Element, Vec3 } from './schema.ts';

/** 一份合法方案；测试用 spread / map 派生坏样本，不改动返回值本身。 */
function base() {
  return {
    id: 'bp-plaza',
    revision: 1,
    title: '地下综合体',
    description: '测试用方案',
    levels: [
      { id: 'lv-street', name: '街面', elevation: 0 },
      { id: 'lv-cinema', name: '地下影院', elevation: 1 },
    ],
    spaces: [
      {
        id: 'sp-shop',
        name: '衣服店',
        level: 'lv-street',
        bounds: { min: [0, 0, 0], max: [4, 4, 4] },
        role: 'room',
        color: '#aabbcc',
      },
    ],
    elements: [
      {
        id: 'el-wall',
        name: '西墙',
        level: 'lv-cinema',
        kind: 'wall',
        bounds: { min: [0, 0, 0], max: [1, 4, 4] },
        color: '#334455',
        shape: 'box',
        direction: 1,
        spaceId: 'sp-shop',
      },
      {
        id: 'el-marker',
        name: '入口标记',
        level: 'lv-street',
        kind: 'marker',
        bounds: { min: [1, 1, 1], max: [2, 2, 2] },
        color: '#ff0000',
        shape: 'box',
        direction: -1,
      },
    ],
    clearances: [
      {
        id: 'cl-door',
        name: '门洞净空',
        bounds: { min: [0, 0, 0], max: [1, 3, 3] },
        ignoreElementIds: ['el-wall'],
      },
    ],
    notes: ['净空为人工示例'],
  };
}

/** 把第一个元素替换成打了 patch 的副本，其余保持不变。 */
function patchFirstElement(patch: Record<string, unknown>): unknown {
  const blueprint = base();
  return {
    ...blueprint,
    elements: blueprint.elements.map((element, index) => (index === 0 ? { ...element, ...patch } : element)),
  };
}

function parseFailure(value: unknown): string {
  const result = Blueprint.safeParse(value);
  if (result.success) throw new Error('期望解析失败，但解析通过了');
  return z.prettifyError(result.error);
}

test('合法方案解析通过，类型只读且运行时冻结', () => {
  const blueprint = Blueprint.parse(base());
  assert.equal(blueprint.levels.length, 2);
  assert.equal(blueprint.elements[1]?.kind, 'marker');
  assert.equal(Object.isFrozen(blueprint), true);
  assert.equal(Object.isFrozen(blueprint.elements), true);
  assert.equal(Object.isFrozen(blueprint.elements[0]?.bounds.min), true);
});

test('Vec3 只接受三元整数，拒绝浮点 / 无穷 / NaN / 非安全整数 / 长度错误', () => {
  assert.deepEqual(Vec3.parse([1, -2, 3]), [1, -2, 3]);
  for (const bad of [
    [1, 2],
    [1, 2, 3, 4],
    [1.5, 2, 3],
    [1, Infinity, 3],
    [1, -Infinity, 3],
    [1, NaN, 3],
    [1, 2 ** 60, 3],
  ]) {
    assert.equal(Vec3.safeParse(bad).success, false, `应当拒绝 ${JSON.stringify(bad)}`);
  }
});

test('Bounds 每轴 max 必须严格大于 min，面贴面或反向都拒绝', () => {
  assert.equal(Bounds.safeParse({ min: [0, 0, 0], max: [1, 1, 1] }).success, true);
  for (const bad of [
    { min: [0, 0, 0], max: [0, 1, 1] },
    { min: [0, 0, 0], max: [1, 0, 1] },
    { min: [0, 0, 0], max: [1, 1, 0] },
    { min: [2, 0, 0], max: [1, 1, 1] },
  ]) {
    assert.equal(Bounds.safeParse(bad).success, false, `应当拒绝 ${JSON.stringify(bad)}`);
  }
});

test('元素类别 / 形体 / 方向 / 颜色只接受登记取值', () => {
  assert.match(parseFailure(patchFirstElement({ kind: 'column' })), /kind/);
  assert.match(parseFailure(patchFirstElement({ shape: 'sphere' })), /shape/);
  assert.match(parseFailure(patchFirstElement({ direction: 0 })), /direction/);
  assert.match(parseFailure(patchFirstElement({ color: '#abc' })), /颜色/);
  assert.match(parseFailure(patchFirstElement({ color: 'red' })), /颜色/);
  // 大小写六位是合法的
  assert.equal(Blueprint.safeParse(patchFirstElement({ color: '#AABBCC' })).success, true);
});

test('四个集合内的 id 各自唯一，重复即报错', () => {
  const levels = base();
  assert.match(
    parseFailure({ ...levels, levels: [...levels.levels, { id: 'lv-street', name: '重复', elevation: 2 }] }),
    /楼层 id 重复：lv-street/,
  );

  const spaces = base();
  assert.match(
    parseFailure({
      ...spaces,
      spaces: [
        ...spaces.spaces,
        {
          id: 'sp-shop',
          name: '重复',
          level: 'lv-street',
          bounds: { min: [0, 0, 0], max: [1, 1, 1] },
          role: 'room',
          color: '#000000',
        },
      ],
    }),
    /空间 id 重复：sp-shop/,
  );

  const elements = base();
  assert.match(
    parseFailure({ ...elements, elements: [...elements.elements, ...elements.elements.slice(0, 1)] }),
    /元素 id 重复：el-wall/,
  );

  const clearances = base();
  assert.match(
    parseFailure({
      ...clearances,
      clearances: [
        ...clearances.clearances,
        { id: 'cl-door', name: '重复', bounds: { min: [5, 5, 5], max: [6, 6, 6] }, ignoreElementIds: [] },
      ],
    }),
    /净空 id 重复：cl-door/,
  );
});

test('跨集合引用必须能解析：未知 level / space / ignore 元素都拒绝', () => {
  assert.match(parseFailure(patchFirstElement({ level: 'lv-missing' })), /引用了不存在的楼层 lv-missing/);
  assert.match(parseFailure(patchFirstElement({ spaceId: 'sp-missing' })), /引用了不存在的空间 sp-missing/);

  const clearances = base();
  assert.match(
    parseFailure({
      ...clearances,
      clearances: clearances.clearances.map((clearance) => ({
        ...clearance,
        ignoreElementIds: ['el-wall', 'el-missing'],
      })),
    }),
    /忽略了不存在的元素 el-missing/,
  );
});

test('严格对象：未知字段不被静默丢弃', () => {
  assert.match(parseFailure({ ...base(), surprise: 1 }), /surprise/);
  assert.match(parseFailure(patchFirstElement({ thickness: 2 })), /thickness/);
});

test('字符串非空有上限、数组有上限、楼层非空', () => {
  assert.equal(Blueprint.safeParse({ ...base(), id: '' }).success, false);
  assert.equal(Blueprint.safeParse({ ...base(), notes: ['x'.repeat(1001)] }).success, false);
  assert.equal(
    Blueprint.safeParse({ ...base(), notes: Array.from({ length: 101 }, (_, i) => `note-${String(i)}`) }).success,
    false,
  );
  assert.equal(Blueprint.safeParse({ ...base(), levels: [] }).success, false);
});

/** 合法的 lathe profile；测试用 spread 派生坏样本。 */
const LATHE_PROFILE = { kind: 'linear', curvature: 0, heightSegments: 24, radialSegments: 48 };

/** 一个合法 lathe 元素；patch 覆盖顶层字段（含整个 profile）。 */
function latheElement(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'el-lathe',
    name: '旋转壳',
    level: 'lv-street',
    kind: 'slab',
    bounds: { min: [-4, 12, -4], max: [4, 36, 4] },
    color: '#8d949b',
    shape: 'lathe',
    direction: 1,
    profile: { ...LATHE_PROFILE },
    ...patch,
  };
}

function elementFailure(value: unknown): string {
  const result = Element.safeParse(value);
  if (result.success) throw new Error('期望解析失败，但解析通过了');
  return z.prettifyError(result.error);
}

test('新增 lathe 后原 schema 兼容：box / wedge 元素不要求 profile', () => {
  const blueprint = Blueprint.parse(base());
  const first = blueprint.elements[0];
  assert.ok(first);
  assert.equal(first.shape, 'box');
  assert.equal(first.profile, undefined);
  const box = latheElement({ shape: 'box' });
  delete box['profile'];
  assert.equal(Element.safeParse(box).success, true);
  const wedge = latheElement({ shape: 'wedge-x', direction: -1 });
  delete wedge['profile'];
  assert.equal(Element.safeParse(wedge).success, true);
});

test('lathe 必须带 profile，其他 shape 禁止 profile', () => {
  assert.equal(Element.safeParse(latheElement()).success, true);
  const missing = latheElement();
  delete missing['profile'];
  assert.match(elementFailure(missing), /profile/);
  assert.match(elementFailure(latheElement({ shape: 'box' })), /profile/);
  assert.match(elementFailure(latheElement({ shape: 'wedge-z' })), /profile/);
});

test('lathe profile：kind 与 curvature 匹配、整数范围，分段边界双向', () => {
  const cases: readonly (readonly [Record<string, unknown>, RegExp])[] = [
    [{ kind: 'cosine' }, /kind/],
    [{ kind: 'linear', curvature: 1 }, /curvature/],
    [{ kind: 'reciprocal', curvature: 0 }, /curvature/],
    [{ curvature: -1 }, /curvature/],
    [{ curvature: 21 }, /curvature/],
    [{ curvature: 1.5 }, /curvature/],
    [{ heightSegments: 3 }, /heightSegments/],
    [{ heightSegments: 129 }, /heightSegments/],
    [{ heightSegments: 4.5 }, /heightSegments/],
    [{ radialSegments: 7 }, /radialSegments/],
    [{ radialSegments: 129 }, /radialSegments/],
    [{ radialSegments: 8.5 }, /radialSegments/],
  ];
  for (const [patch, pattern] of cases) {
    assert.match(elementFailure(latheElement({ profile: { ...LATHE_PROFILE, ...patch } })), pattern);
  }
  // 边界取值合法：reciprocal 曲率上限 20、分段下限 4/8
  assert.equal(
    Element.safeParse(
      latheElement({ profile: { kind: 'reciprocal', curvature: 20, heightSegments: 4, radialSegments: 8 } }),
    ).success,
    true,
  );
  // linear 曲率固定 0、分段上限 128
  assert.equal(
    Element.safeParse(
      latheElement({ profile: { kind: 'linear', curvature: 0, heightSegments: 128, radialSegments: 128 } }),
    ).success,
    true,
  );
});

test('lathe profile 是严格对象，未知字段拒绝', () => {
  assert.match(elementFailure(latheElement({ profile: { ...LATHE_PROFILE, width: 2 } })), /width/);
});

test('lathe 要求 x/z 跨度相等且偶数、direction=1', () => {
  // 跨度 10 偶数、轴在整数中心：合法
  assert.equal(Element.safeParse(latheElement({ bounds: { min: [-5, 12, -5], max: [5, 36, 5] } })).success, true);
  // x / z 跨度不等
  assert.match(elementFailure(latheElement({ bounds: { min: [-4, 12, -6], max: [4, 36, 6] } })), /相等/);
  // 跨度 9 为奇数
  assert.match(elementFailure(latheElement({ bounds: { min: [-5, 12, -5], max: [4, 36, 4] } })), /偶数/);
  // 轴方向必须沿 y 正向
  assert.match(elementFailure(latheElement({ direction: -1 })), /direction/);
});
