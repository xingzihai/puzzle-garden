/** block-usages.ts：组合用法数据与提示段。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BLOCK_USAGE_PROMPT, BLOCK_USAGE_VERSION, BLOCK_USAGES, blockUsage, usagesForBlock } from './block-usages.ts';

test('用法条目版本化、id 唯一、字段完整', () => {
  assert.match(BLOCK_USAGE_VERSION, /^mc-1\.20\.1-\d+$/);
  assert.ok(BLOCK_USAGES.length >= 20);
  const ids = BLOCK_USAGES.map((usage) => usage.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const usage of BLOCK_USAGES) {
    assert.ok(usage.name.length > 0, usage.id);
    assert.ok(usage.blocks.length > 0, usage.id);
    assert.ok(usage.how.length > 0, usage.id);
    assert.ok(usage.states.length > 0, usage.id);
    assert.ok(usage.mistakes.length > 0, usage.id);
    assert.ok(usage.bestFor.length > 0, usage.id);
  }
});

test('覆盖任务要求的常见组合：活板门、楼梯、半砖、栅栏桌、墙栏杆、玻璃板、按钮、吊灯', () => {
  const names = BLOCK_USAGES.map((usage) => usage.name).join('|');
  for (const keyword of ['活板门', '楼梯', '半砖', '栅栏 + 压力板', '墙做栏杆', '玻璃板', '按钮', '灯笼 + 链']) {
    assert.ok(names.includes(keyword), `缺少 ${keyword}`);
  }
  assert.ok(BLOCK_USAGE_PROMPT.includes('状态：'), '提示段必须带状态示例');
  assert.ok(BLOCK_USAGE_PROMPT.includes('避免：'), '提示段必须带常见错误');
});

test('按 id 与按方块查询', () => {
  assert.equal(blockUsage('trapdoor-cabinet')?.blocks.includes('oak_trapdoor'), true);
  assert.equal(blockUsage('missing'), undefined);
  assert.ok(usagesForBlock('oak_stairs').some((usage) => usage.id === 'stairs-eave'));
  assert.equal(usagesForBlock('missing_block').length, 0);
});
