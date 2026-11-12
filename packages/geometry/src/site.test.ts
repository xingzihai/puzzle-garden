/** 场地构件的闭合、连接、净空与坏尺寸；通过公开世界接口验证来源。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { hashGrid } from '@pg/core/hash';
import { measureReach } from '@pg/analysis/reach';
import { createWorld, rect } from './index.ts';
import type { WorldHost } from './index.ts';

const registry = loadRegistry();
test('四角柱廊承托屋面，按根数和间距布柱，额枋可关闭', () => {
  for (const arrangement of [{ count: 4 }, { count: 8 }, { spacing: 4 }]) {
    const h = createWorld(registry.table);
    const w = h.world;
    const base = w.plinth({ footprint: rect(-5, -5, 5, 5), height: 1, project: 1, material: 'stone' });
    const columns = w.colonnade({ on: base, ...arrangement, height: 5, column: { material: 'oak_log' } });
    assert.equal(columns.top.y, 8);
    assert(columns.bays.length >= 4);
    w.roof({ on: columns, kind: 'hip', material: 'stone' });
    for (const x of [-5, 5]) for (const z of [-5, 5]) assert.equal(w.get(x, 2, z), 'oak_log');
    assert.equal(w.get(0, 3, 0), 'air');
    assert.equal(w.get(0, 7, -5), 'oak_log');
  }
  const h = createWorld(registry.table);
  const c = h.world.colonnade({
    footprint: rect(0, 0, 10, 10),
    y: 1,
    count: 4,
    height: 4,
    column: { width: 2, material: 'stone' },
    beam: false,
  });
  assert.equal(c.top.y, 5);
  assert.equal(h.world.get(5, 5, 0), 'air');
});

test('colonnade.count 按边长分配：多出的柱在长边，正方形对称，count 4 只四角', () => {
  // 9×15（沿 x 长 9、沿 z 长 15），count 6：多出的柱在较长的东西边（z 方向），南北边只四角。
  const a = createWorld(registry.table);
  a.world.colonnade({
    footprint: rect(0, 0, 8, 14),
    y: 1,
    count: 6,
    height: 2,
    column: { material: 'stone' },
    beam: false,
  });
  for (const [x, z] of [
    [0, 7],
    [8, 7],
  ] as const)
    assert.equal(a.world.get(x, 2, z), 'stone', `长边 ${String(x)},${String(z)}`);
  for (const [x, z] of [
    [4, 0],
    [4, 14],
  ] as const)
    assert.equal(a.world.get(x, 2, z), 'air', `短边中点 ${String(x)},${String(z)}`);

  // 13×11，count 6：多出的柱在较长的南北边（x 方向）。
  const b = createWorld(registry.table);
  b.world.colonnade({
    footprint: rect(0, 0, 12, 10),
    y: 1,
    count: 6,
    height: 2,
    column: { material: 'stone' },
    beam: false,
  });
  for (const [x, z] of [
    [6, 0],
    [6, 10],
  ] as const)
    assert.equal(b.world.get(x, 2, z), 'stone');
  for (const [x, z] of [
    [0, 5],
    [12, 5],
  ] as const)
    assert.equal(b.world.get(x, 2, z), 'air');

  // 正方形 count 8：两方向各 3 柱，均分位置一致（0、3、7）。
  const c = createWorld(registry.table);
  c.world.colonnade({
    footprint: rect(0, 0, 7, 7),
    y: 1,
    count: 8,
    height: 2,
    column: { material: 'stone' },
    beam: false,
  });
  for (const [x, z] of [
    [0, 3],
    [3, 0],
    [3, 7],
    [7, 3],
  ] as const)
    assert.equal(c.world.get(x, 2, z), 'stone');
  assert.equal(c.world.get(3, 2, 3), 'air');

  // count 4 只四角。
  const d = createWorld(registry.table);
  d.world.colonnade({
    footprint: rect(0, 0, 10, 10),
    y: 1,
    count: 4,
    height: 2,
    column: { material: 'stone' },
    beam: false,
  });
  for (const [x, z] of [
    [0, 0],
    [0, 10],
    [10, 0],
    [10, 10],
  ] as const)
    assert.equal(d.world.get(x, 2, z), 'stone');
  for (const [x, z] of [
    [5, 0],
    [0, 5],
  ] as const)
    assert.equal(d.world.get(x, 2, z), 'air');
});

test('栏杆转角无缺口，手动缺口与踏步自动通路均保留', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const base = w.plinth({ footprint: rect(-4, -4, 4, 4), height: 2, material: 'stone' });
  w.rail({ along: base, material: 'oak_fence', gaps: [{ side: 'south', width: 3 }] });
  assert.equal(w.get(-4, 3, -4), 'oak_fence');
  assert.equal(w.get(4, 3, 4), 'oak_fence');
  assert.equal(w.get(0, 3, 4), 'air');
  assert.throws(
    () => w.rail({ along: base, material: 'stone', gaps: [{ side: 'east', width: 99 }] }),
    /width 最大为 9/,
  );
  assert.throws(
    () => w.rail({ along: base, material: 'stone', gaps: [{ side: 'east', width: 3, at: 9 }] }),
    /at 改到 \[-3, 3\]/,
  );
  // 先写的栏杆在北边没有缺口：之后再在北边建踏步，按决策 #60 报错，不静默挖掉栏杆
  assert.throws(
    () => w.steps({ to: base.edge('north'), width: 3, material: 'stone_brick_stairs' }),
    /先写 steps 再写 rail/,
  );
});

test('栏杆在之前登记的踏步落点自动留口，沿外挑后的外缘走，不盖墙脚（审查 A2、决策 #60）', () => {
  for (const project of [0, 1, 2]) {
    for (const side of ['north', 'south', 'east', 'west'] as const) {
      const h = createWorld(registry.table);
      const w = h.world;
      const base = w.plinth({ footprint: rect(-4, -4, 4, 4), height: 2, project, material: 'stone' });
      const hall = w.walls({ on: base, height: 4, material: 'oak_planks' });
      const door = w.opening({ in: hall.facade(side), kind: 'door', width: 3, height: 3 });
      if (project > 0) w.steps({ to: base.edge(side), width: 3, material: 'stone_brick_stairs' });
      else w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
      w.rail({ along: base, material: 'oak_fence' });
      const grid = h.compose().grid;
      // 墙脚没有被栏杆盖掉：栏杆在装饰层，与墙重合的格让给墙。取四面墙上离门洞最远的格（门洞居中、宽 3）。
      for (const [x, z] of [
        [-4, -3],
        [4, 3],
        [-3, 4],
        [3, -4],
      ] as const) {
        assert.equal(w.get(x, 3, z), 'oak_planks', `墙脚 (${String(x)}, ${String(z)}) p${String(project)} ${side}`);
      }
      if (project > 0) {
        const edge = 4 + project;
        assert.equal(w.get(-edge, 3, -edge), 'oak_fence', `外缘转角 p${String(project)} ${side}`);
      }
      // 从地面经踏步进门
      const inside = { x: 0, y: 3, z: 0 };
      assert(measureReach(grid, registry, { targets: [inside] }).targets[0]?.reached, `p${String(project)} ${side}`);
    }
  }
});

test('铺装连接院门与偏轴房门：路在院内、连续、不穿墙（审查 A7、决策 #62）', () => {
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    const h = createWorld(registry.table);
    const w = h.world;
    const court = w.enclosure({
      outline: rect(-12, -12, 12, 12),
      height: 3,
      material: 'stone',
      gate: { side, width: 3, height: 3 },
    });
    // 房子偏在一角，门朝向院门那一侧
    const house = w.walls({ footprint: rect(2, 2, 8, 8), y: 1, height: 4, material: 'oak_planks' });
    const door = w.opening({ in: house.facade(side), kind: 'door', width: 3, height: 3 });
    w.paving({ from: court.gate, to: door, width: 2, material: 'cobblestone' });
    const grid = h.compose().grid;
    const path = [...grid.cells()].filter((c) => c.state.name === 'cobblestone');
    assert(path.length > 0, side);
    // 全部在院墙内侧（院墙厚 1：x、z ∈ [−11, 11]）
    assert(
      path.every((c) => c.x >= -11 && c.x <= 11 && c.z >= -11 && c.z <= 11),
      `${side} 有铺装在院墙外或墙上`,
    );
    // 面邻接连通成一片
    const keys = new Set(path.map((c) => `${String(c.x)},${String(c.z)}`));
    const first = path[0]!;
    const seen = new Set([`${String(first.x)},${String(first.z)}`]);
    const stack = [[first.x, first.z] as const];
    for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const k = `${String(c[0] + dx)},${String(c[1] + dz)}`;
        if (keys.has(k) && !seen.has(k)) {
          seen.add(k);
          stack.push([c[0] + dx, c[1] + dz]);
        }
      }
    }
    assert.equal(seen.size, keys.size, `${side} 铺装断开`);
  }
});

test('铺装：路宽放不下或两入口不通时报错，不铺一半', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const a = w.walls({ footprint: rect(-10, -3, -4, 3), y: 1, height: 4, material: 'stone' });
  const b = w.walls({ footprint: rect(4, -3, 10, 3), y: 1, height: 4, material: 'stone' });
  const doorA = w.opening({ in: a.facade('east'), kind: 'door', width: 3, height: 3 });
  const doorB = w.opening({ in: b.facade('west'), kind: 'door', width: 3, height: 3 });
  // 两栋中间用一道墙完全隔开（高出地表、长度超出寻路范围）
  w.box([0, 1, -40], [0, 1, 40], 'stone');
  const before = h.compose().grid.calls().length;
  assert.throws(() => w.paving({ from: doorA, to: doorB, width: 1, material: 'cobblestone' }), /连不通/);
  assert.equal(h.compose().grid.calls().length, before);
  // 长度写法：直铺撞墙
  assert.throws(() => w.paving({ from: doorA, to: 10, width: 1, material: 'cobblestone' }), /被已有结构挡住/);
});

test('门洞上的踏步不把门加高；台基边上的踏步不挖墙（审查 A3、A4）', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const hall = w.walls({ footprint: rect(-5, -5, 5, 5), y: 1, height: 6, material: 'oak_planks' });
  const door = w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 2, sill: 1 });
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
  assert.equal(w.get(0, 4, 5), 'oak_planks', '门高 2，门顶以上仍是墙');
  const h2 = createWorld(registry.table);
  const base = h2.world.plinth({ footprint: rect(-5, -5, 5, 5), height: 2, material: 'stone' });
  h2.world.walls({ on: base, height: 5, material: 'oak_planks' });
  h2.world.steps({ to: base.edge('south'), width: 3, material: 'stone_brick_stairs' });
  for (let y = 3; y <= 5; y += 1) assert.equal(h2.world.get(0, y, 5), 'oak_planks', `墙 y=${String(y)}`);
});

test('镜像作用域里的踏步与栏杆：两侧都留口', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  w.mirror({ axis: 'x', at: 0 }, () => {
    const base = w.plinth({ footprint: rect(4, -2, 8, 2), height: 2, project: 1, material: 'stone' });
    w.steps({ to: base.edge('south'), width: 3, material: 'stone_brick_stairs' });
    w.rail({ along: base, material: 'oak_fence' });
  });
  const grid = h.compose().grid;
  const r = measureReach(grid, registry, {
    targets: [
      { x: 6, y: 3, z: 0 },
      { x: -6, y: 3, z: 0 },
    ],
  });
  assert(r.targets.every((t) => t.reached));
});

test('院墙门楼贯穿整个进深，门口铺装朝外，连接另一入口', () => {
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    const h = createWorld(registry.table);
    const w = h.world;
    const court = w.enclosure({
      outline: rect(-7, -7, 7, 7),
      height: 3,
      material: 'stone',
      gate: { side, width: 3, height: 3, gatehouse: { depth: 4, width: 5, height: 5, material: 'stone_bricks' } },
    });
    const b = court.gate.bounds;
    for (let x = b.min[0]; x <= b.max[0]; x += 1)
      for (let z = b.min[2]; z <= b.max[2]; z += 1) assert.equal(w.get(x, 1, z), 'air');
    w.paving({ from: court.gate, to: 4, width: 3, material: 'stone' });
    assert(measureReach(h.compose().grid, registry, { targets: [{ x: 0, y: 1, z: 0 }] }).targets[0]?.reached);
    const house = w.walls({ footprint: rect(-3, -3, 3, 3), y: 1, height: 5, material: 'oak_planks' });
    const door = w.opening({ in: house.facade(side), kind: 'door', width: 3, height: 3 });
    w.paving({ from: court.gate, to: door, width: 2, material: 'stone' });
    assert.equal(h.compose().grid.calls().at(-1)?.api, 'paving');
  }
});

test('普通院门、折线铺装与位置身份', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const court = w.enclosure({
    outline: rect(-8, -8, 8, 8),
    height: 4,
    thickness: 2,
    material: 'stone',
    gate: { side: 'south', width: 3, height: 3 },
  });
  const house = w.walls({ footprint: rect(-3, -3, 3, 3), y: 1, height: 5, material: 'stone' });
  const door = w.opening({ in: house.facade('east'), kind: 'door', width: 2, height: 3 });
  w.paving({ from: court.gate, to: door, width: 3, material: 'stone' });
  assert.throws(() => w.paving({ from: { ...door }, to: 2, width: 1, material: 'stone' }), /当前世界/);
  assert.throws(() => w.rail({ along: { footprint: rect(0, 0, 2, 2), y: 1 }, material: 'stone' }), /当前世界/);
});

test('R8 rail 遇多边形台基报错且不留下格与调用', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const base = w.plinth({
    footprint: {
      points: [
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 6],
        [0, 4],
      ],
    },
    height: 2,
    material: 'stone',
  });
  const calls = h.compose().grid.calls().length;
  const size = h.compose().grid.size;
  assert.throws(() => w.rail({ along: base, material: 'oak_fence' }), /rail 暂不支持多边形台基/);
  assert.equal(h.compose().grid.calls().length, calls);
  assert.equal(h.compose().grid.size, size);
});

test('N2 多边形台基外挑后 rail 仍报错，不留格与调用', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const base = w.plinth({
    footprint: {
      points: [
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 6],
        [0, 4],
      ],
    },
    height: 2,
    project: 1,
    material: 'stone',
  });
  const calls = h.compose().grid.calls().length;
  const size = h.compose().grid.size;
  assert.throws(() => w.rail({ along: base, material: 'oak_fence' }), /rail 暂不支持多边形台基/);
  assert.equal(h.compose().grid.calls().length, calls);
  assert.equal(h.compose().grid.size, size);
});

test('P2 两入口铺装端点跳过台基与踏步：院门到台基房门连通且路不压踏步', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const court = w.enclosure({
    outline: rect(-14, -14, 14, 14),
    height: 3,
    material: 'stone',
    gate: { side: 'south', width: 3, height: 3 },
  });
  const base = w.plinth({ footprint: rect(-4, 2, 4, 8), height: 2, material: 'stone' });
  const house = w.walls({ on: base, height: 5, material: 'oak_planks' });
  const door = w.opening({ in: house.facade('south'), kind: 'door', width: 3, height: 3 });
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
  w.paving({ from: court.gate, to: door, width: 2, material: 'cobblestone' });
  const { grid } = h.compose();
  // 房门在台基顶 y3，从院内可达。
  assert(measureReach(grid, registry, { targets: [{ x: 0, y: 3, z: 7 }] }).targets[0]?.reached);
  // 铺装端点跳过踏步：踏步实心级在 z=9..10（地表那一级不再写方块，z=11 是地面），
  // 所以铺装最远可到 z=11 的地面，但不得压在 z≤10 的梯级上。
  const pavement = [...grid.cells()].filter((c) => c.state.name === 'cobblestone');
  assert(pavement.length > 0);
  assert(
    pavement.every((c) => c.z >= 11),
    `铺装压到踏步：${JSON.stringify(pavement.filter((c) => c.z < 11).map((c) => [c.x, c.z]))}`,
  );
  assert.equal(grid.get(0, 1, 12)?.state.name, 'cobblestone');
});

test('柱廊与门楼尺寸错误拒绝且不留下记录', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const p = { footprint: rect(-3, -3, 3, 3), y: 1, height: 4, column: { material: 'stone' } };
  for (const variation of [
    { count: 5 },
    { count: 4, spacing: 2 },
    { count: 40 },
    { spacing: 1 },
    { count: 4, column: { width: 4, material: 'stone' } },
  ]) {
    assert.throws(() => w.colonnade({ ...p, ...variation }));
    assert.equal(h.compose().grid.calls().length, 0);
  }
  assert.throws(
    () =>
      w.enclosure({
        outline: rect(-3, -3, 3, 3),
        height: 3,
        material: 'stone',
        gate: { side: 'east', width: 3, height: 3, gatehouse: { width: 9, height: 3, depth: 2, material: 'stone' } },
      }),
    /gatehouse/,
  );
  assert.equal(h.compose().grid.calls().length, 0);
});

test('柱廊十字柱：w1 与 w2 的掩码、bays 两端各缩 1 格、方柱 hash 不变', () => {
  const h = createWorld(registry.table);
  const c = h.world.colonnade({
    footprint: rect(-5, -5, 5, 5),
    y: 1,
    count: 4,
    height: 2,
    column: { material: 'stone', shape: 'cross' },
    beam: false,
  });
  for (const [x, z] of [
    [-5, -5],
    [-6, -5],
    [-4, -5],
    [-5, -6],
    [-5, -4],
  ] as const)
    assert.equal(h.world.get(x, 2, z), 'stone', `十字角柱 (${String(x)},${String(z)})`);
  assert.equal(h.world.get(-6, 2, -6), 'air', '四角留空');
  const bay = c.bays.find((b) => b.footprint.minZ === -5 && b.footprint.maxZ === -5);
  assert(bay !== undefined);
  assert.equal(bay.footprint.minX, -3);
  assert.equal(bay.footprint.maxX, 3);
  // w2：方芯 2×2，四面各加宽 1、长 2。
  const g = createWorld(registry.table);
  g.world.colonnade({
    footprint: rect(0, 0, 10, 10),
    y: 1,
    count: 4,
    height: 2,
    column: { width: 2, material: 'stone', shape: 'cross' },
    beam: false,
  });
  assert.equal(g.world.get(0, 2, 0), 'stone');
  assert.equal(g.world.get(1, 2, 1), 'stone');
  assert.equal(g.world.get(-1, 2, 0), 'stone', '左臂');
  assert.equal(g.world.get(0, 2, -1), 'stone', '北臂');
  assert.equal(g.world.get(-1, 2, -1), 'air', '四角留空');
  // 不传 shape 与显式 square 等价（缺省几何不变）。
  const a = createWorld(registry.table);
  a.world.colonnade({ footprint: rect(-4, -4, 4, 4), y: 1, count: 4, height: 2, column: { material: 'stone' } });
  const b = createWorld(registry.table);
  b.world.colonnade({
    footprint: rect(-4, -4, 4, 4),
    y: 1,
    count: 4,
    height: 2,
    column: { material: 'stone', shape: 'square' },
  });
  assert.equal(JSON.stringify([...a.compose().grid.cells()]), JSON.stringify([...b.compose().grid.cells()]));
});

test('柱廊十字柱坏样本：柱芯间距不足时整次失败', () => {
  const h = createWorld(registry.table);
  assert.throws(
    () =>
      h.world.colonnade({
        footprint: rect(0, 0, 4, 4),
        y: 1,
        spacing: 3,
        height: 2,
        column: { material: 'stone', shape: 'cross' },
        beam: false,
      }),
    /colonnade 十字柱相碰：x 向柱芯间距 2，至少为 4/,
  );
  assert.equal(h.compose().grid.calls().length, 0);
});

test('门楼 outward：四向门楼外凸，门洞贯通 depth，top 可挂屋面并封山墙，铺装从外凸门外起铺', () => {
  for (const [side, expect] of [
    ['north', { minZ: -12, maxZ: -9 }],
    ['south', { minZ: 9, maxZ: 12 }],
    ['east', { minX: 9, maxX: 12 }],
    ['west', { minX: -12, maxX: -9 }],
  ] as const) {
    const h = createWorld(registry.table);
    const w = h.world;
    const court = w.enclosure({
      outline: rect(-10, -10, 10, 10),
      height: 3,
      material: 'stone',
      gate: {
        side,
        width: 3,
        height: 3,
        gatehouse: { depth: 4, width: 5, height: 5, material: 'stone_bricks', outward: 2 },
      },
    });
    assert(court.gatehouse !== undefined, side);
    const gb = court.gatehouse.bounds;
    if ('minX' in expect) {
      assert.equal(gb.min[0], expect.minX, `${side} minX`);
      assert.equal(gb.max[0], expect.maxX, `${side} maxX`);
    } else {
      assert.equal(gb.min[2], expect.minZ, `${side} minZ`);
      assert.equal(gb.max[2], expect.maxZ, `${side} maxZ`);
    }
    assert.equal(court.gate.thickness, 4, `${side} 门槛厚度记 depth`);
    // 门洞贯通整个 depth：gate.bounds 的每格都是空。
    const g = court.gate.bounds;
    for (let x = g.min[0]; x <= g.max[0]; x += 1)
      for (let z = g.min[2]; z <= g.max[2]; z += 1)
        for (let y = g.min[1]; y <= g.max[1]; y += 1)
          assert.equal(w.get(x, y, z), 'air', `${side} 洞 (${String(x)},${String(y)},${String(z)})`);
    // 屋面挂 top，山墙用门楼材质。
    w.roof({ on: court.gatehouse.top, kind: 'gable', ridge: 'z', pitch: 1, material: 'deepslate_tiles' });
    w.paving({ from: court.gate, to: 4, width: 3, material: 'stone' });
  }
});

test('门楼顶面锚点：outward 0 与最大值、east 例子的精确几何', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const court = w.enclosure({
    outline: rect(-15, -13, 15, 13),
    height: 3,
    material: 'white_concrete',
    gate: {
      side: 'east',
      width: 3,
      height: 3,
      gatehouse: { depth: 4, width: 5, height: 5, material: 'white_concrete', outward: 2 },
    },
  });
  assert.deepEqual(court.gate.bounds, { min: [14, 1, -1], max: [17, 3, 1] });
  assert.deepEqual(court.gatehouse?.top, { footprint: { minX: 14, minZ: -2, maxX: 17, maxZ: 2 }, y: 6 });
  assert.equal(w.get(15, 2, 1), 'air', '洞内');
  assert.equal(w.get(15, 1, -2), 'white_concrete', '门楼侧墙');
  w.roof({ on: court.gatehouse.top, kind: 'gable', ridge: 'z', pitch: 1, material: 'deepslate_tiles' });
  assert.equal(w.get(15, 6, -2), 'white_concrete', '挂 top 后自动封山墙');
  w.paving({ from: court.gate, to: 4, width: 3, material: 'stone' });
  assert.equal(w.get(18, 1, 0), 'stone', '铺装从外凸门外起铺');
});

test('门楼 outward 坏样本：超过 depth − thickness 时整次失败', () => {
  const h = createWorld(registry.table);
  assert.throws(
    () =>
      h.world.enclosure({
        outline: rect(-10, -10, 10, 10),
        height: 3,
        material: 'stone',
        gate: {
          side: 'east',
          width: 3,
          height: 3,
          gatehouse: { depth: 4, width: 5, height: 5, material: 'stone', outward: 4 },
        },
      }),
    /gatehouse\.outward=4 超过 depth − thickness=3/,
  );
  assert.throws(
    () =>
      h.world.enclosure({
        outline: rect(-10, -10, 10, 10),
        height: 3,
        thickness: 2,
        material: 'stone',
        gate: {
          side: 'east',
          width: 3,
          height: 3,
          gatehouse: { depth: 3, width: 5, height: 5, material: 'stone', outward: 2 },
        },
      }),
    /超过 depth − thickness=1/,
  );
  assert.equal(h.compose().grid.calls().length, 0);
});

test('区域铺装：格数等于面积，墙/踏步结构胜出，调换先后 hash 相同', () => {
  const h = createWorld(registry.table);
  h.world.paving({ region: rect(-1, 0, 1, 1), material: 'stone_bricks' });
  const cells = [...h.compose().grid.cells()];
  assert.equal(cells.length, 6, 'rect(−1,0,1,1) 面积 3×2');
  assert(cells.every((c) => c.y === 1 && c.state.name === 'stone_bricks'));
  // 墙下结构胜出，且与调用顺序无关。
  const a = createWorld(registry.table);
  a.world.paving({ region: rect(-2, -2, 2, 2), material: 'stone_bricks' });
  a.world.walls({ footprint: rect(-2, -2, 2, 2), y: 1, height: 2, material: 'oak_planks' });
  const b = createWorld(registry.table);
  b.world.walls({ footprint: rect(-2, -2, 2, 2), y: 1, height: 2, material: 'oak_planks' });
  b.world.paving({ region: rect(-2, -2, 2, 2), material: 'stone_bricks' });
  assert.equal(hashGrid(a.compose().grid), hashGrid(b.compose().grid));
  assert.equal(a.world.get(-2, 1, -2), 'oak_planks');
  assert.equal(a.world.get(0, 1, 0), 'stone_bricks', '墙内留空处铺装仍在');
  // inner.footprint 是合法矩形来源。
  const c = createWorld(registry.table);
  const hall = c.world.walls({ footprint: rect(0, 0, 6, 6), y: 1, height: 3, material: 'stone' });
  c.world.paving({ region: hall.inner.footprint, material: 'stone_bricks' });
  assert.equal(c.world.get(1, 1, 1), 'stone_bricks');
});

test('区域铺装坏样本：与 from / width 同传、多边形，整次失败', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const cast = (value: unknown): Parameters<typeof w.paving>[0] => value as Parameters<typeof w.paving>[0];
  assert.throws(
    () => w.paving(cast({ region: rect(0, 0, 2, 2), material: 'stone', width: 1 })),
    /paving\.region 与 from \/ to \/ width 互斥/,
  );
  const base = w.plinth({
    footprint: {
      points: [
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 6],
        [0, 4],
      ],
    },
    height: 1,
    material: 'stone',
  });
  const before = h.compose().grid.calls().length;
  assert.throws(() => w.paving({ region: base.top.footprint, material: 'stone' }), /paving\.region 只接受矩形/);
  assert.equal(h.compose().grid.calls().length, before);
});

test('P1 门楼进深不能越过对面墙内缘：超上限报错且原子，depth 恰好上限通过', () => {
  const bad = createWorld(registry.table);
  assert.throws(
    () =>
      bad.world.enclosure({
        outline: rect(-5, -5, 5, 5),
        height: 3,
        material: 'stone',
        gate: {
          side: 'south',
          width: 3,
          height: 3,
          gatehouse: { depth: 20, width: 5, height: 5, material: 'stone_bricks', outward: 0 },
        },
      }),
    /gatehouse\.depth=20 超过上限 10/,
  );
  assert.equal(bad.compose().grid.calls().length, 0);
  assert.equal(bad.compose().grid.size, 0);
  // 上限 = outline 法线向长 11 + outward 0 − thickness 1 = 10。
  const good = createWorld(registry.table);
  assert.doesNotThrow(() =>
    good.world.enclosure({
      outline: rect(-5, -5, 5, 5),
      height: 3,
      material: 'stone',
      gate: {
        side: 'south',
        width: 3,
        height: 3,
        gatehouse: { depth: 10, width: 5, height: 5, material: 'stone_bricks' },
      },
    }),
  );
  // outward 抬高的上限要一并算进去。
  const outward = createWorld(registry.table);
  assert.doesNotThrow(() =>
    outward.world.enclosure({
      outline: rect(-5, -5, 5, 5),
      height: 3,
      material: 'stone',
      gate: {
        side: 'south',
        width: 3,
        height: 3,
        gatehouse: { depth: 12, width: 5, height: 5, material: 'stone_bricks', outward: 2 },
      },
    }),
  );
});

test('P2 区域铺装与带框落地门：两种顺序 hash 相同，门框与门外净空保留', () => {
  const build = (openingFirst: boolean): WorldHost => {
    const h = createWorld(registry.table);
    const w = h.world;
    const hall = w.walls({ footprint: rect(-3, -3, 3, 3), y: 1, height: 5, material: 'stone' });
    const pave = (): void => {
      w.paving({ region: rect(-5, 2, 5, 6), material: 'cobblestone' });
    };
    const open = (): void => {
      w.opening({
        in: hall.facade('south'),
        kind: 'door',
        width: 3,
        height: 3,
        frame: { material: 'iron_block' },
      });
    };
    if (openingFirst) {
      open();
      pave();
    } else {
      pave();
      open();
    }
    return h;
  };
  const first = build(true);
  const second = build(false);
  assert.equal(hashGrid(first.compose().grid), hashGrid(second.compose().grid));
  assert.equal(first.world.get(-2, 1, 4), 'iron_block', '门框格仍是框材质');
  assert.equal(first.world.get(0, 1, 4), 'air', '门外净空仍是空气');
  assert.equal(second.world.get(-2, 1, 4), 'iron_block');
  assert.equal(second.world.get(0, 1, 4), 'air');
});

test('P2 路径铺装从带框落地门起铺不报错', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const hall = w.walls({ footprint: rect(-3, -3, 3, 3), y: 1, height: 5, material: 'stone' });
  const door = w.opening({
    in: hall.facade('south'),
    kind: 'door',
    width: 3,
    height: 3,
    frame: { material: 'iron_block' },
  });
  assert.doesNotThrow(() => w.paving({ from: door, to: 5, width: 1, material: 'cobblestone' }));
});
