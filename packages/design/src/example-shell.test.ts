/** 地表构件的好坏样本：覆盖层 [−2,0) 完整、只两处梯井开洞、入口薄壳阶梯式且上平台在门端。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Element } from './schema.ts';
import { glassEntrance, parkSurface } from './example-shell.ts';

function byId(elements: readonly Element[], id: string): Element {
  const found = elements.find((item) => item.id === id);
  if (found === undefined) throw new Error(`找不到元素 ${id}`);
  return found;
}

test('地表公园：覆盖层为 [−2,0) 完整顶盖，只在两座入口梯井扣洞', () => {
  const elements = parkSurface();
  const covered = (x: number, z: number): boolean =>
    elements.some(
      (item) => item.bounds.min[0] < x && x < item.bounds.max[0] && item.bounds.min[2] < z && z < item.bounds.max[2],
    );
  assert.equal(covered(50, 120), true, '西影厅上方应有地表覆盖');
  assert.equal(covered(120, 120), true, '东影厅上方应有地表覆盖');
  assert.equal(covered(10, 6), false, '北入口梯井应开洞');
  assert.equal(covered(90, 146), false, '南入口梯井应开洞');
  // 覆盖层底面 −2、顶面 0
  assert.equal(byId(elements, 'el-path-ew').bounds.min[1], -2);
  assert.equal(byId(elements, 'el-path-ew').bounds.max[1], 0);
  assert.equal(elements.filter((item) => item.id.startsWith('el-tree-')).length, 6);
});

test('玻璃入口：阶梯式薄壳（一格厚 1），步行梯 9 级，上平台在门端', () => {
  const north = glassEntrance({
    idPrefix: 'el-n',
    name: '北入口',
    xMin: 4,
    xMax: 20,
    zMin: 4,
    zMax: 13,
    highDirection: -1,
    stairStart: 7,
    stairEnd: 16,
    bandZStart: 5,
    bandZEnd: 8,
  });
  const roofs = north.filter((item) => item.id.startsWith('el-n-roof-'));
  assert.equal(roofs.length, 16, '沿 x 每格一块薄顶');
  const firstRoof = byId(north, 'el-n-roof-4');
  assert.equal(firstRoof.bounds.max[1] - firstRoof.bounds.min[1], 1, '薄顶厚 1');
  assert.equal(firstRoof.bounds.max[1], 8, '门端薄顶顶面 8');
  assert.equal(byId(north, 'el-n-roof-19').bounds.max[1], 1, '后端薄顶落到地表层顶面（不再没入覆盖层）');
  assert.equal(north.filter((item) => item.id.startsWith('el-n-side-n-')).length, 15);
  // 北入口上平台在门端 x[4,7)
  assert.equal(byId(north, 'el-n-landing-up').bounds.min[0], 4);
  assert.equal(byId(north, 'el-n-landing-up').bounds.max[0], 7);
  assert.equal(north.filter((item) => item.id.startsWith('el-n-stair-')).length, 9);
  assert.equal(byId(north, 'el-n-stair-1').bounds.max[1], 0);
  assert.equal(byId(north, 'el-n-stair-9').bounds.max[1], -8);

  const south = glassEntrance({
    idPrefix: 'el-s',
    name: '南入口',
    xMin: 81,
    xMax: 97,
    zMin: 144,
    zMax: 153,
    highDirection: 1,
    stairStart: 85,
    stairEnd: 94,
    bandZStart: 145,
    bandZEnd: 148,
  });
  assert.equal(byId(south, 'el-s-roof-96').bounds.max[1], 8, '南入口门端在东端 x=96');
  assert.equal(byId(south, 'el-s-roof-81').bounds.max[1], 1);
  assert.equal(byId(south, 'el-s-landing-up').bounds.min[0], 94);
  assert.equal(byId(south, 'el-s-landing-up').bounds.max[0], 97);
  assert.equal(byId(south, 'el-s-stair-1').bounds.max[1], -8);
  assert.equal(byId(south, 'el-s-stair-9').bounds.max[1], 0);
});
