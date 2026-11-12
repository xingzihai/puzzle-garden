/**
 * 浏览器端：旋转薄壳屋面的母线求值与三角化（MASSING-SPEC §3）。
 *
 * 负责：按整数 profile 把 `shape=lathe` 元素采样成三角面薄壳——半径沿 y 由 profileRadius 求值，
 * 绕 y 轴旋转成环，顶端收成单点扇尖，法线解析求外向；只生成旋转面，不含底面实心盖、不填充内部。
 * 不负责：profile 字段窄化（page/profile-parser.ts）、元素调度与材质（page/scene.ts）、DOM 与渲染（page/main.ts）。
 *
 * 约定：lathe 轴沿 +y（direction=1），bounds 的 x/z 跨度相等偶数（轴在整数中心）；浮点几何不写回方案数据。
 */
import * as THREE from 'three';

import type { Element, LatheProfile } from '@pg/design/schema';

/**
 * 直线母线与反比例母线的半径：
 *   linear     r(t) = R·(1−t)
 *   reciprocal r(t) = R·(1−t)/(1+k·t)
 * t∈[0,1]，底半径 R>0、顶半径 0；参数非法（t 越界、R 非正、kind 与 curvature 不匹配）直接抛错。
 */
export function profileRadius(t: number, baseRadius: number, profile: LatheProfile): number {
  if (!Number.isFinite(baseRadius) || baseRadius <= 0) {
    throw new Error(`底半径 R 必须是正有限数：${String(baseRadius)}`);
  }
  if (!Number.isFinite(t) || t < 0 || t > 1) {
    throw new Error(`母线参数 t 必须在 [0, 1]：${String(t)}`);
  }
  if (profile.kind === 'linear') {
    if (profile.curvature !== 0) throw new Error(`linear 的 curvature 必须为 0：${String(profile.curvature)}`);
    return baseRadius * (1 - t);
  }
  if (!Number.isFinite(profile.curvature) || profile.curvature < 1) {
    throw new Error(`reciprocal 的 curvature 必须 ≥ 1：${String(profile.curvature)}`);
  }
  return (baseRadius * (1 - t)) / (1 + profile.curvature * t);
}

/** dr/dt，用于解析法线：linear 恒为 −R；reciprocal 为 −R·(1+k)/(1+k·t)²。 */
function profileSlope(t: number, baseRadius: number, profile: LatheProfile): number {
  if (profile.kind === 'linear') return -baseRadius;
  const denominator = 1 + profile.curvature * t;
  return (-baseRadius * (1 + profile.curvature)) / (denominator * denominator);
}

/**
 * 生成旋转薄壳几何：`heightSegments` 圈（t = i/heightSegments，均留非零半径）沿 y 采样，
 * 每圈 `radialSegments` 个顶点绕 y 轴旋转；顶端半径归零时不再生成整圈重合点，改成一个扇尖点，
 * 用三角扇收口，因此没有零面积三角形，法线也不会出现 NaN。法线由 (H·cosθ, −r', H·sinθ) 解析求出，指向外侧。
 */
export function latheGeometry(element: Element): THREE.BufferGeometry {
  const profile = element.profile;
  if (profile === undefined) throw new Error(`元素 ${element.id} 声明为 lathe 但没有 profile`);
  if (element.direction !== 1) {
    throw new Error(`lathe 的轴沿 y 正向，direction 必须为 1：${String(element.direction)}`);
  }
  const spanX = element.bounds.max[0] - element.bounds.min[0];
  const spanZ = element.bounds.max[2] - element.bounds.min[2];
  if (spanX !== spanZ) throw new Error(`lathe 的 x、z 跨度必须相等：x=${String(spanX)}、z=${String(spanZ)}`);
  if (spanX % 2 !== 0) throw new Error(`lathe 的 x、z 跨度必须为偶数（轴在整数中心）：${String(spanX)}`);
  const height = element.bounds.max[1] - element.bounds.min[1];
  if (!(height > 0)) throw new Error(`lathe 的高度必须为正：${String(height)}`);
  const baseRadius = spanX / 2;
  const centerX = (element.bounds.min[0] + element.bounds.max[0]) / 2;
  const centerZ = (element.bounds.min[2] + element.bounds.max[2]) / 2;
  const baseY = element.bounds.min[1];
  const heightSegments = profile.heightSegments;
  const radialSegments = profile.radialSegments;

  const positions: number[] = [];
  const normals: number[] = [];
  for (let ring = 0; ring < heightSegments; ring += 1) {
    const t = ring / heightSegments;
    const radius = profileRadius(t, baseRadius, profile);
    const y = baseY + t * height;
    const slope = profileSlope(t, baseRadius, profile);
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const theta = (segment / radialSegments) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      positions.push(centerX + radius * cos, y, centerZ + radius * sin);
      const nx = height * cos;
      const ny = -slope;
      const nz = height * sin;
      const length = Math.hypot(nx, ny, nz);
      normals.push(nx / length, ny / length, nz / length);
    }
  }
  const apexIndex = heightSegments * radialSegments;
  positions.push(centerX, baseY + height, centerZ);
  normals.push(0, 1, 0);

  const indices: number[] = [];
  for (let ring = 0; ring < heightSegments - 1; ring += 1) {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const next = (segment + 1) % radialSegments;
      const a = ring * radialSegments + segment;
      const b = ring * radialSegments + next;
      const c = (ring + 1) * radialSegments + segment;
      const d = (ring + 1) * radialSegments + next;
      indices.push(a, c, d, a, d, b);
    }
  }
  const lastRing = (heightSegments - 1) * radialSegments;
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const next = (segment + 1) % radialSegments;
    indices.push(lastRing + segment, apexIndex, lastRing + next);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  return geometry;
}
