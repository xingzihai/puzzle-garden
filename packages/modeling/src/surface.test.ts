/** surface 的单元测试：采样网格计数 / 闭合跨接、source 记录、六角大尺度环、错误与 float32 退化。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelError } from './errors.ts';
import { createModel } from './model.ts';
import type { SurfaceOptions } from './model.ts';
import { ABS_MAX, ModelDocument } from './schema.ts';
import { surfaceMesh } from './surface.ts';

function base(id: string) {
  return { id, name: '曲面', role: 'roof' as const, color: '#8899aa' };
}

/** 读出三角 (t) 的三个顶点下标。 */
function tri(mesh: { readonly indices: readonly number[] }, t: number): readonly [number, number, number] {
  return [mesh.indices[t * 3] ?? -1, mesh.indices[t * 3 + 1] ?? -1, mesh.indices[t * 3 + 2] ?? -1];
}

/** 断言所有三角在 f64 下非退化（叉积非零）。 */
function assertNoDegenerate(mesh: {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}): void {
  const read = (index: number): readonly [number, number, number] => [
    mesh.positions[index * 3] ?? 0,
    mesh.positions[index * 3 + 1] ?? 0,
    mesh.positions[index * 3 + 2] ?? 0,
  ];
  for (let t = 0; t < mesh.indices.length / 3; t += 1) {
    const [ia, ib, ic] = tri(mesh, t);
    const a = read(ia);
    const b = read(ib);
    const c = read(ic);
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    assert.ok(Math.hypot(nx, ny, nz) > 0, `第 ${String(t)} 个三角退化`);
  }
}

/** 生成一张各列行都离散的采样网格，避免端点行被误判为重合。 */
function grid(columns: number, rows: number): [number, number, number][] {
  return Array.from({ length: columns * rows }, (_unused, index) => {
    const i = Math.floor(index / rows);
    const j = index % rows;
    return [i, j, 0];
  });
}

describe('surfaceMesh 采样网格', () => {
  it('closedU=false：顶点数 (uSeg+1)(vSeg+1)、三角数 2·uSeg·vSeg', () => {
    const uSeg = 4;
    const vSeg = 4;
    const columns = uSeg + 1;
    const samples = grid(columns, vSeg + 1);
    const mesh = surfaceMesh(samples, uSeg, vSeg, false);
    assert.equal(mesh.positions.length / 3, (uSeg + 1) * (vSeg + 1));
    assert.equal(mesh.indices.length / 3, 2 * uSeg * vSeg);
  });

  it('closedU=true：顶点数 uSeg·(vSeg+1)，末列跨接到第 0 列（不复制缝合列）', () => {
    const uSeg = 4;
    const vSeg = 4;
    const rows = vSeg + 1;
    const samples = grid(uSeg, rows);
    const mesh = surfaceMesh(samples, uSeg, vSeg, true);
    assert.equal(mesh.positions.length / 3, uSeg * rows);
    assert.equal(mesh.indices.length / 3, 2 * uSeg * vSeg);
    // 末列 i=uSeg−1 与第 0 列跨接：存在三角同时引用两列。
    let crossed = false;
    for (let t = 0; t < mesh.indices.length / 3; t += 1) {
      const [a, b, c] = tri(mesh, t);
      const lastBase = (uSeg - 1) * rows;
      const usesLast = a >= lastBase || b >= lastBase || c >= lastBase;
      const usesFirst = a < rows || b < rows || c < rows;
      if (usesLast && usesFirst) crossed = true;
    }
    assert.equal(crossed, true, '闭合网格应存在末列与首列跨接的三角');
  });
});

