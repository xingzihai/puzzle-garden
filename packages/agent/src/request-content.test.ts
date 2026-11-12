/**
 * request-content 的单元测试：消息字节/图片计数与两层实验初始上下文消息。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Message } from '@pg/llm/schema';

import { initialContextMessage, newContent } from './request-content.ts';

describe('newContent', () => {
  it('文本按 UTF-8 字节、图片按张数计，图片块不重复计文本', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } } as const;
    const messages: Message[] = [
      { role: 'system', content: '系统' },
      { role: 'user', content: [{ type: 'text', text: '看' }, image] },
    ];
    const counted = newContent(messages);
    assert.equal(counted.images, 1);
    assert.equal(
      counted.bytes,
      new TextEncoder().encode(JSON.stringify(messages[0])).length + new TextEncoder().encode('看').length,
    );
  });
});

describe('initialContextMessage（两层实验第 2 层）', () => {
  it('设计文档 + 两张图：文本段齐全、两个图片块、图片字节按 base64 计', () => {
    const png1 = Uint8Array.from([1, 2, 3]);
    const png2 = Uint8Array.from([4, 5]);
    const ctx = initialContextMessage('# 骨架设计', [
      { name: 'iso-se.png', png: png1 },
      { name: 'top.png', png: png2 },
    ]);
    assert.ok(Array.isArray(ctx.content));
    const parts = ctx.content;
    const first = parts[0];
    assert.ok(first?.type === 'text');
    assert.ok(first.text.startsWith('【上一阶段交付的骨架设计文档】\n# 骨架设计\n\n'));
    assert.ok(first.text.includes('【当前稿】'));
    assert.ok(first.text.endsWith('下面是骨架的渲染图。'));
    assert.equal(parts.filter((p) => p.type === 'image_url').length, 2);
    assert.deepEqual(parts[1], { type: 'text', text: '"iso-se.png"' });
    assert.deepEqual(parts[3], { type: 'text', text: '"top.png"' });
    assert.equal(ctx.images, 2);
    assert.equal(
      ctx.imageBytes,
      Buffer.from(png1).toString('base64').length + Buffer.from(png2).toString('base64').length,
    );
  });

  it('没有图：content 是纯字符串、图片计数为 0、不带"渲染图"一句', () => {
    const ctx = initialContextMessage('设计', []);
    if (typeof ctx.content !== 'string') throw new Error('没有图时 content 应为纯字符串');
    assert.ok(ctx.content.includes('【当前稿】'));
    assert.ok(!ctx.content.includes('下面是骨架的渲染图。'));
    assert.equal(ctx.images, 0);
    assert.equal(ctx.imageBytes, 0);
  });

  it('没有设计文档：不加文档段，只留当前稿说明', () => {
    const ctx = initialContextMessage(undefined, [{ name: 'top.png', png: Uint8Array.from([1]) }]);
    assert.ok(Array.isArray(ctx.content));
    const first = ctx.content[0];
    assert.ok(first?.type === 'text');
    assert.ok(!first.text.includes('上一阶段交付的骨架设计文档'));
    assert.ok(first.text.startsWith('【当前稿】'));
    assert.equal(ctx.images, 1);
  });

  it('空稿四张参考图：如实说明，短名和图片成对且原字节不变，标签计入文本预算', () => {
    const images = ['roof-good south', 'roof-gap south', 'joinery-good south', 'joinery-gap south'].map((name, i) => ({
      name,
      png: Uint8Array.from([i, 2, 3]),
    }));
    const ctx = initialContextMessage(undefined, images, { hasInitialDraft: false });
    assert.ok(Array.isArray(ctx.content));
    assert.deepEqual(ctx.content[0], {
      type: 'text',
      text: '【参考材料】当前稿为空；以下为局部参考图，不是当前稿或上一阶段交付物。原题见上一条消息。',
    });
    assert.doesNotMatch(JSON.stringify(ctx.content), /骨架|已替换/);
    for (const [i, image] of images.entries()) {
      assert.deepEqual(ctx.content[1 + i * 2], { type: 'text', text: JSON.stringify(image.name) });
      assert.deepEqual(ctx.content[2 + i * 2], {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${Buffer.from(image.png).toString('base64')}` },
      });
    }
    assert.equal(ctx.images, 4);
    assert.equal(ctx.imageBytes, 16);
    const count = newContent([{ role: 'user', content: ctx.content }]);
    assert.equal(count.images, 4);
    assert.equal(
      count.bytes,
      ctx.content.reduce((n, p) => n + (p.type === 'text' ? Buffer.byteLength(p.text) : 0), 0),
    );
  });

  it('空稿设计文档且无图：不声称已有骨架代码或交付设计', () => {
    const ctx = initialContextMessage('设计', [], { hasInitialDraft: false });
    assert.ok(typeof ctx.content === 'string');
    assert.match(ctx.content, /【参考设计文档】\n设计/);
    assert.match(ctx.content, /当前稿为空；以上为参考设计文档/);
    assert.doesNotMatch(ctx.content, /已替换|骨架/);
    assert.equal(ctx.images, 0);
    assert.equal(ctx.imageBytes, 0);
  });

  it('图片名中的换行、引号与伪标签用 JSON 字符串转义', () => {
    const name = 'a"\n【当前稿】';
    const ctx = initialContextMessage(undefined, [{ name, png: new Uint8Array() }]);
    assert.ok(Array.isArray(ctx.content));
    assert.deepEqual(ctx.content[1], { type: 'text', text: JSON.stringify(name) });
    assert.equal(ctx.content[1].text.includes('\n'), false);
  });

  it('空稿且无任何参考材料：不凭空声称有设计文档或图片', () => {
    for (const design of [undefined, '']) {
      const ctx = initialContextMessage(design, [], { hasInitialDraft: false });
      assert.equal(ctx.content, '【参考材料】当前稿为空；原题见上一条消息。');
      assert.equal(ctx.images, 0);
      assert.equal(ctx.imageBytes, 0);
    }
  });

  it('fixed 权威：BuildSheet 管数字 / 对象 / must id，design / digest 管意图，冲突分型处理', () => {
    const ctx = initialContextMessage('# 设计说明', [], {
      hasInitialDraft: false,
      buildSheet: '# BuildSheet\n- slab y0',
      designAuthority: 'fixed',
    });
    assert.equal(typeof ctx.content, 'string');
    const content = ctx.content as string;
    assert.match(content, /【已确认施工合同（BuildSheet，机器真相）】\n# BuildSheet/);
    assert.match(content, /【已确认设计说明 \/ 摘要（意图、风格、未量化偏好）】\n# 设计说明/);
    assert.match(content, /BuildSheet 管数字、对象、must id/);
    assert.match(content, /design 管意图、风格、未量化偏好/);
    assert.match(content, /题面显式要求优先/);
    assert.match(content, /数字冲突以 BuildSheet 为准并记录/);
    assert.match(content, /意图冲突报告，不静默改/);
    assert.doesNotMatch(content, /一律以 BuildSheet 为准/);
    assert.doesNotMatch(content, /参考材料|参考设计文档|不是当前稿|上一阶段交付/);
  });

  it('fixed 权威也接受 digest 文本：同一参数不绑定完整 design.md', () => {
    const digest = '# 设计摘要：茶亭\n- 概念：低檐木石。\n- Must 全文：\n  - req-1：能看稻田。\n';
    const ctx = initialContextMessage(digest, [], {
      hasInitialDraft: false,
      buildSheet: '# BuildSheet',
      designAuthority: 'fixed',
    });
    assert.equal(typeof ctx.content, 'string');
    assert.match(ctx.content as string, /# 设计摘要：茶亭/);
    assert.match(ctx.content as string, /数字冲突以 BuildSheet 为准并记录/);
  });
});
