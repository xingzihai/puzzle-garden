import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseState } from '@pg/core/block-state';

import { box, gridOf, ground, registry } from './fixtures.test.ts';
import { MAX_DROP, measureReach } from './reach.ts';

/** 直跑楼梯：从 (0,1,z0) 起每级 +1，共 n 级，沿 +x 方向。 */
function straightStair(n: number, block = 'oak_stairs[facing=east]'): [number, number, number, string][] {
  const out: [number, number, number, string][] = [];
  for (let i = 0; i < n; i += 1) {
    out.push([i, i + 1, 0, block]);
    for (let y = 1; y <= i; y += 1) out.push([i, y, 0, 'stone']);
  }
  return out;
}

describe('measureReach：好样本', () => {
  it('空网格', () => {
    const r = measureReach(gridOf([]), registry, { targets: [{ x: 0, y: 1, z: 0 }] });
    assert.equal(r.standable, 0);
    assert.equal(r.maxReachedY, undefined);
    assert.deepEqual(r.targets, [{ cell: { x: 0, y: 1, z: 0 }, reached: false }]);
  });

  it('平地可达，最高站立高度为 1', () => {
    const r = measureReach(gridOf(ground(2)), registry);
    assert.equal(r.maxReachedY, 1);
    assert.equal(r.reached, r.standable);
    assert.deepEqual(r.blockers, []);
  });

  it('逐级 +1 的直跑楼梯能走到顶', () => {
    const g = gridOf([...ground(2), ...straightStair(6)]);
    const r = measureReach(g, registry, { targets: [{ x: 5, y: 7, z: 0 }] });
    assert.equal(r.maxReachedY, 7);
    assert.deepEqual(r.targets[0]?.reached, true);
  });

  it('实心块也能一级一级跳上去（头顶有空间时）', () => {
    const g = gridOf([...ground(2), ...straightStair(4, 'stone')]);
    assert.equal(measureReach(g, registry).maxReachedY, 5);
  });

  it('可穿过的方块不挡人，也不能站：草、地毯、开着的门', () => {
    const g = gridOf([
      ...ground(3),
      ...box(-1, 1, -1, 1, 1, 1, 'grass'),
      [2, 1, 2, 'white_carpet'],
      [0, 1, 3, 'oak_door'],
    ]);
    const r = measureReach(g, registry, { targets: [{ x: 0, y: 1, z: 0 }] });
    assert.equal(r.targets[0]?.reached, true);
    assert.equal(r.maxReachedY, 1);
  });

  it('下落不超过 3 格', () => {
    // 一座 4 高的台，台顶用楼梯上去；台的另一侧是 3 格落差与 4 格落差两个平台
    assert.equal(MAX_DROP, 3);
    const g = gridOf([
      ...ground(8),
      ...straightStair(4),
      ...box(4, 1, -1, 5, 4, 1, 'stone'), // 台顶站立高度 5
      ...box(6, 1, -1, 6, 1, 1, 'stone'), // 站立高度 2：从 5 落 3 格
      ...box(4, 1, -4, 5, 0, -3, 'stone'), // 地面高度 1 的一块：从 5 落 4 格（但地面本身从外面能走到）
    ]);
    const r = measureReach(g, registry, { targets: [{ x: 6, y: 2, z: 0 }] });
    assert.equal(r.targets[0]?.reached, true);
  });
});

