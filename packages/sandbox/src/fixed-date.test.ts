import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createFixedDate, FIXED_TIME } from './fixed-date.ts';

interface DateLike {
  (): string;
  new (...args: unknown[]): Date;
  now(): number;
  UTC: (...args: number[]) => number;
  parse: (text: string) => number;
  prototype: Date;
}

describe('fixed-date：固定时刻 Date 替身', () => {
  test('函数调用 / 无参构造 / 有参构造 / now / instanceof / prototype', () => {
    const D = createFixedDate(Date) as unknown as DateLike;
    assert.equal(D.now(), FIXED_TIME);
    assert.equal(new D().toISOString(), '2000-01-01T00:00:00.000Z');
    // 有参构造照常按本地时区（子进程 TZ=UTC 才等于 UTC 值，规格 §11.5）。
    assert.equal(new D(2000, 0, 1).toISOString(), new Date(2000, 0, 1).toISOString());
    assert.ok(D().includes('2000'), D());
    assert.ok(new D() instanceof Date);
    assert.equal(D.prototype, Date.prototype);
    assert.equal(D.parse('2000-01-01T00:00:00.000Z'), FIXED_TIME);
    assert.equal(D.UTC(2000, 0, 1), Date.UTC(2000, 0, 1));
  });

  test('替身不修改传入的真实 Date（后门补丁由 installFixedDate 负责）', () => {
    // 用引用相等判定"未被改动"，避免两次读真实时钟之间的自然前进造成竞态。
    const realNow = Date.now;
    const realConstructor = Date.prototype.constructor;
    createFixedDate(Date);
    assert.equal(Date.now, realNow);
    assert.equal(Date.prototype.constructor, realConstructor);
  });
});
