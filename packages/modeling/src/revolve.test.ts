/** revolveMesh 的单元测试：圆柱 / 尖端 / 双尖端计数与绕序，确保无退化三角。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeBounds } from './mesh.ts';
import { revolveEndSnapThreshold, revolveMesh, snapRevolveEnds } from './revolve.ts';
import type { RevolveSample } from './schema.ts';

function sample(r: number, h: number): RevolveSample {
  return [r, h];
}

/** 遍历三角，返回法线与顶点坐标，用于退化 / 绕序断言。 */
function triangles(mesh: { readonly positions: readonly number[]; readonly indices: readonly number[] }): {
  readonly n: readonly [number, number, number];
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  readonly c: readonly [number, number, number];
}[] {
  const out: {
    readonly n: readonly [number, number, number];
    readonly a: readonly [number, number, number];
    readonly b: readonly [number, number, number];
    readonly c: readonly [number, number, number];
  }[] = [];
  const read = (index: number): readonly [number, number, number] => {
    const base = index * 3;
    return [mesh.positions[base] ?? 0, mesh.positions[base + 1] ?? 0, mesh.positions[base + 2] ?? 0];
  };
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = read(mesh.indices[i] ?? 0);
    const b = read(mesh.indices[i + 1] ?? 0);
    const c = read(mesh.indices[i + 2] ?? 0);
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    out.push({ n: [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], a, b, c });
  }
  return out;
}

function assertNoDegenerate(mesh: {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}): void {
  for (const tri of triangles(mesh)) {
    assert.ok(Math.hypot(tri.n[0], tri.n[1], tri.n[2]) > 0, '出现退化三角');
  }
}

describe('revolveMesh', () => {
  it('圆柱：环数 × 径向段数，端部不封底且侧法线水平', () => {
    const samples = [sample(2, 0), sample(2, 2.5), sample(2, 5), sample(2, 7.5), sample(2, 10)];
    const mesh = revolveMesh(samples, 8);
    assert.equal(mesh.positions.length / 3, 5 * 8);
    assert.equal(mesh.indices.length / 3, 4 * 8 * 2);
    assert.deepEqual(computeBounds(mesh.positions), { min: [-2, 0, -2], max: [2, 10, 2] });
    assertNoDegenerate(mesh);
    for (const tri of triangles(mesh)) {
      assert.ok(Math.abs(tri.n[1]) < 1e-9, '圆柱侧面法线应水平');
      const cx = (tri.a[0] + tri.b[0] + tri.c[0]) / 3;
      const cz = (tri.a[2] + tri.b[2] + tri.c[2]) / 3;
      assert.ok(tri.n[0] * cx + tri.n[2] * cz > 0, '圆柱侧面应朝外');
    }
  });

  it('底尖：首采样半径 0 时收成单顶点扇面，无退化三角', () => {
    const samples = [sample(0, 0), sample(1, 2), sample(2, 4), sample(3, 6), sample(4, 8)];
    const mesh = revolveMesh(samples, 8);
    assert.equal(mesh.positions.length / 3, 1 + 4 * 8);
    assert.equal(mesh.indices.length / 3, 8 + 3 * 8 * 2);
    assertNoDegenerate(mesh);
  });

  it('顶尖：末采样半径 0 时同样收成单顶点', () => {
    const samples = [sample(4, 0), sample(3, 2), sample(2, 4), sample(1, 6), sample(0, 8)];
    const mesh = revolveMesh(samples, 6);
    assert.equal(mesh.positions.length / 3, 4 * 6 + 1);
    assert.equal(mesh.indices.length / 3, 3 * 6 * 2 + 6);
    assertNoDegenerate(mesh);
  });

  it('双尖端：锥形两端都收尖，仍无退化三角', () => {
    const radius = (t: number): number => (t === 0 || t === 1 ? 0 : 3);
    const samples = [0, 0.25, 0.5, 0.75, 1].map((t) => sample(radius(t), t * 8));
    const mesh = revolveMesh(samples, 12);
    assert.equal(mesh.positions.length / 3, 2 + 3 * 12);
    assertNoDegenerate(mesh);
  });

  it('径向段数被尊重', () => {
    const samples = [sample(1, 0), sample(1, 1)];
    assert.equal(revolveMesh(samples, 4).positions.length / 3, 8);
    assert.equal(revolveMesh(samples, 32).positions.length / 3, 64);
  });
});

describe('snapRevolveEnds 端部半径吸附', () => {
  it('把首 / 尾的 ~1e-16 半径吸附成精确 0，返回新数组且不改动入参', () => {
    const samples = [sample(1.3e-16, 0), sample(1, 5), sample(1.3e-16, 13)];
    const snapped = snapRevolveEnds(samples);
    assert.equal(snapped[0]?.[0], 0);
    assert.equal(snapped[2]?.[0], 0);
    assert.equal(snapped[1]?.[0], 1);
    assert.notEqual(snapped, samples);
    assert.equal(samples[0]?.[0], 1.3e-16, '不应改动传入的采样');
  });

  it('阈值 = max(1e-9, 跨度×1e-9)：1e-8 吸附、0.01 不吸附', () => {
    // 跨度 = max(水平 2×1, 竖向 20) = 20 → 阈值 2e-8。
    assert.equal(revolveEndSnapThreshold([sample(1e-8, 0), sample(1, 10), sample(1e-8, 20)]), 2e-8);
    const tiny = snapRevolveEnds([sample(1e-8, 0), sample(1, 10), sample(1e-8, 20)]);
    assert.equal(tiny[0]?.[0], 0);
    assert.equal(tiny[2]?.[0], 0);
    const normal = snapRevolveEnds([sample(0.01, 0), sample(1, 10), sample(0.01, 20)]);
    assert.equal(normal[0]?.[0], 0.01);
    assert.equal(normal[2]?.[0], 0.01);
  });

  it('半径恰为 0 时保持 0；极细部件用绝对下限 1e-9；中间采样不吸附', () => {
    const zeros = snapRevolveEnds([sample(0, 0), sample(1, 5), sample(0, 10)]);
    assert.equal(zeros[0]?.[0], 0);
    assert.equal(zeros[2]?.[0], 0);
    // 跨度 = max(2×1e-6, 1e-6) = 2e-6 → 相对阈值 2e-15，取绝对下限 1e-9：1e-10 吸附。
    assert.equal(revolveEndSnapThreshold([sample(1e-6, 0), sample(1e-6, 1e-6)]), 1e-9);
    assert.equal(snapRevolveEnds([sample(1e-10, 0), sample(1e-6, 1e-6)])[0]?.[0], 0);
    const midTiny = snapRevolveEnds([sample(1, 0), sample(1e-16, 10), sample(1, 20)]);
    assert.equal(midTiny[1]?.[0], 1e-16, '中间采样不吸附');
  });

  it('末采样 ~1e-16 半径被吸附成单尖点：少一圈顶点且无退化三角', () => {
    const radialSegments = 8;
    const samples = [sample(3, 0), sample(2, 4), sample(1.3e-16, 13)];
    const mesh = revolveMesh(samples, radialSegments);
    // 3 个采样，末采样收尖：2 环 × 8 + 1；未吸附会是 3 × 8。
    assert.equal(mesh.positions.length / 3, 2 * radialSegments + 1);
    assertNoDegenerate(mesh);
    const bothTiny = [sample(1.3e-16, 0), sample(3, 4), sample(2, 8), sample(1.3e-16, 13)];
    assert.equal(revolveMesh(bothTiny, radialSegments).positions.length / 3, 1 + 2 * radialSegments + 1);
  });
});
