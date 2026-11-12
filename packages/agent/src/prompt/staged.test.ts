/**
 * staged 附加段的单元测试：常量内容与模板转义。
 *
 * 负责：验证骨架段 / 细部段的正文确实保留（含代码反引号、`'opening'`、`w.mirror` 等转义点），
 *   并用 sha256 锁定模型可见正文逐字节不变。
 * 不负责：system 里的拼接与 variant 选择（system.test.ts）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { BLUEPRINT_SECTION, DETAIL_SECTION, REFINE_SECTION, SKELETON_SECTION } from './staged.ts';

/** 当前两段正文的 sha256；锁定逐字节不变（改动即要同步这个测试）。 */
const SKELETON_SHA256 = 'ee98b4dd6e95f509e17062e103d1a06522131287cc127a4aed058b46411957f5';
const DETAIL_SHA256 = 'c0b15a4427cb8ab0d59a94eee11479225a1c4ebe187916d165534438c638cd5e';

describe('staged 附加段', () => {
  it('骨架段：标题、禁用 set/box、结束判断与允许朴素都在', () => {
    assert.ok(SKELETON_SECTION.startsWith('## 本阶段：只搭骨架（分段实验第 1 段）'));
    assert.ok(SKELETON_SECTION.includes('不要用 `set` / `box`'));
    assert.ok(SKELETON_SECTION.includes('只用构件与 `part` / `mirror`'));
    assert.ok(SKELETON_SECTION.includes("w.mirror({ axis: 'x', at: 0 }, …)"));
    assert.ok(SKELETON_SECTION.includes('左右对称'));
    assert.ok(SKELETON_SECTION.includes('上方没有屋面'));
    assert.ok(SKELETON_SECTION.includes('骨架阶段允许体量朴素'));
  });

  it('细部段：骨架冻结、写层归属、被盖掉自查与细部计数都在', () => {
    assert.ok(DETAIL_SECTION.startsWith('## 本阶段：在冻结的骨架上加细部（分段实验第 2 段）'));
    assert.ok(DETAIL_SECTION.includes('**骨架已冻结**'));
    assert.ok(DETAIL_SECTION.includes("写在开洞层（`'opening'`）"));
    assert.ok(DETAIL_SECTION.includes('手写装饰被盖掉'));
    assert.ok(DETAIL_SECTION.includes('核对是否符合设计'));
    assert.ok(DETAIL_SECTION.includes('同状态重复写入也会计数'));
    assert.ok(DETAIL_SECTION.includes('不要把所有装饰改到开洞层'));
    assert.doesNotMatch(DETAIL_SECTION, /有被盖的就说明写错|改到开洞层或换位置/);
    assert.ok(DETAIL_SECTION.includes('交付前对照题面的细部计数'));
  });

  it('模板转义没吞掉反引号与函数名', () => {
    assert.ok(SKELETON_SECTION.includes('`opening`'));
    assert.ok(SKELETON_SECTION.includes('`opening.fill`'));
    assert.ok(!SKELETON_SECTION.includes('\\`'));
  });

  it('sha256 锁定两段正文逐字节不变', () => {
    assert.equal(createHash('sha256').update(SKELETON_SECTION).digest('hex'), SKELETON_SHA256);
    assert.equal(createHash('sha256').update(DETAIL_SECTION).digest('hex'), DETAIL_SHA256);
  });

  it('骨架层：八节结构、长度目标、具体化要求与交付物都在', () => {
    assert.ok(BLUEPRINT_SECTION.startsWith('## 本阶段：先写设计文档，再搭骨架（两层实验第 1 层）'));
    assert.ok(BLUEPRINT_SECTION.includes('先写设计文档'));
    assert.ok(BLUEPRINT_SECTION.includes('6000 字符以上'));
    assert.ok(BLUEPRINT_SECTION.includes('表面装饰都留给第 2 层'));
    for (const s of [
      '任务目标',
      '总平面与坐标表',
      '开间与重复规律',
      '建造顺序',
      '验收标准',
      '美术设计',
      '风险与对策',
      '坐标与自查',
    ]) {
      assert.ok(BLUEPRINT_SECTION.includes(s), `缺少：${s}`);
    }
    assert.ok(BLUEPRINT_SECTION.includes('设计文档是交付物之一'));
    assert.ok(BLUEPRINT_SECTION.includes('每 3 层换一种瓦'));
  });

  it('细化层：七节结构、长度目标、不要求保留骨架、交付物含文档与 note 都在', () => {
    assert.ok(REFINE_SECTION.startsWith('## 本阶段：先写细化设计文档，再细化整栋建筑（两层实验第 2 层）'));
    assert.ok(REFINE_SECTION.includes('自己的细化设计文档'));
    assert.ok(REFINE_SECTION.includes('8000 字符以上'));
    for (const s of [
      '现状评估',
      '最终成品描述',
      '逐立面的分层设计',
      '可数 must 清单',
      '数学与规律',
      '施工工序与自查',
      '验收清单',
    ]) {
      assert.ok(REFINE_SECTION.includes(s), `缺少：${s}`);
    }
    assert.ok(REFINE_SECTION.includes('不要求保留骨架'));
    assert.ok(REFINE_SECTION.includes('交付说明（submit 的 note）'));
  });
});
