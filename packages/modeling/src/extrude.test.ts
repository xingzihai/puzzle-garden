/** extrudeMesh 的单元测试：凸多边形棱柱计数、内外绕序（正 / 反向轮廓）、各面朝外。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extrudeMesh } from './extrude.ts';
import { computeBounds } from './mesh.ts';
import type { Point2 } from './schema.ts';

type Vertex = readonly [number, number, number];
type Tri = readonly [Vertex, Vertex, Vertex];

function read(positions: readonly number[], index: number): Vertex {
  const base = index * 3;
  return [positions[base] ?? 0, positions[base + 1] ?? 0, positions[base + 2] ?? 0];
}

function eachTriangle(
  mesh: { readonly positions: readonly number[]; readonly indices: readonly number[] },
  visit: (tri: Tri) => void,
): void {
  for (let i = 0; i < mesh.indices.length; i += 3) {
    visit([
      read(mesh.positions, mesh.indices[i] ?? 0),
      read(mesh.positions, mesh.indices[i + 1] ?? 0),
      read(mesh.positions, mesh.indices[i + 2] ?? 0),
    ]);
  }
}

function normal(tri: Tri): readonly [number, number, number] {
  const [a, b, c] = tri;
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** 正方轮廓：凸、逆时针（在 x-z 平面有向面积为正）。 */
const SQUARE: readonly Point2[] = [
  [0, 0],
  [4, 0],
  [4, 3],
  [0, 3],
];

/** L 形：6 个互异顶点、面积 12（凹）。 */
const L_SHAPE: readonly Point2[] = [
  [0, 0],
  [4, 0],
  [4, 2],
  [2, 2],
  [2, 4],
  [0, 4],
];

/** 十字形：12 个互异顶点、面积 48（凹）。 */
const CROSS: readonly Point2[] = [
  [1, 0],
  [5, 0],
  [5, 2],
  [7, 2],
  [7, 6],
  [5, 6],
  [5, 8],
  [1, 8],
  [1, 6],
  [-1, 6],
  [-1, 2],
  [1, 2],
];

/** 散度定理求闭合网格的有向体积：Σ a·(b×c)/6；绕序正确时等于实体体积。 */
function signedVolume(mesh: { readonly positions: readonly number[]; readonly indices: readonly number[] }): number {
  let volume = 0;
  eachTriangle(mesh, (tri) => {
    const [a, b, c] = tri;
    const crossBC: readonly [number, number, number] = [
      b[1] * c[2] - b[2] * c[1],
      b[2] * c[0] - b[0] * c[2],
      b[0] * c[1] - b[1] * c[0],
    ];
    volume += (a[0] * crossBC[0] + a[1] * crossBC[1] + a[2] * crossBC[2]) / 6;
  });
  return volume;
}

describe('extrudeMesh', () => {
  it('n 边形棱柱为 2n 顶点、4n−4 三角', () => {
    const n = 5;
    const outline: Point2[] = Array.from({ length: n }, (_, i) => {
      const angle = (2 * Math.PI * i) / n;
      return [4 * Math.cos(angle), 4 * Math.sin(angle)];
    });
    const mesh = extrudeMesh(outline, 2);
    assert.equal(mesh.positions.length / 3, 2 * n);
    assert.equal(mesh.indices.length / 3, 4 * n - 4);
  });

  it('正方棱柱包围盒与实际一致', () => {
    const mesh = extrudeMesh(SQUARE, 5);
    assert.deepEqual(computeBounds(mesh.positions), { min: [0, 0, 0], max: [4, 5, 3] });
  });

  it('所有三角非退化且法线背离形心（外向）', () => {
    const mesh = extrudeMesh(SQUARE, 5);
    const interior: readonly [number, number, number] = [2, 2.5, 1.5];
    eachTriangle(mesh, (tri) => {
      const n = normal(tri);
      assert.ok(Math.hypot(n[0], n[1], n[2]) > 0, '退化三角');
      const centroid: readonly [number, number, number] = [
        (tri[0][0] + tri[1][0] + tri[2][0]) / 3 - interior[0],
        (tri[0][1] + tri[1][1] + tri[2][1]) / 3 - interior[1],
        (tri[0][2] + tri[1][2] + tri[2][2]) / 3 - interior[2],
      ];
      assert.ok(n[0] * centroid[0] + n[1] * centroid[1] + n[2] * centroid[2] > 0, '存在朝内三角');
    });
  });

  it('顺时针轮廓同样生成外向网格（内部翻转绕序）', () => {
    const clockwise: readonly Point2[] = [...SQUARE].reverse();
    const mesh = extrudeMesh(clockwise, 5);
    const interior: readonly [number, number, number] = [2, 2.5, 1.5];
    eachTriangle(mesh, (tri) => {
      const n = normal(tri);
      const centroid: readonly [number, number, number] = [
        (tri[0][0] + tri[1][0] + tri[2][0]) / 3 - interior[0],
        (tri[0][1] + tri[1][1] + tri[2][1]) / 3 - interior[1],
        (tri[0][2] + tri[1][2] + tri[2][2]) / 3 - interior[2],
      ];
      assert.ok(n[0] * centroid[0] + n[1] * centroid[1] + n[2] * centroid[2] > 0, '反向轮廓绕序错误');
    });
  });

  it('凹轮廓（L 形 / 十字形）ear clipping：2n 顶点、4n−4 三角、无退化', () => {
    for (const [outline, area] of [
      [L_SHAPE, 12],
      [CROSS, 48],
    ] as const) {
      const mesh = extrudeMesh(outline, 3, false);
      assert.equal(mesh.positions.length / 3, 2 * outline.length);
      assert.equal(mesh.indices.length / 3, 4 * outline.length - 4);
      eachTriangle(mesh, (tri) => {
        const n = normal(tri);
        assert.ok(Math.hypot(n[0], n[1], n[2]) > 0, '退化三角');
      });
      // 散度定理：闭合且绕序正确时体积 = 面积 × 高度；漏面或翻面会偏离。
      assert.ok(Math.abs(signedVolume(mesh) - area * 3) < 1e-9, `体积应等于面积×高度：${String(signedVolume(mesh))}`);
    }
  });

  it('凹轮廓顺时针同样得到正体积（内部翻转绕序）', () => {
    const clockwise: readonly Point2[] = [...L_SHAPE].reverse();
    const mesh = extrudeMesh(clockwise, 3, false);
    assert.ok(Math.abs(signedVolume(mesh) - 12 * 3) < 1e-9);
  });
});