describe('surfaceMesh v 端整行塌缩', () => {
  /** 在离散网格基础上把某一行整体替换，用来构造“重合 / 差一点”的行。 */
  function withRow(
    columns: number,
    rows: number,
    row: number,
    point: (i: number) => [number, number, number],
  ): [number, number, number][] {
    return Array.from({ length: columns * rows }, (_unused, index) => {
      const i = Math.floor(index / rows);
      const j = index % rows;
      return j === row ? point(i) : ([i * 1000, j, 0] as [number, number, number]);
    });
  }

  /** 统计引用了某顶点的三角个数。 */
  function trianglesUsing(mesh: { readonly indices: readonly number[] }, vertex: number): number {
    let count = 0;
    for (let t = 0; t < mesh.indices.length / 3; t += 1) {
      const [a, b, c] = tri(mesh, t);
      if (a === vertex || b === vertex || c === vertex) count += 1;
    }
    return count;
  }

  it('v=0 行在容差内重合：收成单尖点，扇面连接第 1 行', () => {
    const uSeg = 4;
    const vSeg = 4;
    const rows = vSeg + 1;
    const columns = uSeg + 1;
    // 非端行的 x 跨到 4000 → 阈值 4e-6；v=0 行三轴极差 4e-7 ≤ 阈值 → 塌缩。
    const samples = withRow(columns, rows, 0, (i) => [i * 1e-7, 0, 0]);
    const mesh = surfaceMesh(samples, uSeg, vSeg, false);
    // 1 个尖点 + 其余 4 行各 columns 个顶点。
    assert.equal(mesh.positions.length / 3, 1 + columns * (rows - 1));
    // 底扇面 uSeg 个 + 其余 vSeg−1 普通带各 2·uSeg 个。
    assert.equal(mesh.indices.length / 3, uSeg + 2 * uSeg * (vSeg - 1));
    // 尖点是单个共享顶点：被恰好 uSeg 个扇面三角引用。
    assert.equal(trianglesUsing(mesh, 0), uSeg);
  });

  it('细行恰好未达阈值：不塌缩，仍走普通路径', () => {
    const uSeg = 4;
    const vSeg = 4;
    const rows = vSeg + 1;
    const columns = uSeg + 1;
    // 非端行 x 跨到 4000 → 阈值 4e-6；v=0 行三轴极差 8e-6 > 阈值 → 不塌缩。
    const samples = withRow(columns, rows, 0, (i) => [i * 2e-6, 0, 0]);
    const mesh = surfaceMesh(samples, uSeg, vSeg, false);
    assert.equal(mesh.positions.length / 3, columns * rows);
    assert.equal(mesh.indices.length / 3, 2 * uSeg * vSeg);
  });

  it('纺锤形：两端都重合时各收一个尖点', () => {
    const uSeg = 6;
    const vSeg = 4;
    const rows = vSeg + 1;
    const columns = uSeg;
    const samples = withRow(columns, rows, 0, () => [0, 0, 0]);
    for (let i = 0; i < columns; i += 1) samples[i * rows + vSeg] = [0, 0, 4];
    const mesh = surfaceMesh(samples, uSeg, vSeg, true);
    assert.equal(mesh.positions.length / 3, 2 + columns * (rows - 2));
    assert.equal(mesh.indices.length / 3, 2 * uSeg + 2 * uSeg * (vSeg - 2));
    // 两个尖点是不同顶点，各被 uSeg 个扇面三角引用。
    const bottomApex = 0;
    const topApex = rows - 1; // i=0 列压入：底尖、中间行、顶尖。
    assert.notEqual(mesh.positions[bottomApex * 3 + 2], mesh.positions[topApex * 3 + 2]);
    assert.equal(trianglesUsing(mesh, bottomApex), uSeg);
    assert.equal(trianglesUsing(mesh, topApex), uSeg);
  });
});

