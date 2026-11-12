/**
 * 三次贝塞尔采样：作为 profile 组合的基本工具。
 *
 * 负责：按 B(t) = (1−t)³P0 + 3(1−t)²t·P1 + 3(1−t)t²·P2 + t³P3 求点，-0 规范成 0。
 * 不负责：控制点 / t 的合法性校验（model.ts 调用期用 schema 校验）。
 */
import type { Point2 } from './schema.ts';

/** 求三次贝塞尔曲线上参数 t 处的点。 */
export function bezierPoint(points: readonly [Point2, Point2, Point2, Point2], t: number): Point2 {
  const [p0, p1, p2, p3] = points;
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  const w0 = uu * u;
  const w1 = 3 * uu * t;
  const w2 = 3 * u * tt;
  const w3 = tt * t;
  const x = w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0];
  const y = w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1];
  return [x === 0 ? 0 : x, y === 0 ? 0 : y];
}
