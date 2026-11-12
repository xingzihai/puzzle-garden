/**
 * gates 的单元测试（AGENT-SPEC §5.1）：四类判定各自的好 / 坏样本、顺序、schema 校验与文本。
 * floating 判定会自己重算 measureFloating，所以用真网格；symmetry / reach 直接构造报告对象。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReachReport } from '@pg/analysis/reach';
import type { ReachTargets } from '@pg/analysis/reach-targets';
import type { SymmetryAxis } from '@pg/analysis/symmetry';
import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Grid } from '@pg/core/grid';
import { createWorld, rect } from '@pg/geometry';

import { configuredGateCount, evaluateGates, gatesLines, gatesSchema } from './gates.ts';
import type { GateConfig, GateInput } from './gates.ts';

const registry = loadRegistry();

it('来源区域检查存活格与顶面，不允许象征调用、覆盖遮蔽或空区域', () => {
  const cfg = gatesSchema.parse({
    sourceRegions: [
      { name: '屋盖', bounds: [0, 10, 0, 2, 20, 2], apis: ['surfaceShell'], minCells: 2, minColumns: 2, minRatio: 0.8 },
    ],
  });
  const good = gridOf([
    [0, 10, 0, 'stone', 'surfaceShell'],
    [1, 10, 0, 'stone', 'surfaceShell'],
    [9, 10, 9, 'stone', 'set'],
  ]);
  assert.equal(configuredGateCount(cfg), 1);
  assert.equal(evaluateGates(cfg, inputOf(good)).passed, true);
  for (const bad of [
    gridOf([]),
    gridOf([
      [0, 10, 0, 'stone', 'surfaceShell'],
      [1, 10, 0, 'stone', 'set'],
    ]),
    gridOf([
      [0, 10, 0, 'stone', 'surfaceShell'],
      [0, 11, 0, 'stone', 'surfaceShell'],
    ]),
    gridOf([
      [0, 10, 0, 'stone', 'surfaceShell'],
      [1, 10, 0, 'stone', 'surfaceShell'],
      [0, 11, 0, 'stone', 'set'],
    ]),
  ])
    assert.equal(evaluateGates(cfg, inputOf(bad)).passed, false);
  assert.equal(
    gatesSchema.safeParse({ sourceRegions: [{ ...cfg.sourceRegions?.[0], bounds: [2, 0, 0, 1, 1, 1] }] }).success,
    false,
  );
});

describe('evaluateGates：sourceRegions 顶面按整张 grid 真正最高格判定', () => {
  const cfg = gatesSchema.parse({
    sourceRegions: [
      { name: '屋盖', bounds: [0, 10, 0, 2, 20, 2], apis: ['surfaceShell'], minCells: 2, minColumns: 2, minRatio: 0.8 },
    ],
  });

  it('原好样本仍通过：区域内两列来源允许，区域外格不干扰', () => {
    const grid = gridOf([
      [0, 10, 0, 'stone', 'surfaceShell'],
      [1, 10, 0, 'stone', 'surfaceShell'],
      [9, 10, 9, 'stone', 'set'],
    ]);
    assert.deepEqual(evaluateGates(cfg, inputOf(grid)), { passed: true, failed: [] });
  });

  it('区域内遮挡失败：bounds 内更高层非允许来源压住顶面列', () => {
    const grid = gridOf([
      [0, 10, 0, 'stone', 'surfaceShell'],
      [1, 10, 0, 'stone', 'surfaceShell'],
      [0, 11, 0, 'stone', 'set'],
    ]);
    assert.equal(evaluateGates(cfg, inputOf(grid)).passed, false);
  });

  it('区域上方遮挡失败：y1+1 被 set 全面覆盖，即使区域内格来源全对', () => {
    const grid = gridOf([
      [0, 10, 0, 'stone', 'surfaceShell'],
      [1, 10, 0, 'stone', 'surfaceShell'],
      [0, 21, 0, 'stone', 'set'],
      [1, 21, 0, 'stone', 'set'],
    ]);
    assert.equal(evaluateGates(cfg, inputOf(grid)).passed, false);
  });

  it('小比例上方遮挡在 85% 阈值内通过，收紧阈值则失败', () => {
    const build = (): Grid => {
      const entries: (readonly [number, number, number, string, string])[] = [];
      for (let x = 0; x <= 9; x += 1) entries.push([x, 10, 0, 'stone', 'surfaceShell']);
      entries.push([0, 21, 0, 'stone', 'set']); // 10 列里只有 1 列被上方宝顶遮挡
      return gridOf(entries);
    };
    const region = { name: '屋盖', bounds: [0, 10, 0, 9, 20, 0], apis: ['surfaceShell'], minCells: 1, minColumns: 1 };
    const lenient = gatesSchema.parse({ sourceRegions: [{ ...region, minRatio: 0.85 }] });
    assert.deepEqual(evaluateGates(lenient, inputOf(build())), { passed: true, failed: [] });
    const strict = gatesSchema.parse({ sourceRegions: [{ ...region, minRatio: 0.95 }] });
    assert.equal(evaluateGates(strict, inputOf(build())).passed, false);
  });

  it('区外独立格不干扰：区域外 x,z 的格不进分母', () => {
    const grid = gridOf([
      [0, 10, 0, 'stone', 'surfaceShell'],
      [1, 10, 0, 'stone', 'surfaceShell'],
      [5, 21, 5, 'stone', 'set'],
    ]);
    assert.deepEqual(evaluateGates(cfg, inputOf(grid)), { passed: true, failed: [] });
  });

  it('同 x,z 下方格不算遮挡：低于 bounds 的格不影响真正最高格', () => {
    const grid = gridOf([
      [0, 10, 0, 'stone', 'surfaceShell'],
      [1, 10, 0, 'stone', 'surfaceShell'],
      [0, 9, 0, 'stone', 'set'],
      [1, 9, 0, 'stone', 'set'],
    ]);
    assert.deepEqual(evaluateGates(cfg, inputOf(grid)), { passed: true, failed: [] });
  });

  it('空区域失败', () => {
    const grid = gridOf([[9, 10, 9, 'stone', 'surfaceShell']]);
    assert.equal(evaluateGates(cfg, inputOf(grid)).passed, false);
  });
});

/** 手工造格：每个 [x,y,z,方块,api] 定义一次调用并写入；方块为 air 时是挖空。 */
function gridOf(entries: readonly (readonly [number, number, number, string, string])[]): Grid {
  const grid = createGrid(registry.table);
  const calls = new Map<string, number>();
  for (const [x, y, z, block, api] of entries) {
    let id = calls.get(api);
    if (id === undefined) {
      id = grid.defineCall(api, 1, {});
      calls.set(api, id);
    }
    grid.set(x, y, z, parseState(registry.table, block), 0, id);
  }
  return grid;
}

