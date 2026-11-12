/**
 * controls.ts 的单元测试：整体 / 俯视 / 侧视位姿、取景距离装下包围盒、把位姿应用到相机、尺寸适配。
 *
 * three 的相机在 Node 里可直接构造，不需要 DOM 或 WebGL。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import type { Bounds } from '@pg/design/schema';

import { applyPose, framingDistance, overallPose, resizeView, sidePose, topPose, VIEW_FOV_DEG } from './controls.ts';
import type { OrbitLike, ResizableRenderer, ViewPose } from './controls.ts';

const BOUNDS: Bounds = { min: [0, -24, 0], max: [20, 0, 12] };
/** 与地下综合体量级相近的宽扁包围盒，用来验证取景不会把主体推得太远。 */
const WIDE: Bounds = { min: [0, -24, 0], max: [176, 0, 160] };

function noopOrbit(): OrbitLike {
  return { target: new THREE.Vector3(), update: () => undefined };
}

/** 把包围盒 8 个角点投影到 NDC，返回最大的 |x| / |y|：<1 表示全部入镜，越接近 1 表示主体越满。 */
function ndcExtent(bounds: Bounds, pose: ViewPose, aspect: number): number {
  const camera = new THREE.PerspectiveCamera(VIEW_FOV_DEG, aspect, 0.1, 100000);
  applyPose(camera, noopOrbit(), pose);
  camera.updateMatrixWorld();
  let max = 0;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const projected = new THREE.Vector3(x, y, z).project(camera);
        max = Math.max(max, Math.abs(projected.x), Math.abs(projected.y));
      }
    }
  }
  return max;
}

test('overallPose 注视中心、从上方斜看', () => {
  const pose = overallPose(BOUNDS, 1.6);
  assert.deepEqual(pose.target, [10, -12, 6]);
  assert.deepEqual(pose.up, [0, 1, 0]);
  assert.ok(pose.position[1] > pose.target[1]);
  const distance = Math.hypot(
    pose.position[0] - pose.target[0],
    pose.position[1] - pose.target[1],
    pose.position[2] - pose.target[2],
  );
  assert.ok(distance > 0);
});

test('topPose 垂直向下、屏幕上方为 -z', () => {
  const pose = topPose(BOUNDS, 1.6);
  assert.deepEqual(pose.target, [10, -12, 6]);
  assert.deepEqual(pose.up, [0, 0, -1]);
  assert.equal(pose.position[0], pose.target[0]);
  assert.equal(pose.position[2], pose.target[2]);
  assert.ok(pose.position[1] > pose.target[1]);
});

test('sidePose 位于 +z、近似水平看向中心', () => {
  const pose = sidePose(BOUNDS, 1.6);
  assert.deepEqual(pose.target, [10, -12, 6]);
  assert.deepEqual(pose.up, [0, 1, 0]);
  // 相机在中心正前方（同 x），+z 一侧，只有极小仰角。
  assert.equal(pose.position[0], pose.target[0]);
  assert.ok(pose.position[2] > pose.target[2], '相机应在 +z 一侧');
  const elevation = Math.atan2(pose.position[1] - pose.target[1], pose.position[2] - pose.target[2]);
  assert.ok(elevation > 0, '应略高于中心');
  assert.ok(elevation < 0.2, `仰角应近似 0，实际 ${elevation.toFixed(3)} rad`);
});

test('零尺寸包围盒也给正距离，不产生 NaN', () => {
  const flat = overallPose({ min: [1, 1, 1], max: [1, 1, 1] }, 1);
  assert.ok(Number.isFinite(flat.position[0]));
  assert.ok(flat.position[1] > flat.target[1]);
});

test('整体 / 俯视 / 侧视都把可见包围盒装进画布且占满大部分', () => {
  for (const aspect of [0.9, 16 / 9]) {
    for (const pose of [overallPose(WIDE, aspect), topPose(WIDE, aspect), sidePose(WIDE, aspect)]) {
      const extent = ndcExtent(WIDE, pose, aspect);
      assert.ok(extent <= 1.0, `角点应全部入镜，实际最大 NDC ${extent.toFixed(3)}（aspect ${String(aspect)}）`);
      assert.ok(extent >= 0.6, `主体应占满大部分画布，实际最大 NDC ${extent.toFixed(3)}（aspect ${String(aspect)}）`);
    }
  }
});

test('framingDistance 单调且对非法输入报错', () => {
  const direction = [1, 0.9, 1] as const;
  const small = framingDistance(BOUNDS, 1.6, VIEW_FOV_DEG, direction, [0, 1, 0]);
  const large = framingDistance(WIDE, 1.6, VIEW_FOV_DEG, direction, [0, 1, 0]);
  assert.ok(large > small, '更大包围盒需要更远距离');
  assert.throws(() => framingDistance(BOUNDS, 0, VIEW_FOV_DEG, direction, [0, 1, 0]), /宽高比必须为正/);
  assert.throws(() => framingDistance(BOUNDS, 1, VIEW_FOV_DEG, [0, 0, 0], [0, 1, 0]), /不能为零向量/);
});

test('applyPose 写入相机与 orbit 目标并调用 update', () => {
  const camera = new THREE.PerspectiveCamera(VIEW_FOV_DEG, 1, 0.1, 1000);
  let updates = 0;
  const orbit: OrbitLike = {
    target: new THREE.Vector3(),
    update: () => {
      updates += 1;
    },
  };
  const pose = overallPose(BOUNDS, 1);
  applyPose(camera, orbit, pose);
  assert.deepEqual([camera.position.x, camera.position.y, camera.position.z], [...pose.position]);
  assert.deepEqual([camera.up.x, camera.up.y, camera.up.z], [...pose.up]);
  assert.deepEqual([orbit.target.x, orbit.target.y, orbit.target.z], [...pose.target]);
  assert.equal(updates, 1);
});

test('resizeView 更新渲染器尺寸与相机宽高比', () => {
  const sizes: (readonly [number, number])[] = [];
  const renderer: ResizableRenderer = {
    setSize: (width, height) => {
      sizes.push([width, height]);
    },
  };
  const camera = new THREE.PerspectiveCamera(VIEW_FOV_DEG, 1, 0.1, 1000);
  resizeView(renderer, camera, 800, 400);
  assert.deepEqual(sizes, [[800, 400]]);
  assert.equal(camera.aspect, 2);
  assert.throws(() => {
    resizeView(renderer, camera, 0, 400);
  }, /视口尺寸必须为正/);
});
