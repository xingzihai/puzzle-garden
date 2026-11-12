/** mc-catalog.ts：状态 / 连接 / 默认模型查找。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';

import { isConnectionAware, resolveModelId } from './mc-catalog.ts';
import type { McAssetCatalog } from './mc-catalog.ts';

const registry = loadRegistry();
const table = registry.table;

const catalog: McAssetCatalog = {
  mcVersion: '1.20.1',
  states: { 'oak_stairs[facing=east]': 7, oak_door: 8 },
  connections: { oak_fence: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
  defaults: { oak_stairs: 6, oak_door: 8 },
  coverage: { blocks: 3, states: 2, models: 16, textures: 4 },
};

test('精确状态优先，缺失时回退默认状态', () => {
  assert.equal(resolveModelId(catalog, parseState(table, 'oak_stairs[facing=east]')), 7);
  assert.equal(resolveModelId(catalog, parseState(table, 'oak_stairs[facing=west]')), 6);
  assert.equal(resolveModelId(catalog, parseState(table, 'oak_door')), 8);
  assert.equal(resolveModelId(catalog, parseState(table, 'stone')), 0);
});

test('连接方块用 0–15 掩码查表，不回落普通状态', () => {
  assert.equal(isConnectionAware(catalog, 'oak_fence'), true);
  assert.equal(isConnectionAware(catalog, 'oak_stairs'), false);
  assert.equal(resolveModelId(catalog, parseState(table, 'oak_fence'), 0), 1);
  assert.equal(resolveModelId(catalog, parseState(table, 'oak_fence'), 15), 16);
  assert.equal(resolveModelId(catalog, parseState(table, 'oak_fence'), 16), 1);
});