function axisOf(overrides: Partial<SymmetryAxis>): SymmetryAxis {
  return {
    axis: 'x',
    at: 0,
    cells: 1000,
    matched: 1000,
    glass: 0,
    glassMatched: 0,
    glassBelow: 0,
    glassAbove: 0,
    lonely: [],
    lonelyGlass: [],
    ...overrides,
  };
}

const noReach: ReachReport = {
  standable: 0,
  reached: 0,
  maxReachedY: undefined,
  maxStandableY: undefined,
  targets: [],
  blockers: [],
};

const noTargets: ReachTargets = { targets: [], missing: [], skipped: [] };

/** 默认输入：空网格、空报告。需要浮动 / 可进入判定的用例自己给（带真格的）grid 与 calls。 */
function inputOf(grid: Grid, overrides: Partial<GateInput> = {}): GateInput {
  return {
    grid,
    calls: grid.calls(),
    symmetry: { axes: [] },
    reach: noReach,
    reachTargets: noTargets,
    registry,
    ...overrides,
  };
}

/**
 * 用真 world 造一段封闭外墙（默认无门，内部走不进去）。good=true 时在南面开一扇门。
 * 墙底铺一列台基，内部 y=2 才是站立面。
 */
function walled(footprint: readonly [number, number, number, number], withDoor: boolean, line = 0): Grid {
  const host = createWorld(registry.table, { callSite: () => line });
  const w = host.world;
  const [x0, z0, x1, z1] = footprint;
  const base = w.plinth({ footprint: rect(x0, z0, x1, z1), height: 1, material: 'stone_bricks' });
  const hall = w.walls({ on: base, height: 4, material: 'stone_bricks' });
  if (withDoor) w.opening({ in: hall.facade('south'), kind: 'door', width: 1, height: 3 });
  return host.compose().grid;
}

