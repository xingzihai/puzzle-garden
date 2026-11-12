import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ALLOWED_GLOBALS, FIXED_TIME, prepareGlobals } from './child-globals.ts';
import type { MutableGlobals } from './child-globals.ts';

interface DateLike {
  (): string;
  new (...args: unknown[]): Date;
  now(): number;
  UTC: (...args: number[]) => number;
  parse: (text: string) => number;
}

function isolated(): MutableGlobals {
  return {
    process: { fake: true },
    Buffer: { fake: true },
    fetch: (): undefined => undefined,
    WebAssembly: { fake: true },
    Intl: { fake: true },
    setTimeout: (): undefined => undefined,
    crypto: { fake: true },
    navigator: { fake: true },
    Request: 1,
    Response: 2,
  };
}

function dateOf(target: MutableGlobals): DateLike {
  return target['Date'] as DateLike;
}

describe('child-globals：准备全局', () => {
  test('白名单之外的全局全部消失，Math / Date / performance 被替换', () => {
    const target = isolated();
    const capture = prepareGlobals(target, { seed: 1, consoleBytes: 100 });
    for (const name of ['process', 'Buffer', 'fetch', 'WebAssembly', 'Intl', 'setTimeout', 'crypto', 'navigator']) {
      assert.equal(target[name], undefined, name);
    }
    // F1：Node 新增但白名单没有的全局（Event / URL / structuredClone 等）同样删掉。
    for (const name of ['Event', 'URL', 'URLSearchParams', 'structuredClone']) {
      assert.equal(target[name], undefined, name);
    }
    assert.notEqual(target['Math'], Math);
    assert.notEqual(target['Date'], Date);
    assert.equal(capture.truncated, 0);
  });

  test('删除完成后剩下的字符串键恰好是白名单', () => {
    const target: MutableGlobals = {};
    for (const name of ALLOWED_GLOBALS) target[name] = undefined;
    target['process'] = 1;
    target['Event'] = 1;
    target['structuredClone'] = (): undefined => undefined;
    prepareGlobals(target, { seed: 1, consoleBytes: 100 });
    const remaining = Reflect.ownKeys(target)
      .filter((key): key is string => typeof key === 'string')
      .sort();
    assert.deepEqual(remaining, [...ALLOWED_GLOBALS].sort());
    assert.equal(Object.isFrozen(target), true);
  });

  test('performance 替身 now() 恒为 0（F1）', () => {
    const target = isolated();
    prepareGlobals(target, { seed: 1, consoleBytes: 100 });
    const perf = target['performance'] as { now: () => number };
    assert.equal(perf.now(), 0);
    assert.equal(Object.isFrozen(perf), true);
  });

  test('Math.random 换成 mulberry32：同种子同序列，异种子不同', () => {
    const targetA = isolated();
    const targetB = isolated();
    const targetC = isolated();
    prepareGlobals(targetA, { seed: 42, consoleBytes: 100 });
    prepareGlobals(targetB, { seed: 42, consoleBytes: 100 });
    prepareGlobals(targetC, { seed: 43, consoleBytes: 100 });
    const random = (t: MutableGlobals): number => (t['Math'] as { random: () => number }).random();
    assert.equal(random(targetA), random(targetB));
    assert.notEqual(random(targetA), random(targetC));
  });

  test('Date 四种写法：固定时刻、now、有参构造、instanceof', () => {
    const target = isolated();
    prepareGlobals(target, { seed: 1, consoleBytes: 100 });
    const D = dateOf(target);
    assert.equal(D.now(), FIXED_TIME);
    assert.equal(new D().toISOString(), '2000-01-01T00:00:00.000Z');
    // 有参构造照常按本地时区；宿主 CST 下与真实 Date 相同（子进程 TZ=UTC 才等于 UTC 值，规格 §11.5）。
    assert.equal(new D(2000, 0, 1).toISOString(), new Date(2000, 0, 1).toISOString());
    assert.ok(D().includes('2000'), D());
    assert.ok(new D() instanceof Date);
    assert.equal(D.parse('2000-01-01T00:00:00.000Z'), FIXED_TIME);
    assert.equal(D.UTC(2000, 0, 1), Date.UTC(2000, 0, 1));
  });

  test('console 捕获三个级别、对象用 JSON、空方法可调用', () => {
    const target = isolated();
    const capture = prepareGlobals(target, { seed: 1, consoleBytes: 1024 });
    const consoleObj = target['console'] as {
      log: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
      trace: (...args: unknown[]) => void;
    };
    consoleObj.log('x', 1, { a: 2 });
    consoleObj.warn('w');
    consoleObj.error('e');
    consoleObj.trace('ignored');
    assert.deepEqual(capture.entries, [
      { level: 'log', text: 'x 1 {"a":2}' },
      { level: 'warn', text: 'w' },
      { level: 'error', text: 'e' },
    ]);
    assert.equal(capture.truncated, 0);
  });

  test('console 按字节截断，额度用尽的条目丢弃并计数', () => {
    const target = isolated();
    const capture = prepareGlobals(target, { seed: 1, consoleBytes: 10 });
    const log = (target['console'] as { log: (...args: readonly unknown[]) => void }).log;
    log('abcdefghij'); // 10 字节，正好用满
    log('x'); // 丢弃
    log('y'); // 丢弃
    assert.equal(capture.entries.length, 1);
    assert.equal(capture.entries[0]?.text, 'abcdefghij');
    assert.equal(capture.truncated, 2);

    const target2 = isolated();
    const capture2 = prepareGlobals(target2, { seed: 1, consoleBytes: 12 });
    (target2['console'] as { log: (...args: readonly unknown[]) => void }).log('abcdefghijklmnop');
    const text = capture2.entries[0]?.text ?? '';
    assert.ok(text.endsWith('…'));
    assert.ok(Buffer.byteLength(text, 'utf8') <= 12);
    assert.equal(capture2.truncated, 0);
  });

  test('extras 在冻结前挂上，冻结后不能改全局', () => {
    const target = isolated();
    prepareGlobals(target, { seed: 1, consoleBytes: 100, extras: { rect: 'R' } });
    assert.equal(target['rect'], 'R');
    assert.equal(Object.isFrozen(target), true);
    assert.throws(() => {
      target['Math'] = 1;
    }, TypeError);
    assert.throws(() => {
      target['newGlobal'] = 1;
    }, TypeError);
  });

  test('冻结全局不影响 Error 子类给 this.name 赋值（F1）', () => {
    const target = isolated();
    prepareGlobals(target, { seed: 1, consoleBytes: 100 });
    class CustomError extends Error {
      constructor() {
        super('boom');
        this.name = 'CustomError';
      }
    }
    const error = new CustomError();
    assert.equal(error.name, 'CustomError');
    assert.equal(error.message, 'boom');
  });
});
