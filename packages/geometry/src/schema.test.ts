/** schema 的默认值、拒绝路径与候选状态；不依赖具体构件实现。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentSchemas, rect, parse, plinthSchema, wallsSchema, openingSchema } from './schema.ts';
import type { ApiStatus } from './schema.ts';

test('矩形坐标必须为有序整数且在核心范围内', () => {
  assert.deepEqual(rect(-3, -4, 3, 4), { minX: -3, minZ: -4, maxX: 3, maxZ: 4 });
  for (const args of [
    [2, 0, 1, 0],
    [0, 1, 0, 0],
    [0.5, 0, 1, 1],
    [0, 0, 2 ** 25, 1],
  ] as const) {
    assert.throws(() => rect(args[0], args[1], args[2], args[3]), /构件参数不合法/);
  }
});

test('基础参数默认值明确，额外参数不被静默丢弃，构件状态集中在登记表', () => {
  const footprint = rect(-3, -3, 3, 3);
  const p = parse(plinthSchema, { footprint, height: 2, material: 'stone' });
  assert.equal(p.y, 1);
  assert.equal(p.project, 0);
  assert(Object.isFrozen(p));
  assert.throws(() => parse(plinthSchema, { ...p, surprise: 1 }), /surprise/);
  assert.throws(() => parse(plinthSchema, { ...p, height: 0 }), /height/);
  assert.throws(() => parse(wallsSchema, { footprint, height: 3, material: 'stone' }));
  assert.throws(() => parse(wallsSchema, { footprint, y: 1, on: { footprint, y: 1 }, height: 3, material: 'stone' }));
  const opening = parse(openingSchema, {
    in: { footprint, y: 1, height: 6, thickness: 1, side: 'south' },
    kind: 'door',
    width: 1,
    height: 2,
  });
  assert.equal(opening.fill, 'air');
  assert.equal(opening.shape, 'rect');
  assert.equal(Object.keys(componentSchemas).length, 13);
  const statuses: readonly ApiStatus[] = Object.values(componentSchemas).map((component) => component.status);
  assert.deepEqual(
    statuses.filter((status) => status !== 'offline-pass'),
    [],
    '所有构件都离线通过，没有候选构件',
  );
  for (const component of Object.values(componentSchemas)) assert(component.schema.description);
});
