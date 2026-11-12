/** 覆盖反馈只报真实合成状态；样例、行号和调用编号不可交叉配对，存档与 hash 不变。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { readArchive, writeArchive } from '@pg/core/archive';
import { hashGrid } from '@pg/core/hash';
import { createWorld, API_VERSION } from './index.ts';
import { Writer } from './writer.ts';
import type { Write } from './writer.ts';

const table = loadRegistry().table;

function cell(w: Writer, x: number, state: string, writeLayer: Write['writeLayer'], y = 1, z = 0): Write {
  return { x, y, z, state: w.material(state), writeLayer };
}

test('无覆盖与纯同层替换：零损失、不凭空生成状态变化样例', () => {
  const w = new Writer(table);
  assert.deepEqual(w.compose().overlapSummary, {
    sameLayer: 0,
    crossLayer: 0,
    lostDecor: 0,
    groups: [],
    groupsOmitted: 0,
  });
  w.commit('set', {}, [cell(w, 0, 'stone', 'structure')]);
  w.commit('set', {}, [cell(w, 0, 'glass', 'structure')]);
  const result = w.compose();
  assert.deepEqual(result.overlapSummary, {
    sameLayer: 1,
    crossLayer: 0,
    lostDecor: 0,
    groups: [],
    groupsOmitted: 0,
  });
  assert.equal(result.overlaps[0]?.sampleDetail, undefined);
});

test('全盖败方不在存档调用表仍有真实来源；部分盖只统计损失，hash/字节不受报告影响', () => {
  let line = 10;
  const w = new Writer(table, () => line);
  w.commit('set', { material: '故意不可信的参数摘要' }, [cell(w, 0, 'smooth_sandstone_slab[type=top]', 'decoration')]);
  line = 20;
  w.commit('box', {}, [cell(w, 1, 'glass', 'decoration'), cell(w, 2, 'glass', 'decoration')]);
  line = 30;
  w.commit('set', {}, [cell(w, 0, 'nether_brick_slab', 'structure'), cell(w, 1, 'stone', 'structure')]);
  const result = w.compose();
  const summary = result.overlapSummary;
  assert.equal(summary.lostDecor, 2);
  assert.equal(summary.crossLayer, 2);
  assert.equal(result.grid.get(2, 1, 0)?.state.canonical, 'glass');
  const first = summary.groups[0];
  assert.deepEqual(first, {
    winner: 3,
    loser: 1,
    cells: 1,
    sample: [0, 1, 0],
    sampleDetail: {
      expectedState: 'smooth_sandstone_slab[type=top]',
      actualState: 'nether_brick_slab',
      winnerSource: { api: 'set', line: 30, writeLayer: 'structure' },
      loserSource: { api: 'set', line: 10, writeLayer: 'decoration' },
    },
  });
  const bytes = writeArchive(result.grid, API_VERSION);
  const restored = readArchive(table, bytes).grid;
  assert.equal(
    restored.calls().some((c) => c.id === 1),
    false,
  );
  assert.equal(
    restored.calls().some((c) => c.id === 2),
    true,
  );
  assert.equal(hashGrid(result.grid), hashGrid(restored));
  assert.deepEqual(writeArchive(w.compose().grid, API_VERSION), bytes);
  assert.deepEqual(w.compose().overlapSummary, summary);
});

test('同状态覆盖仍计 lostDecor；air 与 opening 玻璃分别保留实际状态，不按 api 猜挖掉', () => {
  for (const actual of ['stone', 'air', 'glass']) {
    const w = new Writer(table);
    w.commit('set', {}, [cell(w, 0, 'stone', 'decoration')]);
    w.commit('opening', {}, [cell(w, 0, actual, 'opening')]);
    const result = w.compose();
    const sample = result.overlapSummary.groups[0];
    assert.equal(result.overlapSummary.lostDecor, 1);
    assert.equal(sample?.sampleDetail.expectedState, 'stone');
    assert.equal(sample.sampleDetail.actualState, actual);
    assert.equal(sample.sampleDetail.winnerSource.writeLayer, 'opening');
    assert.equal(result.grid.get(0, 1, 0)?.state.canonical ?? 'air', actual);
  }
});

test('同调用多状态样例按 y,z,x 选整项；重复合成确定，非手写装饰与装饰空气不附 detail', () => {
  const w = new Writer(table, () => 42);
  w.commit('set', {}, [
    cell(w, -9, 'stone', 'decoration', 3),
    cell(w, -9, 'glass', 'decoration', 2, 3),
    cell(w, 1, 'smooth_sandstone', 'decoration', 2, 1),
    cell(w, 0, 'smooth_sandstone_slab', 'decoration', 2, 1),
  ]);
  w.commit('set', {}, [
    cell(w, -9, 'stone', 'structure', 3),
    cell(w, -9, 'stone', 'structure', 2, 3),
    cell(w, 1, 'stone', 'structure', 2, 1),
    cell(w, 0, 'nether_bricks', 'structure', 2, 1),
  ]);
  const result = w.compose();
  assert.deepEqual(result.overlaps[0]?.sample, [0, 2, 1]);
  assert.equal(result.overlaps[0].sampleDetail?.expectedState, 'smooth_sandstone_slab');
  assert.equal(result.overlaps[0].sampleDetail.actualState, 'nether_bricks');
  assert.deepEqual(result.overlaps[0].sampleDetail, result.overlapSummary.groups[0]?.sampleDetail);
  const other = new Writer(table);
  other.commit('rail', {}, [cell(other, 0, 'glass', 'decoration')]);
  other.commit('set', {}, [cell(other, 1, 'air', 'decoration')]);
  other.commit('set', {}, [cell(other, 0, 'stone', 'structure'), cell(other, 1, 'stone', 'structure')]);
  assert.equal(other.compose().overlapSummary.lostDecor, 0);
  assert.ok(other.compose().overlaps.every((o) => o.sampleDetail === undefined));
});

test('按双方源码 api/line/层聚合，最小坐标代表调用及其行号一起选择', () => {
  let line = 10;
  const w = new Writer(table, () => line);
  for (const x of [5, -2, 3]) w.commit('set', {}, [cell(w, x, x === -2 ? 'glass' : 'stone', 'decoration')]);
  line = 20;
  for (const x of [5, -2, 3]) w.commit('set', {}, [cell(w, x, 'nether_bricks', 'structure')]);
  const summary = w.compose().overlapSummary;
  assert.equal(summary.groups.length, 1);
  assert.deepEqual(summary.groups[0], {
    winner: 5,
    loser: 2,
    cells: 3,
    sample: [-2, 1, 0],
    sampleDetail: {
      expectedState: 'glass',
      actualState: 'nether_bricks',
      winnerSource: { api: 'set', line: 20, writeLayer: 'structure' },
      loserSource: { api: 'set', line: 10, writeLayer: 'decoration' },
    },
  });
  // 不同 loser 行必须分组，不能给最小样例配最大败方的行号。
  line = 11;
  w.commit('set', {}, [cell(w, -3, 'glass', 'decoration')]);
  line = 20;
  w.commit('set', {}, [cell(w, -3, 'stone', 'structure')]);
  assert.equal(w.compose().overlapSummary.groups.length, 2);
  assert.equal(w.compose().overlapSummary.groups[1]?.sampleDetail.loserSource.line, 11);
});

test('任一方未知行退回调用编号；源码 api 与写入层也各自区分，组排序与省略数准确', () => {
  for (const unknown of ['winner', 'loser', 'both']) {
    let line = unknown === 'winner' ? 10 : 0;
    const w = new Writer(table, () => line);
    for (let x = 0; x < 5; x++) w.commit('set', {}, [cell(w, x, 'glass', 'decoration')]);
    line = unknown === 'loser' ? 20 : 0;
    for (let x = 0; x < 5; x++) w.commit('set', {}, [cell(w, x, 'stone', 'structure')]);
    const summary = w.compose().overlapSummary;
    assert.equal(summary.groups.length, 3);
    assert.equal(summary.groupsOmitted, 2);
    assert.equal(summary.lostDecor, 5);
    assert.deepEqual(
      summary.groups.map((g) => g.winner),
      [6, 7, 8],
    );
  }
  const w = new Writer(table, () => 1);
  for (let x = 0; x < 5; x++) {
    const writes = Array.from({ length: x + 1 }, (_, z) => cell(w, x, 'glass', 'decoration', 1, z));
    w.commit(x === 0 ? 'box' : 'set', {}, writes);
    w.commit(
      x === 1 ? 'roof' : 'set',
      {},
      writes.map((c) => ({
        ...c,
        state: w.material('stone'),
        writeLayer: x === 2 ? 'opening' : 'structure',
      })),
    );
  }
  const summary = w.compose().overlapSummary;
  assert.equal(summary.lostDecor, 15);
  assert.equal(summary.groupsOmitted, 1);
  assert.deepEqual(
    summary.groups.map((g) => g.cells),
    [9, 3, 2],
  );
});

test('镜像样例保留翻转后的真实方块状态，不拿原参数恢复状态', () => {
  let line = 7;
  const host = createWorld(table, { callSite: () => line });
  host.world.mirror({ axis: 'x', at: 0 }, () => {
    host.world.set(2, 1, 0, 'oak_stairs[facing=east]', 'decoration');
    line = 8;
    host.world.set(2, 1, 0, 'stone', 'structure');
  });
  const result = host.compose();
  const group = result.overlapSummary.groups[0];
  assert.deepEqual(group?.sample, [-2, 1, 0]);
  assert.equal(group.sampleDetail.expectedState, 'oak_stairs[facing=west]');
  assert.equal(group.sampleDetail.actualState, 'stone');
  assert.equal(group.sampleDetail.loserSource.line, 7);
  assert.equal(group.sampleDetail.winnerSource.line, 8);
});

test('同一胜败调用对写入不同层：原条目保持聚合，summary 仍按真实层分开并各取对应状态', () => {
  const w = new Writer(table, () => 8);
  w.commit('box', {}, [cell(w, 0, 'stone', 'decoration'), cell(w, 1, 'stone', 'decoration')]);
  w.commit('opening', {}, [cell(w, 0, 'glass', 'opening'), cell(w, 1, 'air', 'structure')]);
  const result = w.compose();
  assert.equal(result.overlaps.length, 1);
  assert.equal(result.overlaps[0]?.lostDecor, 2);
  assert.equal(result.overlapSummary.lostDecor, 2);
  assert.equal(result.overlapSummary.groups.length, 2);
  assert.deepEqual(
    result.overlapSummary.groups.map((g) => [
      g.cells,
      g.sample,
      g.sampleDetail.actualState,
      g.sampleDetail.winnerSource.writeLayer,
    ]),
    [
      [1, [0, 1, 0], 'glass', 'opening'],
      [1, [1, 1, 0], 'air', 'structure'],
    ],
  );
});
