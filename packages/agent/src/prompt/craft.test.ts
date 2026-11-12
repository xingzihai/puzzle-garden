/**
 * craft 附加段的单元测试（决策 #84、QUALITY-PLAN §3a K 线）：常量内容与拼接形状。
 *
 * 负责：验证 ② 提示（形态方块表 + 立面层次段）与 ③ 三段范例的内容确实被保留、模板转义没有吞掉代码里的反引号与 ${}。
 * 不负责：范例能否通过 world.d.ts 预检（要用真 prechecker，见 craft.integration.test.ts）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { CRAFT_EXAMPLES, CRAFT_HINTS, CRAFT_SECTION } from './craft.ts';

/** 2026-10-04 换入 ceiling-gap §5 草稿后 CRAFT_SECTION 的 sha256；锁定模型可见正文逐字节不变。 */
const CRAFT_SECTION_SHA256 = 'b053d06efc2372f5175b06e5864570d62d0076ea1b0d51900d80d41b236eca83';

describe('craft 附加段', () => {
  it('提示含形态方块表、做法要点与立面层次段', () => {
    assert.ok(CRAFT_HINTS.startsWith('## 形态方块：什么部位用什么方块（做法提示）'));
    assert.ok(CRAFT_HINTS.includes('外挑腰线、檐下线脚'));
    assert.ok(CRAFT_HINTS.includes('倒置楼梯'));
    assert.ok(CRAFT_HINTS.includes('做法要点：'));
    assert.ok(CRAFT_HINTS.includes("w.set(x, y, z, 方块, 'opening')"));
    assert.ok(CRAFT_HINTS.includes('## 立面层次：配色、开间、细部密度'));
    assert.ok(CRAFT_HINTS.includes('### 1. 配色：至少 4 档明度'));
    assert.ok(CRAFT_HINTS.includes('### 2. 每个开间叠够 6 层'));
    assert.ok(CRAFT_HINTS.includes('### 3. 不留大面平墙，竖向拔高'));
    assert.ok(CRAFT_HINTS.includes('收尾自查：'));
  });

  it('用石英、方解石替代錾制石砖作对比色，墩顶指向范例 3', () => {
    assert.ok(CRAFT_HINTS.includes('錾制石砖与石砖远看同色，不算对比'));
    assert.ok(CRAFT_HINTS.includes('按范例 3 的 `pinnacle` 收成小尖塔'));
  });

  it('三段范例原样保留（函数与注释都在）', () => {
    assert.ok(CRAFT_EXAMPLES.startsWith('## 范例代码\n\n### 范例 1：外挑线脚'));
    assert.ok(CRAFT_EXAMPLES.includes('function ledge('));
    assert.ok(CRAFT_EXAMPLES.includes('function spire('));
    assert.ok(CRAFT_EXAMPLES.includes('function spireR('));
    assert.ok(CRAFT_EXAMPLES.includes('function inSpire('));
    assert.ok(CRAFT_EXAMPLES.includes('function pinnacle('));
    assert.ok(CRAFT_EXAMPLES.includes('### 范例 3：小尖塔'));
    assert.equal((CRAFT_EXAMPLES.match(/```ts/g) ?? []).length, 3);
  });

  it('代码里的反引号与 ${} 没有被模板插值吞掉', () => {
    assert.ok(CRAFT_EXAMPLES.includes('quartz_stairs[facing=${f},half=top]'));
    assert.ok(CRAFT_EXAMPLES.includes('deepslate_tile_stairs[facing=${f}]'));
    assert.ok(CRAFT_HINTS.includes('stone_brick_stairs[facing=west,half=top]'));
    assert.ok(CRAFT_HINTS.includes('fill: GLASS[i % GLASS.length]'));
  });

  it('CRAFT_SECTION 是提示与范例按顺序拼接', () => {
    assert.equal(CRAFT_SECTION, `${CRAFT_HINTS}\n\n${CRAFT_EXAMPLES}`);
  });

  it('模型可见正文逐字节锁定（sha256 快照）', () => {
    assert.equal(createHash('sha256').update(CRAFT_SECTION).digest('hex'), CRAFT_SECTION_SHA256);
  });
});
