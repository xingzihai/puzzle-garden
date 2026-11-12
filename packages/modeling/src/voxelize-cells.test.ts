/** voxelize-cells 的单元测试：格键去重 / -0、膨胀、solid 洪水（闭合与开放壳）、孤立格识别。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addCell, coordsOf, createCellStore, dilate, fillSolid, findIsolated } from './voxelize-cells.ts';

function firstKey(store: { readonly index: Map<number, number> }): number {
  const key = [...store.index.keys()][0];
  assert.ok(key !== undefined);
  return key;
}

describe('voxelize-cells 格集', () => {
  it('addCell 去重、-0 规范成 0、coordsOf 回读坐标', () => {
    const store = createCellStore();
    addCell(store, 1, 2, 3);
    addCell(store, 1, 2, 3);
    assert.equal(store.index.size, 1);
    assert.deepEqual(coordsOf(store, firstKey(store)), [1, 2, 3]);
    const zeros = createCellStore();
    addCell(zeros, -0, -0, -0);
    assert.deepEqual(coordsOf(zeros, firstKey(zeros)), [0, 0, 0]);
    assert.equal(Object.is(coordsOf(zeros, firstKey(zeros))[0], -0), false);
  });

  it('dilate 一圈把单格膨胀成 7 格（自身 + 6 邻接）', () => {
    const store = createCellStore();
    addCell(store, 4, 5, 6);
    assert.equal(dilate(store, 1).index.size, 7);
    assert.equal(dilate(store, 0).index.size, 1);
  });

  it('fillSolid：闭合壳填满内部', () => {
    const shell = createCellStore();
    for (let x = 0; x <= 4; x += 1) {
      for (let y = 0; y <= 4; y += 1) {
        for (let z = 0; z <= 4; z += 1) {
          if (x === 0 || x === 4 || y === 0 || y === 4 || z === 0 || z === 4) addCell(shell, x, y, z);
        }
      }
    }
    const filled = fillSolid(shell);
    assert.equal(filled.leaky, false);
    assert.equal(filled.store.index.size, 125);
  });

  it('fillSolid：开放壳标 leaky 且不填内部', () => {
    const shell = createCellStore();
    for (let x = 0; x <= 4; x += 1) {
      for (let y = 0; y <= 4; y += 1) {
        for (let z = 0; z <= 4; z += 1) {
          const boundary = x === 0 || x === 4 || y === 0 || y === 4 || z === 0 || z === 4;
          const hole = x === 0 && y === 2 && z === 2;
          if (boundary && !hole) addCell(shell, x, y, z);
        }
      }
    }
    const result = fillSolid(shell);
    assert.equal(result.leaky, true);
    assert.equal(result.store.index.size, shell.index.size);
  });

  it('findIsolated 只留没有 6 邻接同伴的格', () => {
    const store = createCellStore();
    addCell(store, 0, 0, 0);
    addCell(store, 1, 0, 0);
    addCell(store, 9, 0, 0);
    const keys = [...store.index.keys()];
    const isolated = findIsolated(new Set(keys));
    assert.equal(isolated.size, 1);
    assert.equal(isolated.has(keys[0] ?? -1), false);
    assert.equal(isolated.has(keys[2] ?? -1), true);
  });
});
