/**
 * F5 塔楼两稿的目标回归：旧存档的楼板层位、墙顶、栏杆、顶饰与登顶可达。
 *
 * 只从公共 world 执行两稿，用测试自己的常量核对坐标，不读夹具内部变量；
 * 可达性只认指定的最高平台点与每层指定站立点，不用 maxReachedY 代替目标。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGrid } from '@pg/core/grid';
import { loadRegistry } from '@pg/blocks/load';
import { measureReach } from '@pg/analysis/reach';
import { reachTargetsByCall } from '@pg/analysis/reach-targets';
import { createWorld } from './index.ts';
import type { World } from './index.ts';
import a5 from '../fixtures/f5-tow.A.ts';
import b5 from '../fixtures/f5-tow.B.ts';

interface BandCheck {
  readonly y: number;
  readonly material: string;
}

interface TowerCase {
  readonly name: string;
  readonly build: (w: World) => void;
  /** 旧存档楼板绝对 y 列表（v02 f5-tow.A.js:20 / B.js:25）。 */
  readonly floors: readonly number[];
  readonly plateMaterial: string;
  readonly wallTopMaterial: string;
  readonly bandChecks: readonly BandCheck[];
  /** 窗口旧存档绝对 y；墙用 height 没有 storeys，按绝对 y 转相对 sill。 */
  readonly windowSills: readonly number[];
  /** 攒尖顶点（屋面材质）的绝对 y 与顶饰金块绝对 y。 */
  readonly apexY: number;
  readonly goldYs: readonly number[];
}

const registry = loadRegistry();

/** 塔底（台基顶面）绝对 y。 */
const WALL_BASE = 2;
/** 最高的指定平台点：顶层楼板 y42 的站立面；避梯孔与 ±7 栏杆。 */
const HIGHEST_PLATFORM = { x: 5, y: 43, z: 5 } as const;

const CASES: readonly TowerCase[] = [
  {
    name: 'f5-tow.A',
    build: a5,
    floors: [12, 22, 32, 42],
    plateMaterial: 'dark_oak_planks',
    wallTopMaterial: 'dark_oak_planks',
    bandChecks: [
      { y: 22, material: 'stone_bricks' },
      { y: 23, material: 'dark_oak_planks' },
    ],
    windowSills: [6, 16, 26, 36],
    apexY: 51,
    goldYs: [52, 53, 54],
  },
  {
    name: 'f5-tow.B',
    build: b5,
    floors: [10, 18, 26, 34, 42],
    plateMaterial: 'oak_planks',
    wallTopMaterial: 'oak_planks',
    bandChecks: [
      { y: 3, material: 'stone_bricks' },
      { y: 4, material: 'oak_planks' },
    ],
    windowSills: [7, 15, 23, 31, 39],
    apexY: 56,
    goldYs: [57, 58],
  },
];

