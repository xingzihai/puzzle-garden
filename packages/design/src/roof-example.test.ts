/** roof-example 的好坏样本：三版 lathe profile、同 id 不同 revision、差异只在屋面、基底与空间不动。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffBlueprint } from './diff.ts';
import type { Element } from './schema.ts';
import { createRoofExample } from './roof-example.ts';

type ParsedBlueprint = ReturnType<typeof createRoofExample>;

/** 取出屋面元素；找不到就让测试失败，而不是继续用 undefined。 */
function roofOf(blueprint: ParsedBlueprint): Element {
  const roof = blueprint.elements.find((element) => element.id === 'roof-profile');
  assert.ok(roof, '屋面元素 roof-profile 必须存在');
  return roof;
}

test('默认 cone：id / revision / 楼层 / 只有基底 + 空间 + 屋面，clearances 为空', () => {
  const blueprint = createRoofExample();
  assert.equal(blueprint.id, 'bp-roof-lathe');
  assert.equal(blueprint.revision, 1);
  assert.deepEqual(
    blueprint.levels.map((level) => [level.id, level.elevation]),
    [
      ['surface', 0],
      ['roof', 12],
    ],
  );
  assert.equal(blueprint.spaces.length, 1);
  const room = blueprint.spaces[0];
  assert.ok(room);
  assert.equal(room.id, 'sp-room');
  assert.equal(room.role, 'room');
  assert.equal(room.bounds.min[1], 0);
  assert.equal(room.bounds.max[1], 12);
  assert.deepEqual(blueprint.clearances, []);
  assert.deepEqual(
    blueprint.elements.map((element) => element.id).sort((a, b) => (a < b ? -1 : 1)),
    ['base-slab', 'roof-profile'],
  );
  assert.equal(
    blueprint.elements.some((element) => element.kind === 'wall' || element.kind === 'furnishing'),
    false,
  );

  const roof = roofOf(blueprint);
  assert.equal(roof.shape, 'lathe');
  assert.equal(roof.direction, 1);
  assert.equal(roof.level, 'roof');
  assert.deepEqual(roof.profile, { kind: 'linear', curvature: 0, heightSegments: 24, radialSegments: 48 });
});

test('三版 profile：cone=linear k0、reciprocal=k2、curved=k6', () => {
  const cone = roofOf(createRoofExample('cone')).profile;
  assert.ok(cone);
  assert.equal(cone.kind, 'linear');
  assert.equal(cone.curvature, 0);

  const reciprocal = roofOf(createRoofExample('reciprocal')).profile;
  assert.ok(reciprocal);
  assert.equal(reciprocal.kind, 'reciprocal');
  assert.equal(reciprocal.curvature, 2);

  const curved = roofOf(createRoofExample('curved')).profile;
  assert.ok(curved);
  assert.equal(curved.kind, 'reciprocal');
  assert.equal(curved.curvature, 6);
});

test('缺省 variant 为 cone', () => {
  assert.deepEqual(createRoofExample(), createRoofExample('cone'));
});

test('屋面包围盒：x/z 跨度 32 偶数、壳基 y=12、顶端 y=36，三版一致', () => {
  for (const variant of ['cone', 'reciprocal', 'curved'] as const) {
    const roof = roofOf(createRoofExample(variant));
    assert.equal(roof.bounds.max[0] - roof.bounds.min[0], 32);
    assert.equal(roof.bounds.max[2] - roof.bounds.min[2], 32);
    assert.equal(roof.bounds.min[1], 12);
    assert.equal(roof.bounds.max[1], 36);
  }
});

test('三版同 id 不同 revision，差异只有 roof-profile', () => {
  const cone = createRoofExample('cone');
  const reciprocal = createRoofExample('reciprocal');
  const curved = createRoofExample('curved');
  assert.deepEqual(
    [cone, reciprocal, curved].map((blueprint) => blueprint.id),
    ['bp-roof-lathe', 'bp-roof-lathe', 'bp-roof-lathe'],
  );
  assert.deepEqual(
    [cone, reciprocal, curved].map((blueprint) => blueprint.revision),
    [1, 2, 3],
  );
  assert.deepEqual(diffBlueprint(cone, reciprocal), {
    added: [],
    removed: [],
    changed: ['roof-profile'],
    spacesChanged: [],
  });
  assert.deepEqual(diffBlueprint(cone, curved), {
    added: [],
    removed: [],
    changed: ['roof-profile'],
    spacesChanged: [],
  });
});

test('改屋面 profile 不影响基底平板与圆厅空间', () => {
  const cone = createRoofExample('cone');
  const curved = createRoofExample('curved');
  const baseOf = (blueprint: ParsedBlueprint): Element | undefined =>
    blueprint.elements.find((element) => element.id === 'base-slab');
  assert.deepEqual(baseOf(cone), baseOf(curved));
  assert.deepEqual(cone.spaces, curved.spaces);
  // 屋面包围盒不随 curvature 变化，只有 profile 变
  assert.deepEqual(roofOf(cone).bounds, roofOf(curved).bounds);
  assert.notDeepEqual(roofOf(cone).profile, roofOf(curved).profile);
});
