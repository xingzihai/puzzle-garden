import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Grid } from '@pg/core/grid';
import { createWorld, rect } from '@pg/geometry';

import { box, ground, registry } from './fixtures.test.ts';
import { measureReach } from './reach.ts';
import { reachTargetsByCall } from './reach-targets.ts';

type Spec = readonly (readonly [number, number, number, string])[];

/** 按调用逐个写格：每个调用先 defineCall，再写它的格（后写覆盖，与 geometry 合成后的存档一致）。 */
function gridOfCalls(calls: readonly { api: string; args: unknown; cells: Spec }[]): Grid {
  const g = createGrid(registry.table);
  for (const c of calls) {
    const id = g.defineCall(c.api, 1, c.args);
    for (const [x, y, z, s] of c.cells) g.set(x, y, z, parseState(registry.table, s), 0, id);
  }
  return g;
}

const plate = (y: number, r = 3): Spec => box(-r, y, -r, r, y, r, 'oak_planks');

describe('reachTargetsByCall：好样本', () => {
  it('每个 floorPlate 出一个目标：最高一层上方，按 (z, x) 取第一个站立点', () => {
    const g = gridOfCalls([
      { api: 'set', args: [], cells: ground(5) },
      { api: 'floorPlate', args: { y: 4 }, cells: plate(4) },
      { api: 'floorPlate', args: { y: 8, thickness: 2 }, cells: [...plate(8), ...plate(9)] },
    ]);
    const r = reachTargetsByCall(g, registry);
    assert.deepEqual(r.targets, [
      { callId: 2, api: 'floorPlate', cell: { x: -3, y: 5, z: -3 } },
      { callId: 3, api: 'floorPlate', cell: { x: -3, y: 10, z: -3 } },
    ]);
    assert.deepEqual(r.missing, []);
  });

  it('角上被挡时顺延到下一个站立点；梯孔（挖空）的列不当承托', () => {
    const g = gridOfCalls([
      { api: 'floorPlate', args: {}, cells: plate(4) },
      { api: 'box', args: {}, cells: [[-3, 5, -3, 'stone']] }, // 角上压一块
      { api: 'stair', args: {}, cells: [[-2, 4, -3, 'air']] }, // 下一格是梯孔
    ]);
    assert.deepEqual(reachTargetsByCall(g, registry).targets[0]?.cell, { x: -1, y: 5, z: -3 });
  });

  it('带女儿墙的 kind:flat 的 roof 出目标，无女儿墙的平顶不作目标，坡屋面不出', () => {
    const g = gridOfCalls([
      { api: 'roof', args: { kind: 'flat', parapet: { height: 1 } }, cells: plate(4) },
      { api: 'roof', args: { kind: 'flat' }, cells: plate(9) },
      { api: 'roof', args: { kind: 'gable', y: 9 }, cells: plate(14) },
    ]);
    const r = reachTargetsByCall(g, registry);
    assert.deepEqual(r.targets, [{ callId: 1, api: 'roof', cell: { x: -3, y: 5, z: -3 } }]);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.skipped, [{ callId: 2, api: 'roof', reason: 'flat-no-parapet' }]);
  });

  it('女儿墙：同一 roof 调用的外圈高一格，目标落在女儿墙内侧而不是墙顶', () => {
    const parapet = box(-3, 5, -3, 3, 5, 3, 'stone').filter(([x, , z]) => Math.abs(x) === 3 || Math.abs(z) === 3);
    const g = gridOfCalls([
      { api: 'roof', args: { kind: 'flat', parapet: { height: 1 } }, cells: [...plate(4), ...parapet] },
    ]);
    assert.deepEqual(reachTargetsByCall(g, registry).targets[0]?.cell, { x: -2, y: 5, z: -2 });
  });

  it('真实构件：walls + 带女儿墙的平屋面 + 直跑楼梯上屋顶，目标在屋面内侧且能到', () => {
    const host = createWorld(registry.table);
    const w = host.world;
    const base = w.plinth({ footprint: rect(-6, -6, 6, 6), height: 1, material: 'stone_bricks' });
    const hall = w.walls({ on: base, height: 6, material: 'stone_bricks' });
    w.opening({ in: hall.facade('south'), kind: 'door', width: 1, height: 2 });
    const roof = w.roof({ on: hall, kind: 'flat', material: 'stone', parapet: { height: 1, material: 'stone' } });
    if (roof.top === undefined) throw new Error('平屋面应返回 top');
    w.stair({ from: hall.inner, to: roof.top, kind: 'straight', at: [-3, 3], facing: 'north', material: 'oak_stairs' });
    const { grid } = host.compose();
    const r = reachTargetsByCall(grid, registry);
    assert.deepEqual(r.missing, []);
    const t = r.targets.find((x) => x.api === 'roof');
    assert.ok(t !== undefined);
    // 女儿墙格的上方不是站立点；目标的脚下是屋面板，与女儿墙同属该 roof 调用
    assert.equal(t.cell.y, roof.top.y);
    assert.equal(grid.get(t.cell.x, t.cell.y, t.cell.z), undefined);
    assert.equal(measureReach(grid, registry, { targets: [t.cell] }).targets[0]?.reached, true);
  });
});

