/** 基础构件组合回归：墙不填室内、洞不被墙盖、失败不写半成品、确定性与来源。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import fc from 'fast-check';
import { loadRegistry } from '@pg/blocks/load';
import { hashGrid } from '@pg/core/hash';
import { measureFloating } from '@pg/analysis/floating';
import { createWorld, rect } from './index.ts';
import { parse, plinthSchema, wallsSchema, openingSchema } from './schema.ts';

const table = loadRegistry().table;
const footprint = rect(-4, -4, 4, 4);

/** 捕获同步调用的报错文案；不抛错时视为测试失败。 */
function message(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('预期这次调用报错，但没有');
}

test('台基外挑不改变承托轮廓，外墙留空，门贯穿厚墙且不会被重写墙填回', () => {
  const data: unknown = JSON.parse(readFileSync(new URL('../fixtures/basic-hall.json', import.meta.url), 'utf8'));
  const fixture = parse(
    z.strictObject({
      base: z.unknown(),
      wall: z.record(z.string(), z.unknown()),
      door: z.record(z.string(), z.unknown()),
    }),
    data,
  );
  const host = createWorld(table);
  const w = host.world;
  const base = w.plinth(parse(plinthSchema, fixture.base));
  assert.deepEqual(base.bounds, { min: [-5, 1, -5], max: [5, 2, 5] });
  assert.deepEqual(base.top, { footprint, y: 3 });
  assert.equal(base.edge('south').footprint.maxZ, 5);
  const wallParams = parse(wallsSchema, { footprint, y: base.top.y, ...fixture.wall });
  const walls = w.walls({
    on: base,
    height: 'height' in wallParams ? wallParams.height : wallParams.storeys.count * wallParams.storeys.height,
    thickness: wallParams.thickness,
    material: wallParams.material,
  });
  assert.equal(w.get(0, 3, 0), 'air');
  assert.equal(walls.top.y, 9);
  const south = walls.facade('south');
  assert.equal(walls.facade('south'), south);
  const doorParams = parse(openingSchema.unwrap().omit({ in: true }), fixture.door);
  const door = w.opening({ ...doorParams, in: south });
  assert.equal(south.opening(0), door);
  assert.throws(() => south.opening(-1), /索引/);
  assert.throws(() => south.opening(0.5), /索引/);
  w.walls({ footprint, y: 3, height: 6, thickness: 2, material: 'stone' });
  for (const z of [3, 4, 5]) assert.equal(w.get(0, 3, z), 'air');
  assert.equal(w.get(2, 3, 5), 'stone');
  const result = host.compose();
  assert.equal(result.grid.calls().length, 4);
  assert.equal(result.grid.calls()[2]?.api, 'opening');
  assert.equal(result.grid.get(-4, 3, 0)?.call, 4);
  assert(result.overlaps.some((o) => o.winner === 3 && o.loser === 4));
  assert.equal(measureFloating(result.grid).cells, 0);
});

test('窗填充、显式位置、表面关系与部件；快照不影响查询', () => {
  const host = createWorld(table);
  const w = host.world;
  w.part('主厅', () => {
    const base = w.plinth({ footprint, height: 1, material: 'stone' });
    const hall = w.walls({ on: base.top, height: 5, material: 'stone' });
    w.opening({ in: hall.facade('east'), kind: 'window', width: 2, height: 2, sill: 1, fill: 'glass' });
  });
  assert.equal(w.get(4, 3, -1), 'glass');
  assert.equal(host.compose().grid.get(4, 3, -1)?.part, 1);
  w.set(0, 2, 0, 'oak_planks', 'decoration');
  w.box([0, 2, 0], [0, 2, 0], 'stone');
  assert.equal(w.get(0, 2, 0), 'stone');
  w.box([0, 2, 0], [0, 2, 0], 'air');
  w.set(0, 2, 0, 'stone');
  assert.equal(w.get(0, 2, 0), 'air');
  w.set(0, 2, 0, 'glass', 'opening');
  assert.equal(w.get(0, 2, 0), 'glass');
  w.set(0, 2, 0, 'air');
  assert.equal(host.compose().grid.get(0, 2, 0), undefined);
});

