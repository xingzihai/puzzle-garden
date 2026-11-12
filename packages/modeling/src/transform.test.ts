/** transform 的单元测试：缺省解析、平移 / 缩放、Euler XYZ 旋转（对独立矩阵乘法的参照）。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TransformDocument } from './schema.ts';
import { applyTransform, resolveTransform } from './transform.ts';

type Vec = readonly [number, number, number];

function mesh(vertices: readonly Vec[]): { readonly positions: number[]; readonly indices: number[] } {
  return { positions: vertices.flatMap((v) => [v[0], v[1], v[2]]), indices: [] };
}

function doc(translate: Vec, rotate: Vec, scale: Vec): TransformDocument {
  return { translate, rotate, scale };
}

function approx(actual: readonly number[], expected: readonly Vec[]): void {
  assert.equal(actual.length, expected.length * 3);
  expected.forEach((v, i) => {
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(
        Math.abs((actual[i * 3 + axis] ?? 0) - (v[axis] ?? 0)) < 1e-9,
        `第 ${String(i)} 点第 ${String(axis)} 轴不符`,
      );
    }
  });
}

// —— 参照实现：显式构造 Rx、Ry、Rz 并按 Rx·Ry·Rz 相乘，独立于 transform.ts 的展开式。 ——
function rotationX(a: number): number[][] {
  return [
    [1, 0, 0],
    [0, Math.cos(a), -Math.sin(a)],
    [0, Math.sin(a), Math.cos(a)],
  ];
}
function rotationY(a: number): number[][] {
  return [
    [Math.cos(a), 0, Math.sin(a)],
    [0, 1, 0],
    [-Math.sin(a), 0, Math.cos(a)],
  ];
}
function rotationZ(a: number): number[][] {
  return [
    [Math.cos(a), -Math.sin(a), 0],
    [Math.sin(a), Math.cos(a), 0],
    [0, 0, 1],
  ];
}
function multiply(a: readonly number[][], b: readonly number[][]): number[][] {
  return [0, 1, 2].map((row) =>
    [0, 1, 2].map(
      (col) =>
        (a[row]?.[0] ?? 0) * (b[0]?.[col] ?? 0) +
        (a[row]?.[1] ?? 0) * (b[1]?.[col] ?? 0) +
        (a[row]?.[2] ?? 0) * (b[2]?.[col] ?? 0),
    ),
  );
}
function reference(rotate: Vec, p: Vec): Vec {
  const m = multiply(multiply(rotationX(rotate[0]), rotationY(rotate[1])), rotationZ(rotate[2]));
  return [
    (m[0]?.[0] ?? 0) * p[0] + (m[0]?.[1] ?? 0) * p[1] + (m[0]?.[2] ?? 0) * p[2],
    (m[1]?.[0] ?? 0) * p[0] + (m[1]?.[1] ?? 0) * p[1] + (m[1]?.[2] ?? 0) * p[2],
    (m[2]?.[0] ?? 0) * p[0] + (m[2]?.[1] ?? 0) * p[1] + (m[2]?.[2] ?? 0) * p[2],
  ];
}

describe('resolveTransform', () => {
  it('缺省为单位变换', () => {
    assert.deepEqual(resolveTransform(undefined), doc([0, 0, 0], [0, 0, 0], [1, 1, 1]));
  });

  it('补齐缺省分量并保留给定分量', () => {
    assert.deepEqual(resolveTransform({ translate: [1, 2, 3] }), doc([1, 2, 3], [0, 0, 0], [1, 1, 1]));
    assert.deepEqual(
      resolveTransform({ rotate: [0.5, 0, 0], scale: [2, 2, 2] }),
      doc([0, 0, 0], [0.5, 0, 0], [2, 2, 2]),
    );
  });
});

describe('applyTransform', () => {
  it('单位变换保持顶点', () => {
    const out = applyTransform(mesh([[1, 2, 3]]), doc([0, 0, 0], [0, 0, 0], [1, 1, 1]));
    approx(out.positions, [[1, 2, 3]]);
  });

  it('先缩放、再旋转、最后平移', () => {
    const out = applyTransform(mesh([[1, 1, 0]]), doc([10, 0, 0], [0, 0, Math.PI / 2], [2, 3, 1]));
    // 缩放 (2,3,0) → 绕 z 转 90° 得 (-3,2,0) → 平移 +10x → (7,2,0)。
    approx(out.positions, [[7, 2, 0]]);
  });

  it('绕单轴旋转符合右手系', () => {
    approx(applyTransform(mesh([[0, 1, 0]]), doc([0, 0, 0], [Math.PI / 2, 0, 0], [1, 1, 1])).positions, [[0, 0, 1]]);
    approx(applyTransform(mesh([[1, 0, 0]]), doc([0, 0, 0], [0, Math.PI / 2, 0], [1, 1, 1])).positions, [[0, 0, -1]]);
    approx(applyTransform(mesh([[1, 0, 0]]), doc([0, 0, 0], [0, 0, Math.PI / 2], [1, 1, 1])).positions, [[0, 1, 0]]);
  });

  it('复合旋转与 Rx·Ry·Rz 参照一致', () => {
    const rotate: Vec = [0.3, -0.7, 1.1];
    const points: readonly Vec[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [2, -3, 4],
    ];
    const out = applyTransform(mesh(points), doc([1, -2, 0.5], rotate, [1.5, 0.5, 2]));
    const expected = points.map((p) => {
      const r = reference(rotate, [p[0] * 1.5, p[1] * 0.5, p[2] * 2]);
      return [r[0] + 1, r[1] - 2, r[2] + 0.5] as Vec;
    });
    approx(out.positions, expected);
  });

  it('不修改原网格，且复制索引', () => {
    const input = { positions: [1, 2, 3], indices: [0, 0, 0] };
    const out = applyTransform(input, doc([5, 0, 0], [0, 0, 0], [1, 1, 1]));
    assert.deepEqual(input.positions, [1, 2, 3]);
    assert.notEqual(out.positions, input.positions);
    assert.notEqual(out.indices, input.indices);
    assert.deepEqual(out.indices, [0, 0, 0]);
  });

  it('把 -0 规范成 0', () => {
    const out = applyTransform(mesh([[-0, 0, 0]]), doc([0, 0, 0], [0, 0, Math.PI], [1, 1, 1]));
    assert.equal(Object.is(out.positions[0], 0), true);
  });
});
