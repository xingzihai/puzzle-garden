/**
 * scene.ts 的单元测试：响应窄化、几何包围盒与楔体方向、可见性、剖切面、修改高亮。
 *
 * 用 three 在 Node 里建几何与场景（不需要 WebGL）；用 JSON 往返模拟服务端响应。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import type { Element, Space } from '@pg/design/schema';

import {
  applyLevelDisplay,
  blueprintBounds,
  buildMassingScene,
  clipPlaneFor,
  clipValueRange,
  displayPlanes,
  elementGeometry,
  elementInLevelRange,
  elementLevelPlanes,
  elementSize,
  firstSelectable,
  HIGHLIGHT_COLOR,
  highlightedIds,
  levelDisplay,
  parseBlueprint,
  parseBlueprints,
  setHighlighted,
  spaceInLevelRange,
  visibleBounds,
  wedgeVertices,
} from './scene.ts';
import type { LevelDisplay, ViewerBlueprint } from './scene.ts';

function boxElement(overrides: Partial<Element> = {}): Element {
  return {
    id: 'el-box',
    name: '盒子',
    level: 'b1',
    kind: 'wall',
    bounds: { min: [0, 0, 0], max: [2, 3, 4] },
    color: '#aabbcc',
    shape: 'box',
    direction: 1,
    ...overrides,
  };
}

function space(overrides: Partial<Space> = {}): Space {
  return {
    id: 'sp-1',
    name: '空间',
    level: 'b1',
    bounds: { min: [0, 0, 0], max: [1, 2, 1] },
    role: 'room',
    color: '#ddeeff',
    ...overrides,
  };
}

function blueprintOf(elements: readonly Element[], spaces: readonly Space[] = []): ViewerBlueprint {
  return {
    id: 'bp-test',
    title: '测试方案',
    description: '用于单测',
    levels: [
      { id: 'surface', name: '地表', elevation: 0 },
      { id: 'b1', name: '地下一层', elevation: -8 },
      { id: 'b2', name: '地下二层', elevation: -16 },
    ],
    spaces,
    elements,
    notes: ['单测样例'],
  };
}

function rawElement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'el-1',
    name: '墙',
    level: 'b1',
    kind: 'wall',
    bounds: { min: [0, 0, 0], max: [1, 2, 3] },
    color: '#aabbcc',
    shape: 'wedge-x',
    direction: -1,
    ...overrides,
  };
}

function rawWithElement(element: unknown): Record<string, unknown> {
  return {
    id: 'bp-test',
    title: '测试方案',
    description: '用于单测',
    levels: [{ id: 'b1', name: '地下一层', elevation: -8 }],
    spaces: [],
    elements: [element],
    notes: ['说明'],
  };
}

/** 经字符串往返，模拟服务端发出的纯 JSON。 */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test('parseBlueprint 接受合法 JSON 并保留字段', () => {
  const parsed = parseBlueprint(asJson(rawWithElement(rawElement())));
  assert.equal(parsed.id, 'bp-test');
  assert.equal(parsed.elements.length, 1);
  const element = parsed.elements.at(0);
  assert.ok(element !== undefined);
  assert.equal(element.id, 'el-1');
  assert.equal(element.shape, 'wedge-x');
  assert.equal(element.direction, -1);
  assert.deepEqual(element.bounds.min, [0, 0, 0]);
  assert.deepEqual(parsed.notes, ['说明']);
});

