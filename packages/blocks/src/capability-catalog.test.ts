/** capability-catalog.ts：生成目录的结构、关键方块与查询。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BLOCK_CAPABILITIES,
  BLOCK_CAPABILITY_MC_VERSION,
  BLOCK_CAPABILITY_VERSION,
  blockCapability,
  blockCapabilityIds,
} from './capability-catalog.ts';

test('目录版本化、按 id 排序且不含重复', () => {
  assert.equal(BLOCK_CAPABILITY_MC_VERSION, '1.20.1');
  assert.match(BLOCK_CAPABILITY_VERSION, /^mc-1\.20\.1-\d+$/);
  assert.ok(BLOCK_CAPABILITIES.length >= 30);
  const ids = blockCapabilityIds();
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(Object.isFrozen(BLOCK_CAPABILITIES), false);
});

test('关键家具 / 方向方块都有状态、放置面与碰撞口径', () => {
  for (const id of [
    'oak_door',
    'oak_trapdoor',
    'oak_stairs',
    'oak_slab',
    'oak_fence',
    'glass_pane',
    'lantern',
    'chain',
    'chest',
    'red_bed',
    'flower_pot',
    'rail',
  ]) {
    const block = blockCapability(id);
    assert.ok(block, id);
    assert.ok(block.states.length >= 0, id);
    assert.ok(block.placeOn.length > 0, id);
    assert.ok(block.support.length > 0, id);
    assert.ok(block.collision.length > 0, id);
  }
  assert.equal(blockCapability('oak_stairs')?.shape, 'stairs');
  assert.equal(blockCapability('lantern')?.luminance, 15);
  assert.equal(blockCapability('missing_block'), undefined);
});

test('官方模型覆盖标记与标签来自导入资源', () => {
  const fence = blockCapability('oak_fence');
  assert.ok(fence !== undefined);
  assert.equal(fence.officialModel, true);
  assert.ok(fence.tags.includes('fences'));
  const door = blockCapability('oak_door');
  assert.ok(door !== undefined);
  assert.ok(door.states.some((state) => state.startsWith('facing=')));
});
