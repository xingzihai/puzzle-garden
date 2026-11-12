/**
 * 参数化采样（M3）：surface / revolve 的采样、收尖、端部吸附、变换与错误文案；
 * 这些语义从 model.ts 抽出后由 model.test.ts 与 shell.test.ts 共同依赖。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelError } from './errors.ts';
import { sampleRevolve, sampleSurface } from './parametric.ts';

const TAU = Math.PI * 2;

function expectModelError(run: () => unknown, keyword: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ModelError, `期望 ModelError，实际 ${String(error)}`);
    assert.match(error.message, keyword);
    return true;
  });
}

describe('sampleSurface', () => {
  it('平面片：顶点数与包围盒可手算，source 参数通过 schema', () => {
    const sampled = sampleSurface({
      position: (u: number, v: number) => [u * 4, v * 3, 0],
      uSegments: 4,
      vSegments: 6,
    });
    assert.equal(sampled.positions.length, 5 * 7 * 3);
    assert.equal(sampled.indices.length, 4 * 6 * 6);
    assert.deepEqual(sampled.bounds, { min: [0, 0, 0], max: [4, 3, 0] });
    assert.deepEqual(sampled.parameters, {
      uSegments: 4,
      vSegments: 6,
      closedU: false,
      transform: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
    });
  });

  it('closedU 只采样 uSegments 列（不复制缝合列）', () => {
    const open = sampleSurface({ position: (u: number, v: number) => [u, v, 0], uSegments: 8, vSegments: 4 });
    const closed = sampleSurface({
      position: (u: number, v: number) => [u, v, 0],
      uSegments: 8,
      vSegments: 4,
      closedU: true,
    });
    assert.equal(open.positions.length, 9 * 5 * 3);
    assert.equal(closed.positions.length, 8 * 5 * 3);
  });

  it('v 端整行重合时自动收成尖点（closedU 纺锤形）', () => {
    const sampled = sampleSurface({
      position: (u: number, v: number) => [Math.cos(u * TAU) * v, v, Math.sin(u * TAU) * v],
      uSegments: 12,
      vSegments: 5,
      closedU: true,
    });
    // 底行塌缩成一个顶点：1 + 12×5 = 61。
    assert.equal(sampled.positions.length, 61 * 3);
    assert.deepEqual(sampled.bounds, { min: [-1, 0, -1], max: [1, 1, 1] });
  });

  it('transform 在采样后作用于网格并记进 source', () => {
    const sampled = sampleSurface({
      position: (u: number, v: number) => [u, v, 0],
      uSegments: 4,
      vSegments: 4,
      transform: { translate: [1, 2, 3], scale: [2, 1, 1] },
    });
    assert.deepEqual(sampled.bounds, { min: [1, 2, 3], max: [3, 3, 3] });
    assert.deepEqual(sampled.parameters.transform.translate, [1, 2, 3]);
    assert.deepEqual(sampled.parameters.transform.scale, [2, 1, 1]);
  });

  it('position 不是函数 / 抛错 / 返回非法值都报中文可行动错误', () => {
    expectModelError(() => sampleSurface({ position: 3, uSegments: 4, vSegments: 4 }), /必须是 .*函数/);
    expectModelError(
      () =>
        sampleSurface({
          position: (u: number) => {
            if (u > 0.5) throw new Error('boom');
            return [u, 0, 0];
          },
          uSegments: 4,
          vSegments: 4,
        }),
      /抛错：boom/,
    );
    expectModelError(() => sampleSurface({ position: () => [Number.NaN, 0, 0], uSegments: 4, vSegments: 4 }), /有限数/);
    expectModelError(
      () => sampleSurface({ position: () => [Number.POSITIVE_INFINITY, 0, 0], uSegments: 4, vSegments: 4 }),
      /有限数/,
    );
    expectModelError(() => sampleSurface({ position: () => [100001, 0, 0], uSegments: 4, vSegments: 4 }), /有限数/);
  });

  it('段数越界在 source 二次校验前就被参数 schema 拒绝（由调用方负责范围）', () => {
    expectModelError(
      () => sampleSurface({ position: () => [0, 0, 0], uSegments: 2, vSegments: 4 }),
      /采样参数非法|uSegments/,
    );
  });
});

describe('sampleRevolve', () => {
  it('缺省段数 32 / 48，圆台网格顶点数与参数一致', () => {
    const sampled = sampleRevolve({ profile: (t: number) => [1 + t, t] });
    assert.equal(sampled.parameters.profileSegments, 32);
    assert.equal(sampled.parameters.radialSegments, 48);
    assert.equal(sampled.parameters.sampledProfile.length, 33);
    assert.equal(sampled.positions.length, 33 * 48 * 3);
    assert.deepEqual(sampled.bounds, { min: [-2, 0, -2], max: [2, 1, 2] });
  });

  it('端部近零半径吸附成精确 0，走单尖点路径（D2 教训）', () => {
    const sampled = sampleRevolve({
      profile: (t: number) => [4 * (1 - t), t],
      profileSegments: 4,
      radialSegments: 8,
    });
    const last = sampled.parameters.sampledProfile.at(-1);
    assert.deepEqual(last, [0, 1]);
    // 尾端一圈 8 个顶点收成 1 个：4 环 + 1 尖。
    assert.equal(sampled.positions.length, (4 * 8 + 1) * 3);
  });

  it('profile 非函数 / 抛错 / 返回非法值 / 轮廓违规都报中文错误', () => {
    expectModelError(() => sampleRevolve({ profile: 'x' }), /必须是 .*函数/);
    expectModelError(
      () =>
        sampleRevolve({
          profile: (t: number) => {
            if (t > 0.5) throw new Error('nope');
            return [1, t];
          },
        }),
      /抛错：nope/,
    );
    expectModelError(() => sampleRevolve({ profile: () => [1] }), /两个有限数字/);
    expectModelError(
      () => sampleRevolve({ profile: (t: number) => [-1, t], profileSegments: 4, radialSegments: 4 }),
      /半径必须 ≥ 0/,
    );
    expectModelError(
      () => sampleRevolve({ profile: (t: number) => [1 - t * 2, 0], profileSegments: 4, radialSegments: 4 }),
      /高度必须沿采样严格递增/,
    );
    expectModelError(
      () =>
        sampleRevolve({
          profile: (t: number) => [t === 0 || t === 1 ? 1 : 0, t],
          profileSegments: 4,
          radialSegments: 4,
        }),
      /中间采样不得半径为 0/,
    );
  });

  it('transform 记进 source 并作用于网格', () => {
    const sampled = sampleRevolve({
      profile: (t: number) => [1, t],
      profileSegments: 4,
      radialSegments: 8,
      transform: { translate: [5, 0, 0] },
    });
    assert.deepEqual(sampled.parameters.transform.translate, [5, 0, 0]);
    assert.equal(sampled.bounds.min[0], 4);
    assert.equal(sampled.bounds.max[0], 6);
  });

  it('同输入同输出：两次采样逐位相同', () => {
    const options = { profile: (t: number) => [2 * (1 - t), 3 * t], profileSegments: 8, radialSegments: 12 };
    const a = sampleRevolve(options);
    const b = sampleRevolve(options);
    assert.deepEqual(a.positions, b.positions);
    assert.deepEqual(a.indices, b.indices);
  });
});