describe('reachTargetsByCall：推不出时逐个报原因', () => {
  it('no-standable：楼板上方整层被压满', () => {
    const g = gridOfCalls([
      { api: 'floorPlate', args: {}, cells: plate(4, 1) },
      { api: 'box', args: {}, cells: box(-1, 6, -1, 1, 6, 1, 'stone') }, // 头顶只剩一格
    ]);
    assert.deepEqual(reachTargetsByCall(g, registry), {
      targets: [],
      missing: [{ callId: 1, api: 'floorPlate', reason: 'no-standable' }],
      skipped: [],
    });
  });

  it('女儿墙围死的 1×1 屋面：内侧那格被压住时报 no-standable，不退到女儿墙顶', () => {
    const parapet = box(-1, 5, -1, 1, 5, 1, 'stone').filter(([x, , z]) => x !== 0 || z !== 0);
    const g = gridOfCalls([
      { api: 'roof', args: { kind: 'flat', parapet: { height: 1 } }, cells: [...plate(4, 1), ...parapet] },
      { api: 'set', args: {}, cells: [[0, 6, 0, 'stone']] },
    ]);
    assert.deepEqual(reachTargetsByCall(g, registry).missing, [{ callId: 1, api: 'roof', reason: 'no-standable' }]);
  });

  it('no-cells：格全被后写覆盖', () => {
    const g = gridOfCalls([
      { api: 'floorPlate', args: {}, cells: plate(4, 0) },
      { api: 'set', args: {}, cells: [[0, 4, 0, 'stone']] },
    ]);
    assert.deepEqual(reachTargetsByCall(g, registry).missing, [{ callId: 1, api: 'floorPlate', reason: 'no-cells' }]);
  });

  it('roof 参数被截断：kind / parapet 在截断前缀里就照常判断，判断不了报 args-truncated', () => {
    const long = 'x'.repeat(300);
    const g = gridOfCalls([
      // 键按字母序：finial < kind，长 finial 把 kind 挤出 200 码元
      { api: 'roof', args: { finial: { material: long }, kind: 'flat', parapet: { height: 1 } }, cells: plate(4) },
      // kind、parapet 键都在前缀里（长材质在 parapet 内部）：平顶带女儿墙，出目标
      { api: 'roof', args: { kind: 'flat', parapet: { height: 1, material: long } }, cells: plate(9) },
      // kind 在前缀、parapet 被截掉：无法判断是不是目标
      { api: 'roof', args: { kind: 'flat', material: long }, cells: plate(14) },
      { api: 'roof', args: { kind: 'hip', material: long }, cells: plate(19) },
    ]);
    assert.ok(g.calls().every((c) => c.args.endsWith('…')));
    const r = reachTargetsByCall(g, registry);
    assert.deepEqual(r.missing, [
      { callId: 1, api: 'roof', reason: 'args-truncated' },
      { callId: 3, api: 'roof', reason: 'args-truncated' },
    ]);
    assert.deepEqual(
      r.targets.map((t) => t.callId),
      [2],
    );
    assert.deepEqual(r.skipped, []);
  });

  it('args-invalid：不是 JSON、或没有字符串 kind', () => {
    const g = createGrid(registry.table);
    g.restoreTables(
      [],
      [
        { id: 1, api: 'roof', line: 0, args: '{bad' },
        { id: 2, api: 'roof', line: 0, args: '{"kind":3}' },
      ],
    );
    assert.deepEqual(reachTargetsByCall(g, registry).missing, [
      { callId: 1, api: 'roof', reason: 'args-invalid' },
      { callId: 2, api: 'roof', reason: 'args-invalid' },
    ]);
  });

  it('其它 API 与空网格不出目标', () => {
    assert.deepEqual(reachTargetsByCall(createGrid(registry.table), registry), {
      targets: [],
      missing: [],
      skipped: [],
    });
    const g = gridOfCalls([{ api: 'box', args: {}, cells: plate(4) }]);
    assert.deepEqual(reachTargetsByCall(g, registry), { targets: [], missing: [], skipped: [] });
  });
});

describe('reachTargetsByCall：确定性', () => {
  it('写入顺序不同（同一调用表），结果相同', () => {
    const cells = plate(4);
    const a = gridOfCalls([{ api: 'floorPlate', args: {}, cells }]);
    const b = gridOfCalls([{ api: 'floorPlate', args: {}, cells: [...cells].reverse() }]);
    assert.deepEqual(reachTargetsByCall(a, registry), reachTargetsByCall(b, registry));
  });
});