test('parseBlueprint 对坏样本报可读错误', () => {
  assert.throws(() => parseBlueprint(null), /蓝图 必须是对象/);
  assert.throws(() => parseBlueprint({}), /蓝图\.id 必须是非空字符串/);
  assert.throws(
    () => parseBlueprint({ id: 'x', title: 't', description: 'd', levels: 'no', spaces: [], elements: [], notes: [] }),
    /蓝图\.levels 必须是数组/,
  );
  assert.throws(
    () => parseBlueprint(rawWithElement(rawElement({ bounds: { min: [0, 0, 0], max: [0, 2, 3] } }))),
    /max 严格大于 min/,
  );
  assert.throws(() => parseBlueprint(rawWithElement(rawElement({ shape: 'sphere' }))), /shape 取值非法/);
  assert.throws(() => parseBlueprint(rawWithElement(rawElement({ direction: 0 }))), /direction 必须是 1 或 -1/);
  // 坐标必须是整数（schema 的 z.int()），颜色必须是 #rrggbb：声明为 Element 就要按同口径校验。
  assert.throws(
    () => parseBlueprint(rawWithElement(rawElement({ bounds: { min: [0.5, 0, 0], max: [1, 2, 3] } }))),
    /必须是整数/,
  );
  assert.throws(() => parseBlueprint(rawWithElement(rawElement({ color: 'red' }))), /#rrggbb/);
});

test('parseBlueprint 解析空间与可选 spaceId，拒绝非法角色', () => {
  const raw = rawWithElement(rawElement({ spaceId: 'sp-1' }));
  raw['spaces'] = [
    {
      id: 'sp-1',
      name: '空间',
      level: 'b1',
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      role: 'room',
      color: '#ddeeff',
    },
  ];
  const parsed = parseBlueprint(asJson(raw));
  assert.equal(parsed.elements.at(0)?.spaceId, 'sp-1');
  assert.equal(parsed.spaces.at(0)?.role, 'room');
  assert.equal(parseBlueprint(asJson(rawWithElement(rawElement()))).elements.at(0)?.spaceId, undefined);
  raw['spaces'] = [
    {
      id: 'sp-1',
      name: '空间',
      level: 'b1',
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      role: 'lobby',
      color: '#ddeeff',
    },
  ];
  assert.throws(() => parseBlueprint(asJson(raw)), /role 取值非法/);
});

test('parseBlueprints 只接受数组', () => {
  assert.throws(() => parseBlueprints({}), /蓝图列表 必须是数组/);
  const list = parseBlueprints([asJson(rawWithElement(rawElement()))]);
  assert.equal(list.length, 1);
});

test('parseBlueprint：lathe 保留 profile，未知 shape 与坏 profile 都拒绝', () => {
  const lathe = rawElement({
    shape: 'lathe',
    direction: 1,
    bounds: { min: [-16, 0, -16], max: [16, 24, 16] },
    profile: { kind: 'reciprocal', curvature: 2, heightSegments: 24, radialSegments: 48 },
  });
  const parsed = parseBlueprint(asJson(rawWithElement(lathe)));
  const element = parsed.elements.at(0);
  assert.ok(element !== undefined);
  assert.equal(element.shape, 'lathe');
  assert.deepEqual(element.profile, { kind: 'reciprocal', curvature: 2, heightSegments: 24, radialSegments: 48 });
  // lathe 缺 profile 不是静默回退 wedge，而是直接报错。
  assert.throws(
    () => parseBlueprint(rawWithElement(rawElement({ shape: 'lathe', direction: 1 }))),
    /profile 必须是对象/,
  );
  assert.throws(
    () =>
      parseBlueprint(
        rawWithElement(
          rawElement({
            shape: 'lathe',
            direction: 1,
            profile: { kind: 'linear', curvature: 2, heightSegments: 24, radialSegments: 48 },
          }),
        ),
      ),
    /linear 时必须为 0/,
  );
  assert.throws(() => parseBlueprint(rawWithElement(rawElement({ shape: 'sphere' }))), /shape 取值非法/);
});

test('blueprintBounds 取元素与空间的并集，空方案回退', () => {
  const bounds = blueprintBounds(
    blueprintOf(
      [boxElement({ bounds: { min: [-2, -8, 0], max: [4, -2, 9] } })],
      [space({ bounds: { min: [-6, -8, -3], max: [1, 0, 2] } })],
    ),
  );
  assert.deepEqual(bounds.min, [-6, -8, -3]);
  assert.deepEqual(bounds.max, [4, 0, 9]);
  assert.deepEqual(blueprintBounds(blueprintOf([], [])), { min: [0, 0, 0], max: [1, 1, 1] });
});

test('elementSize 返回三轴长度', () => {
  assert.deepEqual(elementSize(boxElement({ bounds: { min: [1, 2, 3], max: [4, 6, 10] } })), [3, 4, 7]);
});

test('levelDisplay：具体楼层取 [floor, 上一层)，最高层到 maxY，all 隐藏地表只留地下', () => {
  const levels = blueprintOf([]).levels;
  const b1 = levelDisplay(levels, { level: 'b1', showSurface: false }, 1);
  assert.deepEqual(b1.range, { floor: -8, top: 0 });
  assert.equal(b1.planFloor, -8);
  assert.deepEqual(levelDisplay(levels, { level: 'b2', showSurface: false }, 1).range, { floor: -16, top: -8 });
  assert.deepEqual(levelDisplay(levels, { level: 'surface', showSurface: true }, 9).range, { floor: 0, top: 9 });
  const hidden = levelDisplay(levels, { level: 'all', showSurface: false }, 9);
  assert.equal(hidden.range.floor, Number.NEGATIVE_INFINITY);
  assert.equal(hidden.range.top, 0);
  assert.equal(hidden.planFloor, null);
  assert.equal(levelDisplay(levels, { level: 'all', showSurface: true }, 9).range.top, Number.POSITIVE_INFINITY);
  assert.throws(() => levelDisplay(levels, { level: 'b9', showSurface: false }, 9), /未知楼层/);
});

test('levelDisplay：缺少 surface 时隐藏地表用最高标高，空楼层回退 0', () => {
  const levels = [
    { id: 'b1', name: '一层', elevation: -8 },
    { id: 'b2', name: '二层', elevation: -16 },
  ];
  assert.equal(levelDisplay(levels, { level: 'all', showSurface: false }, 5).range.top, -8);
  assert.equal(levelDisplay([], { level: 'all', showSurface: false }, 5).range.top, 0);
});

test('elementInLevelRange：跨层墙每层都在，本层楼板保留、上层楼板排除', () => {
  const levels = blueprintOf([]).levels;
  const b1 = levelDisplay(levels, { level: 'b1', showSurface: false }, 1);
  const wall = boxElement({ id: 'el-wall', level: 'b3', bounds: { min: [0, -24, 0], max: [1, -2, 1] } });
  assert.equal(elementInLevelRange(wall, b1), true);
  const ownSlab = boxElement({ kind: 'slab', level: 'b1', bounds: { min: [0, -9, 0], max: [10, -8, 10] } });
  assert.equal(elementInLevelRange(ownSlab, b1), true);
  const upperCover = boxElement({ kind: 'landscape', level: 'surface', bounds: { min: [0, -2, 0], max: [10, 0, 10] } });
  assert.equal(elementInLevelRange(upperCover, b1), false);
  const b3Slab = boxElement({ kind: 'slab', level: 'b3', bounds: { min: [0, -25, 0], max: [10, -24, 10] } });
  assert.equal(elementInLevelRange(b3Slab, b1), false);
});

test('旋转屋顶在最高层仍显示，不当成上层水平盖板移除', () => {
  const roof = boxElement({
    kind: 'slab',
    shape: 'lathe',
    level: 'roof',
    bounds: { min: [-16, 12, -16], max: [16, 36, 16] },
    profile: { kind: 'reciprocal', curvature: 2, heightSegments: 24, radialSegments: 48 },
  });
  const view = levelDisplay(
    [
      { id: 'surface', name: '地面', elevation: 0 },
      { id: 'roof', name: '屋顶', elevation: 12 },
    ],
    { level: 'roof', showSurface: true },
    36,
  );
  assert.equal(elementInLevelRange(roof, view), true);
});

test('all 隐藏地表：保留地下入口梯，隐藏地表顶盖与地上构件', () => {
  const hidden = levelDisplay(blueprintOf([]).levels, { level: 'all', showSurface: false }, 9);
  const stair = boxElement({ kind: 'stair', level: 'surface', bounds: { min: [0, -9, 0], max: [1, 0, 1] } });
  assert.equal(elementInLevelRange(stair, hidden), true);
  const cover = boxElement({ kind: 'landscape', level: 'surface', bounds: { min: [0, -2, 0], max: [10, 0, 10] } });
  assert.equal(elementInLevelRange(cover, hidden), false);
  const lion = boxElement({ kind: 'furnishing', level: 'surface', bounds: { min: [0, 0, 0], max: [1, 2, 1] } });
  assert.equal(elementInLevelRange(lion, hidden), false);
});

test('elementLevelPlanes：非楼板按区间上下裁剪，本层楼板不含下边界', () => {
  const b1 = levelDisplay(blueprintOf([]).levels, { level: 'b1', showSurface: false }, 1);
  const wall = boxElement({ bounds: { min: [0, -24, 0], max: [1, -2, 1] } });
  const planes = elementLevelPlanes(wall, b1);
  assert.equal(planes.length, 2);
  assert.equal(planes[0]?.distanceToPoint(new THREE.Vector3(0, -7, 0)), 1);
  assert.equal(planes[1]?.distanceToPoint(new THREE.Vector3(0, -1, 0)), 1);
  const slab = boxElement({ kind: 'slab', bounds: { min: [0, -9, 0], max: [10, -8, 10] } });
  const slabPlanes = elementLevelPlanes(slab, b1);
  assert.equal(slabPlanes.length, 1);
  assert.ok((slabPlanes[0]?.distanceToPoint(new THREE.Vector3(0, -9, 0)) ?? -1) >= 0);
});

test('displayPlanes：具体楼层两个平面，all 隐藏地表只有一个顶部平面', () => {
  const levels = blueprintOf([]).levels;
  assert.equal(displayPlanes(levelDisplay(levels, { level: 'b1', showSurface: false }, 1)).length, 2);
  assert.equal(displayPlanes(levelDisplay(levels, { level: 'all', showSurface: false }, 9)).length, 1);
  assert.equal(displayPlanes(levelDisplay(levels, { level: 'all', showSurface: true }, 9)).length, 0);
});

test('spaceInLevelRange 按区间与地表状态过滤空间盒', () => {
  const levels = blueprintOf([]).levels;
  const b1 = levelDisplay(levels, { level: 'b1', showSurface: false }, 1);
  assert.equal(spaceInLevelRange(space({ bounds: { min: [0, -8, 0], max: [4, -2, 4] } }), b1), true);
  assert.equal(spaceInLevelRange(space({ bounds: { min: [0, 0, 0], max: [4, 1, 4] } }), b1), false);
  assert.equal(spaceInLevelRange(space({ bounds: { min: [0, -24, 0], max: [4, -2, 4] } }), b1), true);
  // surface 空间在不看地表时隐藏（即使几何落到地下区间）。
  const park = space({ level: 'surface', bounds: { min: [0, -2, 0], max: [176, 0, 160] } });
  assert.equal(spaceInLevelRange(park, b1), false);
  assert.equal(spaceInLevelRange(park, levelDisplay(levels, { level: 'all', showSurface: false }, 8)), false);
  assert.equal(spaceInLevelRange(park, levelDisplay(levels, { level: 'all', showSurface: true }, 8)), true);
  // surface 视图按“顶面 = planFloor”保留公园空间盒。
  assert.equal(spaceInLevelRange(park, levelDisplay(levels, { level: 'surface', showSurface: false }, 8)), true);
});

test('visibleBounds 只取当前显示的元素，隐藏地表不计入，跨层元素按区间裁剪', () => {
  const surface = boxElement({
    id: 'el-park',
    level: 'surface',
    bounds: { min: [-50, 0, -50], max: [200, 1, 200] },
  });
  // 挑高墙：y -24..-2，进 b1 视图后只应算到 b1 区间内。
  const wall = boxElement({ id: 'el-wall', level: 'b3', bounds: { min: [4, -24, 8], max: [164, -2, 153] } });
  const bp = blueprintOf([surface, wall], [space({ bounds: { min: [0, -30, 0], max: [10, 0, 10] } })]);
  const display = (level: string, showSurface: boolean): LevelDisplay =>
    levelDisplay(bp.levels, { level, showSurface }, 1);

  const hiddenSurface = visibleBounds(bp, display('all', false), false);
  assert.deepEqual(hiddenSurface.min, [4, -24, 8]);
  assert.deepEqual(hiddenSurface.max, [164, -2, 153]);

  const withSurface = visibleBounds(bp, display('all', true), false);
  assert.deepEqual(withSurface.min, [-50, -24, -50]);
  assert.deepEqual(withSurface.max, [200, 1, 200]);

  const withSpaces = visibleBounds(bp, display('all', false), true);
  assert.deepEqual(withSpaces.min, [0, -30, 0]);

  // b1 视图：地表不在范围内，挑高墙裁剪到 [-8, 0)。
  const b1 = visibleBounds(bp, display('b1', true), false);
  assert.deepEqual(b1.min, [4, -8, 8]);
  assert.deepEqual(b1.max, [164, -2, 153]);

  // 显示集合为空时回退到整份方案，不会得到退化包围盒。
  const empty = visibleBounds(blueprintOf([surface]), display('b1', false), false);
  assert.deepEqual(empty.min, [-50, 0, -50]);
});

test('clipValueRange 返回剖切轴区间', () => {
  const bounds = { min: [-5, -24, 0] as const, max: [176, 0, 160] as const };
  assert.deepEqual(clipValueRange(bounds, 'none'), [0, 1]);
  assert.deepEqual(clipValueRange(bounds, 'x'), [-5, 176]);
  assert.deepEqual(clipValueRange(bounds, 'y'), [-24, 0]);
  assert.deepEqual(clipValueRange(bounds, 'z'), [0, 160]);
});

test('clipPlaneFor 保留坐标 ≤ value 的一侧', () => {
  assert.equal(clipPlaneFor('none', 3), null);
  const plane = clipPlaneFor('x', 10);
  assert.notEqual(plane, null);
  if (plane === null) return;
  assert.deepEqual([plane.normal.x, plane.normal.y, plane.normal.z], [-1, 0, 0]);
  assert.equal(plane.constant, 10);
  assert.ok(plane.distanceToPoint(new THREE.Vector3(4, 0, 0)) > 0);
  assert.ok(plane.distanceToPoint(new THREE.Vector3(16, 0, 0)) < 0);
});

function hit(object: THREE.Object3D, point: readonly [number, number, number], distance: number): THREE.Intersection {
  return { distance, point: new THREE.Vector3(point[0], point[1], point[2]), object };
}

/** 按对象名回查元素网格再读材质剖切面，模拟 main.ts 的 planesPerObject 回调。 */
function planesOf(byId: ReadonlyMap<string, THREE.Mesh>): (object: THREE.Object3D) => readonly THREE.Plane[] {
  return (object) => {
    const mesh = byId.get(object.name);
    if (mesh === undefined) return [];
    const material = mesh.material;
    const materials = Array.isArray(material) ? material : [material];
    return materials.flatMap((entry) => (Array.isArray(entry.clippingPlanes) ? entry.clippingPlanes : []));
  };
}

test('firstSelectable 跳过隐藏网格与任一剖切面外侧的命中', () => {
  const hidden = new THREE.Mesh();
  hidden.visible = false;
  const visibleA = new THREE.Mesh();
  const visibleB = new THREE.Mesh();
  const xPlane = clipPlaneFor('x', 5); // 保留 x ≤ 5
  const planes = xPlane === null ? [] : [xPlane];
  const isVisible = (object: THREE.Object3D): boolean => object.visible;
  const withX = (): readonly THREE.Plane[] => planes;
  const none = (): readonly THREE.Plane[] => [];

  // 隐藏的最近命中被跳过，返回可见的那个。
  assert.equal(
    firstSelectable([hit(hidden, [3, 0, 0], 1), hit(visibleA, [3, 0, 0], 2)], isVisible, withX)?.object,
    visibleA,
  );
  // 所有命中都隐藏 → 不可选中。
  assert.equal(firstSelectable([hit(hidden, [3, 0, 0], 1)], isVisible, withX), null);
  // 被剖掉一侧（x>5）的命中跳过，返回保留侧的命中。
  assert.equal(
    firstSelectable([hit(visibleA, [10, 0, 0], 1), hit(visibleB, [4, 0, 0], 2)], isVisible, withX)?.object,
    visibleB,
  );
  // 多个平面都要通过：第二片保留 y ≤ 0，y=2 的命中被跳过。
  const bothPlanes = [...planes, clipPlaneFor('y', 0)].filter((plane): plane is THREE.Plane => plane !== null);
  assert.equal(
    firstSelectable([hit(visibleA, [3, 2, 0], 1), hit(visibleB, [3, 0, 0], 2)], isVisible, () => bothPlanes)?.object,
    visibleB,
  );
  // 没有保留侧命中 → 不可选中。
  assert.equal(firstSelectable([hit(visibleA, [10, 0, 0], 1)], isVisible, withX), null);
  // 不剖切时取第一个可见命中。
  assert.equal(
    firstSelectable([hit(hidden, [3, 0, 0], 1), hit(visibleA, [10, 0, 0], 2)], isVisible, none)?.object,
    visibleA,
  );
});

test('firstSelectable 用各对象材质实际剖切面：本层楼板豁免下边界，隐藏/剖切淘汰', () => {
  const wall = boxElement({ id: 'el-wall', level: 'b3', bounds: { min: [0, -24, 0], max: [1, -2, 1] } });
  const slab = boxElement({ id: 'el-slab', kind: 'slab', level: 'b1', bounds: { min: [0, -9, 0], max: [10, -8, 10] } });
  const hidden = boxElement({ id: 'el-b2', level: 'b2', bounds: { min: [0, -17, 0], max: [1, -16, 1] } });
  const bp = blueprintOf([wall, slab, hidden]);
  const built = buildMassingScene(bp);
  // b1 + 轴向 x≤5：墙被上下裁剪，楼板豁免下边界，b2 隐藏。
  const b1 = levelDisplay(bp.levels, { level: 'b1', showSurface: false }, 1);
  const axis = clipPlaneFor('x', 5);
  assert.notEqual(axis, null);
  if (axis === null) throw new Error('测试需要 x 剖切面');
  applyLevelDisplay(built, bp, b1, axis);

  const wallMesh = built.elementById.get('el-wall');
  const slabMesh = built.elementById.get('el-slab');
  const hiddenMesh = built.elementById.get('el-b2');
  assert.ok(wallMesh !== undefined && slabMesh !== undefined && hiddenMesh !== undefined);
  const isVisible = (object: THREE.Object3D): boolean => object.visible;
  const planesFor = planesOf(built.elementById);

  // 墙的 b1 段（y=-7, x=3）可选中；轴外（x=10）被淘汰。
  assert.equal(firstSelectable([hit(wallMesh, [3, -7, 0], 1)], isVisible, planesFor)?.object, wallMesh);
  assert.equal(firstSelectable([hit(wallMesh, [10, -7, 0], 1)], isVisible, planesFor), null);
  // 墙在 b1 区间以下（y=-9）被下边界淘汰。
  assert.equal(firstSelectable([hit(wallMesh, [3, -9, 0], 1)], isVisible, planesFor), null);
  // 本层楼板不受下边界约束：y=-9（板底）仍可选中。
  assert.equal(firstSelectable([hit(slabMesh, [3, -9, 0], 1)], isVisible, planesFor)?.object, slabMesh);
  // 被过滤隐藏的 b2 网格即使有命中也不可选。
  assert.equal(firstSelectable([hit(hiddenMesh, [0, -17, 0], 1)], isVisible, planesFor), null);
});

test('highlightedIds 启用时是修改∪新增，否则为空', () => {
  const diff = { added: ['a'], removed: ['r'], changed: ['c'], spacesChanged: ['s'] };
  assert.deepEqual([...highlightedIds(diff, true)].sort(), ['a', 'c']);
  assert.equal(highlightedIds(diff, false).size, 0);
});

function topYAt(vertices: readonly (readonly [number, number, number])[], axis: 0 | 2, coordinate: number): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const vertex of vertices) {
    if (vertex[axis] === coordinate && vertex[1] > best) best = vertex[1];
  }
  return best;
}

