/**
 * profile-parser.ts 的单元测试：合法 profile 原样保留、非法取值抛出可读错误（不做静默回退）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLatheProfile } from './profile-parser.ts';

const LINEAR = { kind: 'linear', curvature: 0, heightSegments: 24, radialSegments: 48 };
const RECIPROCAL = { kind: 'reciprocal', curvature: 2, heightSegments: 24, radialSegments: 48 };

test('parseLatheProfile：linear 与 reciprocal 都原样返回', () => {
  assert.deepEqual(parseLatheProfile(LINEAR, '屋面.profile'), LINEAR);
  assert.deepEqual(parseLatheProfile(RECIPROCAL, '屋面.profile'), RECIPROCAL);
});

test('parseLatheProfile：kind 与 curvature 必须匹配', () => {
  assert.throws(() => parseLatheProfile({ ...LINEAR, curvature: 2 }, 'p'), /linear 时必须为 0/);
  assert.throws(() => parseLatheProfile({ ...RECIPROCAL, curvature: 0 }, 'p'), /reciprocal 时必须 ≥ 1/);
  assert.throws(() => parseLatheProfile({ ...LINEAR, curvature: 21 }, 'p'), /必须在 0–20/);
  assert.throws(() => parseLatheProfile({ ...LINEAR, curvature: -1 }, 'p'), /必须在 0–20/);
});

test('parseLatheProfile：非法 kind 与分段数抛错', () => {
  assert.throws(() => parseLatheProfile({ ...LINEAR, kind: 'spiral' }, 'p'), /kind 取值非法/);
  assert.throws(() => parseLatheProfile({ ...LINEAR, heightSegments: 2 }, 'p'), /heightSegments 必须在 4–128/);
  assert.throws(() => parseLatheProfile({ ...LINEAR, radialSegments: 7 }, 'p'), /radialSegments 必须在 8–128/);
  assert.throws(() => parseLatheProfile({ ...LINEAR, radialSegments: 129 }, 'p'), /radialSegments 必须在 8–128/);
  assert.throws(() => parseLatheProfile(null, 'p'), /p 必须是对象/);
  assert.throws(() => parseLatheProfile({ ...LINEAR, curvature: 1.5 }, 'p'), /curvature 必须是整数/);
});