/** 两段墙：第一段开门（walls#2）、第二段封闭（walls#5），用来验证比例刚好达标。 */
function twoWalls(): Grid {
  const host = createWorld(registry.table);
  const w = host.world;
  const build = (x0: number, z0: number, x1: number, z1: number, withDoor: boolean): void => {
    const base = w.plinth({ footprint: rect(x0, z0, x1, z1), height: 1, material: 'stone_bricks' });
    const hall = w.walls({ on: base, height: 4, material: 'stone_bricks' });
    if (withDoor) w.opening({ in: hall.facade('south'), kind: 'door', width: 1, height: 3 });
  };
  build(-6, -6, -2, -2, true);
  build(2, 2, 6, 6, false);
  return host.compose().grid;
}

describe('evaluateGates：forbidApis', () => {
  const grid = gridOf([
    [0, 0, 0, 'stone', 'set'],
    [1, 0, 0, 'stone', 'set'],
    [2, 0, 0, 'stone', 'box'],
    [3, 0, 0, 'air', 'box'],
    [0, 1, 0, 'stone', 'walls'],
    [0, 1, 1, 'stone', 'walls'],
  ]);

  it('好样本：没有命中即通过', () => {
    const out = evaluateGates({ forbidApis: ['roof'] }, inputOf(grid));
    assert.deepEqual(out, { passed: true, failed: [] });
  });

  it('坏样本：实体格与挖空记录都计，多 api 按格数降序、同数按名字升序', () => {
    const out = evaluateGates({ forbidApis: ['set', 'box'] }, inputOf(grid));
    assert.equal(out.passed, false);
    assert.deepEqual(out.failed, ['只用构件：box 2 格、set 2 格']);
  });

  it('单个 api 命中用"共 N 格写入"', () => {
    const out = evaluateGates({ forbidApis: ['walls'] }, inputOf(grid));
    assert.deepEqual(out.failed, ['只用构件：walls 共 2 格写入']);
  });
});

describe('evaluateGates：symmetry', () => {
  const grid = gridOf([[0, 0, 0, 'stone', 'walls']]);
  const failAxis = { axis: 'x' as const, at: 0, min: 0.99 };

  it('好样本：找得到轴且比例达标', () => {
    const input = inputOf(grid, { symmetry: { axes: [axisOf({})] } });
    assert.deepEqual(evaluateGates({ symmetry: failAxis }, input), { passed: true, failed: [] });
  });

  it('坏样本：比例不足，百分比一位小数，min 去掉多余零', () => {
    const input = inputOf(grid, { symmetry: { axes: [axisOf({ matched: 894 })] } });
    assert.deepEqual(evaluateGates({ symmetry: failAxis }, input).failed, ['左右对称：实体对上 89.4%，要求 ≥ 99%']);
  });

  it('坏样本：min 为 .5 时写 99.5%', () => {
    const input = inputOf(grid, { symmetry: { axes: [axisOf({ matched: 994 })] } });
    assert.deepEqual(evaluateGates({ symmetry: { axis: 'x', at: 0, min: 0.995 } }, input).failed, [
      '左右对称：实体对上 99.4%，要求 ≥ 99.5%',
    ]);
  });

  it('坏样本：没有匹配的轴（无轴 / at 不同），带 at 时写明镜面', () => {
    const noAxis = inputOf(grid, { symmetry: { axes: [] } });
    assert.deepEqual(evaluateGates({ symmetry: failAxis }, noAxis).failed, ['左右对称：没有 x 轴（镜面 0）的测量']);
    const otherAt = inputOf(grid, { symmetry: { axes: [axisOf({ at: 0.5 })] } });
    assert.deepEqual(evaluateGates({ symmetry: failAxis }, otherAt).failed, ['左右对称：没有 x 轴（镜面 0）的测量']);
    const noAt = inputOf(grid, { symmetry: { axes: [] } });
    assert.deepEqual(evaluateGates({ symmetry: { axis: 'z', min: 0.9 } }, noAt).failed, ['左右对称：没有 z 轴的测量']);
  });
});