test('错误材质、无室内、越界和跨世界锚点拒绝，失败不增加调用表', () => {
  const host = createWorld(table);
  const other = createWorld(table);
  const w = host.world;
  const base = other.world.plinth({ footprint, height: 1, material: 'stone' });
  const wall = other.world.walls({ on: base, height: 5, material: 'stone' });
  for (const action of [
    () => w.walls({ on: base, height: 5, material: 'stone' }),
    () => w.opening({ in: wall.facade('north'), kind: 'gate', width: 3, height: 3 }),
    () => w.walls({ footprint, y: 1, height: 5, thickness: 5, material: 'stone' }),
    () => w.plinth({ footprint, y: 2047, height: 1, material: 'stone' }),
    () => w.plinth({ footprint, height: 1, material: 'air' }),
    () => {
      w.set(0.5, 1, 0, 'stone');
    },
    () => {
      w.set(0, 1, 0, 'ston');
    },
    () => {
      w.box([0, 1, 0], [1, 2048, 1], 'stone');
    },
  ]) {
    assert.throws(action);
    assert.equal(host.compose().grid.calls().length, 0);
    assert.equal(host.compose().grid.size, 0);
  }
  const hall = w.walls({ footprint, y: 1, height: 5, material: 'stone' });
  assert.throws(() => w.opening({ in: hall.facade('north'), kind: 'door', width: 20, height: 3 }));
  assert.throws(() => hall.facade('north').opening(0));
  assert.equal(host.compose().grid.calls().length, 1);
});

test('显式写入层不能把空气降为结构或装饰，报错后保持原格与调用表', () => {
  const host = createWorld(table);
  host.world.set(0, 1, 0, 'stone');
  assert.throws(() => {
    host.world.set(0, 1, 0, 'air', 'structure');
  }, /空气必须/);
  assert.throws(() => {
    host.world.box([0, 1, 0], [1, 1, 1], 'air', 'decoration');
  }, /空气必须/);
  assert.equal(host.world.get(0, 1, 0), 'stone');
  assert.equal(host.compose().grid.calls().length, 1);
});

test('性质：跨层顺序不影响体素集合，重复执行完全确定', () => {
  fc.assert(
    fc.property(fc.integer({ min: -20, max: 20 }), fc.boolean(), (x, reverse) => {
      function build(order: boolean): string {
        const host = createWorld(table);
        const w = host.world;
        const carve = (): void => {
          w.box([x, 1, 0], [x, 3, 0], 'air');
        };
        if (order) carve();
        w.box([x - 2, 1, 0], [x + 2, 5, 0], 'stone');
        if (!order) carve();
        return hashGrid(host.compose().grid);
      }
      assert.equal(build(reverse), build(!reverse));
      assert.equal(build(reverse), build(reverse));
    }),
  );
});

test('callSite 注入：成功调用各取一次行号，part / mirror 回调分别取值，失败调用不取', () => {
  let calls = 0;
  let seq = 0;
  const host = createWorld(table, {
    callSite: () => {
      calls += 1;
      seq += 1;
      return 100 + seq;
    },
  });
  const w = host.world;
  w.set(0, 1, 0, 'stone');
  w.part('塔', () => {
    w.set(1, 1, 0, 'stone');
  });
  // mirror at x=0 把 x=2 反射到 x=-2；副本与原调用同属一次 commit，共用同一个行号。
  w.mirror({ axis: 'x', at: 0 }, () => {
    w.set(2, 1, 0, 'stone');
  });
  const { grid } = host.compose();
  assert.equal(calls, 3);
  assert.deepEqual(
    grid.calls().map((c) => c.line),
    [101, 102, 103],
  );
  const mirrored = grid.get(2, 1, 0);
  assert.equal(mirrored?.call, grid.get(-2, 1, 0)?.call);
  // 失败调用不读取调用点：材质非法在 commit 之前抛。
  assert.throws(() => {
    w.set(3, 1, 0, 'stone_brikcs');
  }, /未知方块/);
  assert.equal(calls, 3);
  assert.equal(host.compose().grid.calls().length, 3);
});

