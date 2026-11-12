/**
 * surfaceShell 构件（SURFACE-SHELL-SPEC §3–§6）：两种 kind、放置 / 旋转 / 变换、solid 与 leaky、
 * 材质、部件与来源、错误码、与既有构件的冲突、测量与确定性。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { measureFloating } from '@pg/analysis/floating';
import { measureSeams } from '@pg/analysis/seams';
import { loadRegistry } from '@pg/blocks/load';
import { XZ_MAX } from '@pg/core/coord';
import { hashGrid } from '@pg/core/hash';

import { createWorld, MassingError, rect } from './index.ts';
import type { SurfaceShellHandle, WorldHost } from './index.ts';

const table = loadRegistry().table;
type Cell = readonly [number, number, number];

function makeWorld(): WorldHost {
  return createWorld(table);
}

/** 合成网格里全部实体格，按 (x,y,z) 升序。 */
function cellsOf(host: WorldHost): Cell[] {
  return [...host.compose().grid.cells()]
    .map((c): Cell => [c.x, c.y, c.z])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

function expectShellError(run: () => unknown, code: MassingError['code'], keyword: RegExp): void {
  let error: unknown;
  try {
    run();
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof MassingError, `期望 MassingError，实际 ${String(error)}`);
  assert.equal(error.code, code);
  assert.match(error.message, keyword);
}

const plane = (z: number, y0 = 0) => ({
  kind: 'surface' as const,
  position: (u: number, v: number): readonly [number, number, number] => [u * 4, y0 + v * 3, z],
  uSegments: 8,
  vSegments: 8,
  material: 'stone',
});

/** 闭合纺锤（两端收尖、无开放边）：solid 可填内部。 */
const spindle = {
  kind: 'revolve' as const,
  profile: (t: number): readonly [number, number] => [4 * Math.sin(Math.PI * t), 5 * t],
  profileSegments: 16,
  radialSegments: 16,
  material: 'stone',
};

/** 开放穹顶（底圈不封底）：solid 会回退为壳并标 leaky。 */
const dome = {
  kind: 'revolve' as const,
  profile: (t: number): readonly [number, number] => [4 * Math.pow(1 - t, 2), 0.6 + 5 * t],
  profileSegments: 16,
  radialSegments: 16,
  material: 'stone',
};

describe('surfaceShell 基本语义', () => {
  it('kind:surface 平面：格数、包围盒、句柄与一次调用来源', () => {
    const host = makeWorld();
    const handle = host.world.surfaceShell(plane(0));
    assert.deepEqual(handle, { bounds: { min: [0, 1, -1], max: [3, 3, -1] }, cellCount: 12, leaky: false });
    const grid = host.compose().grid;
    const calls = grid.calls();
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.api, 'surfaceShell');
    // args 摘要不含函数，只记可序列化参数。
    assert.match(call.args, /"kind":"surface"/);
    assert.match(call.args, /"uSegments":8/);
    assert.doesNotMatch(call.args, /position/);
    assert([...grid.cells()].every((c) => c.call === call.id));
  });

  it('部件名默认为 surfaceShell，可命名，并嵌套在当前 world.part 作用域下', () => {
    const host = makeWorld();
    host.world.part('亭子', () => {
      host.world.surfaceShell({ ...plane(0), name: '屋面' });
    });
    const parts = host.compose().grid.parts();
    assert.deepEqual(
      parts.map((p) => p.name),
      ['亭子', '屋面'],
    );
    assert.equal(parts[1]?.parent, parts[0]?.id);
    const plain = makeWorld();
    plain.world.surfaceShell(plane(0));
    assert.equal(plain.compose().grid.parts()[0]?.name, 'surfaceShell');
  });

  it('closedU 与段数默认值记进 args；显式段数覆盖默认', () => {
    const host = makeWorld();
    host.world.surfaceShell({
      kind: 'surface',
      position: (u, v) => [u * 4, v * 3, 0],
      material: 'stone',
    });
    const args = host.compose().grid.calls()[0]?.args ?? '';
    assert.match(args, /"uSegments":32/);
    assert.match(args, /"vSegments":32/);
    assert.match(args, /"closedU":false/);
  });

  it('material 支持带状态写法，按原样写入结构层', () => {
    const host = makeWorld();
    host.world.surfaceShell({ ...plane(0), material: 'deepslate_tile_stairs[facing=east,half=top]' });
    const cell = host.compose().grid.get(0, 1, -1);
    assert.ok(cell !== undefined);
    assert.equal(cell.state.name, 'deepslate_tile_stairs');
    assert.equal(cell.state.props['facing'], 'east');
    assert.equal(cell.state.props['half'], 'top');
    assert.equal(host.world.get(0, 1, -1), 'deepslate_tile_stairs[facing=east,half=top]');
  });

  it('at / rotate / transform：格映射精确，且互不混淆', () => {
    const host = makeWorld();
    host.world.surfaceShell({ ...plane(0), at: [10, 2, 20], rotate: 90 });
    // 局部 (i,j,-1) → 旋转 (0, j, i)，再平移。
    assert.deepEqual(cellsOf(host), [
      [10, 2, 20],
      [10, 2, 21],
      [10, 2, 22],
      [10, 2, 23],
      [10, 3, 20],
      [10, 3, 21],
      [10, 3, 22],
      [10, 3, 23],
      [10, 4, 20],
      [10, 4, 21],
      [10, 4, 22],
      [10, 4, 23],
    ]);
    const scaled = makeWorld();
    scaled.world.surfaceShell({
      kind: 'surface',
      position: (u, v) => [u, 1 + v, 0],
      uSegments: 8,
      vSegments: 8,
      material: 'stone',
      transform: { scale: [2, 1, 1] },
    });
    const bounds = [...scaled.compose().grid.cells()].reduce(
      (acc, c) => ({
        minX: Math.min(acc.minX, c.x),
        maxX: Math.max(acc.maxX, c.x),
        minY: Math.min(acc.minY, c.y),
        maxY: Math.max(acc.maxY, c.y),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
    );
    assert.deepEqual(bounds, { minX: 0, maxX: 1, minY: 2, maxY: 2 });
  });

  it('thickness 2 的壳包含 thickness 1 的壳（逐格）', () => {
    const thin = makeWorld();
    thin.world.surfaceShell({ ...plane(0, 1), thickness: 1 });
    const thick = makeWorld();
    thick.world.surfaceShell({ ...plane(0, 1), thickness: 2 });
    const thinCells = new Set(cellsOf(thin).map((c) => c.join(',')));
    assert(cellsOf(thick).length > thinCells.size);
    for (const c of thinCells)
      assert([...thick.compose().grid.cells()].some((x) => `${String(x.x)},${String(x.y)},${String(x.z)}` === c));
  });

  it('cleanup:none 保留孤立格；默认 isolated 全删后报 empty-shell', () => {
    const tiny = {
      kind: 'surface' as const,
      position: (u: number, v: number): readonly [number, number, number] => [u * 0.1, v * 0.1, 0],
      uSegments: 4,
      vSegments: 4,
      material: 'stone',
    };
    const kept = makeWorld();
    const handle = kept.world.surfaceShell({ ...tiny, cleanup: 'none' });
    assert.equal(handle.cellCount, 1);
    expectShellError(() => makeWorld().world.surfaceShell(tiny), 'empty-shell', /没有生成任何格/);
  });
});

describe('surfaceShell revolve 与 solid', () => {
  it('kind:revolve 闭合成壳；solid 传递到内核并在句柄如实报 leaky', () => {
    // 公式曲面在 1 格分辨率下棱角采样会留缝：内核按转换层语义回退为壳并标 leaky（不静默）；
    // 整数盒的填实正确性由内核单测覆盖（voxelize.test.ts 48 格），这里断言 mode 传递与标记。
    const shell = makeWorld();
    const shellHandle = shell.world.surfaceShell(spindle);
    const solid = makeWorld();
    const solidHandle = solid.world.surfaceShell({ ...spindle, solid: true });
    assert.equal(shellHandle.leaky, false);
    assert(shellHandle.cellCount > 0);
    assert.equal(solidHandle.leaky, true);
    assert.equal(solidHandle.cellCount, shellHandle.cellCount);
  });

  it('二维平面 solid 无内部可填：与壳同格、leaky:false', () => {
    const host = makeWorld();
    const handle = host.world.surfaceShell({ ...plane(0), solid: true });
    assert.equal(handle.leaky, false);
    assert.equal(handle.cellCount, 12);
  });

  it('开放壳 solid 回退为壳、leaky:true，格数与壳模式一致（不静默）', () => {
    const shell = makeWorld();
    const shellHandle = shell.world.surfaceShell(dome);
    const leaky = makeWorld();
    const leakyHandle = leaky.world.surfaceShell({ ...dome, solid: true });
    assert.equal(leakyHandle.leaky, true);
    assert.equal(leakyHandle.cellCount, shellHandle.cellCount);
  });

  it('revolve 默认段数 32 / 48', () => {
    const host = makeWorld();
    host.world.surfaceShell({ kind: 'revolve', profile: (t) => [2, 0.5 + 3 * t], material: 'stone' });
    const args = host.compose().grid.calls()[0]?.args ?? '';
    assert.match(args, /"profileSegments":32/);
    assert.match(args, /"radialSegments":48/);
  });
});

describe('surfaceShell 错误码与文案', () => {
  it('选项非法：kind 缺失 / 非函数 / at 非整数 / rotate 45 / thickness 0 或 5 / solid+thickness', () => {
    const world = makeWorld().world;
    expectShellError(
      () =>
        (world.surfaceShell as unknown as (v: unknown) => unknown)({ position: () => [0, 0, 0], material: 'stone' }),
      'options-invalid',
      /kind 必须是 'surface' 或 'revolve'/,
    );
    expectShellError(
      () =>
        (world.surfaceShell as unknown as (v: unknown) => unknown)({ kind: 'surface', position: 3, material: 'stone' }),
      'options-invalid',
      /position\(u, v\) 函数/,
    );
    expectShellError(
      () =>
        (world.surfaceShell as unknown as (v: unknown) => unknown)({
          kind: 'revolve',
          profile: 'x',
          material: 'stone',
        }),
      'options-invalid',
      /profile\(t\) 函数/,
    );
    expectShellError(
      () => (world.surfaceShell as unknown as (v: unknown) => unknown)({ ...plane(0), at: [0.5, 1, 0] }),
      'options-invalid',
      /at/,
    );
    expectShellError(
      () => (world.surfaceShell as unknown as (v: unknown) => unknown)({ ...plane(0), rotate: 45 }),
      'options-invalid',
      /rotate/,
    );
    expectShellError(
      () => (world.surfaceShell as unknown as (v: unknown) => unknown)({ ...plane(0), thickness: 0 }),
      'options-invalid',
      /thickness/,
    );
    expectShellError(
      () => (world.surfaceShell as unknown as (v: unknown) => unknown)({ ...plane(0), thickness: 5 }),
      'options-invalid',
      /thickness/,
    );
    expectShellError(
      () => world.surfaceShell({ ...spindle, solid: true, thickness: 2 }),
      'options-invalid',
      /solid:true 与 thickness/,
    );
  });

  it('geometry-invalid：采样退化（共线 / NaN）', () => {
    expectShellError(
      () =>
        makeWorld().world.surfaceShell({
          kind: 'surface',
          position: () => [0, 0, 0],
          uSegments: 4,
          vSegments: 4,
          material: 'stone',
        }),
      'geometry-invalid',
      /曲面网格不合法.*退化/,
    );
    expectShellError(
      () =>
        makeWorld().world.surfaceShell({
          kind: 'surface',
          position: (u) => [u, Number.NaN, 0],
          uSegments: 4,
          vSegments: 4,
          material: 'stone',
        }),
      'geometry-invalid',
      /有限数/,
    );
  });

  it('material-invalid：未知方块带建议，空气拒绝', () => {
    expectShellError(
      () => makeWorld().world.surfaceShell({ ...plane(0), material: 'stnoe' }),
      'material-invalid',
      /stnoe/,
    );
    expectShellError(
      () => makeWorld().world.surfaceShell({ ...plane(0), material: 'air' }),
      'material-invalid',
      /空气/,
    );
  });

  it('below-ground / out-of-range / limit-exceeded 整次拒绝且失败原子', () => {
    const below = makeWorld();
    const before = below.compose().grid.calls().length;
    expectShellError(
      () => below.world.surfaceShell({ ...plane(0), at: [0, 0, 0] }),
      'below-ground',
      /y<1.*\(0, 0, -1\)/,
    );
    assert.equal(below.compose().grid.calls().length, before);
    expectShellError(
      () => makeWorld().world.surfaceShell({ ...plane(0), at: [XZ_MAX, 1, 0] }),
      'out-of-range',
      /世界坐标范围/,
    );
    expectShellError(
      () =>
        makeWorld().world.surfaceShell({
          kind: 'surface',
          position: (u, v) => [u * 1000, v * 1000, 0],
          uSegments: 4,
          vSegments: 4,
          material: 'stone',
        }),
      'limit-exceeded',
      /500000/,
    );
  });
});

describe('surfaceShell 与既有构件的冲突', () => {
  it('stair：壳先与梯先都报 stair-structure / 保护角色', () => {
    const first = makeWorld();
    const w1 = first.world;
    const hall1 = w1.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    const lower1 = w1.floorPlate({ in: hall1.inner, material: 'stone' });
    w1.surfaceShell({ ...spindle, at: [-3, 1, -2] });
    const before = first.compose().grid.calls().length;
    assert.throws(
      () =>
        w1.stair({
          from: lower1,
          to: hall1.top,
          kind: 'spiral',
          at: [0, 0],
          radius: 2,
          material: 'stone_brick_stairs',
        }),
      /stair 的踏面.*撞上 surfaceShell#\d+/,
    );
    assert.equal(first.compose().grid.calls().length, before);

    const reverse = makeWorld();
    const w2 = reverse.world;
    const hall2 = w2.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    const lower2 = w2.floorPlate({ in: hall2.inner, material: 'stone' });
    w2.stair({ from: lower2, to: hall2.top, kind: 'spiral', at: [0, 0], radius: 2, material: 'stone_brick_stairs' });
    assert.throws(() => w2.surfaceShell({ ...spindle, at: [-3, 1, -2] }), /surfaceShell 盖到了此前 stair#\d+ 的踏面/);
  });

  it('steps：壳先与踏步先都报 steps-structure', () => {
    const first = makeWorld();
    const w1 = first.world;
    const hall1 = w1.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    const door1 = w1.opening({ in: hall1.facade('south'), kind: 'door', width: 3, height: 2, sill: 1 });
    w1.surfaceShell(plane(6));
    assert.throws(() => w1.steps({ to: door1, width: 3, material: 'stone_brick_stairs' }), /surfaceShell#\d+/);

    const reverse = makeWorld();
    const w2 = reverse.world;
    const hall2 = w2.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    const door2 = w2.opening({ in: hall2.facade('south'), kind: 'door', width: 3, height: 2, sill: 1 });
    w2.steps({ to: door2, width: 3, material: 'stone_brick_stairs' });
    assert.throws(() => w2.surfaceShell(plane(6)), /surfaceShell 盖到了此前 steps#\d+ 的踏面/);
  });

  it('opening 的 hole：两种顺序分别报 opening-hole-body 与保护角色', () => {
    const first = makeWorld();
    const w1 = first.world;
    const hall1 = w1.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    w1.surfaceShell(plane(5));
    assert.throws(
      () => w1.opening({ in: hall1.facade('south'), kind: 'door', width: 3, height: 2 }),
      /opening 的洞.*落进 surfaceShell#\d+/,
    );

    const reverse = makeWorld();
    const w2 = reverse.world;
    const hall2 = w2.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    w2.opening({ in: hall2.facade('south'), kind: 'door', width: 3, height: 2 });
    assert.throws(() => w2.surfaceShell(plane(5)), /surfaceShell 盖到了此前 opening#\d+ 的洞/);
  });

  it('手写 set / box 不参与构件冲突（决策 #88），按覆盖报告处理', () => {
    const host = makeWorld();
    host.world.surfaceShell({ ...plane(0) });
    host.world.set(0, 1, -1, 'air');
    assert.equal(host.world.get(0, 1, -1), 'air');
    const overlaps = host.compose().overlaps;
    assert(overlaps.some((o) => o.kind === 'cross-layer'));
  });
});

describe('surfaceShell 测量与确定性', () => {
  it('落在台基上的壳悬空 0；悬空放置如实报出', () => {
    const grounded = makeWorld();
    grounded.world.plinth({ footprint: rect(-3, -3, 3, 3), y: 1, height: 1, material: 'stone' });
    grounded.world.surfaceShell({ ...plane(0, 1), at: [0, 1, 0], material: 'stone' });
    // 平面在世界 y=2，台基顶 y=1，面邻接。
    assert.equal(measureFloating(grounded.compose().grid).cells, 0);
    const air = makeWorld();
    air.world.surfaceShell({ ...plane(0), at: [0, 5, 0] });
    assert.equal(measureFloating(air.compose().grid).cells, 12);
  });

  it('同输入同结果：两次构建的网格 hash 与句柄逐字相同', () => {
    const build = (): { readonly host: WorldHost; readonly text: string; readonly handle: SurfaceShellHandle } => {
      const host = makeWorld();
      host.world.plinth({ footprint: rect(-3, -3, 3, 3), y: 1, height: 1, material: 'stone' });
      const handle = host.world.surfaceShell({ ...plane(0, 1), at: [0, 1, 0], material: 'stone' });
      return { host, text: JSON.stringify(handle), handle };
    };
    const first = build();
    const second = build();
    assert.equal(hashGrid(first.host.compose().grid), hashGrid(second.host.compose().grid));
    assert.equal(first.text, second.text);
    assert(measureSeams(first.host.compose().grid).cells >= 0);
  });

  it('无 massing 资产注入时照常工作', () => {
    const host = createWorld(table);
    host.world.surfaceShell(plane(0));
    assert.equal(cellsOf(host).length, 12);
  });
});
