/** 楼梯路线与组合回归：使用实际可达测量验证，另测尺寸、朝向与失败原子性。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import fc from 'fast-check';
import { z } from 'zod';
import { loadRegistry } from '@pg/blocks/load';
import { measureReach } from '@pg/analysis/reach';
import { measureFloating } from '@pg/analysis/floating';
import { hashGrid } from '@pg/core/hash';
import { parseState } from '@pg/core/block-state';
import { createWorld, rect } from './index.ts';
import type { WorldHost, StairHandle, Side } from './index.ts';
import { parse, stairSchema, stepsSchema, wallsSchema } from './schema.ts';
import { stairPlan, stepsPlan } from './circulation.ts';

const registry = loadRegistry();
const footprint = rect(-10, -10, 10, 10);
const material = 'stone_brick_stairs';

function build(
  kind: 'straight' | 'switchback' | 'spiral',
  facing: Side,
  latePlate: boolean,
  width = 2,
): {
  readonly host: WorldHost;
  readonly stair: StairHandle;
} {
  const host = createWorld(registry.table);
  const w = host.world;
  const hall = w.walls({ footprint, y: 1, storeys: { count: 2, height: 7 }, material: 'stone' });
  const lower = w.floorPlate({ in: hall.storey(0), material: 'oak_planks' });
  const upper = w.floorPlate({ in: hall.storey(1), material: 'oak_planks' });
  const door = w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 4, sill: 1 });
  w.steps({ to: door, width: 3, material });
  const options = { from: lower, to: upper, at: [0, 0] as const, facing, material };
  const stair = kind === 'spiral' ? w.stair({ ...options, kind, radius: 2 }) : w.stair({ ...options, kind, width });
  if (latePlate) w.floorPlate({ in: hall.storey(1), material: 'oak_planks' });
  return { host, stair };
}

test('三种楼梯四个朝向：从场地走到上层；后铺楼板不封梯道', () => {
  for (const kind of ['straight', 'switchback', 'spiral'] as const) {
    for (const facing of ['east', 'west', 'north', 'south'] as const) {
      const { host, stair } = build(kind, facing, true);
      const { grid } = host.compose();
      const targets = stair.path.map(([x, y, z]) => ({ x, y, z }));
      targets.push({ x: 8, y: 9, z: 8 });
      const report = measureReach(grid, registry, { targets });
      assert(
        report.targets.every((t) => t.reached),
        `${kind}/${facing}: ${JSON.stringify(report.targets.filter((t) => !t.reached))}`,
      );
      assert.equal(hashGrid(grid), hashGrid(build(kind, facing, false).host.compose().grid));
      assert.equal(measureFloating(grid).cells, 0, `${kind}/${facing} 悬空`);
      for (const [a, b] of stair.path.slice(1).map((p, i) => [stair.path[i], p] as const)) {
        assert(a !== undefined);
        assert.equal(Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2]), 1);
        assert(b[1] - a[1] >= 0 && b[1] - a[1] <= 1);
      }
    }
  }
});

test('P1 螺旋梯径 2 在 7×7 塔内：入口平台落在环内，不挖塔墙且可达', () => {
  const host = createWorld(registry.table);
  const w = host.world;
  const tower = w.walls({ footprint: rect(-3, -3, 3, 3), y: 1, storeys: { count: 2, height: 7 }, material: 'stone' });
  const bottom = w.floorPlate({ in: tower.storey(0), material: 'stone' });
  const top = w.floorPlate({ in: tower.storey(1), material: 'stone' });
  const door = w.opening({ in: tower.facade('south'), kind: 'door', width: 3, height: 3, sill: 1 });
  w.steps({ to: door, width: 3, material });
  const stair = w.stair({ from: bottom, to: top, kind: 'spiral', at: [0, 0], radius: 2, material });
  // 入口平台不再落在环外：旧位置 (-3,-2) 在塔墙上，仍应是石块。
  assert.deepEqual(stair.path[0], [-2, 2, -1]);
  assert.equal(w.get(-3, 1, -2), 'stone', '塔墙被入口平台挖掉');
  const { grid } = host.compose();
  const report = measureReach(grid, registry, { targets: stair.path.map(([x, y, z]) => ({ x, y, z })) });
  assert(
    report.targets.every((t) => t.reached),
    JSON.stringify(report.targets.filter((t) => !t.reached)),
  );
  // 坏样本：radius 3 的环超出 5×5 塔心，放不下。
  const bad = createWorld(registry.table);
  const bw = bad.world;
  const bt = bw.walls({ footprint: rect(-3, -3, 3, 3), y: 1, storeys: { count: 2, height: 7 }, material: 'stone' });
  const blo = bw.floorPlate({ in: bt.storey(0), material: 'stone' });
  const bhi = bw.floorPlate({ in: bt.storey(1), material: 'stone' });
  assert.throws(() => bw.stair({ from: blo, to: bhi, kind: 'spiral', at: [0, 0], radius: 3, material }), /放不下/);
});

test('楼梯 width 以 at 为中线：偶数宽多出的格在世界坐标较小一侧（四向 1/2/3）', () => {
  // 入口平台（add(-1, 0, from.y-1)）是 y=from.y-1 上唯一的踏面，用来核对宽度展开。
  // from.y=2 时入口平台在 y=1（地表那一级的 y=0 不再写方块，见决策 #21）。
  const entry = { east: [-1, 0], west: [1, 0], south: [0, -1], north: [0, 1] } as const;
  for (const facing of ['east', 'west', 'north', 'south'] as const) {
    for (const width of [1, 2, 3] as const) {
      const p = parse(stairSchema, {
        kind: 'straight',
        from: { footprint, y: 2 },
        to: { footprint, y: 3 },
        at: [0, 0],
        facing,
        width,
        material,
      });
      const plan = stairPlan(registry.table, p);
      const actual = new Set(
        plan.writes
          .filter((w) => w.writeLayer === 'opening' && w.state.name.endsWith('_stairs') && w.y === 1)
          .map((w) => `${String(w.x)},${String(w.z)}`),
      );
      const [rx, rz] = entry[facing];
      const lateralIsZ = facing === 'east' || facing === 'west';
      const expected = new Set<string>();
      for (let i = 0; i < width; i += 1) {
        const offset = i - Math.floor(width / 2);
        expected.add(lateralIsZ ? `${String(rx)},${String(rz + offset)}` : `${String(rx + offset)},${String(rz)}`);
      }
      assert.deepEqual([...actual].sort(), [...expected].sort(), `${facing} width=${String(width)}`);
    }
  }
});

test('switchback 宽 2/3 四个朝向仍可达，两跑各宽 width、中间隔一格', () => {
  for (const width of [2, 3] as const) {
    for (const facing of ['east', 'west', 'north', 'south'] as const) {
      const { host, stair } = build('switchback', facing, false, width);
      const { grid } = host.compose();
      const report = measureReach(grid, registry, {
        targets: stair.path.map(([x, y, z]) => ({ x, y, z })),
      });
      assert(
        report.targets.every((t) => t.reached),
        `switchback/${facing} width=${String(width)}: ${JSON.stringify(report.targets.filter((t) => !t.reached))}`,
      );
      assert.equal(measureFloating(grid).cells, 0, `switchback/${facing} width=${String(width)} 悬空`);
      for (const [a, b] of stair.path.slice(1).map((p, i) => [stair.path[i], p] as const)) {
        assert(a !== undefined);
        assert.equal(Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2]), 1);
        assert(b[1] - a[1] >= 0 && b[1] - a[1] <= 1);
      }
    }
  }
});

test('坏样本：删掉楼梯后，上层目标不可达；保留楼板可见，不靠最高点替代目标', () => {
  const { host } = build('straight', 'east', true);
  const { grid } = host.compose();
  const stairCall = grid.calls().find((c) => c.api === 'stair')?.id;
  assert(stairCall !== undefined);
  for (const c of [...grid.cells()])
    if (c.call === stairCall) grid.set(c.x, c.y, c.z, parseState(registry.table, 'air'), 0, 0);
  const report = measureReach(grid, registry, { targets: [{ x: 8, y: 9, z: 8 }] });
  assert.equal(report.targets[0]?.reached, false);
  assert.equal(report.maxStandableY, 15);
});

test('四层螺旋梯逐层相连，后写楼板仍可达所有楼层', () => {
  const data: unknown = JSON.parse(
    readFileSync(new URL('../fixtures/four-storey-stair.json', import.meta.url), 'utf8'),
  );
  const fixture = parse(z.strictObject({ walls: wallsSchema, stair: z.record(z.string(), z.unknown()) }), data);
  const host = createWorld(registry.table);
  const w = host.world;
  const hall = w.walls(fixture.walls);
  const plates = Array.from({ length: 4 }, (_, i) => w.floorPlate({ in: hall.storey(i), material: 'oak_planks' }));
  const door = w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 4, sill: 1 });
  w.steps({ to: door, width: 3, material });
  const low = plates[0];
  const high = plates[3];
  assert(low !== undefined && high !== undefined);
  const params = parse(stairSchema, { ...fixture.stair, from: low.top, to: high.top });
  const stair = w.stair({ ...params, from: low, to: high });
  for (let i = 0; i < 4; i += 1) w.floorPlate({ in: hall.storey(i), material: 'oak_planks' });
  const report = measureReach(host.compose().grid, registry, {
    targets: [...stair.path.map(([x, y, z]) => ({ x, y, z })), ...plates.map((p) => ({ x: 8, y: p.top.y, z: 8 }))],
  });
  assert(
    report.targets.every((t) => t.reached),
    JSON.stringify(report.targets.filter((t) => !t.reached)),
  );
});

test('楼层索引、楼板厚度、位置互斥与关系身份', () => {
  const host = createWorld(registry.table);
  const w = host.world;
  const hall = w.walls({ footprint, y: 1, storeys: { count: 3, height: 5 }, material: 'stone' });
  assert.equal(hall.top.y, 16);
  assert.equal(hall.storey(2).y, 11);
  assert.equal(hall.storey(2), hall.storey(2));
  for (const i of [-1, 3, 0.5]) assert.throws(() => hall.storey(i), /storey/);
  const plain = w.walls({ footprint, y: 1, height: 5, material: 'stone' });
  assert.throws(() => plain.storey(0), /指定 storeys/);
  const plate = w.floorPlate({ footprint, y: 4, thickness: 2, material: 'oak_planks' });
  assert.equal(plate.top.y, 6);
  assert.equal(plate.region.y, 4);
  assert.equal(w.get(0, 4, 0), 'oak_planks');
  assert.equal(w.get(0, 5, 0), 'oak_planks');
  const before = host.compose().grid.calls().length;
  assert.throws(() => w.floorPlate({ in: { footprint, y: 1 }, material: 'stone' }), /当前世界/);
  assert.throws(() => w.floorPlate({ in: hall.inner, footprint, y: 1, material: 'stone' }), /构件参数/);
  assert.throws(() => w.floorPlate({ footprint, y: 2047, thickness: 2, material: 'stone' }));
  assert.equal(host.compose().grid.calls().length, before);
});

test('踏步四个立面自动朝向，接齐台基边；窗或已填充门不能作为踏步目标', () => {
  const direction = { north: 'south', south: 'north', east: 'west', west: 'east' } as const;
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    const host = createWorld(registry.table);
    const w = host.world;
    const base = w.plinth({ footprint: rect(-2, -2, 2, 2), height: 4, material: 'stone' });
    const steps = w.steps({ to: base.edge(side), width: 2, material });
    const { grid } = host.compose();
    const targets = [...steps.path.map(([x, y, z]) => ({ x, y, z })), { x: 0, y: base.top.y, z: 0 }];
    assert(measureReach(grid, registry, { targets }).targets.every((t) => t.reached));
    const tread = steps.path[1];
    assert(tread !== undefined);
    const state = grid.get(tread[0], tread[1] - 1, tread[2])?.state;
    assert(state !== undefined);
    const facing = state.props['facing'] ?? registry.table.blocks.get(state.name)?.props.get('facing')?.default;
    assert.equal(facing, direction[side]);
    const hall = w.walls({ on: base, height: 6, material: 'stone' });
    const window = w.opening({ in: hall.facade(side), kind: 'window', width: 1, height: 2 });
    // at 偏移一格，避免与上面的窗洞重叠触发"两洞 hole 重叠"（R4）。
    const filled = w.opening({ in: hall.facade(side), kind: 'door', width: 1, height: 2, fill: 'glass', at: 1 });
    assert.throws(() => w.steps({ to: window, width: 1, material }), /未填充/);
    assert.throws(() => w.steps({ to: filled, width: 1, material }), /未填充/);
    assert.throws(() => w.steps({ to: hall.facade(side), width: 1, material }), /台基边/);
  }
});

test('无效楼梯不留下调用或挖空：材质、起止高度、尺寸、坐标、跨世界关系', () => {
  const host = createWorld(registry.table);
  const w = host.world;
  const lower = w.floorPlate({ footprint, y: 1, material: 'stone' });
  const upper = w.floorPlate({ footprint, y: 7, material: 'stone' });
  const options = { kind: 'straight' as const, from: lower, to: upper, at: [0, 0] as const, material };
  const other = createWorld(registry.table).world.floorPlate({ footprint, y: 1, material: 'stone' });
  const before = host.compose();
  for (const bad of [
    { ...options, material: 'stone' },
    { ...options, material: 'oak_stairs[half=top]' },
    { ...options, material: 'oak_stairs[facing=east]' },
    { ...options, to: lower },
    { ...options, from: upper, to: lower },
    { ...options, at: [9, 0] as const },
    { ...options, width: 30 },
    { ...options, from: other },
  ]) {
    assert.throws(() => w.stair(bad));
    assert.equal(hashGrid(host.compose().grid), hashGrid(before.grid));
    assert.deepEqual(host.compose().grid.calls(), before.grid.calls());
    assert.deepEqual([...host.compose().grid.carved()], [...before.grid.carved()]);
  }
  const adjacent = w.floorPlate({ footprint, y: 2, material: 'stone' });
  assert.throws(() => w.stair({ ...options, kind: 'switchback', to: adjacent }), /至少为 2/);
  assert.throws(() => w.stair({ ...options, at: [0.5, 0] }), /at\[0\]/);
});

test('几何计划拒绝过窄入口、地表齐平、越界净空；材质显式保水', () => {
  const to = { side: 'south', bounds: { min: [0, 3, 0], max: [2, 5, 0] } };
  const p = parse(stepsSchema, { to, width: 2, material: 'oak_stairs[waterlogged=true]' });
  assert(stepsPlan(registry.table, p).writes.some((w) => w.state.props['waterlogged'] === 'true'));
  assert.throws(() => stepsPlan(registry.table, { ...p, width: 4 }), /净宽/);
  assert.throws(
    () => stepsPlan(registry.table, { ...p, to: { ...p.to, bounds: { min: [0, 1, 0], max: [2, 3, 0] } } }),
    /steps 不需要：门洞底 y=1 已与地表齐平/,
  );
  const stair = parse(stairSchema, {
    kind: 'straight',
    from: { footprint, y: 2044 },
    to: { footprint, y: 2047 },
    at: [0, 0],
    material,
  });
  assert.throws(() => stairPlan(registry.table, stair), /越界/);
});

test('R6 楼梯堵门：9×9 两层塔南门 sill1，switchback at[0,0] facing south 整扇堵死报错且原子', () => {
  const scene = (): {
    readonly host: WorldHost;
    readonly door: () => void;
    readonly stair: (facing: Side) => void;
  } => {
    const host = createWorld(registry.table);
    const w = host.world;
    const hall = w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, storeys: { count: 2, height: 5 }, material: 'stone' });
    const lower = w.floorPlate({ in: hall.storey(0), material: 'oak_planks' });
    const upper = w.floorPlate({ in: hall.storey(1), material: 'oak_planks' });
    return {
      host,
      door: () => w.opening({ in: hall.facade('south'), kind: 'door', width: 1, height: 2, sill: 1 }),
      stair: (facing) =>
        w.stair({ from: lower.top, to: upper.top, kind: 'switchback', at: [0, 0], facing, width: 1, material }),
    };
  };
  const snap = (host: WorldHost): string => {
    const { grid } = host.compose();
    return `${hashGrid(grid)}:${String(grid.calls().length)}`;
  };
  // 门先写、楼梯后写：楼梯提交时报错。
  const doorFirst = scene();
  doorFirst.door();
  const dBefore = snap(doorFirst.host);
  assert.throws(() => {
    doorFirst.stair('south');
  }, /stair 挡住了门 south#\d+：门内 \([^)]+\) 是梯(级|背板)/);
  assert.equal(snap(doorFirst.host), dBefore);
  // 楼梯先写、门后写：开洞提交时反查。
  const stairFirst = scene();
  stairFirst.stair('south');
  const sBefore = snap(stairFirst.host);
  assert.throws(stairFirst.door, /stair 挡住了门 south#\d+/);
  assert.equal(snap(stairFirst.host), sBefore);
  // 好样本：朝北背离南门，不报。
  const good = scene();
  good.door();
  assert.doesNotThrow(() => {
    good.stair('north');
  });
});

test('R10 踏步 path 取中线：门宽 3、踏步宽 2 时 x 为 0，落点留口不变', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const hall = w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
  const door = w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 2, sill: 1 });
  const steps = w.steps({ to: door, width: 2, material });
  // 门洞 x∈[−1,1]，踏步宽 2 占 {−1,0}，中线取偶数宽较大坐标侧 0（与楼梯 width=2 占 {at−1,at} 同规则）。
  for (const p of steps.path) assert.equal(p[0], 0, `path x=${String(p[0])}`);
  const h2 = createWorld(registry.table);
  const w2 = h2.world;
  const base = w2.plinth({ footprint: rect(-4, -4, 4, 4), height: 2, project: 1, material: 'stone' });
  const edge = w2.steps({ to: base.edge('south'), width: 2, material });
  for (const p of edge.path) assert.equal(p[0], 0);
  w2.rail({ along: base, material: 'oak_fence' });
  // 落点两列 x∈{−1,0}（台基顶 y=3、南缘 z=5）留口，x=1 仍有栏杆。
  assert.equal(w2.get(-1, 3, 5), 'air');
  assert.equal(w2.get(0, 3, 5), 'air');
  assert.equal(w2.get(1, 3, 5), 'oak_fence');
});

test('R11 楼梯放不下给出合法 at 范围；端点可放、端点外 1 格不可放；先材质后位置', () => {
  const build = (at: readonly [number, number]): WorldHost => {
    const host = createWorld(registry.table);
    const w = host.world;
    const lower = w.floorPlate({ footprint: rect(0, 0, 10, 10), y: 1, material: 'stone' });
    const upper = w.floorPlate({ footprint: rect(0, 0, 10, 10), y: 3, material: 'stone' });
    w.stair({ from: lower, to: upper, kind: 'straight', at, facing: 'east', width: 1, material });
    return host;
  };
  // 直跑 east、宽 1、高差 2：偏移 x∈[−1,2]、z∈[0,0]，共同占地 x、z∈[0,10] → at 可取 x∈[1,8]、z∈[0,10]。
  assert.throws(() => build([0, 0]), /at 可取 x∈\[1, 8\]、z∈\[0, 10\]/);
  assert.throws(() => build([9, 0]), /at 可取 x∈\[1, 8\]/);
  assert.doesNotThrow(() => build([1, 0]));
  assert.doesNotThrow(() => build([8, 0]));
  const host = createWorld(registry.table);
  const w = host.world;
  const lower = w.floorPlate({ footprint: rect(0, 0, 10, 10), y: 1, material: 'stone' });
  const upper = w.floorPlate({ footprint: rect(0, 0, 10, 10), y: 3, material: 'stone' });
  // 材质非法且 at 越界：先报材质（R11 校验顺序）。
  assert.throws(
    () =>
      w.stair({ from: lower, to: upper, kind: 'straight', at: [0, 0], facing: 'east', width: 1, material: 'stone' }),
    /必须使用楼梯类方块/,
  );
});

test('steps 不写 y ≤ 0 的格：门洞底 y=3 从地表仍可达门内', () => {
  const host = createWorld(registry.table);
  const w = host.world;
  const hall = w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
  // sill 2：站立面 y=1 起算，门洞底 y=3。踏步原有 y=0 踏面与 y=-1 背板。
  const door = w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 2, sill: 2 });
  const steps = w.steps({ to: door, width: 3, material });
  const stairsCall = host
    .compose()
    .grid.calls()
    .find((c) => c.api === 'steps')?.id;
  assert(stairsCall !== undefined);
  const cells = [...host.compose().grid.cells()].filter((c) => c.call === stairsCall);
  assert.ok(cells.length > 0);
  assert.ok(
    cells.every((c) => c.y >= 1),
    `steps 写出了 y ≤ 0：${JSON.stringify(cells.filter((c) => c.y <= 0))}`,
  );
  // 从地表（门洞外远处 y=1）能走到门内站立点。
  const center = steps.path.at(-1);
  assert(center !== undefined);
  const targets = [...steps.path.map(([x, y, z]) => ({ x, y, z })), { x: center[0], y: 3, z: 4 }];
  const report = measureReach(host.compose().grid, registry, { targets });
  assert(
    report.targets.every((t) => t.reached),
    JSON.stringify(report.targets.filter((t) => !t.reached)),
  );
});

test('stair from 是地表（y=1）时不写 y ≤ 0 的入口平台与背板', () => {
  const p = parse(stairSchema, {
    kind: 'straight',
    from: { footprint, y: 1 },
    to: { footprint, y: 3 },
    at: [0, 0],
    facing: 'east',
    material,
  });
  const plan = stairPlan(registry.table, p);
  assert.ok(plan.writes.length > 0);
  assert.ok(
    plan.writes.every((w) => w.y >= 1),
    JSON.stringify(plan.writes.filter((w) => w.y <= 0)),
  );
  // 入口平台的站立点仍保留在 path 里（y=1，站在地面上）。
  assert.equal(plan.path[0]?.[1], 1);
});

test('性质：直跑楼梯的上升高度由锚点决定，每级相邻且材质朝向确定', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 8 }), fc.constantFrom('east', 'south', 'west', 'north'), (rise, facing) => {
      const p = parse(stairSchema, {
        kind: 'straight',
        from: { footprint, y: 2 },
        to: { footprint, y: 2 + rise },
        at: [0, 0],
        facing,
        material,
      });
      const plan = stairPlan(registry.table, p);
      assert.equal(plan.path.length, rise + 2);
      assert.equal(plan.path[0]?.[1], 2);
      assert.equal(plan.path.at(-1)?.[1], rise + 2);
      assert.deepEqual(plan, stairPlan(registry.table, p));
    }),
  );
});
