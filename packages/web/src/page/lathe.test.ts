/**
 * lathe.ts 的单元测试：母线求值、旋转薄壳几何（Y 向上、薄壳无底盖、顶端扇尖无 NaN、法线外向、无退化三角形）。
 *
 * 用 three 在 Node 里建几何（不需要 WebGL）；不依赖 DOM。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import type { Element, LatheProfile } from '@pg/design/schema';

import { latheGeometry, profileRadius } from './lathe.ts';

const LINEAR: LatheProfile = { kind: 'linear', curvature: 0, heightSegments: 24, radialSegments: 48 };
const RECIPROCAL: LatheProfile = { kind: 'reciprocal', curvature: 2, heightSegments: 24, radialSegments: 48 };

function latheElement(overrides: Partial<Element> = {}): Element {
  return {
    id: 'roof-profile',
    name: '旋转壳屋面',
    level: 'roof',
    kind: 'slab',
    bounds: { min: [-16, 12, -16], max: [16, 36, 16] },
    color: '#aabbcc',
    shape: 'lathe',
    direction: 1,
    profile: LINEAR,
    ...overrides,
  };
}

function attributes(geometry: THREE.BufferGeometry): { position: THREE.BufferAttribute; index: THREE.BufferAttribute } {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const index = geometry.getIndex();
  assert.ok(position instanceof THREE.BufferAttribute);
  assert.ok(normal instanceof THREE.BufferAttribute);
  assert.ok(index instanceof THREE.BufferAttribute);
  return { position, index };
}

test('profileRadius：linear 为 R·(1−t)，两端与中点取值正确', () => {
  assert.equal(profileRadius(0, 10, LINEAR), 10);
  assert.equal(profileRadius(0.5, 10, LINEAR), 5);
  assert.equal(profileRadius(1, 10, LINEAR), 0);
});

test('profileRadius：reciprocal 为 R·(1−t)/(1+k·t)，t=1 顶半径归零', () => {
  assert.equal(profileRadius(0, 16, RECIPROCAL), 16);
  assert.equal(profileRadius(0.5, 16, RECIPROCAL), 4);
  assert.equal(profileRadius(1, 16, RECIPROCAL), 0);
});

test('profileRadius：k 越大腰部越收，反比例中点半径小于线性', () => {
  const k2 = profileRadius(0.5, 16, { ...RECIPROCAL, curvature: 2 });
  const k6 = profileRadius(0.5, 16, { ...RECIPROCAL, curvature: 6 });
  const k20 = profileRadius(0.5, 16, { ...RECIPROCAL, curvature: 20 });
  assert.ok(k2 < profileRadius(0.5, 16, LINEAR), `k=2 应收分：${String(k2)}`);
  assert.ok(k6 < k2, `k=6 应比 k=2 更收：${String(k6)} < ${String(k2)}`);
  assert.ok(k20 < k6, `k=20 应比 k=6 更收：${String(k20)} < ${String(k6)}`);
});

test('profileRadius：非法 t、R 与 kind/curvature 不匹配抛错', () => {
  assert.throws(() => profileRadius(-0.1, 10, LINEAR), /t 必须在 \[0, 1\]/);
  assert.throws(() => profileRadius(1.1, 10, LINEAR), /t 必须在 \[0, 1\]/);
  assert.throws(() => profileRadius(0.5, 0, LINEAR), /R 必须是正有限数/);
  assert.throws(() => profileRadius(0.5, Number.NaN, LINEAR), /R 必须是正有限数/);
  assert.throws(() => profileRadius(0.5, 10, { ...LINEAR, curvature: 2 }), /linear 的 curvature 必须为 0/);
  assert.throws(() => profileRadius(0.5, 10, { ...RECIPROCAL, curvature: 0 }), /reciprocal 的 curvature 必须 ≥ 1/);
});

test('latheGeometry：Y 向上、包围盒等于元素边界、顶端在 maxY', () => {
  const element = latheElement();
  const geometry = latheGeometry(element);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  assert.notEqual(box, null);
  if (box === null) return;
  assert.equal(box.min.y, 12);
  assert.equal(box.max.y, 36);
  assert.ok(Math.abs(box.min.x + 16) < 1e-6);
  assert.ok(Math.abs(box.max.x - 16) < 1e-6);
  assert.ok(Math.abs(box.min.z + 16) < 1e-6);
  assert.ok(Math.abs(box.max.z - 16) < 1e-6);
});

test('latheGeometry：薄壳只生成旋转面，顶端收成一个扇尖点', () => {
  const element = latheElement();
  const geometry = latheGeometry(element);
  const position = attributes(geometry).position;
  const profile = LINEAR;
  assert.equal(position.count, profile.heightSegments * profile.radialSegments + 1);
  // 最后一点是唯一一个位于顶面中心（半径为 0）的顶点。
  const apexY = 36;
  let apexCount = 0;
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const z = position.getZ(index);
    if (position.getY(index) === apexY && Math.hypot(x, z) < 1e-9) apexCount += 1;
  }
  assert.equal(apexCount, 1, '顶端应只有一个扇尖点');
});

test('latheGeometry：position / normal 全部有限，顶端不出现 NaN', () => {
  for (const profile of [LINEAR, RECIPROCAL, { ...RECIPROCAL, curvature: 20 }]) {
    const geometry = latheGeometry(latheElement({ profile }));
    const { position } = attributes(geometry);
    const normal = geometry.getAttribute('normal');
    assert.ok(normal instanceof THREE.BufferAttribute);
    for (let index = 0; index < position.count; index += 1) {
      for (const value of [position.getX(index), position.getY(index), position.getZ(index)]) {
        assert.ok(Number.isFinite(value), `position 出现非有限值：${String(value)}`);
      }
      for (const value of [normal.getX(index), normal.getY(index), normal.getZ(index)]) {
        assert.ok(Number.isFinite(value), `normal 出现非有限值：${String(value)}`);
      }
    }
  }
});

test('latheGeometry：法线外向（径向分量与半径同向）', () => {
  const geometry = latheGeometry(latheElement({ profile: RECIPROCAL }));
  const position = attributes(geometry).position;
  const normal = geometry.getAttribute('normal');
  assert.ok(normal instanceof THREE.BufferAttribute);
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const z = position.getZ(index);
    const radius = Math.hypot(x, z);
    const radialDot = normal.getX(index) * x + normal.getZ(index) * z;
    if (radius < 1e-9) {
      // 扇尖：法线取 +y，不参与径向判定。
      assert.ok(normal.getY(index) > 0);
      continue;
    }
    assert.ok(radialDot > 0, `顶点 ${String(index)} 法线径向分量为 ${String(radialDot)}，应外向`);
  }
});

test('latheGeometry：所有三角形非退化（面积大于阈值）', () => {
  for (const profile of [LINEAR, RECIPROCAL, { ...RECIPROCAL, curvature: 20 }]) {
    const geometry = latheGeometry(latheElement({ profile }));
    const position = attributes(geometry).position;
    const index = geometry.getIndex();
    assert.ok(index instanceof THREE.BufferAttribute);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    for (let triangle = 0; triangle < index.count; triangle += 3) {
      const i0 = index.getX(triangle);
      const i1 = index.getX(triangle + 1);
      const i2 = index.getX(triangle + 2);
      a.set(position.getX(i0), position.getY(i0), position.getZ(i0));
      b.set(position.getX(i1), position.getY(i1), position.getZ(i1));
      c.set(position.getX(i2), position.getY(i2), position.getZ(i2));
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const area = ab.cross(ac).length() / 2;
      assert.ok(area > 1e-6, `第 ${String(triangle / 3)} 个三角形退化，面积 ${String(area)}`);
    }
  }
});

test('latheGeometry：缺少 profile、跨度不等或 direction 非 1 时抛错', () => {
  const missing: Element = {
    id: 'roof-profile',
    name: '旋转壳屋面',
    level: 'roof',
    kind: 'slab',
    bounds: { min: [-16, 12, -16], max: [16, 36, 16] },
    color: '#aabbcc',
    shape: 'lathe',
    direction: 1,
  };
  assert.throws(() => latheGeometry(missing), /没有 profile/);
  assert.throws(
    () => latheGeometry(latheElement({ bounds: { min: [-16, 12, -16], max: [16, 36, 14] } })),
    /x、z 跨度必须相等/,
  );
  assert.throws(() => latheGeometry(latheElement({ direction: -1 })), /direction 必须为 1/);
});
