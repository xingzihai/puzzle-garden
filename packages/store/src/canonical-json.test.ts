/**
 * canonicalJson 的测试（MODEL-SPEC §2、§7.4、§9）。
 *
 * 规范 JSON 的规则与 core 的 `args` 规范 JSON 一致（CORE-SPEC §4.1），所以这里直接复用
 * `packages/core/src/grid.test.ts`（金标来源：commit 494ec1f，grid.test.ts 第 80–94 行）的
 * 金标样例逐字对照；core 的 canonicalJson 未导出，无法直接调用，故用行为金标。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { canonicalJson } from './canonical-json.ts';

describe('canonicalJson 金标（与 core 的 args 规范 JSON 对照）', () => {
  it('好样本：core grid.test.ts 的金标逐字一致', () => {
    // 金标来源：packages/core/src/grid.test.ts:83-93。
    assert.equal(
      canonicalJson({ b: 1, a: [1, undefined, Number.NaN, Infinity], c: undefined, d: 'x' }),
      '{"a":[1,null,null,null],"b":1,"d":"x"}',
    );
    assert.equal(canonicalJson({ B: 1, a: 2, _: 3 }), '{"B":1,"_":3,"a":2}');
    assert.equal(canonicalJson(undefined), 'null');
    assert.equal(canonicalJson(true), 'true');
    assert.equal(canonicalJson(false), 'false');
    assert.equal(canonicalJson({ n: { m: [] } }), '{"n":{"m":[]}}');
    const shared = { v: 1 };
    assert.equal(canonicalJson([shared, shared]), '[{"v":1},{"v":1}]');
  });
});

describe('canonicalJson 键序', () => {
  it('按 UTF-16 码元升序，而不是码点或 locale 顺序', () => {
    // 'z'(0x7A) < 'ä'(0xE4) < '😀'(U+1F600，高代理项 0xD83D)。码点顺序会把 😀 排在 ä 前。
    assert.equal(canonicalJson({ ä: 1, z: 2, '😀': 3 }), '{"z":2,"ä":1,"😀":3}');
  });

  it('嵌套对象同样排序，数组保持原序', () => {
    assert.equal(canonicalJson({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] }), '{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}');
  });
});

describe('canonicalJson 数字与字符串', () => {
  it('用 JSON.stringify 的数字形式，无多余空格', () => {
    assert.equal(canonicalJson({ a: 1, b: -0, c: 1.5, d: 1e21 }), '{"a":1,"b":0,"c":1.5,"d":1e+21}');
    assert.equal(canonicalJson([Number.NaN, Infinity, -Infinity]), '[null,null,null]');
  });

  it('字符串按 JSON 转义，Unicode 字符原样保留（不转成 \\u 代理对）', () => {
    assert.equal(canonicalJson({ 'a"b': 'x\ny' }), '{"a\\"b":"x\\ny"}');
    assert.equal(canonicalJson('中文😀'), '"中文😀"');
  });

  it('undefined：顶层与数组元素写成 null，对象属性省略', () => {
    assert.equal(canonicalJson(undefined), 'null');
    assert.equal(canonicalJson([undefined, 1]), '[null,1]');
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  });
});

describe('canonicalJson 坏样本', () => {
  it('函数、symbol、bigint、循环引用都抛 TypeError', () => {
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    assert.throws(() => canonicalJson({ f: () => 0 }), /function/);
    assert.throws(() => canonicalJson([Symbol('s')]), /symbol/);
    assert.throws(() => canonicalJson(10n), /bigint/);
    assert.throws(() => canonicalJson(loop), /循环引用/);
  });

  it('共享引用（非循环）不报错', () => {
    const shared = { v: 1 };
    assert.equal(canonicalJson([shared, shared]), '[{"v":1},{"v":1}]');
  });
});

describe('canonicalJson 性质', () => {
  const jsonValue = fc.letrec((tie) => ({
    value: fc.oneof(
      { depthSize: 'small' },
      fc.boolean(),
      fc.integer(),
      fc.string(),
      fc.constant(null),
      fc.array(tie('value'), { maxLength: 4 }),
      fc.dictionary(fc.string(), tie('value'), { maxKeys: 4 }),
    ),
  })).value;

  it('同值同字节，幂等', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const once = canonicalJson(value);
        assert.equal(canonicalJson(value), once);
        assert.equal(canonicalJson(JSON.parse(once) as unknown), once);
      }),
    );
  });

  it('输出无结构空白（字符串内的空白除外）', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const text = canonicalJson(value);
        const outside = text.replaceAll(/"(?:[^"\\]|\\.)*"/g, '');
        assert.ok(!/[\s]/.test(outside));
      }),
    );
  });
});