for (const tower of CASES) {
  const { name, build } = tower;

  test(`${name} 旧楼板层位、墙顶、栏杆与顶饰`, () => {
    const host = createWorld(registry.table);
    build(host.world);
    const { grid } = host.compose();
    const api = new Map(grid.calls().map((call) => [call.id, call.api]));
    const cells = [...grid.cells()];

    // 墙：旧稿塔身到 y42；显式 height41 + band 转换后，材质分界与旧存档一致。
    const wallCells = cells.filter((cell) => api.get(cell.call) === 'walls');
    assert.ok(
      wallCells.some((cell) => cell.y === 42),
      `${name} 墙顶 y42 缺失`,
    );
    assert.equal(grid.get(-7, 42, 0)?.state.name, tower.wallTopMaterial, `${name} 墙顶材质`);
    for (const band of tower.bandChecks)
      assert.equal(grid.get(-7, band.y, 0)?.state.name, band.material, `${name} 墙 y${String(band.y)} 材质`);

    // 楼板：来源格只出现在旧列表的层位，没有多出底层板，也没有下移。
    const plateYs = [
      ...new Set(cells.filter((cell) => api.get(cell.call) === 'floorPlate').map((cell) => cell.y)),
    ].sort((a, b) => a - b);
    assert.deepEqual(plateYs, [...tower.floors], `${name} 楼板层位`);

    // 栏杆：挂在 tower.top（y43），不是被下移的楼板顶面。
    const railCells = cells.filter((cell) => api.get(cell.call) === 'rail');
    assert.ok(railCells.length > 0, `${name} 栏杆缺失`);
    assert.ok(
      railCells.every((cell) => cell.y === 43),
      `${name} 栏杆不在 y43`,
    );

    // 门：sill0，与基座表面齐，底层不封。
    assert.equal(grid.get(0, WALL_BASE, 7), undefined, `${name} 门底被填住`);

    // 窗：按旧绝对 y 转相对 sill 后，北面 z=-7 在 sill 处透空、再下一格仍是墙。
    for (const sill of tower.windowSills) {
      assert.equal(grid.get(0, sill, -7), undefined, `${name} 北窗 y${String(sill)} 未开`);
      assert.notEqual(grid.get(0, sill - 1, -7), undefined, `${name} 北窗 y${String(sill)} 下方应仍是墙`);
    }

    // 顶饰：瓦尖落点与金块的绝对位置。
    assert.equal(grid.get(0, tower.apexY, 0)?.state.name, 'deepslate_tiles', `${name} 瓦尖 y${String(tower.apexY)}`);
    for (const y of tower.goldYs)
      assert.equal(grid.get(0, y, 0)?.state.name, 'gold_block', `${name} 金块 y${String(y)}`);
    assert.equal(grid.get(0, Math.max(...tower.goldYs) + 1, 0), undefined, `${name} 金块之上应为空气`);
  });

  test(`${name} 指定最高平台与每层目标可达`, () => {
    const host = createWorld(registry.table);
    build(host.world);
    const { grid } = host.compose();
    const targets = [
      HIGHEST_PLATFORM,
      ...tower.floors.map((fy) => ({ x: HIGHEST_PLATFORM.x, y: fy + 1, z: HIGHEST_PLATFORM.z })),
    ];

    // 后写的 roof / stair 支承没有占掉目标：站立格是空气，脚下由 floorPlate 承托。
    for (const target of targets) {
      assert.equal(
        grid.get(target.x, target.y, target.z),
        undefined,
        `${name} 目标 ${JSON.stringify(target)} 被实体占住`,
      );
      assert.equal(
        grid.get(target.x, target.y - 1, target.z)?.state.name,
        tower.plateMaterial,
        `${name} 目标 ${JSON.stringify(target)} 脚下不是楼板`,
      );
    }

    const report = measureReach(grid, registry, { targets });
    for (const result of report.targets)
      assert.equal(
        result.reached,
        true,
        `${name} 指定目标 ${JSON.stringify(result.cell)} 不可达（不使用 maxReachedY 代替）`,
      );
  });

  test(`${name} 删除楼梯来源格后最高平台不可达`, () => {
    const host = createWorld(registry.table);
    build(host.world);
    const { grid } = host.compose();
    const stairIds = new Set(
      grid
        .calls()
        .filter((call) => call.api === 'stair')
        .map((call) => call.id),
    );
    assert.ok(stairIds.size > 0, `${name} 没有 stair 调用`);

    const mutant = createGrid(registry.table);
    let removed = 0;
    for (const cell of grid.cells()) {
      if (stairIds.has(cell.call)) {
        removed += 1;
        continue;
      }
      mutant.set(cell.x, cell.y, cell.z, cell.state, 0, 0);
    }
    assert.ok(removed > 0, `${name} 没有删到楼梯来源格`);

    const report = measureReach(mutant, registry, { targets: [HIGHEST_PLATFORM] });
    assert.equal(report.targets[0]?.reached, false, `${name} 删除楼梯后最高平台仍可达`);
  });

  test(`${name} reachTargetsByCall：每层楼板出目标、与指定层位一致且可达；删梯后顶层不可达`, () => {
    const host = createWorld(registry.table);
    build(host.world);
    const { grid } = host.compose();
    const derived = reachTargetsByCall(grid, registry);
    assert.deepEqual(derived.missing, [], `${name} 有推不出目标的调用`);
    // 坡屋面（pyramid）不出目标；每块楼板一个，站立高度 = 旧楼板层位 + 1，最高一个就是指定平台那一层 y43。
    assert.ok(derived.targets.every((t) => t.api === 'floorPlate'));
    const ys = derived.targets.map((t) => t.cell.y);
    assert.deepEqual(
      ys,
      tower.floors.map((fy) => fy + 1),
    );
    assert.equal(Math.max(...ys), HIGHEST_PLATFORM.y);
    const cells = derived.targets.map((t) => t.cell);
    const report = measureReach(grid, registry, { targets: [...cells, HIGHEST_PLATFORM] });
    assert.ok(
      report.targets.every((t) => t.reached),
      `${name} 推出的目标不可达`,
    );

    // 删梯变异体：保留调用表与来源，只去掉 stair 写的格；推出的顶层目标必须到不了。
    const mutant = createGrid(registry.table);
    mutant.restoreTables(grid.parts(), grid.calls());
    const stairIds = new Set(
      grid
        .calls()
        .filter((call) => call.api === 'stair')
        .map((call) => call.id),
    );
    for (const cell of grid.cells())
      if (!stairIds.has(cell.call)) mutant.set(cell.x, cell.y, cell.z, cell.state, cell.part, cell.call);
    const mutantTargets = reachTargetsByCall(mutant, registry).targets;
    const top = mutantTargets.at(-1);
    assert.equal(top?.cell.y, HIGHEST_PLATFORM.y);
    const mutantReport = measureReach(mutant, registry, { targets: mutantTargets.map((t) => t.cell) });
    assert.deepEqual(
      mutantReport.targets.map((t) => t.reached),
      mutantTargets.map(() => false),
      `${name} 删除楼梯后楼板目标仍可达`,
    );
  });
}