describe('createModel surface', () => {
  it('记录 source（含 resolved closedU 与 transform）并按公式生成网格', () => {
    const model = createModel();
    model.surface({ ...base('s'), uSegments: 8, vSegments: 4, position: (u, v) => [u, 0, v] });
    const part = model.finish().parts[0];
    assert.ok(part);
    assert.deepEqual(part.source, {
      operation: 'surface',
      parameters: {
        uSegments: 8,
        vSegments: 4,
        closedU: false,
        transform: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
      },
    });
    assert.equal(part.positions.length / 3, (8 + 1) * (4 + 1));
    assert.deepEqual(part.bounds, { min: [0, 0, 0], max: [1, 0, 1] });
  });

  it('closedU=true 不在 u=1 采样缝合列，f32 校验通过', () => {
    const model = createModel();
    assert.doesNotThrow(() => {
      model.surface({
        ...base('tube'),
        uSegments: 16,
        vSegments: 4,
        closedU: true,
        position: (u, v) => {
          if (u === 1) throw new Error('closedU 不应采样 u=1 的缝合列');
          const theta = 2 * Math.PI * u;
          return [Math.cos(theta), v, Math.sin(theta)];
        },
      });
    });
    const part = model.finish().parts[0];
    assert.ok(part);
    assert.ok(part.source.operation === 'surface');
    assert.equal(part.source.parameters.closedU, true);
    assert.equal(part.positions.length / 3, 16 * (4 + 1));
  });

  it('六角调制平面环：大尺度下 float32 校验通过', () => {
    const R = 40000;
    const hexFactor = (theta: number): number => {
      const deg = ((theta * 180) / Math.PI) % 60;
      const m = deg < 0 ? deg + 60 : deg;
      const arg = ((m - 30) * Math.PI) / 180;
      return 1 / Math.cos(arg);
    };
    const model = createModel();
    model.surface({
      ...base('hex-ring'),
      role: 'roof',
      uSegments: 128,
      vSegments: 16,
      closedU: true,
      position: (u, v) => {
        const theta = 2 * Math.PI * u;
        const r = (10000 + (R - 10000) * v) * hexFactor(theta);
        return [r * Math.cos(theta), 0, r * Math.sin(theta)];
      },
    });
    const document = model.finish();
    const part = document.parts[0];
    assert.ok(part);
    const maxAbs = Math.max(
      Math.abs(part.bounds.min[0]),
      Math.abs(part.bounds.max[0]),
      Math.abs(part.bounds.min[2]),
      Math.abs(part.bounds.max[2]),
    );
    assert.ok(maxAbs < ABS_MAX, '大尺度六角环仍在绝对坐标上限内');
    const reparsed = ModelDocument.safeParse(JSON.parse(JSON.stringify(document)));
    assert.equal(reparsed.success, true, `float32 下应通过：${JSON.stringify(reparsed.error?.issues)}`);
  });

  it('穹顶：v=0 整行重合自动收成尖点，closedU=true 无退化三角且 f32 通过', () => {
    const R = 6;
    const H = 10;
    const model = createModel();
    model.surface({
      ...base('dome'),
      uSegments: 16,
      vSegments: 8,
      closedU: true,
      position: (u, v) => {
        const phi = (Math.PI / 2) * v;
        const theta = 2 * Math.PI * u;
        const r = R * Math.sin(phi);
        return [r * Math.cos(theta), H * Math.cos(phi), r * Math.sin(theta)];
      },
    });
    const document = model.finish();
    const part = document.parts[0];
    assert.ok(part);
    // columns=16，v=0 收尖：1 + 16×8 = 129 顶点；底扇面 16 + 普通带 7×2×16 = 240 三角。
    assert.equal(part.positions.length / 3, 129);
    assert.equal(part.indices.length / 3, 240);
    assertNoDegenerate(part);
    // 尖点是单个顶点：y=H 只出现一次。
    let apexCount = 0;
    for (let i = 1; i < part.positions.length; i += 3) if (part.positions[i] === H) apexCount += 1;
    assert.equal(apexCount, 1);
    // createModel 已在 addPart 走 schema 的 f64 + float32 双重校验，能 finish 即通过。
    const reparsed = ModelDocument.safeParse(JSON.parse(JSON.stringify(document)));
    assert.equal(reparsed.success, true, `float32 下应通过：${JSON.stringify(reparsed.error?.issues)}`);
  });

  it('纺锤形：两端整行重合各收一个尖点，两端都无退化三角', () => {
    const A = 5;
    const H = 12;
    const model = createModel();
    model.surface({
      ...base('spindle'),
      uSegments: 8,
      vSegments: 4,
      closedU: true,
      position: (u, v) => {
        const theta = 2 * Math.PI * u;
        const r = A * 4 * v * (1 - v);
        return [r * Math.cos(theta), H * (2 * v - 1), r * Math.sin(theta)];
      },
    });
    const part = model.finish().parts[0];
    assert.ok(part);
    // columns=8；v=0、v=4 各收尖：2 + 8×3 = 26 顶点；两端扇面 8 + 普通带 2×2×8 = 48 三角。
    assert.equal(part.positions.length / 3, 26);
    assert.equal(part.indices.length / 3, 48);
    assertNoDegenerate(part);
    let top = 0;
    let bottom = 0;
    for (let i = 1; i < part.positions.length; i += 3) {
      if (part.positions[i] === H) top += 1;
      if (part.positions[i] === -H) bottom += 1;
    }
    assert.equal(top, 1);
    assert.equal(bottom, 1);
  });

  it('细行恰好未重合时仍走普通路径（小跨度下 f32 通过）', () => {
    const model = createModel();
    model.surface({
      ...base('thin-row'),
      uSegments: 4,
      vSegments: 4,
      position: (u, v) => [u, v === 0 ? u * 1e-7 : v, 0],
    });
    const part = model.finish().parts[0];
    assert.ok(part);
    // 未塌缩：完整 (4+1)(4+1)=25 顶点。
    assert.equal(part.positions.length / 3, 25);
  });
});

