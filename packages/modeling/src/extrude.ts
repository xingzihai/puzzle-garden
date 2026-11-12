/**
 * 简单多边形拉伸网格：轮廓在 x-z 平面，沿 +y 拉伸 height，闭合顶底。
 *
 * 负责：对已校验的简单轮廓（凸或凹）三角化顶 / 底盖——凸轮廓用 O(n) 扇形快路径，凹轮廓用
 * ear clipping；生成侧壁，按轮廓有向面积统一外向绕序（浏览器自行算法线）。
 * 不负责：轮廓合法性（checkOutline 在 polygon.ts）、变换（transform.ts）。
 *
 * 绕序推导：有向面积为正时，顶盖取三角 (a, c, b)（法线 +y）、底盖取 (a, b, c)（法线 −y）；
 * 侧壁取 (b_i, t_i, t_{i+1}) 与 (b_i, t_{i+1}, b_{i+1})（外向）。面积为负时每个三角交换后两位翻转。
 */
import type { MeshData } from './mesh.ts';
import { clean } from './mesh.ts';
import { signedArea2, triangulateOutline } from './polygon.ts';
import type { Point2 } from './schema.ts';

function pointAt(points: readonly Point2[], index: number): Point2 {
  const point = points[index];
  if (point === undefined) throw new Error(`extrudeMesh：缺少第 ${String(index)} 个轮廓点`);
  return point;
}

function indexAt(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`extrudeMesh：缺少第 ${String(index)} 个三角下标`);
  return value;
}

/** 生成简单轮廓棱柱网格。outline 已保证规范形（无重复闭合点）、简单（凸或凹）、非退化、不自交。 */
export function extrudeMesh(outline: readonly Point2[], height: number, convex = false): MeshData {
  const n = outline.length;
  const flip = signedArea2(outline) < 0;
  const positions: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const point = pointAt(outline, i);
    positions.push(clean(point[0]), 0, clean(point[1]));
  }
  const topBase = n;
  for (let i = 0; i < n; i += 1) {
    const point = pointAt(outline, i);
    positions.push(clean(point[0]), clean(height), clean(point[1]));
  }
  const indices: number[] = [];
  const triangle = (a: number, b: number, c: number): void => {
    if (flip) indices.push(a, c, b);
    else indices.push(a, b, c);
  };
  // 顶盖与底盖：用三角化结果（凸走扇形、凹走 ear clipping）；顶 / 底绕序相反。
  const capTriangles = triangulateOutline(outline, convex);
  for (let t = 0; t < capTriangles.length; t += 3) {
    const a = indexAt(capTriangles, t);
    const b = indexAt(capTriangles, t + 1);
    const c = indexAt(capTriangles, t + 2);
    triangle(topBase + a, topBase + c, topBase + b);
    triangle(a, b, c);
  }
  // 侧壁：每条轮廓边一个四边形，拆成两个三角。
  for (let i = 0; i < n; i += 1) {
    const next = (i + 1) % n;
    triangle(i, topBase + i, topBase + next);
    triangle(i, topBase + next, next);
  }
  return { positions, indices };
}