describe('evaluateGates：structureSpans', () => {
  it('好样本：两轴跨度都在范围内，非结构 api 不计', () => {
    const grid = gridOf([
      [0, 1, 0, 'stone', 'walls'],
      [4, 1, 3, 'stone', 'walls'],
      [10, 1, 10, 'stone', 'set'],
    ]);
    assert.deepEqual(evaluateGates({ structureSpans: { x: [5, 5], z: [4, 4] } }, inputOf(grid)), {
      passed: true,
      failed: [],
    });
  });

  it('坏样本：只有一轴超出时只写那轴', () => {
    const grid = gridOf([
      [0, 1, 0, 'stone', 'roof'],
      [9, 1, 2, 'stone', 'roof'],
    ]);
    assert.deepEqual(evaluateGates({ structureSpans: { x: [3, 5], z: [3, 5] } }, inputOf(grid)).failed, [
      '结构跨度：x 10 不在 3–5',
    ]);
  });

  it('坏样本：两轴都超出时顿号分隔，数字为实测跨度', () => {
    const grid = gridOf([
      [0, 1, 0, 'stone', 'walls'],
      [149, 1, 212, 'stone', 'walls'],
    ]);
    assert.deepEqual(evaluateGates({ structureSpans: { x: [108, 133], z: [162, 198] } }, inputOf(grid)).failed, [
      '结构跨度：x 150 不在 108–133、z 213 不在 162–198',
    ]);
  });

  it('没有结构格时通过（骨架阶段不该发生）', () => {
    const grid = gridOf([[0, 1, 0, 'stone', 'set']]);
    assert.deepEqual(evaluateGates({ structureSpans: { x: [1, 2], z: [1, 2] } }, inputOf(grid)), {
      passed: true,
      failed: [],
    });
  });

  /** 10×8 / 12×8 外墙 + 合法 1 格挑檐：roof 格一定超出墙的 footprint。 */
  function wallsWithEave(width: number): Grid {
    const host = createWorld(registry.table);
    const w = host.world;
    const hall = w.walls({
      footprint: rect(2, 2, 2 + width - 1, 9),
      y: 1,
      height: 4,
      thickness: 1,
      material: 'stone_bricks',
    });
    w.roof({ on: hall, kind: 'gable', ridge: 'x', pitch: 0.5, overhang: 1, material: 'deepslate_tiles' });
    return host.compose().grid;
  }

  it('10×8 墙 footprint + 合法 1 格挑檐：只量 footprint，跨度 10×8 通过', () => {
    assert.deepEqual(evaluateGates({ structureSpans: { x: [1, 10], z: [1, 8] } }, inputOf(wallsWithEave(10))), {
      passed: true,
      failed: [],
    });
  });

  it('12×8 墙 footprint + 1 格挑檐：x 跨度 12 失败，挑檐不参与判定', () => {
    assert.deepEqual(evaluateGates({ structureSpans: { x: [1, 10], z: [1, 8] } }, inputOf(wallsWithEave(12))).failed, [
      '结构跨度：x 12 不在 1–10',
    ]);
  });

  it('没有 footprint 调用时保留旧回退：roof-only 的挑檐仍计入跨度', () => {
    const grid = gridOf([
      [0, 5, 0, 'stone', 'roof'],
      [11, 5, 7, 'stone', 'roof'],
    ]);
    assert.deepEqual(evaluateGates({ structureSpans: { x: [1, 10], z: [1, 8] } }, inputOf(grid)).failed, [
      '结构跨度：x 12 不在 1–10',
    ]);
  });

  it('只有 floorPlate 也算 footprint：10×8 楼板 + 1 格挑檐仍通过', () => {
    const host = createWorld(registry.table);
    const w = host.world;
    const floor = w.floorPlate({ footprint: rect(2, 2, 11, 9), y: 0, thickness: 1, material: 'stone_bricks' });
    w.roof({ on: floor.top, kind: 'gable', ridge: 'x', pitch: 0.5, overhang: 1, material: 'deepslate_tiles' });
    assert.deepEqual(evaluateGates({ structureSpans: { x: [1, 10], z: [1, 8] } }, inputOf(host.compose().grid)), {
      passed: true,
      failed: [],
    });
  });
});