describe('createModel surface 错误', () => {
  it('position 非函数 / 抛错 / 非有限值 / 超限都报可读错误并指出采样位置', () => {
    const model = createModel();
    const notFunction = { ...base('s1'), uSegments: 4, vSegments: 4, position: 5 } as unknown as SurfaceOptions;
    assert.throws(() => {
      model.surface(notFunction);
    }, /position 必须是/);

    assert.throws(() => {
      model.surface({
        ...base('s2'),
        uSegments: 4,
        vSegments: 4,
        position: () => {
          throw new Error('曲面坏了');
        },
      });
    }, /曲面坏了/);

    assert.throws(
      () => {
        model.surface({ ...base('s3'), uSegments: 4, vSegments: 4, position: () => [Number.NaN, 0, 0] });
      },
      (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.match(error.message, /有限数/);
        assert.match(error.message, /u=/);
        assert.match(error.message, /v=/);
        return true;
      },
    );

    assert.throws(() => {
      model.surface({ ...base('s4'), uSegments: 4, vSegments: 4, position: () => [ABS_MAX + 1, 0, 0] });
    }, /有限数/);

    assert.throws(() => {
      model.surface({ ...base('s5'), uSegments: 4, vSegments: 4, position: () => [0, 0, Infinity] });
    }, /有限数/);
  });

  it('uSegments / vSegments 越界或非整数都拒绝', () => {
    const model = createModel();
    const position = (): readonly [number, number, number] => [0, 0, 0];
    assert.throws(() => {
      model.surface({ ...base('b1'), uSegments: 3, vSegments: 4, position });
    }, /uSegments/);
    assert.throws(() => {
      model.surface({ ...base('b2'), uSegments: 129, vSegments: 4, position });
    }, /uSegments/);
    assert.throws(() => {
      model.surface({ ...base('b3'), uSegments: 4, vSegments: 3, position });
    }, /vSegments/);
    assert.throws(() => {
      model.surface({ ...base('b4'), uSegments: 4, vSegments: 129, position });
    }, /vSegments/);
    assert.throws(() => {
      model.surface({ ...base('b5'), uSegments: 4.5, vSegments: 4, position });
    }, /uSegments/);
  });

  it('窄条曲面（跨度 2e5、末端 5e-4 细特征）在 float32 下被拒', () => {
    const X0 = -100000;
    const X1 = 100000;
    const gap = 0.0005;
    const x = (u: number): number => {
      if (u <= 0.75) return X0 + (X1 - gap - X0) * (u / 0.75);
      return X1 - gap + gap * ((u - 0.75) / 0.25);
    };
    const model = createModel();
    assert.throws(
      () => {
        model.surface({
          ...base('thin-strip'),
          uSegments: 4,
          vSegments: 4,
          position: (u, v) => [x(u), v, 0],
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.match(error.message, /渲染精度（float32）下退化/);
        assert.match(error.message, /thin-strip/);
        return true;
      },
    );
  });
});
