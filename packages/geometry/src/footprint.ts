/** 多边形占地验证、格点包含与外挑；不写世界，不把凹多边形当包围矩形填满。 */
import { rect } from './schema.ts';
import type { Footprint } from './schema.ts';
type Vertex = readonly [number, number];
function cross(a: Vertex, b: Vertex, c: Vertex): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function on(a: Vertex, b: Vertex, c: Vertex): boolean {
  return (
    cross(a, b, c) === 0 &&
    c[0] >= Math.min(a[0], b[0]) &&
    c[0] <= Math.max(a[0], b[0]) &&
    c[1] >= Math.min(a[1], b[1]) &&
    c[1] <= Math.max(a[1], b[1])
  );
}
function segments(points: readonly Vertex[]): readonly (readonly [Vertex, Vertex])[] {
  return points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    if (b === undefined) throw new Error('多边形边缺失');
    return [a, b] as const;
  });
}
export function polygonFootprint(points: readonly Vertex[]): Footprint {
  const edges = segments(points);
  let area = 0;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [a, b] of edges) {
    if (a[0] === b[0] && a[1] === b[1]) throw new Error('多边形相邻顶点不能重复');
    area += a[0] * b[1] - b[0] * a[1];
    minX = Math.min(minX, a[0]);
    minZ = Math.min(minZ, a[1]);
    maxX = Math.max(maxX, a[0]);
    maxZ = Math.max(maxZ, a[1]);
  }
  if (area === 0) throw new Error('多边形面积必须大于零');
  for (let i = 0; i < edges.length; i += 1)
    for (let j = i + 1; j < edges.length; j += 1) {
      if (j === i + 1 || (i === 0 && j === edges.length - 1)) continue;
      const a = edges[i];
      const b = edges[j];
      if (a === undefined || b === undefined) throw new Error('多边形边索引错误');
      if (
        on(a[0], a[1], b[0]) ||
        on(a[0], a[1], b[1]) ||
        on(b[0], b[1], a[0]) ||
        on(b[0], b[1], a[1]) ||
        (cross(a[0], a[1], b[0]) * cross(a[0], a[1], b[1]) < 0 && cross(b[0], b[1], a[0]) * cross(b[0], b[1], a[1]) < 0)
      )
        throw new Error('多边形不能自交或自接触');
    }
  return Object.freeze({
    ...rect(minX, minZ, maxX, maxZ),
    polygon: Object.freeze(points.map((p) => Object.freeze(p))),
  });
}
export function contains(r: Footprint, x: number, z: number): boolean {
  if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) return false;
  if (r.apse === true) {
    const dx = (x - (r.minX + r.maxX) / 2) / ((r.maxX - r.minX + 1) / 2);
    const dz = (z - r.maxZ) / (r.maxZ - r.minZ + 1);
    return dx * dx + dz * dz <= 1;
  }
  if (r.polygon === undefined) return true;
  let inside = false;
  for (const [a, b] of segments(r.polygon)) {
    if (on(a, b, [x, z])) return true;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function projected(r: Footprint, x: number, z: number, distance: number): boolean {
  for (let dz = -distance; dz <= distance; dz += 1)
    for (let dx = -distance; dx <= distance; dx += 1) if (contains(r, x + dx, z + dz)) return true;
  return false;
}