describe('evaluateGates：reachInsideWalls', () => {
  it('好样本：南面开门，内部能走进去，比例达标', () => {
    const grid = walled([-5, -5, 5, 5], true);
    assert.deepEqual(evaluateGates({ reachInsideWalls: { minRatio: 0.5 } }, inputOf(grid)), {
      passed: true,
      failed: [],
    });
  });

  it('坏样本：封闭墙走不进去，列出围合段与行号', () => {
    const grid = walled([-5, -5, 5, 5], false, 37);
    assert.deepEqual(evaluateGates({ reachInsideWalls: { minRatio: 0.5 } }, inputOf(grid)).failed, [
      '可进入：1 段围合墙里 1 段走不进去（walls#2 第 37 行）',
    ]);
  });

  it('比例刚好达标（1/2 = 0.5）时通过，提高门槛则失败', () => {
    const grid = twoWalls();
    assert.deepEqual(evaluateGates({ reachInsideWalls: { minRatio: 0.5 } }, inputOf(grid)), {
      passed: true,
      failed: [],
    });
    assert.deepEqual(evaluateGates({ reachInsideWalls: { minRatio: 0.6 } }, inputOf(grid)).failed, [
      '可进入：2 段围合墙里 1 段走不进去（walls#5 第 0 行）',
    ]);
  });

  it('失败文案列前 3 段，超过写"…另 N 段"', () => {
    const host = createWorld(registry.table);
    const w = host.world;
    for (const [x, z] of [
      [0, 0],
      [10, 10],
      [20, 20],
      [30, 30],
    ] as const)
      w.walls({ footprint: rect(x, z, x + 2, z + 2), y: 1, height: 3, material: 'stone' });
    const grid = host.compose().grid;
    assert.deepEqual(evaluateGates({ reachInsideWalls: { minRatio: 0.5 } }, inputOf(grid)).failed, [
      '可进入：4 段围合墙里 4 段走不进去（walls#1 第 0 行、walls#2 第 0 行、walls#3 第 0 行…另 1 段）',
    ]);
  });

  it('分母 0（墙没有内部 / 没有 walls 调用）时通过', () => {
    const noInterior = gridOf([[0, 1, 0, 'stone', 'walls']]);
    assert.deepEqual(evaluateGates({ reachInsideWalls: { minRatio: 1 } }, inputOf(noInterior)), {
      passed: true,
      failed: [],
    });
    const noWalls = gridOf([[0, 1, 0, 'stone', 'set']]);
    assert.deepEqual(evaluateGates({ reachInsideWalls: { minRatio: 1 } }, inputOf(noWalls)), {
      passed: true,
      failed: [],
    });
  });
});

describe('evaluateGates：reachAll', () => {
  const grid = gridOf([[0, 0, 0, 'stone', 'walls']]);
  const cell = { x: 0, y: 1, z: 0 };

  it('好样本：目标都能到且没有 missing', () => {
    const input = inputOf(grid, { reach: { ...noReach, targets: [{ cell, reached: true }] } });
    assert.deepEqual(evaluateGates({ reachAll: true }, input), { passed: true, failed: [] });
  });

  it('坏样本：到不了与没有站立点都写，段内用顿号', () => {
    const input = inputOf(grid, {
      reach: {
        ...noReach,
        targets: [
          { cell, reached: false },
          { cell, reached: false },
        ],
      },
      reachTargets: {
        targets: [],
        missing: [{ callId: 7, api: 'roof', reason: 'no-standable' }],
        skipped: [],
      },
    });
    assert.deepEqual(evaluateGates({ reachAll: true }, input).failed, ['可达：2 个目标到不了、1 个目标没有站立点']);
  });

  it('坏样本：只有一段时只写那段', () => {
    const onlyMissing = inputOf(grid, {
      reach: { ...noReach, targets: [{ cell, reached: true }] },
      reachTargets: { targets: [], missing: [{ callId: 7, api: 'floorPlate', reason: 'no-cells' }], skipped: [] },
    });
    assert.deepEqual(evaluateGates({ reachAll: true }, onlyMissing).failed, ['可达：1 个目标没有站立点']);
    const onlyUnreached = inputOf(grid, { reach: { ...noReach, targets: [{ cell, reached: false }] } });
    assert.deepEqual(evaluateGates({ reachAll: true }, onlyUnreached).failed, ['可达：1 个目标到不了']);
  });

  it('reachAll 为 false 时不生效', () => {
    const input = inputOf(grid, { reach: { ...noReach, targets: [{ cell, reached: false }] } });
    assert.deepEqual(evaluateGates({ reachAll: false }, input), { passed: true, failed: [] });
    assert.equal(configuredGateCount({ reachAll: false }), 0);
  });
});