describe('measureReach：坏样本', () => {
  it('一次高 2 格上不去，报 too-high', () => {
    const g = gridOf([...ground(3), ...box(1, 1, -1, 2, 2, 1, 'stone')]);
    const r = measureReach(g, registry, { targets: [{ x: 1, y: 3, z: 0 }] });
    assert.equal(r.targets[0]?.reached, false);
    assert.equal(r.maxReachedY, 1);
    assert.equal(r.maxStandableY, 3);
    assert.ok(r.blockers.some((b) => b.reason === 'too-high' && b.to.y === 3));
  });

  it('要跳的台阶被楼板盖住头顶：报 no-headroom 并给出挡路方块', () => {
    // 实心块台阶：站立点 (i, i + 2, 0)。从 (1, 3) 跳到 (2, 4) 需要 (1, 5) 是空的，在那里放一块楼板
    const g = gridOf([...ground(4), ...straightStair(4, 'stone'), [1, 5, 0, 'oak_planks']]);
    const r = measureReach(g, registry, { targets: [{ x: 3, y: 5, z: 0 }] });
    assert.equal(r.targets[0]?.reached, false);
    assert.equal(r.maxReachedY, 3);
    const b = r.blockers.find((x) => x.reason === 'no-headroom');
    assert.deepEqual(b?.block, { x: 1, y: 5, z: 0, block: 'oak_planks', call: 0 });
  });

  it('楼梯方块上一级不用跳：同样的楼板下仍能走上去', () => {
    const g = gridOf([...ground(4), ...straightStair(4), [1, 5, 0, 'oak_planks']]);
    const r = measureReach(g, registry, { targets: [{ x: 3, y: 5, z: 0 }] });
    assert.equal(r.targets[0]?.reached, true);
  });

  it('栅栏高 1.5：挡人、不能站，也不能从它上面跨过去', () => {
    const fence = box(-3, 1, -3, 3, 1, 3, 'oak_fence').filter(([x, , z]) => Math.abs(x) === 3 || Math.abs(z) === 3);
    const g = gridOf([...ground(5), ...fence]);
    const r = measureReach(g, registry, { targets: [{ x: 0, y: 1, z: 0 }] });
    assert.equal(r.targets[0]?.reached, false);
  });

  /**
   * 一个 3×3 的实心高台（顶面站立 y = h + 1），四周地面之外用高 2 的墙围住，墙内只有高台一处可站；
   * 高台旁边挖一口井：井底一格，井壁把它与其他地方隔开。唯一进出井底的办法是从高台顶跳下去。
   */
  function platformWithWell(h: number): ReturnType<typeof gridOf> {
    const cells: [number, number, number, string][] = [
      ...box(-1, 0, -1, 1, h, 1, 'stone'), // 高台（含 y = 0）
      ...box(2, 0, 0, 2, 0, 0, 'stone'), // 井底地面（站立 y = 1）
      // 井壁：把 (2, *, 0) 这一列与外界隔开，高到高台顶面以上
      ...box(3, 0, -1, 3, h + 2, 1, 'stone'),
      ...box(2, 0, -1, 2, h + 2, -1, 'stone'),
      ...box(2, 0, 1, 2, h + 2, 1, 'stone'),
      // 高台其余三边也围上墙，只留顶面；再用楼梯从外面上到顶面
      ...straightStair(h).map(([x, y, z, b]) => [x - h - 1, y, z, b] as [number, number, number, string]),
    ];
    return gridOf([...box(-12, 0, -4, 5, 0, 4, 'grass_block'), ...cells]);
  }

  it('下落超过 3 格：报 too-far-down', () => {
    const g = platformWithWell(4); // 顶面站立 y = 5，井底站立 y = 1：落差 4
    const r = measureReach(g, registry, {
      targets: [
        { x: 2, y: 1, z: 0 },
        { x: 0, y: 5, z: 0 },
      ],
    });
    assert.deepEqual(
      r.targets.map((t) => t.reached),
      [false, true],
    );
    assert.ok(r.blockers.some((b) => b.reason === 'too-far-down' && b.to.x === 2 && b.to.y === 1));
  });

  it('落差 3 格以内可以跳下去', () => {
    const g = platformWithWell(3); // 顶面 y = 4，井底 y = 1：落差 3
    const r = measureReach(g, registry, { targets: [{ x: 2, y: 1, z: 0 }] });
    assert.equal(r.targets[0]?.reached, true);
  });

  it('下落时目标上方被挡：报 no-headroom', () => {
    // 井里 y = 3 有一块悬挑贴着井壁（在 z = -1 那侧），井底站立点 (2, 1, 0) 头顶 (2, 2..3) 是空的，
    // 但从高台顶 (1, 4, 0) 走过去要经过 (2, 4, 0) 和 (2, 5, 0) 才能落下，在 (2, 4, 0) 放一块挡住
    const base = platformWithWell(3);
    base.set(2, 4, 0, parseState(registry.table, 'oak_planks'), 0, 0);
    const r = measureReach(base, registry, { targets: [{ x: 2, y: 1, z: 0 }] });
    assert.equal(r.targets[0]?.reached, false);
    const b = r.blockers.find((x) => x.to.x === 2 && x.to.y === 1);
    assert.equal(b!.reason, 'no-headroom');
    assert.deepEqual(b!.block, { x: 2, y: 4, z: 0, block: 'oak_planks', call: 0 });
  });
});

describe('measureReach：确定性', () => {
  it('blockers 按目标高度降序，最多 20 个', () => {
    const pillars: [number, number, number, string][] = [];
    for (let i = 0; i < 30; i += 1) pillars.push(...box(i * 3, 1, 0, i * 3, 1 + (i % 4), 0, 'stone'));
    const r = measureReach(gridOf([...box(-2, 0, -2, 95, 0, 2, 'grass_block'), ...pillars]), registry);
    assert.ok(r.blockers.length <= 20);
    const ys = r.blockers.map((b) => b.to.y);
    assert.deepEqual(
      ys,
      [...ys].sort((a, b) => b - a),
    );
  });
});
