/** camera.ts：视角表、取景、对齐与 pixelsPerCell（RENDER-SPEC §5、§12 第 4 条）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VIEW_NAMES, viewFrame } from './camera.ts';
import type { BBox, CameraSpec, ViewFrame } from './camera.ts';

const RATIOS: readonly [number, number][] = [
  [1024, 768],
  [900, 900],
  [1600, 900],
];

const BBOX: BBox = { min: [0, 1, 0], max: [11, 8, 7] };

type Vec = readonly [number, number, number];
function sub(a: Vec, b: Vec): Vec {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec, b: Vec): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function len(a: Vec): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function unit(a: Vec): Vec {
  const l = len(a);
  return [a[0] / l, a[1] / l, a[2] / l];
}
function basis(camera: CameraSpec): { x: Vec; y: Vec } {
  const z = unit(sub(camera.position, camera.target));
  const x = unit(cross(camera.up, z));
  const y = cross(z, x);
  return { x, y };
}
function project(frame: ViewFrame, camera: CameraSpec, p: Vec, w: number, h: number): [number, number] {
  const { x, y } = basis(camera);
  const rel = sub(p, camera.target);
  return [w / 2 + dot(rel, x) * frame.pixelsPerCell, h / 2 - dot(rel, y) * frame.pixelsPerCell];
}

const EXTERIOR_VIEWS = ['south', 'east', 'north', 'west', 'top', 'iso-se', 'iso-nw'] as const;

test('VIEW_NAMES：7 个外部视角 + interior / cutaway，顺序固定', () => {
  assert.deepEqual([...VIEW_NAMES], [...EXTERIOR_VIEWS, 'interior', 'cutaway']);
});

test('7 个外部视角 × 3 种画幅：8 角都在画面内，pixelsPerCell = H/(2h)', () => {
  for (const view of EXTERIOR_VIEWS) {
    for (const [w, h] of RATIOS) {
      const frame = viewFrame(view, BBOX, w, h);
      const [x0, y0, x1, y1] = frame.bbox;
      assert.ok(
        x0 >= 0 && y0 >= 0 && x1 <= w && y1 <= h,
        `${view} ${String(w)}x${String(h)} bbox=${String(frame.bbox)}`,
      );
      assert.ok(Math.abs(frame.pixelsPerCell - h / (2 * frame.camera.top)) < 1e-9, view);
      assert.ok(frame.frameFill > 0 && frame.frameFill <= 1, `${view} frameFill=${String(frame.frameFill)}`);
    }
  }
});

test('interior：相机在室内、站立眼高、沿长轴横看；结果确定', () => {
  const [w, h] = [1024, 768];
  const frame = viewFrame('interior', BBOX, w, h);
  const [px, py, pz] = frame.camera.position;
  assert.ok(px > BBOX.min[0] && px < BBOX.max[0] + 1, `px=${String(px)}`);
  assert.ok(pz > BBOX.min[2] && pz < BBOX.max[2] + 1, `pz=${String(pz)}`);
  assert.ok(Math.abs(py - (BBOX.min[1] + 1.6)) < 1e-9, `eye=${String(py)}`);
  assert.equal(frame.camera.target[1], py);
  const d = unit(sub(frame.camera.target, frame.camera.position));
  // BBOX 的 x 跨度大于 z：从西侧向东看。
  assert.ok(Math.abs(d[0] - 1) < 1e-9 && Math.abs(d[1]) < 1e-9 && Math.abs(d[2]) < 1e-9, JSON.stringify(d));
  assert.ok(Math.abs(frame.pixelsPerCell - h / (2 * frame.camera.top)) < 1e-9);
  assert.equal(frame.camera.clippingPlanes, undefined);
  const [x0, y0, x1, y1] = frame.bbox;
  assert.ok(x0 >= 0 && y0 >= 0 && x1 <= w && y1 <= h, `bbox=${String(frame.bbox)}`);
  assert.ok(frame.frameFill > 0 && frame.frameFill <= 1);
  assert.deepEqual(viewFrame('interior', BBOX, w, h), frame);

  const tall = viewFrame('interior', { min: [0, 1, 0], max: [1, 6, 11] }, w, h);
  const dz = unit(sub(tall.camera.target, tall.camera.position));
  assert.ok(Math.abs(dz[2] - 1) < 1e-9 && Math.abs(dz[0]) < 1e-9, JSON.stringify(dz));
});

test('cutaway：东南斜视 + 水平裁剪屋面 + 近侧墙裁剪；结果确定', () => {
  const [w, h] = [1024, 768];
  const frame = viewFrame('cutaway', BBOX, w, h);
  const iso = viewFrame('iso-se', BBOX, w, h);
  const dc = unit(sub(frame.camera.position, frame.camera.target));
  const di = unit(sub(iso.camera.position, iso.camera.target));
  assert.ok(Math.abs(dot(dc, di) - 1) < 1e-9, 'cutaway 与 iso-se 同方向');
  const planes = frame.camera.clippingPlanes;
  assert.equal(planes?.length, 3);
  assert.deepEqual(planes[0], { normal: [0, -1, 0], constant: 5 });
  assert.deepEqual(planes[1], { normal: [-1, 0, 0], constant: BBOX.max[0] + 1 - 1 });
  assert.deepEqual(planes[2], { normal: [0, 0, -1], constant: BBOX.max[2] + 1 - 1 });
  const [x0, y0, x1, y1] = frame.bbox;
  assert.ok(x0 >= 0 && y0 >= 0 && x1 <= w && y1 <= h, `bbox=${String(frame.bbox)}`);
  assert.ok(frame.frameFill > 0 && frame.frameFill <= 1);
  assert.ok(Math.abs(frame.pixelsPerCell - h / (2 * frame.camera.top)) < 1e-9);
  assert.deepEqual(viewFrame('cutaway', BBOX, w, h), frame);

  // 很薄的建筑没有可切掉的“近侧墙”，只保留屋面裁剪面。
  const thin = viewFrame('cutaway', { min: [0, 1, 0], max: [1, 4, 1] }, w, h);
  assert.equal(thin.camera.clippingPlanes?.length, 1);
});

test('斜视留白 ≥ 全幅 4.5% − 1 像素', () => {
  for (const view of ['iso-se', 'iso-nw'] as const) {
    const [w, h] = [1024, 768];
    const frame = viewFrame(view, BBOX, w, h);
    const [x0, y0, x1, y1] = frame.bbox;
    // 紧的方向留白 = 1.10 缩放后的剩余：4.545% 半幅；取两轴中较小的留白比例。
    const tight = Math.min(Math.min(x0, w - x1) / w, Math.min(y0, h - y1) / h);
    assert.ok(tight >= 0.045 - 2 / Math.min(w, h), `${view} tight=${String(tight)} bbox=${String(frame.bbox)}`);
  }
});

test('立面与俯视：整数世界坐标格线投到整像素', () => {
  for (const view of ['south', 'east', 'north', 'west', 'top'] as const) {
    const [w, h] = [1024, 768];
    const frame = viewFrame(view, BBOX, w, h);
    assert.equal(Number.isInteger(frame.pixelsPerCell), true, `${view} 应是整像素/格`);
    for (const x of [0, 3, 11]) {
      for (const y of [1, 5, 8]) {
        for (const z of [0, 4, 7]) {
          const [px, py] = project(frame, frame.camera, [x, y, z], w, h);
          assert.ok(
            Math.abs(px - Math.round(px)) < 1e-6,
            `${view} (${String(x)},${String(y)},${String(z)}) px=${String(px)}`,
          );
          assert.ok(
            Math.abs(py - Math.round(py)) < 1e-6,
            `${view} (${String(x)},${String(y)},${String(z)}) py=${String(py)}`,
          );
        }
      }
    }
  }
});

test('top 画面上方是 −z；east 与 west 视线方向相反', () => {
  const top = viewFrame('top', BBOX, 1024, 768);
  assert.deepEqual(top.camera.up, [0, 0, -1]);
  const east = viewFrame('east', BBOX, 1024, 768);
  const west = viewFrame('west', BBOX, 1024, 768);
  const de = unit(sub(east.camera.position, east.camera.target));
  const dw = unit(sub(west.camera.position, west.camera.target));
  assert.ok(Math.abs(dot(de, dw) + 1) < 1e-9);
});

test('p < 2 时走斜视公式：不对齐、pixelsPerCell 照实为小数', () => {
  const huge: BBox = { min: [0, 0, 0], max: [4999, 3, 4999] };
  const frame = viewFrame('south', huge, 256, 256);
  assert.ok(frame.pixelsPerCell < 2);
  // 不对齐：相机中心就是 B 的中心（半开区间 → (0+5000)/2、(0+4)/2）。
  assert.deepEqual(frame.camera.target, [2500, 2, 2500]);
});

test('每种画幅下 8 角都在画面内（含 16:9）', () => {
  const frame = viewFrame('iso-se', BBOX, 1600, 900);
  const [x0, y0, x1, y1] = frame.bbox;
  assert.ok(x0 >= 0 && y0 >= 0 && x1 <= 1600 && y1 <= 900);
});
