/** 材质带、后殿与重复异形洞的组合；坏参数必须完整拒绝。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { createWorld, rect } from './index.ts';

const table = loadRegistry().table;
test('材质带按相对高度分段，重叠或越界带拒绝', () => {
  const h = createWorld(table);
  const w = h.world;
  const p = { footprint: rect(-5, -5, 5, 5), y: 2, height: 8, material: 'stone' };
  w.walls({ ...p, bands: [{ from: 4, to: 7, material: 'oak_planks' }] });
  assert.equal(w.get(-5, 5, 0), 'stone');
  assert.equal(w.get(-5, 6, 0), 'oak_planks');
  for (const bands of [
    [{ from: 0, to: 8, material: 'stone' }],
    [{ from: 4, to: 3, material: 'stone' }],
    [
      { from: 0, to: 3, material: 'stone' },
      { from: 3, to: 5, material: 'stone' },
    ],
  ]) {
    assert.throws(() => w.walls({ ...p, bands }), /bands/);
    assert.equal(h.compose().grid.calls().length, 1);
  }
});
test('后殿曲边围合而非实心，直边可开连接门', () => {
  const h = createWorld(table);
  const w = h.world;
  const apse = w.walls({ footprint: rect(-5, -6, 5, 0), y: 1, height: 6, outline: 'apse', material: 'stone' });
  assert.equal(w.get(-5, 1, -6), 'air');
  assert.equal(w.get(0, 1, -3), 'air');
  assert.equal(w.get(0, 1, -6), 'stone');
  assert.equal(w.get(0, 1, 0), 'stone');
  w.opening({ in: apse.facade('south'), kind: 'door', width: 3, height: 3 });
  assert.equal(w.get(0, 1, 0), 'air');
  w.opening({ in: apse.facade('north'), kind: 'window', width: 3, height: 2, sill: 2, fill: 'glass' });
  assert.equal(w.get(0, 3, -6), 'glass');
  w.floorPlate({ in: apse.inner, material: 'oak_planks' });
  assert.equal(w.get(-4, 1, -5), 'air');
  assert.throws(
    () => w.walls({ footprint: rect(0, 0, 2, 2), y: 1, height: 3, outline: 'apse', thickness: 2, material: 'stone' }),
    /内部空间/,
  );
});
test('四种洞形、雨棚与窗框，不让外框填满圆窗或拱门', () => {
  for (const shape of ['rect', 'arch', 'pointed', 'round'] as const) {
    const h = createWorld(table);
    const w = h.world;
    const hall = w.walls({ footprint: rect(-5, -5, 5, 5), y: 1, height: 10, material: 'stone' });
    w.opening({
      in: hall.facade('south'),
      kind: 'window',
      width: 5,
      height: 5,
      sill: 2,
      shape,
      fill: 'glass',
      frame: { material: 'oak_planks' },
      canopy: { depth: 2, material: 'stone_bricks' },
    });
    assert.equal(w.get(0, 5, 5), 'glass');
    assert.equal(w.get(0, 8, 7), 'stone_bricks');
    if (shape !== 'rect') assert.equal(w.get(-2, 7, 5), 'stone');
    // 玻璃只在墙厚之内，墙外是空气净空（审查 A5：原先玻璃外凸到雨棚深度）
    assert.equal(w.get(0, 5, 6), 'air');
    assert.equal(w.get(0, 5, 7), 'air');
  }
});

test('坏样本回归：带框、带雨棚的窗不外凸；玻璃格数等于洞面积 × 墙厚', () => {
  for (const thickness of [1, 2]) {
    const h = createWorld(table);
    const hall = h.world.walls({ footprint: rect(-5, -5, 5, 5), y: 1, height: 8, thickness, material: 'stone' });
    h.world.opening({
      in: hall.facade('south'),
      kind: 'window',
      width: 3,
      height: 2,
      sill: 2,
      fill: 'glass',
      frame: { material: 'oak_planks' },
      canopy: { depth: 3, material: 'stone_bricks' },
    });
    const glass = [...h.compose().grid.cells()].filter((c) => c.state.name === 'glass');
    assert.equal(glass.length, 3 * 2 * thickness);
    assert(
      glass.every((c) => c.z > 5 - thickness),
      '玻璃在墙外',
    );
  }
});

test('立面合法范围不含转角：洞不能开进相邻墙，报错给出可用的 at 范围（审查 A6）', () => {
  for (const thickness of [1, 2]) {
    const h = createWorld(table);
    const hall = h.world.walls({ footprint: rect(0, 0, 10, 10), y: 1, height: 5, thickness, material: 'stone' });
    const south = hall.facade('south');
    // 居中洞宽 1 时 at ∈ [−5 + thickness, 5 − thickness]
    h.world.opening({ in: south, kind: 'door', width: 1, height: 2, at: -5 + thickness });
    assert.throws(
      () => h.world.opening({ in: south, kind: 'door', width: 1, height: 2, at: -5 + thickness - 1 }),
      new RegExp(`at 改到 \\[${String(-5 + thickness)}, ${String(5 - thickness)}\\]`),
    );
    // 按间距重复：所有洞都在墙身里，转角两端不出现洞
    const north = hall.facade('north');
    h.world.opening({ in: north, kind: 'window', width: 1, height: 2, sill: 1, repeat: { every: 5 } });
    for (let i = 0; ; i += 1) {
      let o;
      try {
        o = north.opening(i);
      } catch {
        break;
      }
      assert(o.bounds.min[0] >= thickness && o.bounds.max[0] <= 10 - thickness, `洞 ${String(i)} 开进转角`);
    }
  }
});

test('台基边没有转角：踏步可以放到台基边的端点', () => {
  const h = createWorld(table);
  const base = h.world.plinth({ footprint: rect(-1, -3, 1, 3), height: 2, material: 'stone' });
  // 南边宽 3，踏步宽 3：正好铺满整条边
  h.world.steps({ to: base.edge('south'), width: 3, material: 'stone_brick_stairs' });
  assert.equal(h.compose().grid.calls().length, 2);
});
test('窗列按间距或楼层重复，每个洞有序可取；无效重复不留部分洞', () => {
  const h = createWorld(table);
  const w = h.world;
  const hall = w.walls({ footprint: rect(-10, -5, 10, 5), y: 1, storeys: { count: 3, height: 6 }, material: 'stone' });
  const south = hall.facade('south');
  w.opening({ in: south, kind: 'window', width: 2, height: 2, sill: 2, repeat: { every: 4 } });
  assert(south.opening(4));
  assert.throws(() => south.opening(5));
  const north = hall.facade('north');
  w.opening({ in: north, kind: 'window', width: 2, height: 2, sill: 2, repeat: { storeys: [0, 1, 2] } });
  // S1：sill 从该层楼板顶面（层底 + 1）算起，storey(2).y=13、sill=2 → 洞底 16。
  assert.equal(north.opening(2).bounds.min[1], 16);
  for (const repeat of [{ storeys: [0, 4] }, { storeys: [1, 1] }, { every: 1 }]) {
    assert.throws(() => w.opening({ in: north, kind: 'window', width: 2, height: 2, repeat }));
    assert.throws(() => north.opening(3));
  }
  const plain = w.walls({ footprint: rect(-3, -3, 3, 3), y: 1, height: 6, material: 'stone' });
  assert.throws(
    () => w.opening({ in: plain.facade('east'), kind: 'window', width: 1, height: 1, repeat: { storeys: [0] } }),
    /storeys/,
  );
});

test('S1 repeat.storeys 的 sill 从该层楼板顶面算起，sill 0 与楼面齐平', () => {
  const h = createWorld(table);
  const w = h.world;
  const hall = w.walls({ footprint: rect(-5, -5, 5, 5), y: 1, storeys: { count: 2, height: 6 }, material: 'stone' });
  const plate = w.floorPlate({ in: hall.storey(1), material: 'oak_planks' });
  const door = w.opening({
    in: hall.facade('south'),
    kind: 'door',
    width: 3,
    height: 2,
    sill: 0,
    repeat: { storeys: [1] },
  });
  assert.equal(door.bounds.min[1], plate.top.y, 'storey 0 的洞底应等于该层站立面');
  assert.equal(plate.top.y, hall.storey(1).y + 1);
  // 好样本：普通（无 storeys）外墙的 sill 仍从墙底算。
  const plain = w.walls({ footprint: rect(-5, -5, 5, 5), y: 10, height: 6, material: 'stone' });
  const win = w.opening({ in: plain.facade('south'), kind: 'window', width: 1, height: 1, sill: 2 });
  assert.equal(win.bounds.min[1], 12, '无 storeys 时洞底 = 墙底 10 + sill 2');
});
