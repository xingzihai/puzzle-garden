/**
 * v02hint 附加段的单元测试（对照实验）：常量内容与来源注释所声明的"只删减、未改写"。
 *
 * 负责：验证 v0.2"材质与形态"删减稿的三条要点原样保留，并用 sha256 锁定模型可见正文逐字节不变。
 * 不负责：拼接与 variant 选择（见 system.test.ts）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { V02HINT_SECTION } from './v02hint.ts';

/** 2026-10-04 定稿的 V02HINT_SECTION sha256；锁定这份对照实验文本逐字节不变。 */
const V02HINT_SECTION_SHA256 = 'deb2981b9a6aa00576bd1b77e78cbeb56456bdd50f183cc7627f2523c8c4adb4';

describe('v02hint 附加段', () => {
  it('以 v0.2 原版标题开头，且只保留三条要点', () => {
    assert.ok(V02HINT_SECTION.startsWith('## 形态方块：什么部位用什么方块（v0.2 原版提示，删减）'));
    assert.equal((V02HINT_SECTION.match(/^- /gm) ?? []).length, 3);
  });

  it('三条要点原样保留（可用形态 / 场景→形态 / 外形与特性）', () => {
    assert.ok(V02HINT_SECTION.includes('可用形态：slab（半砖）、stairs（楼梯）'));
    assert.ok(V02HINT_SECTION.includes('场景→形态（先想场景，再选形态）'));
    assert.ok(V02HINT_SECTION.includes('发现自己用整块方块手拼台阶 / 门框 / 栏杆时，换成对应形态方块'));
    assert.ok(V02HINT_SECTION.includes('外形与特性必须与原版一致'));
    assert.ok(V02HINT_SECTION.includes('纹理 / 颜色渲染允许与原版有差异'));
  });

  it('模型可见正文逐字节锁定（sha256 快照）', () => {
    assert.equal(createHash('sha256').update(V02HINT_SECTION).digest('hex'), V02HINT_SECTION_SHA256);
  });
});