test('wedgeVertices：wedge-x 高端随 direction 落在两端', () => {
  const bounds = { min: [0, 0, 0] as const, max: [4, 3, 2] as const };
  const positive = wedgeVertices(bounds, 'wedge-x', 1);
  assert.equal(topYAt(positive, 0, 4), 3);
  assert.equal(topYAt(positive, 0, 0), 0);
  const negative = wedgeVertices(bounds, 'wedge-x', -1);
  assert.equal(topYAt(negative, 0, 0), 3);
  assert.equal(topYAt(negative, 0, 4), 0);
});

test('wedgeVertices：wedge-z 高端随 direction 落在两端', () => {
  const bounds = { min: [0, 0, 0] as const, max: [4, 3, 2] as const };
  const positive = wedgeVertices(bounds, 'wedge-z', 1);
  assert.equal(topYAt(positive, 2, 2), 3);
  assert.equal(topYAt(positive, 2, 0), 0);
  const negative = wedgeVertices(bounds, 'wedge-z', -1);
  assert.equal(topYAt(negative, 2, 0), 3);
  assert.equal(topYAt(negative, 2, 2), 0);
});

test('elementGeometry：box 包围盒等于元素边界，wedge 有包围盒', () => {
  const geometry = elementGeometry(boxElement({ bounds: { min: [1, -8, 2], max: [5, -4, 6] } }));
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  assert.notEqual(box, null);
  if (box === null) return;
  assert.deepEqual([box.min.x, box.min.y, box.min.z], [1, -8, 2]);
  assert.deepEqual([box.max.x, box.max.y, box.max.z], [5, -4, 6]);
  const wedgeGeometry = elementGeometry(boxElement({ shape: 'wedge-x', direction: -1 }));
  wedgeGeometry.computeBoundingBox();
  assert.notEqual(wedgeGeometry.boundingBox, null);
});

