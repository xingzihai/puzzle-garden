/**
 * craft-small：小体量与室内提示的正文锁定与边界测试。
 *
 * 负责：确认尺度、室内、方向方块、家具与常见失败都在正文里；三段范例没有被模板插值吞掉。
 * 不负责：范例能否通过预检（craft-small.integration.test.ts）、拼接选择（system.test.ts）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { CRAFT_SMALL_EXAMPLES, CRAFT_SMALL_HINTS, CRAFT_SMALL_SECTION } from './craft-small.ts';

describe('craft-small 附加段', () => {
  it('覆盖小体量尺度、室内、家具、楼层与方向方块', () => {
    for (const text of [
      '1–3 层、占地 8–30m、总方块 5k–30k',
      '层高 3.2–4.0m',
      '门洞 2.1–2.4m',
      '窗台离室内地面 0.8–1.0m',
      '檐口外挑 0.6–2.0m',
      '栏杆/女儿墙 0.9–1.1m',
      '室内必须完成，不能只做空壳',
      '固定家具优先',
      '楼板与楼层',
      'stairs：facing',
      'door：上下两格成对',
      'trapdoor：facing',
      'fence_gate：facing',
      'axis=x|y|z',
    ]) {
      assert.ok(CRAFT_SMALL_HINTS.includes(text), `缺少：${text}`);
    }
  });

  it('包含常见失败清单，避免退化成缩小版哥特或空壳', () => {
    for (const text of ['缩小版哥特', '单色盒子', '无收口平顶', '超大屋檐压墙', '门洞被填死', '室内空壳']) {
      assert.ok(CRAFT_SMALL_HINTS.includes(text), `缺少：${text}`);
    }
  });

  it('三段范例保留反引号与 ${}，没有被模板插值吞掉', () => {
    assert.equal((CRAFT_SMALL_EXAMPLES.match(/```ts/g) ?? []).length, 3);
    assert.ok(CRAFT_SMALL_EXAMPLES.includes('${f}'));
    assert.ok(CRAFT_SMALL_EXAMPLES.includes('half=top'));
  });

  it('CRAFT_SMALL_SECTION 是提示与范例按顺序拼接', () => {
    assert.equal(CRAFT_SMALL_SECTION, `${CRAFT_SMALL_HINTS}\n\n${CRAFT_SMALL_EXAMPLES}`);
  });

  it('官方方块组合目录进入正文，状态与常见错误都在', () => {
    for (const text of [
      '官方方块组合目录',
      '活板门做柜门',
      '栅栏 + 压力板做桌子',
      '玻璃板做隔断',
      '灯笼 + 链做吊灯',
      '状态：',
      '避免：',
    ]) {
      assert.ok(CRAFT_SMALL_HINTS.includes(text), `缺少：${text}`);
    }
  });

  it('模型可见正文逐字节锁定（sha256 快照）', () => {
    assert.equal(
      createHash('sha256').update(CRAFT_SMALL_SECTION).digest('hex'),
      'deecc1505f5a75fd510d269667d3cccb0efda424f5162fd9867ba79c94a7c513',
    );
  });
});