describe('evaluateGates：floatingAllowApis', () => {
  const good = gridOf([
    [0, 5, 0, 'stone', 'roof'],
    [1, 5, 0, 'stone', 'roof'],
    [0, 5, 1, 'stone', 'roof'],
    [1, 5, 1, 'stone', 'roof'],
  ]);
  const mixed = gridOf([
    [0, 5, 0, 'stone', 'roof'],
    [1, 5, 0, 'stone', 'roof'],
    [20, 5, 20, 'stone', 'set'],
    [21, 5, 20, 'stone', 'set'],
  ]);

  it('好样本：悬空组全部属于允许来源', () => {
    assert.deepEqual(evaluateGates({ floatingAllowApis: ['roof'] }, inputOf(good)), { passed: true, failed: [] });
  });

  it('坏样本：统计不属于允许来源的格数', () => {
    assert.deepEqual(evaluateGates({ floatingAllowApis: ['roof'] }, inputOf(mixed)).failed, [
      '悬空：2 格不属于 [roof]',
    ]);
  });

  it('空允许列表 = 不允许任何悬空', () => {
    assert.deepEqual(evaluateGates({ floatingAllowApis: [] }, inputOf(good)).failed, ['悬空：4 格不属于任何允许来源']);
  });
});

describe('evaluateGates：组合与顺序', () => {
  it('failed 顺序固定为 forbidApis → symmetry → structureSpans → reachAll → reachInsideWalls → floatingAllowApis', () => {
    const host = createWorld(registry.table);
    const w = host.world;
    const base = w.plinth({ footprint: rect(-5, -5, 5, 5), height: 1, material: 'stone_bricks' });
    w.walls({ on: base, height: 4, material: 'stone_bricks' });
    w.set(20, 5, 20, 'stone');
    const grid = host.compose().grid;
    const input = inputOf(grid, {
      symmetry: { axes: [axisOf({ matched: 900 })] },
      reach: { ...noReach, targets: [{ cell: { x: 0, y: 1, z: 0 }, reached: false }] },
    });
    const out = evaluateGates(
      {
        forbidApis: ['set'],
        symmetry: { axis: 'x', at: 0, min: 0.99 },
        structureSpans: { x: [1, 5], z: [1, 5] },
        reachAll: true,
        reachInsideWalls: { minRatio: 0.5 },
        floatingAllowApis: ['roof'],
      },
      input,
    );
    assert.equal(out.passed, false);
    assert.equal(out.failed.length, 6);
    assert.match(out.failed[0] ?? '', /^只用构件：/);
    assert.match(out.failed[1] ?? '', /^左右对称：/);
    assert.match(out.failed[2] ?? '', /^结构跨度：/);
    assert.match(out.failed[3] ?? '', /^可达：/);
    assert.match(out.failed[4] ?? '', /^可进入：/);
    assert.match(out.failed[5] ?? '', /^悬空：/);
    assert.equal(
      configuredGateCount({
        forbidApis: [],
        symmetry: { axis: 'x', min: 1 },
        structureSpans: { x: [1, 2], z: [1, 2] },
        reachAll: true,
        reachInsideWalls: { minRatio: 0.5 },
        floatingAllowApis: [],
      }),
      6,
    );
  });

  it('没设的项跳过，不影响结果', () => {
    const grid = gridOf([[0, 0, 0, 'stone', 'set']]);
    assert.deepEqual(evaluateGates({}, inputOf(grid)), { passed: true, failed: [] });
    assert.equal(configuredGateCount({}), 0);
  });
});