test('elementGeometry：lathe 走旋转薄壳（顶点数为 hSeg×rSeg+1），不是楔体的 6 顶点', () => {
  const element: Element = {
    id: 'roof-profile',
    name: '旋转壳屋面',
    level: 'roof',
    kind: 'slab',
    bounds: { min: [-16, 12, -16], max: [16, 36, 16] },
    color: '#aabbcc',
    shape: 'lathe',
    direction: 1,
    profile: { kind: 'linear', curvature: 0, heightSegments: 24, radialSegments: 48 },
  };
  const geometry = elementGeometry(element);
  const position = geometry.getAttribute('position');
  assert.ok(position instanceof THREE.BufferAttribute);
  assert.equal(position.count, 24 * 48 + 1);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  assert.notEqual(box, null);
  if (box === null) return;
  assert.equal(box.min.y, 12);
  assert.equal(box.max.y, 36);
});

test('buildMassingScene：元素各一网格、空间有半透明盒与轮廓、盒名记空间 id', () => {
  const built = buildMassingScene(blueprintOf([boxElement({ id: 'el-1' }), boxElement({ id: 'el-2' })], [space()]));
  assert.equal(built.elementById.size, 2);
  assert.equal(built.elementById.get('el-1')?.name, 'el-1');
  assert.equal(built.spaceLines.length, 1);
  assert.equal(built.spaceById.size, 1);
  const solid = built.spaceById.get('sp-1');
  assert.ok(solid !== undefined);
  assert.equal(solid.name, 'sp-1');
  assert.ok(solid.material instanceof THREE.MeshLambertMaterial);
  assert.equal(solid.material.transparent, true);
  assert.equal(built.spaceGroup.children.length, 2);
});

