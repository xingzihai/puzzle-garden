/** 写入器的事务、来源与覆盖报告；空气必须保留为高优先级写入。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { hashGrid } from '@pg/core/hash';
import { Writer } from './writer.ts';
import type { Write } from './writer.ts';

const table = loadRegistry().table;

function detail(
  expectedState: string,
  actualState: string,
  winnerApi: string,
  winnerLayer: Write['writeLayer'],
): object {
  return {
    expectedState,
    actualState,
    winnerSource: { api: winnerApi, line: 0, writeLayer: winnerLayer },
    loserSource: { api: 'set', line: 0, writeLayer: 'decoration' },
  };
}

test('三层优先级、同层后写、跨层失败方与成功方均带调用编号', () => {
  const w = new Writer(table);
  const write = (block: string, writeLayer: Write['writeLayer']): Write => ({
    x: 0,
    y: 1,
    z: 0,
    state: w.material(block),
    writeLayer,
  });
  w.commit('decor', {}, [write('oak_planks', 'decoration')]);
  w.commit('wall', {}, [write('stone', 'structure')]);
  w.commit('wall2', {}, [write('stone_bricks', 'structure')]);
  w.commit('door', {}, [write('air', 'opening')]);
  assert.equal(w.get(0, 1, 0), 'air');
  const result = w.compose();
  assert.equal(result.grid.size, 0);
  assert.deepEqual([...result.grid.carved()], [{ x: 0, y: 1, z: 0, call: 4 }]);
  assert.deepEqual(result.overlaps, [
    { kind: 'same-layer', winner: 3, loser: 2, cells: 1 },
    { kind: 'cross-layer', winner: 4, loser: 1, cells: 1 },
    { kind: 'cross-layer', winner: 4, loser: 3, cells: 1 },
  ]);
  assert.deepEqual(w.compose().overlaps, result.overlaps);
  assert.equal(w.get(20, 0, 0), 'air');
});

test('失败调用不留下写入、调用记录或覆盖；部件异常仍恢复父作用域', () => {
  const w = new Writer(table);
  const good: Write = { x: 0, y: 1, z: 0, state: w.material('stone'), writeLayer: 'structure' };
  assert.throws(() => w.commit('bad', {}, [good, { ...good, x: 0.5 }]), /整数/);
  assert.equal(w.compose().grid.calls().length, 0);
  assert.equal(w.compose().grid.size, 0);
  assert.throws(() => w.material('air', true), /不能是空气/);
  w.part('主厅', () => {
    assert.throws(() => {
      w.part('门框', () => {
        w.commit('set', {}, [good]);
        throw new Error('失败');
      });
    }, /失败/);
    w.commit('set', {}, [{ ...good, x: 1 }]);
  });
  w.commit('set', {}, [{ ...good, x: 2 }]);
  const { grid } = w.compose();
  assert.deepEqual(grid.parts(), [
    { id: 1, name: '主厅', parent: 0 },
    { id: 2, name: '门框', parent: 1 },
  ]);
  assert.equal(grid.get(0, 1, 0)?.part, 2);
  assert.equal(grid.get(1, 1, 0)?.part, 1);
  assert.equal(grid.get(2, 1, 0)?.part, 0);
  const hash = hashGrid(grid);
  grid.set(2, 1, 0, w.material('air'), 0, 0);
  assert.equal(hashGrid(w.compose().grid), hash);
});

test('重复写同一调用不报自覆盖；覆盖格数聚合，填充也优先于结构', () => {
  const w = new Writer(table);
  const a: Write = { x: 1, y: 1, z: 1, state: w.material('glass'), writeLayer: 'opening' };
  w.commit('window', {}, [a, a, { ...a, x: 2 }]);
  w.commit('wall', {}, [
    { ...a, state: w.material('stone'), writeLayer: 'structure' },
    { ...a, x: 2, state: w.material('stone'), writeLayer: 'structure' },
  ]);
  assert.equal(w.get(1, 1, 1), 'glass');
  assert.deepEqual(w.compose().overlaps, [{ kind: 'cross-layer', winner: 1, loser: 2, cells: 2 }]);
});

test('callSite 只在 commit 校验全部通过后取一次，失败校验不取；返回非法值不留下调用', () => {
  let calls = 0;
  const w = new Writer(table, () => {
    calls += 1;
    return 42;
  });
  const good: Write = { x: 0, y: 1, z: 0, state: w.material('stone'), writeLayer: 'structure' };
  // 非整数坐标在 commit 内的 checkCoord 失败，早于 callSite。
  assert.throws(() => w.commit('bad', {}, [good, { ...good, x: 0.5 }]), /整数/);
  assert.equal(calls, 0);
  w.commit('set', {}, [good]);
  assert.equal(calls, 1);
  assert.equal(w.compose().grid.calls()[0]?.line, 42);

  const bad = new Writer(table, () => 1.5);
  assert.throws(() => bad.commit('set', {}, [good]), /callSite 必须返回非负整数/);
  assert.equal(bad.compose().grid.calls().length, 0);
  assert.equal(bad.compose().grid.size, 0);
});

test('决策 #92：跨层败方是装饰层 set/box 实体时带 lostDecor 与按 y、z、x 最小的 sample', () => {
  const w = new Writer(table);
  const cell = (x: number, y: number, z: number, block: string, writeLayer: Write['writeLayer']): Write => ({
    x,
    y,
    z,
    state: w.material(block),
    writeLayer,
  });
  const points = [
    [9, 2, 1],
    [4, 1, 3],
    [7, 1, 2],
    [1, 1, 2],
  ] as const;
  w.commit(
    'set',
    {},
    points.map(([x, y, z]) => cell(x, y, z, 'white_stained_glass', 'decoration')),
  );
  w.commit(
    'walls',
    {},
    points.map(([x, y, z]) => cell(x, y, z, 'quartz_block', 'structure')),
  );
  // 格数 4；y 最小为 1，再比 z 取 2，再比 x 取 1。
  assert.deepEqual(w.compose().overlaps, [
    {
      kind: 'cross-layer',
      winner: 2,
      loser: 1,
      cells: 4,
      lostDecor: 4,
      sample: [1, 1, 2],
      sampleDetail: detail('white_stained_glass', 'quartz_block', 'walls', 'structure'),
    },
  ]);
});

test('决策 #92：构件（非 set / box）写的装饰被盖，不带 lostDecor', () => {
  const w = new Writer(table);
  const deco: Write = { x: 0, y: 1, z: 0, state: w.material('oak_fence'), writeLayer: 'decoration' };
  w.commit('rail', {}, [deco]);
  w.commit('walls', {}, [{ ...deco, state: w.material('stone'), writeLayer: 'structure' }]);
  assert.deepEqual(w.compose().overlaps, [{ kind: 'cross-layer', winner: 2, loser: 1, cells: 1 }]);
});

test('决策 #92：开洞层空气盖住装饰层 set 的实体也计入（玻璃被洞挖掉同样是丢失）', () => {
  const w = new Writer(table);
  const glass: Write = { x: 0, y: 1, z: 0, state: w.material('white_stained_glass'), writeLayer: 'decoration' };
  w.commit('set', {}, [glass]);
  w.commit('opening', {}, [{ ...glass, state: w.material('air'), writeLayer: 'opening' }]);
  assert.deepEqual(w.compose().overlaps, [
    {
      kind: 'cross-layer',
      winner: 2,
      loser: 1,
      cells: 1,
      lostDecor: 1,
      sample: [0, 1, 0],
      sampleDetail: detail('white_stained_glass', 'air', 'opening', 'opening'),
    },
  ]);
});

test('决策 #92：只有部分装饰被盖时按格计数，未被盖的不算', () => {
  const w = new Writer(table);
  const cell = (x: number, block: string, writeLayer: Write['writeLayer']): Write => ({
    x,
    y: 1,
    z: 0,
    state: w.material(block),
    writeLayer,
  });
  w.commit('set', {}, [cell(0, 'glass', 'decoration'), cell(1, 'glass', 'decoration'), cell(2, 'glass', 'decoration')]);
  w.commit('walls', {}, [cell(0, 'stone', 'structure'), cell(1, 'stone', 'structure')]);
  assert.deepEqual(w.compose().overlaps, [
    {
      kind: 'cross-layer',
      winner: 2,
      loser: 1,
      cells: 2,
      lostDecor: 2,
      sample: [0, 1, 0],
      sampleDetail: detail('glass', 'stone', 'walls', 'structure'),
    },
  ]);
  assert.equal(w.get(2, 1, 0), 'glass');
});
