/** 人工方案重写执行与楼梯目标回归；不把机械测量当审美验收。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { hashGrid } from '@pg/core/hash';
import { measureReach } from '@pg/analysis/reach';
import { measureRoofProfile } from '@pg/analysis/roof-profile';
import { createWorld } from './index.ts';
import a1 from '../fixtures/f1-pav.A.ts';
import b1 from '../fixtures/f1-pav.B.ts';
import a2 from '../fixtures/f2-res.A.ts';
import b2 from '../fixtures/f2-res.B.ts';
import a3 from '../fixtures/f3-stu.A.ts';
import b3 from '../fixtures/f3-stu.B.ts';
import a4 from '../fixtures/f4-chu.A.ts';
import b4 from '../fixtures/f4-chu.B.ts';
import a5 from '../fixtures/f5-tow.A.ts';
import b5 from '../fixtures/f5-tow.B.ts';
import a6 from '../fixtures/f6-crt.A.ts';
import b6 from '../fixtures/f6-crt.B.ts';

const registry = loadRegistry();
const table = registry.table;
export const humanFixtures = {
  'f1-pav.A': a1,
  'f1-pav.B': b1,
  'f2-res.A': a2,
  'f2-res.B': b2,
  'f3-stu.A': a3,
  'f3-stu.B': b3,
  'f4-chu.A': a4,
  'f4-chu.B': b4,
  'f5-tow.A': a5,
  'f5-tow.B': b5,
  'f6-crt.A': a6,
  'f6-crt.B': b6,
};
for (const [name, build] of Object.entries(humanFixtures))
  test(`${name} 重写确定性与来源`, () => {
    const a = createWorld(table);
    const b = createWorld(table);
    build(a.world);
    build(b.world);
    const grid = a.compose().grid;
    assert.equal(hashGrid(grid), hashGrid(b.compose().grid));
    assert(grid.size > 100);
    assert([...grid.cells()].every((c) => c.call > 0));
    const stairIds = new Set(
      grid
        .calls()
        .filter((c) => c.api === 'stair')
        .map((c) => c.id),
    );
    if (stairIds.size > 0) {
      const targets = [...grid.cells()]
        .filter((c) => stairIds.has(c.call) && c.state.name.endsWith('_stairs') && c.state.props['half'] !== 'top')
        .map((c) => ({ x: c.x, y: c.y + 1, z: c.z }));
      assert(targets.length > 0);
      assert(measureReach(grid, registry, { targets }).targets.every((t) => t.reached));
    }
    // 每次 roof 调用单独测：坡面材质的格超出连接所需为 0（薄壳，决策 #59）。顶饰、女儿墙材质不同，不计入。
    // 不同 roof 调用之间的重叠（如 F6-A 正房与厢房的檐口都落在 x = 7，原方案就是如此）是体块关系，由报告列出。
    for (const call of grid.calls().filter((c) => c.api === 'roof')) {
      const roof = measureRoofProfile(grid, (c) => c.call === call.id && c.state.name === 'deepslate_tiles');
      assert.deepEqual(roof.excess, { columns: 0, cells: 0 }, `${name} roof#${String(call.id)}`);
    }
  });

test('F1-A 十字柱臂落在上层台面上，南面入口可达上层', () => {
  const host = createWorld(table);
  a1(host.world);
  // 上层台基 project 1 后外缘到 x ±7、z ±6：十字柱臂下方是 smooth_stone 台面而不是空气。
  assert.equal(host.world.get(7, 2, -5), 'smooth_stone', '东臂下台面');
  assert.equal(host.world.get(7, 3, -5), 'oak_log', '东臂');
  assert.equal(host.world.get(0, 2, -6), 'smooth_stone', '北臂下台面');
  assert.equal(host.world.get(0, 3, -6), 'oak_log', '北臂');
  // 南面入口（中柱十字臂占口中，两 2 格宽通道）仍能从地面走到上层台面。
  assert(measureReach(host.compose().grid, registry, { targets: [{ x: 0, y: 3, z: 0 }] }).targets[0]?.reached);
});