test('applyLevelDisplay 按楼层过滤并设置裁剪：楼板豁免下边界，轴向剖切叠加', () => {
  const wall = boxElement({ id: 'el-wall', level: 'b3', bounds: { min: [0, -24, 0], max: [1, -2, 1] } });
  const slab = boxElement({ id: 'el-slab', kind: 'slab', level: 'b1', bounds: { min: [0, -9, 0], max: [10, -8, 10] } });
  const upper = boxElement({
    id: 'el-upper',
    kind: 'landscape',
    level: 'surface',
    bounds: { min: [0, -2, 0], max: [10, 0, 10] },
  });
  const b2 = boxElement({ id: 'el-b2', level: 'b2', bounds: { min: [0, -17, 0], max: [1, -16, 1] } });
  const sp = space({ bounds: { min: [0, -8, 0], max: [4, -2, 4] } });
  const bp = blueprintOf([wall, slab, upper, b2], [sp]);
  const built = buildMassingScene(bp);
  const b1 = levelDisplay(bp.levels, { level: 'b1', showSurface: false }, 1);

  applyLevelDisplay(built, bp, b1, null);
  assert.equal(built.elementById.get('el-wall')?.visible, true);
  assert.equal(built.elementById.get('el-b2')?.visible, false);
  const wallMaterial = built.elementById.get('el-wall')?.material;
  assert.ok(wallMaterial instanceof THREE.MeshLambertMaterial);
  assert.deepEqual(wallMaterial.clippingPlanes, elementLevelPlanes(wall, b1));
  const slabMaterial = built.elementById.get('el-slab')?.material;
  assert.ok(slabMaterial instanceof THREE.MeshLambertMaterial);
  assert.deepEqual(slabMaterial.clippingPlanes, elementLevelPlanes(slab, b1));
  const lines = built.spaceLines.at(0);
  assert.ok(lines !== undefined);
  const lineMaterial = lines.material;
  assert.ok(lineMaterial instanceof THREE.LineBasicMaterial);
  assert.deepEqual(lineMaterial.clippingPlanes, displayPlanes(b1));
  const solid = built.spaceById.get('sp-1');
  assert.ok(solid !== undefined);
  const solidMaterial = solid.material;
  assert.ok(solidMaterial instanceof THREE.MeshLambertMaterial);
  assert.deepEqual(solidMaterial.clippingPlanes, displayPlanes(b1));

  // 叠加轴向剖切：每片再多一个平面。
  const axis = clipPlaneFor('x', 5);
  assert.notEqual(axis, null);
  if (axis === null) throw new Error('测试需要 x 剖切面');
  applyLevelDisplay(built, bp, b1, axis);
  assert.deepEqual(wallMaterial.clippingPlanes, [...elementLevelPlanes(wall, b1), axis]);
  assert.deepEqual(lineMaterial.clippingPlanes, [...displayPlanes(b1), axis]);
  assert.deepEqual(solidMaterial.clippingPlanes, [...displayPlanes(b1), axis]);
});

test('setHighlighted 切换自发光：命中高亮色，其余恢复', () => {
  const built = buildMassingScene(blueprintOf([boxElement({ id: 'el-1' }), boxElement({ id: 'el-2' })], []));
  const mesh = built.elementById.get('el-1');
  assert.ok(mesh !== undefined);
  const material = mesh.material;
  assert.ok(material instanceof THREE.MeshLambertMaterial);
  setHighlighted(built, new Set(['el-1']));
  assert.equal(material.emissive.getHex(), HIGHLIGHT_COLOR);
  const other = built.elementById.get('el-2');
  assert.ok(other !== undefined);
  const otherMaterial = other.material;
  assert.ok(otherMaterial instanceof THREE.MeshLambertMaterial);
  assert.equal(otherMaterial.emissive.getHex(), 0x000000);
});
