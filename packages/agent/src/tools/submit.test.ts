import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { submit } from './submit.ts';

describe('submit 通过条件（AGENT-SPEC §4.4）', () => {
  it('当前稿已检查且执行成功：接受', () => {
    const result = submit({ draftVersion: 9, lastCheck: { version: 9, outcome: 'ok' } });
    assert.deepEqual(result, { accepted: true, text: '已提交第 v9 版。' });
  });

  it('没有代码、没检查、版本不一致：各自拒绝', () => {
    assert.deepEqual(submit({ draftVersion: null, lastCheck: null }), {
      accepted: false,
      text: '当前稿还没有代码，先 write_code。',
    });
    assert.deepEqual(submit({ draftVersion: 1, lastCheck: null }), {
      accepted: false,
      text: '当前稿第 v1 版还没检查，先 check_code。',
    });
    const stale = submit({ draftVersion: 9, lastCheck: { version: 8, outcome: 'ok' } });
    assert.equal(stale.accepted, false);
    assert.ok(stale.text.includes('最近检查的是第 v8 版'));
  });

  it('版本一致但检查未成功：按结果类型拒绝', () => {
    const cases = [
      ['precheck-failed', '类型预检未通过'],
      ['build-error', '执行出错'],
      ['not-finished', '执行未完成'],
    ] as const;
    for (const [outcome, text] of cases) {
      const result = submit({ draftVersion: 5, lastCheck: { version: 5, outcome } });
      assert.equal(result.accepted, false);
      assert.ok(result.text.includes(text), outcome);
      assert.ok(result.text.includes('check_code 成功后再 submit'));
    }
  });

  it('门槛未过：拒绝并列出失败项；门槛全过或没传门槛：接受', () => {
    const rejected = submit({
      draftVersion: 9,
      lastCheck: {
        version: 9,
        outcome: 'ok',
        gates: { passed: false, failed: ['左右对称：实体对上 89.4%，要求 ≥ 99%', '悬空：2 格不属于 [roof]'] },
      },
    });
    assert.equal(rejected.accepted, false);
    assert.equal(
      rejected.text,
      '第 v9 版没过骨架门槛（左右对称：实体对上 89.4%，要求 ≥ 99%；悬空：2 格不属于 [roof]），' +
        '先修改并 check_code 让门槛全过后再 submit。',
    );

    const passed = submit({
      draftVersion: 9,
      lastCheck: { version: 9, outcome: 'ok', gates: { passed: true, failed: [] } },
    });
    assert.deepEqual(passed, { accepted: true, text: '已提交第 v9 版。' });

    const noGates = submit({ draftVersion: 9, lastCheck: { version: 9, outcome: 'ok' } });
    assert.deepEqual(noGates, { accepted: true, text: '已提交第 v9 版。' });
  });

  it('requireDesign：没写文档拒绝；写了文档才通过；缺省不要求', () => {
    const rejected = submit({
      draftVersion: 9,
      lastCheck: { version: 9, outcome: 'ok' },
      requireDesign: true,
      design: '',
    });
    assert.deepEqual(rejected, { accepted: false, text: '还没有设计文档，先 write_design 再 submit。' });

    const undefinedDesign = submit({
      draftVersion: 9,
      lastCheck: { version: 9, outcome: 'ok' },
      requireDesign: true,
    });
    assert.equal(undefinedDesign.accepted, false);

    const accepted = submit({
      draftVersion: 9,
      lastCheck: { version: 9, outcome: 'ok' },
      requireDesign: true,
      design: '# 设计',
    });
    assert.deepEqual(accepted, { accepted: true, text: '已提交第 v9 版。' });

    // requireDesign 缺省（base / detail 等旧路径）：空设计文档不拦
    const noRequirement = submit({ draftVersion: 9, lastCheck: { version: 9, outcome: 'ok' }, design: '' });
    assert.deepEqual(noRequirement, { accepted: true, text: '已提交第 v9 版。' });
  });
});