test('callSite 返回非法值抛错且不留下调用；未注入时 line 为 0', () => {
  const negative = createWorld(table, { callSite: () => -1 });
  assert.throws(() => {
    negative.world.set(0, 1, 0, 'stone');
  }, /callSite 必须返回非负整数/);
  assert.equal(negative.compose().grid.calls().length, 0);
  assert.equal(negative.compose().grid.size, 0);

  const fractional = createWorld(table, { callSite: () => 1.5 });
  assert.throws(() => {
    fractional.world.set(0, 1, 0, 'stone');
  }, /callSite 必须返回非负整数/);

  const plain = createWorld(table);
  plain.world.set(0, 1, 0, 'stone');
  assert.equal(plain.compose().grid.calls()[0]?.line, 0);
});

test('运行期仍接受 minecraft: 前缀材质，声明收窄只约束预检', () => {
  const host = createWorld(table);
  host.world.set(0, 1, 0, 'minecraft:stone');
  host.world.set(1, 1, 0, 'minecraft:oak_stairs[facing=east]');
  assert.equal(host.world.get(0, 1, 0), 'stone');
  assert.equal(host.world.get(1, 1, 0), 'oak_stairs[facing=east]');
});

test('opening.storey：sill 从该层楼面算，可与 repeat.every 组合', () => {
  const host = createWorld(table);
  const w = host.world;
  const hall = w.walls({ footprint: rect(-6, -6, 6, 6), y: 1, storeys: { count: 2, height: 5 }, material: 'stone' });
  // storey 1：洞底 = 墙底 + 1×层高 + 1 = 1 + 5 + 1 = 7，与二层楼板顶齐平。
  const door = w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 3, storey: 1 });
  assert.equal(door.bounds.min[1], 7);
  // storey 0：洞底 = 1 + 0 + 1 = 2，与底层楼板顶齐平。
  const door0 = w.opening({ in: hall.facade('north'), kind: 'door', width: 3, height: 3, storey: 0 });
  assert.equal(door0.bounds.min[1], 2);
  // repeat.every 只在该层排一排窗，洞底仍在 2。
  w.opening({
    in: hall.facade('east'),
    kind: 'window',
    width: 2,
    height: 2,
    storey: 0,
    repeat: { every: 4 },
    fill: 'glass',
  });
  assert.equal(w.get(6, 2, -1), 'glass');
  assert.equal(w.get(6, 7, -1), 'stone');
});

test('opening.storey 坏样本：无 storeys、越界、穿板、与 repeat.storeys 同传，整次失败', () => {
  const host = createWorld(table);
  const w = host.world;
  const onlyHeight = w.walls({ footprint, y: 1, height: 8, material: 'stone' });
  assert.throws(
    () => w.opening({ in: onlyHeight.facade('south'), kind: 'door', width: 3, height: 3, storey: 0 }),
    /opening\.storey 需要外墙用 storeys 建造/,
  );
  const before = host.compose().grid.calls().length;
  const hall = w.walls({ footprint: rect(-6, -6, 6, 6), y: 1, storeys: { count: 2, height: 5 }, material: 'stone' });
  assert.throws(
    () => w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 3, storey: 2 }),
    /不存在，可用 \[0, 1\]/,
  );
  assert.throws(
    () => w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 6, storey: 0 }),
    /穿进第 1 层楼板/,
  );
  assert.throws(
    () =>
      w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 3, storey: 0, repeat: { storeys: [0] } }),
    /opening\.storey 与 repeat\.storeys 二选一/,
  );
  assert.equal(host.compose().grid.calls().length, before + 1);
});

test('opening.mullion：竖框列从小坐标端起每 every 格，配 frame 与 repeat', () => {
  const host = createWorld(table);
  const w = host.world;
  const hall = w.walls({ footprint: rect(-8, -4, 8, 4), y: 1, height: 8, material: 'stone' });
  // width 13 的北窗：洞 x −6..6、y 3..4；竖框 x = −6、−4、…、6 共 7 列。
  w.opening({
    in: hall.facade('north'),
    kind: 'window',
    width: 13,
    height: 2,
    sill: 2,
    fill: 'glass',
    mullion: { material: 'iron_bars' },
  });
  for (let x = -6; x <= 6; x += 2) assert.equal(w.get(x, 3, -4), 'iron_bars', `竖框 x=${String(x)}`);
  assert.equal(w.get(-5, 3, -4), 'glass');
  // 配 frame：框在外侧一格（东立面 x=9），洞内竖框仍在 x=8。
  w.opening({
    in: hall.facade('east'),
    kind: 'window',
    width: 5,
    height: 2,
    sill: 2,
    fill: 'glass',
    mullion: { material: 'iron_bars' },
    frame: { material: 'stone' },
  });
  assert.equal(w.get(8, 3, -2), 'iron_bars');
  assert.equal(w.get(8, 3, -1), 'glass');
  assert.equal(w.get(9, 3, -3), 'stone', '框在外侧一格');
  // 配 repeat：每个副本各自从自己的 start 分格，仍有竖框与玻璃。
  w.opening({
    in: hall.facade('south'),
    kind: 'window',
    width: 5,
    height: 2,
    sill: 2,
    fill: 'glass',
    mullion: { material: 'iron_bars' },
    repeat: { every: 6 },
  });
  const bars = [...host.compose().grid.cells()].filter((c) => c.y === 3 && c.state.name === 'iron_bars');
  assert(bars.length > 0);
});

