/** boxMesh 的单元测试：顶点 / 三角计数、包围盒、所有三角外向且非退化。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boxMesh } from './box.ts';
import { computeBounds } from './mesh.ts';

interface Tri {
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  readonly c: readonly [number, number, number];
}

function triangles(positions: readonly number[], indices: readonly number[]): Tri[] {
  const out: Tri[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const read = (index: number): readonly [number, number, number] => {
      const base = index * 3;
      return [positions[base] ?? 0, positions[base + 1] ?? 0, positions[base + 2] ?? 0];
    };
    out.push({ a: read(indices[i] ?? 0), b: read(indices[i + 1] ?? 0), c: read(indices[i + 2] ?? 0) });
  }
  return out;
}

function normal(tri: Tri): readonly [number, number, number] {
  const ux = tri.b[0] - tri.a[0];
  const uy = tri.b[1] - tri.a[1];
  const uz = tri.b[2] - tri.a[2];
  const vx = tri.c[0] - tri.a[0];
  const vy = tri.c[1] - tri.a[1];
  const vz = tri.c[2] - tri.a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

describe('boxMesh', () => {
  it('8 个共享顶点、12 个三角', () => {
    const mesh = boxMesh([2, 3, 4]);
    assert.equal(mesh.positions.length / 3, 8);
    assert.equal(mesh.indices.length / 3, 12);
  });

  it('包围盒等于 [0,size]', () => {
    assert.deepEqual(computeBounds(boxMesh([2, 3, 4]).positions), { min: [0, 0, 0], max: [2, 3, 4] });
  });

  it('每个三角非退化且法线背离盒中心（外向绕序）', () => {
    const mesh = boxMesh([2, 3, 4]);
    const center: readonly [number, number, number] = [1, 1.5, 2];
    for (const tri of triangles(mesh.positions, mesh.indices)) {
      const n = normal(tri);
      const length = Math.hypot(n[0], n[1], n[2]);
      assert.ok(length > 0, '三角退化');
      const centroid: readonly [number, number, number] = [
        (tri.a[0] + tri.b[0] + tri.c[0]) / 3 - center[0],
        (tri.a[1] + tri.b[1] + tri.c[1]) / 3 - center[1],
        (tri.a[2] + tri.b[2] + tri.c[2]) / 3 - center[2],
      ];
      const dot = n[0] * centroid[0] + n[1] * centroid[1] + n[2] * centroid[2];
      assert.ok(dot > 0, `三角面朝内：normal=${JSON.stringify(n)}`);
    }
  });

  it('每个面两个三角，面积合计等于表面积', () => {
    const mesh = boxMesh([1, 1, 1]);
    let area = 0;
    for (const tri of triangles(mesh.positions, mesh.indices)) {
      const n = normal(tri);
      area += Math.hypot(n[0], n[1], n[2]) / 2;
    }
    // 表面积 6、12 个三角恰好每个 0.5。
    assert.ok(Math.abs(area - 6) < 1e-9);
  });
});
