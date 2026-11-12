/**
 * craft2 附加段的单元测试（DECOR-PLAN §3）：常量内容与拼接形状。
 *
 * 负责：锁定 §3 表面装饰段、验证旧"立面层次"段已被替换且不重复、craft 的形态方块段与三段范例原样复用。
 * 不负责：范例能否通过 world.d.ts 预检（要用真 prechecker，见 craft.integration.test.ts）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { CRAFT_EXAMPLES, CRAFT_HINTS } from './craft.ts';
import { CRAFT2_DECOR, CRAFT2_HINTS, CRAFT2_SECTION } from './craft2.ts';

/** 2026-10-04 按 DECOR-PLAN §3 换段后 CRAFT2_SECTION 的 sha256；锁定模型可见正文逐字节不变。 */
const CRAFT2_SECTION_SHA256 = 'f72a2d65536fe3fc89c2dab80592da418a80d03d9a35728354a945ed231ba24e';

describe('craft2 附加段', () => {
  it('含形态方块表、做法要点与 §3 表面装饰四小节', () => {
    assert.ok(CRAFT2_HINTS.startsWith('## 形态方块：什么部位用什么方块（做法提示）'));
    assert.ok(CRAFT2_HINTS.includes('外挑腰线、檐下线脚'));
    assert.ok(CRAFT2_HINTS.includes('做法要点：'));
    assert.ok(CRAFT2_HINTS.includes('## 表面装饰：明度分档、墙面条纹、屋面分色'));
    assert.ok(CRAFT2_HINTS.includes('### 1 明度分档（至少四档）'));
    assert.ok(CRAFT2_HINTS.includes('### 2 墙面条纹（按高度与开间）'));
    assert.ok(CRAFT2_HINTS.includes('### 3 屋面分色（当前最缺）'));
    assert.ok(CRAFT2_HINTS.includes('### 4 彩窗与塔尖'));
    assert.ok(CRAFT2_HINTS.includes('自查：数四向立面的明度档数'));
  });

  it('不保留旧"立面层次"段，也不出现重复堆叠', () => {
    assert.ok(!CRAFT2_SECTION.includes('## 立面层次：配色、开间、细部密度'));
    assert.ok(!CRAFT2_SECTION.includes('### 1. 配色：至少 4 档明度'));
    assert.ok(!CRAFT2_SECTION.includes('### 2. 每个开间叠够 6 层'));
    assert.ok(!CRAFT2_SECTION.includes('### 3. 不留大面平墙，竖向拔高'));
    assert.equal((CRAFT2_SECTION.match(/## 表面装饰/g) ?? []).length, 1);
    assert.equal((CRAFT2_SECTION.match(/## 形态方块/g) ?? []).length, 1);
  });

  it('形态方块段与做法要点从 craft 原样切出，前接 §3 表面装饰段', () => {
    const at = CRAFT_HINTS.indexOf('## 立面层次：配色、开间、细部密度');
    assert.ok(at > 0);
    const kept = CRAFT_HINTS.slice(0, at).replace(/\n+$/, '');
    assert.equal(CRAFT2_HINTS.slice(0, kept.length), kept);
    assert.equal(CRAFT2_HINTS, `${kept}\n\n${CRAFT2_DECOR}`);
  });

  it('复用 craft 的三段范例（ledge / spire / pinnacle）', () => {
    for (const s of [
      'function ledge(',
      'function spire(',
      'function spireR(',
      'function inSpire(',
      'function pinnacle(',
    ]) {
      assert.ok(CRAFT2_SECTION.includes(s), s);
    }
    assert.ok(CRAFT2_SECTION.includes('### 范例 3：小尖塔'));
    assert.equal((CRAFT2_SECTION.match(/```ts/g) ?? []).length, 3);
    assert.equal(CRAFT2_SECTION, `${CRAFT2_HINTS}\n\n${CRAFT_EXAMPLES}`);
  });

  it('模型可见正文逐字节锁定（sha256 快照）', () => {
    assert.equal(createHash('sha256').update(CRAFT2_SECTION).digest('hex'), CRAFT2_SECTION_SHA256);
  });
});