test('opening.mullion 坏样本：门、拱窗、宽度不足，整次失败', () => {
  const host = createWorld(table);
  const w = host.world;
  const hall = w.walls({ footprint: rect(-8, -4, 8, 4), y: 1, height: 8, material: 'stone' });
  const before = host.compose().grid.calls().length;
  assert.throws(
    () =>
      w.opening({
        in: hall.facade('north'),
        kind: 'door',
        width: 5,
        height: 3,
        mullion: { material: 'iron_bars' },
      }),
    /opening\.mullion 只用于矩形窗/,
  );
  assert.throws(
    () =>
      w.opening({
        in: hall.facade('north'),
        kind: 'window',
        shape: 'arch',
        width: 5,
        height: 3,
        mullion: { material: 'iron_bars' },
      }),
    /只用于矩形窗/,
  );
  assert.throws(
    () =>
      w.opening({
        in: hall.facade('north'),
        kind: 'window',
        width: 2,
        height: 2,
        mullion: { material: 'iron_bars' },
      }),
    /width 至少为 3/,
  );
  // P4：width 必须是 k·every + 1（两端竖框），报错给出最近合法 width。
  assert.throws(
    () =>
      w.opening({
        in: hall.facade('north'),
        kind: 'window',
        width: 6,
        height: 2,
        mullion: { material: 'iron_bars' },
      }),
    /不满足 width = k·every \+ 1[\s\S]*最近的合法 width 是 5/,
  );
  assert.throws(
    () =>
      w.opening({
        in: hall.facade('north'),
        kind: 'window',
        width: 8,
        height: 2,
        mullion: { material: 'iron_bars' },
      }),
    /最近的合法 width 是 7/,
  );
  assert.equal(host.compose().grid.calls().length, before);
});

test('opening 越界报错写全当前 at、墙身范围、已有洞与可放 at（首批运行 #3）', () => {
  const host = createWorld(table);
  const w = host.world;
  const hall = w.walls({ footprint: rect(-5, -5, 5, 5), y: 1, height: 6, material: 'stone' });
  const south = hall.facade('south');
  w.opening({ in: south, kind: 'window', width: 2, height: 2, sill: 2, at: 0, frame: { material: 'iron_block' } });
  const text = message(() => w.opening({ in: south, kind: 'door', width: 20, height: 2 }));
  assert.match(text, /当前 at=0/);
  assert.match(text, /本立面墙身可用 x ∈ \[-4, 4\]（共 9 格/);
  assert.match(text, /本立面已有 1 个洞：at=0 连框占 x∈\[-2, 1\]/);
  assert.match(text, /frame 默认宽 1，两侧各占 1 格/);
  assert.match(text, /或把 at 改到 \[[-\d]+, [-\d]+\]/);
  assert.equal(host.compose().grid.calls().length, 2, '失败调用不留下半成品');
});

test('walls 同时给 on 与 footprint：报「写法二选一」中文（首批运行 #3）', () => {
  const host = createWorld(table);
  const w = host.world;
  const base = w.plinth({ footprint, height: 1, material: 'stone' });
  const text = message(() => w.walls({ on: base.top, footprint, y: 1, height: 5, material: 'stone' }));
  assert.match(text, /写法二选一/);
  assert.match(text, /A（on）/);
  assert.match(text, /B（footprint \+ y）/);
  assert.match(text, /你给了/);
  assert.match(text, /footprint/);
});
