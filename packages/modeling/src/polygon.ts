/**
 * 2D 多边形几何：轮廓校验（简单多边形，凸或凹）与三角化。
 *
 * 负责：去掉一次重复闭合点后的轮廓合法性（点数、重复点、面积、相邻共线退化、非相邻边自交），
 * 判定凸 / 凹；凸轮廓走扇形快路径、凹轮廓走 ear clipping，返回与有向面积同号的三角下标。
 * 不负责：zod schema（schema.ts）、拉伸成网格（extrude.ts）。
 *
 * 坐标系：轮廓点 (x, z) 位于 x-z 平面；有向面积 2A = Σ(x_i·z_{i+1} − x_{i+1}·z_i)。
 * 校验用 EPSILON 阈值区分共线 / 自交，生成网格与合法输入的尺度远大于它。
 */
import type { Point2 } from './schema.ts';

/** 共线 / 自交判定的浮点阈值；生成网格与合法输入的尺度远大于它。 */
export const EPSILON = 1e-9;
/** 轮廓点数上限；自交校验是平方级，限制点数避免构造病态输入拖慢。 */
export const MAX_OUTLINE_POINTS = 512;

function samePoint(a: Point2, b: Point2): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** 二维叉积 (a−o)×(b−o)；正负表示转向。 */
export function cross2(o: Point2, a: Point2, b: Point2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function onSegment(a: Point2, b: Point2, p: Point2): boolean {
  return (
    p[0] >= Math.min(a[0], b[0]) - EPSILON &&
    p[0] <= Math.max(a[0], b[0]) + EPSILON &&
    p[1] >= Math.min(a[1], b[1]) - EPSILON &&
    p[1] <= Math.max(a[1], b[1]) + EPSILON
  );
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const o1 = cross2(a, b, c);
  const o2 = cross2(a, b, d);
  const o3 = cross2(c, d, a);
  const o4 = cross2(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (Math.abs(o1) <= EPSILON && onSegment(a, b, c)) return true;
  if (Math.abs(o2) <= EPSILON && onSegment(a, b, d)) return true;
  if (Math.abs(o3) <= EPSILON && onSegment(c, d, a)) return true;
  if (Math.abs(o4) <= EPSILON && onSegment(c, d, b)) return true;
  return false;
}

function pointAt(points: readonly Point2[], index: number): Point2 {
  const point = points[index];
  if (point === undefined) throw new Error(`polygon：坐标点数组缺少第 ${String(index)} 个点`);
  return point;
}

/** 有向面积的 2 倍：正为逆时针（x-z 平面口径），负为顺时针，0 为退化。 */
export function signedArea2(points: readonly Point2[]): number {
  let area2 = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = pointAt(points, i);
    const b = pointAt(points, (i + 1) % points.length);
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  return area2;
}

/** checkOutline 的结果：合法时给出规范形（去掉一次重复闭合点）与凸性，非法时给出中文原因。 */
export type OutlineCheck =
  | { readonly ok: true; readonly outline: Point2[]; readonly convex: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * 校验并规范化简单多边形轮廓：允许首尾重复一次的闭合点（去掉），要求至少 3 个互异点、面积非零、
 * 相邻顶点不共线退化、非相邻边不自交；凹形合法（由 ear clipping 三角化）。
 * 返回规范化点列与凸性；非法时返回原因。调用期用它报错，schema 用它校验 source。
 */
export function checkOutline(raw: readonly Point2[]): OutlineCheck {
  const outline = [...raw];
  if (outline.length >= 2) {
    const first = outline[0];
    const last = outline[outline.length - 1];
    if (first !== undefined && last !== undefined && samePoint(first, last)) outline.pop();
  }
  const n = outline.length;
  if (n < 3) return { ok: false, error: `轮廓至少需要 3 个互异的点，实际 ${String(n)} 个` };
  if (n > MAX_OUTLINE_POINTS) {
    return { ok: false, error: `轮廓点数不得超过 ${String(MAX_OUTLINE_POINTS)}，实际 ${String(n)} 个` };
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = pointAt(outline, i);
      const b = pointAt(outline, j);
      if (samePoint(a, b)) {
        return {
          ok: false,
          error: `轮廓存在重复点：第 ${String(i)} 与第 ${String(j)} 个 (${String(a[0])}, ${String(a[1])})`,
        };
      }
    }
  }
  const area2 = signedArea2(outline);
  if (Math.abs(area2) <= EPSILON) return { ok: false, error: '轮廓面积为零（点共线或退化）' };
  const sign = area2 > 0 ? 1 : -1;
  let convex = true;
  for (let i = 0; i < n; i += 1) {
    const a = pointAt(outline, i);
    const b = pointAt(outline, (i + 1) % n);
    const c = pointAt(outline, (i + 2) % n);
    const turn = cross2(a, b, c);
    if (Math.abs(turn) <= EPSILON) return { ok: false, error: `轮廓在第 ${String(i)} 个点共线或退化` };
    if (Math.sign(turn) !== sign) convex = false;
  }
  for (let i = 0; i < n; i += 1) {
    const iNext = (i + 1) % n;
    for (let j = i + 1; j < n; j += 1) {
      const jNext = (j + 1) % n;
      if (i === jNext || j === iNext) continue;
      const a = pointAt(outline, i);
      const b = pointAt(outline, iNext);
      const c = pointAt(outline, j);
      const d = pointAt(outline, jNext);
      if (segmentsIntersect(a, b, c, d)) {
        return { ok: false, error: `轮廓自交：边 ${String(i)}→${String(iNext)} 与边 ${String(j)}→${String(jNext)}` };
      }
    }
  }
  return { ok: true, outline, convex };
}

/** 点 p 是否落在三角形 abc 内或边界上（含边界，避免耳朵切到恰在边上的顶点）。 */
function pointInTriangle(a: Point2, b: Point2, c: Point2, p: Point2): boolean {
  const d1 = cross2(a, b, p);
  const d2 = cross2(b, c, p);
  const d3 = cross2(c, a, p);
  const hasNeg = d1 < -EPSILON || d2 < -EPSILON || d3 < -EPSILON;
  const hasPos = d1 > EPSILON || d2 > EPSILON || d3 > EPSILON;
  return !(hasNeg && hasPos);
}

function indexAt(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`polygon：三角下标数组缺少第 ${String(index)} 项`);
  return value;
}

/**
 * 把简单多边形（凸或凹）三角化成下标三元组，每个三角 (a,b,c) 的二维绕序与多边形有向面积同号。
 * convex=true 走以第 0 点为扇心的 O(n) 快路径；否则走 ear clipping（简单多边形必有耳朵）。
 * 凸性由 checkOutline 判定，调用方直接传入，避免重复计算。
 */
export function triangulateOutline(outline: readonly Point2[], convex: boolean): number[] {
  const n = outline.length;
  if (n < 3) throw new Error(`triangulateOutline：至少需要 3 个点，实际 ${String(n)} 个`);
  const sign = signedArea2(outline) > 0 ? 1 : -1;
  const indices: number[] = [];
  if (convex) {
    for (let i = 1; i < n - 1; i += 1) indices.push(0, i, i + 1);
    return indices;
  }
  const remaining: number[] = [];
  for (let i = 0; i < n; i += 1) remaining.push(i);
  while (remaining.length > 3) {
    let clipped = false;
    for (let k = 0; k < remaining.length; k += 1) {
      const length = remaining.length;
      const prev = indexAt(remaining, (k - 1 + length) % length);
      const curr = indexAt(remaining, k);
      const next = indexAt(remaining, (k + 1) % length);
      const a = pointAt(outline, prev);
      const b = pointAt(outline, curr);
      const c = pointAt(outline, next);
      if (Math.sign(cross2(a, b, c)) !== sign) continue;
      let ear = true;
      for (const idx of remaining) {
        if (idx === prev || idx === curr || idx === next) continue;
        if (pointInTriangle(a, b, c, pointAt(outline, idx))) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      indices.push(prev, curr, next);
      remaining.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('triangulateOutline：ear clipping 未找到耳朵，轮廓可能非简单多边形');
  }
  indices.push(indexAt(remaining, 0), indexAt(remaining, 1), indexAt(remaining, 2));
  return indices;
}
