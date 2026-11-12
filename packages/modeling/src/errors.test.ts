/** ModelError 与 zod 问题格式化的单元测试；好 / 坏样本都覆盖。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelError, formatIssues } from './errors.ts';

describe('ModelError', () => {
  it('是 Error 子类，保留名字与消息', () => {
    const error = new ModelError('参数坏了');
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ModelError');
    assert.equal(error.message, '参数坏了');
  });
});

describe('formatIssues', () => {
  it('路径用点连接，空路径写作 (根)，多个问题用「；」分隔', () => {
    assert.equal(
      formatIssues([
        { path: ['a', 'b'], message: '第一个' },
        { path: [], message: '第二个' },
      ]),
      'a.b: 第一个；(根): 第二个',
    );
  });

  it('数字路径也转成字符串', () => {
    assert.equal(formatIssues([{ path: ['parts', 0, 'id'], message: '重复' }]), 'parts.0.id: 重复');
  });

  it('空问题列表得到空串', () => {
    assert.equal(formatIssues([]), '');
  });
});
