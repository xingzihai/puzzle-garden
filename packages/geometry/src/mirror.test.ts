/** 镜像状态与作用域；双镜像还原、默认属性翻转、越界时原子拒绝。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { createWorld, rect } from './index.ts';
import type { WallsHandle } from './index.ts';
import { mirrorState } from './mirror.ts';

const table = loadRegistry().table;
test('默认朝向、楼梯左右、门铰链、连接面和旋转状态双镜像还原', () => {
  for (const text of [
    'oak_stairs',
    'oak_stairs[facing=east,shape=inner_left]',
    'oak_door[hinge=left]',
    'oak_fence[east=true]',
    'rail[shape=ascending_east]',
    'rail',
    'rail[shape=east_west]',
    'chest[type=left]',
    'oak_sign[rotation=3]',
    'jigsaw[orientation=east_up]',
  ]) {
    for (const axis of ['x', 'z'] as const) {
      const state = parseState(table, text);
      assert.equal(mirrorState(table, mirrorState(table, state, axis), axis).canonical, state.canonical);
    }
  }
  assert.equal(mirrorState(table, parseState(table, 'oak_stairs'), 'z').props['facing'], 'south');
});
test('镜像轴允许半格：偶数宽建筑关于 2.5 对称，其他小数拒绝', () => {
  // x 0..5 关于 2.5 镜像：0↔5、1↔4、2↔3。
  const h = createWorld(table);
  const w = h.world;
  w.mirror({ axis: 'x', at: 2.5 }, () => {
    for (const x of [0, 1, 2]) w.set(x, 1, 0, 'stone');
  });
  for (const x of [0, 1, 2, 3, 4, 5]) assert.equal(w.get(x, 1, 0), 'stone', `x=${String(x)} 未成对`);
  assert.equal(h.compose().grid.size, 6);
  // 半格轴下的状态翻转与整数轴一致：0 的 east 反射到 5 的 west。
  const h2 = createWorld(table);
  h2.world.mirror({ axis: 'x', at: 2.5 }, () => {
    h2.world.set(0, 1, 0, 'oak_stairs[facing=east]');
  });
  assert.equal(h2.world.get(0, 1, 0), 'oak_stairs[facing=east]');
  assert.equal(h2.world.get(5, 1, 0), 'oak_stairs[facing=west]');
  // at 0.25 既不是整数也不是半格，报错信息说明只能是整数或半格。
  assert.throws(() => {
    h2.world.mirror({ axis: 'x', at: 0.25 }, () => {
      assert.fail('非法的镜像轴不应执行回调');
    });
  }, /整数或半格/);
  // 半格轴反射后坐标仍是整数且在范围内。
  const h3 = createWorld(table);
  h3.world.mirror({ axis: 'z', at: 1.5 }, () => {
    h3.world.set(0, 1, 1, 'stone');
  });
  assert.equal(h3.world.get(0, 1, 1), 'stone');
  assert.equal(h3.world.get(0, 1, 2), 'stone');
});

test('R9 镜像句柄作用域：内层用外层合法，作用域外使用报错且原子', () => {
  const h = createWorld(table);
  const w = h.world;
  const outer = w.walls({ footprint: rect(-4, -2, 4, 2), y: 1, height: 4, material: 'stone' });
  // 内层用外层句柄合法：外层句柄的快照为空，一定是当前栈的前缀。
  assert.doesNotThrow(() => {
    w.mirror({ axis: 'x', at: 0 }, () => {
      w.floorPlate({ in: outer.inner, material: 'stone' });
    });
  });
  let hall: WallsHandle | undefined;
  w.mirror({ axis: 'x', at: 0 }, () => {
    const base = w.plinth({ footprint: rect(1, -2, 3, 2), height: 1, material: 'stone' });
    hall = w.walls({ on: base, height: 4, material: 'stone' });
    // 同作用域内使用合法。
    w.floorPlate({ in: hall.inner, material: 'stone' });
  });
  const captured = hall;
  if (captured === undefined) throw new Error('mirror 回调未生成 walls 句柄');
  const before = h.compose().grid.calls().length;
  assert.throws(
    () => w.floorPlate({ in: captured.inner, material: 'stone' }),
    /walls 建在 mirror\(\{axis:'x',at:0\}\)/,
  );
  assert.equal(h.compose().grid.calls().length, before);
});

test('嵌套镜像一个整数轴与一个半格轴', () => {
  const h = createWorld(table);
  const w = h.world;
  w.mirror({ axis: 'x', at: 2.5 }, () => {
    w.mirror({ axis: 'z', at: 0 }, () => {
      w.set(1, 1, 0, 'stone');
    });
  });
  // z=0 反射到自身，x=1↔4；去重后两格。
  assert.equal(h.compose().grid.size, 2);
  for (const x of [1, 4]) assert.equal(w.get(x, 1, 0), 'stone', `x=${String(x)}`);
});

test('嵌套镜像四份写入，回调只运行一次，异常恢复作用域', () => {
  const h = createWorld(table);
  const w = h.world;
  let calls = 0;
  w.mirror({ axis: 'x', at: 0 }, () => {
    w.mirror({ axis: 'z', at: 0 }, () => {
      calls += 1;
      w.set(2, 1, 3, 'oak_stairs[facing=east]');
    });
  });
  assert.equal(calls, 1);
  assert.equal(h.compose().grid.size, 4);
  assert.equal(w.get(-2, 1, 3), 'oak_stairs[facing=west]');
  assert.throws(() => {
    w.mirror({ axis: 'x', at: 0 }, () => {
      throw new Error('失败');
    });
  }, /失败/);
  w.set(4, 1, 0, 'stone');
  assert.equal(w.get(-4, 1, 0), 'air');
  const before = h.compose().grid.calls().length;
  assert.throws(() => {
    w.mirror({ axis: 'x', at: 2 ** 25 - 1 }, () => {
      w.set(-1, 1, 0, 'stone');
    });
  }, /越界/);
  assert.equal(h.compose().grid.calls().length, before);
});