describe('gatesLines', () => {
  it('全过：明确 submit 会被接受，但完成度看对象差异与 must 证据', () => {
    assert.deepEqual(gatesLines({}, { passed: true, failed: [] }, 4), [
      '门槛（骨架阶段）：全部通过。',
      '骨架门槛已过：submit 会被接受（仅表示提交不会被拒）；完成度看对象差异与 must 证据；check 通过 ≠ review 满意。',
    ]);
  });

  it('未过：首行 N/M 与拒绝提示，每项一行 ✗', () => {
    const outcome = { passed: false, failed: ['左右对称：实体对上 89.4%，要求 ≥ 99%', '悬空：2 格不属于 [roof]'] };
    assert.deepEqual(gatesLines({}, outcome, 4), [
      '门槛（骨架阶段）：未过 2/4 项，过门槛前 submit 会被拒绝：',
      '  ✗ 左右对称：实体对上 89.4%，要求 ≥ 99%',
      '  ✗ 悬空：2 格不属于 [roof]',
    ]);
  });
});

describe('gatesSchema', () => {
  const valid = {
    forbidApis: ['set', 'box'],
    symmetry: { axis: 'x', at: 0, min: 0.99 },
    structureSpans: { x: [108, 133], z: [162, 198] },
    reachAll: true,
    reachInsideWalls: { minRatio: 0.5 },
    floatingAllowApis: ['roof'],
  };

  it('好样本：完整配置与最小空对象都通过', () => {
    assert.equal(gatesSchema.safeParse(valid).success, true);
    assert.equal(gatesSchema.safeParse({}).success, true);
    assert.equal(gatesSchema.safeParse({ symmetry: { axis: 'z', at: 1.5, min: 0.5 } }).success, true);
    assert.equal(gatesSchema.safeParse({ structureSpans: { x: [0, 0], z: [1, 2] } }).success, true);
    const parsed: GateConfig = gatesSchema.parse({ floatingAllowApis: [] });
    assert.deepEqual(parsed.floatingAllowApis, []);
  });

  it('坏样本：未知字段、min 越界、空数组元素、at 不是整数或 .5', () => {
    assert.equal(gatesSchema.safeParse({ bogus: 1 }).success, false);
    assert.equal(gatesSchema.safeParse({ symmetry: { axis: 'x', min: 0 } }).success, false);
    assert.equal(gatesSchema.safeParse({ symmetry: { axis: 'x', min: 1.1 } }).success, false);
    assert.equal(gatesSchema.safeParse({ symmetry: { axis: 'y', min: 0.9 } }).success, false);
    assert.equal(gatesSchema.safeParse({ symmetry: { axis: 'x', at: 0.25, min: 0.9 } }).success, false);
    assert.equal(gatesSchema.safeParse({ forbidApis: [''] }).success, false);
    assert.equal(gatesSchema.safeParse({ floatingAllowApis: ['roof', ''] }).success, false);
  });

  it('structureSpans：min > max 报错，缺轴 / 多轴 / 非二元组都拒绝', () => {
    assert.equal(gatesSchema.safeParse({ structureSpans: { x: [10, 5], z: [1, 2] } }).success, false);
    assert.equal(gatesSchema.safeParse({ structureSpans: { x: [1, 2], z: [5, 4] } }).success, false);
    assert.equal(gatesSchema.safeParse({ structureSpans: { x: [1, 2] } }).success, false);
    assert.equal(gatesSchema.safeParse({ structureSpans: { x: [1, 2], z: [3, 4], y: [0, 1] } }).success, false);
    assert.equal(gatesSchema.safeParse({ structureSpans: { x: [1], z: [1, 2] } }).success, false);
  });

  it('reachInsideWalls：minRatio 必须在 (0,1]，未知字段拒绝', () => {
    assert.equal(gatesSchema.safeParse({ reachInsideWalls: { minRatio: 0.5 } }).success, true);
    assert.equal(gatesSchema.safeParse({ reachInsideWalls: { minRatio: 1 } }).success, true);
    assert.equal(gatesSchema.safeParse({ reachInsideWalls: { minRatio: 0 } }).success, false);
    assert.equal(gatesSchema.safeParse({ reachInsideWalls: { minRatio: 1.1 } }).success, false);
    assert.equal(gatesSchema.safeParse({ reachInsideWalls: { ratio: 0.5 } }).success, false);
    assert.equal(gatesSchema.safeParse({ reachInsideWalls: undefined }).success, true);
  });
});
