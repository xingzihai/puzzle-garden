import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ts from 'typescript';

import { RULES_VERSION, collectRuleDiagnostics } from './rules.ts';

function codesFor(code: string): string[] {
  const sourceFile = ts.createSourceFile('building.ts', code, ts.ScriptTarget.Latest, true);
  return collectRuleDiagnostics(sourceFile).map((d) => d.code);
}

function entry(body: string): string {
  return `export default function build(w: World): void {\n${body}\n}\n`;
}

describe('rules', () => {
  test('规则版本是 2', () => {
    assert.equal(RULES_VERSION, 2);
  });

  test('合法入口与辅助代码不报', () => {
    assert.deepEqual(
      codesFor(
        `const K = 2;\nfunction helper(x: number): number { return x * K; }\ntype T = { a: number };\n${entry('void helper(1);')}`,
      ),
      [],
    );
  });

  test('PG001：静态 import / export from / 动态 import / import.meta / require', () => {
    assert.ok(codesFor(`import fs from 'node:fs';\n${entry('void fs;')}`).includes('PG001'));
    assert.ok(codesFor(`export { readFile } from 'node:fs';\n${entry('')}`).includes('PG001'));
    assert.ok(codesFor(entry(`void import('node:fs');`)).includes('PG001'));
    assert.ok(codesFor(entry(`void import.meta.url;`)).includes('PG001'));
    assert.ok(codesFor(entry(`void require('node:fs');`)).includes('PG001'));
  });

  test('PG002：入口缺失 / 多余 export / 入口形态', () => {
    assert.ok(codesFor('const x = 1; void x;').includes('PG002'));
    assert.ok(codesFor(`export const x = 1;\n${entry('')}`).includes('PG002'));
    assert.ok(codesFor(`export default function construct(w: World): void { void w; }`).includes('PG002'));
    assert.ok(
      codesFor(`export default function build(a: World, b: World): void { void a; void b; }`).includes('PG002'),
    );
    assert.ok(codesFor(`export default function (w: World): void { void w; }`).includes('PG002'));
  });

  test('PG002：async / await / 生成器 / yield / for await', () => {
    assert.ok(codesFor(`export default async function build(w: World): void { void w; }`).includes('PG002'));
    assert.ok(codesFor(entry('await Promise.resolve();')).includes('PG002'));
    assert.ok(codesFor(`export default function* build(w: World): void { yield w; }`).includes('PG002'));
    assert.ok(codesFor(entry('for await (const x of [] as number[]) { void x; }')).includes('PG002'));
    assert.ok(codesFor(entry('const f = async (): Promise<void> => {}; void f;')).includes('PG002'));
  });

  test('PG003：被删标识符与 locale 属性', () => {
    for (const body of [
      'void Intl;',
      "eval('1');",
      'void process;',
      'void globalThis;',
      'void Buffer;',
      'void fetch;',
    ]) {
      assert.ok(codesFor(entry(body)).includes('PG003'), body);
    }
    assert.ok(codesFor(entry(`void 'a'.localeCompare('b');`)).includes('PG003'));
    assert.ok(codesFor(entry(`void 'a'['toLocaleString']();`)).includes('PG003'));
    assert.ok(codesFor(entry(`void ''.toLocaleUpperCase();`)).includes('PG003'));
    // 模型自己声明的同名局部变量也按语法报（规格 §3.2）。
    assert.ok(codesFor(`const Intl = 1;\n${entry('void Intl;')}`).includes('PG003'));
  });

  test('PG004：prototype / __proto__ / Error 栈属性', () => {
    assert.ok(codesFor(entry('Array.prototype.push = () => {};')).includes('PG004'));
    assert.ok(codesFor(entry(`Object.prototype['x'] = 1;`)).includes('PG004'));
    assert.ok(codesFor(entry('const o: { __proto__?: unknown } = {}; o.__proto__ = {};')).includes('PG004'));
    assert.ok(codesFor(entry('Error.stackTraceLimit = 0;')).includes('PG004'));
    assert.ok(codesFor(entry('Error.prepareStackTrace = () => {};')).includes('PG004'));
    assert.ok(codesFor(entry('const o: { __proto__?: unknown } = {}; delete o.__proto__;')).includes('PG004'));
    assert.ok(codesFor(entry('Array.prototype.length += 1;')).includes('PG004'));
  });

  test('PG005：declare 语句 / 修饰符一律拒绝', () => {
    assert.ok(
      codesFor(`declare const performance: { now(): number };\n${entry('void performance;')}`).includes('PG005'),
    );
    assert.ok(codesFor(`declare function helper(): number;\n${entry('void helper();')}`).includes('PG005'));
    assert.ok(codesFor(`const K = 1;\ndeclare const extra: number;\n${entry('void [K, extra];')}`).includes('PG005'));
  });

  test('PG004 不追求完备：未覆盖写法交给运行期冻结', () => {
    assert.equal(codesFor(entry('Math.PI = 3;')).includes('PG004'), false);
    assert.equal(
      codesFor(entry(`Object.defineProperty(Array.prototype, 'x', { value: 1 });`)).includes('PG004'),
      false,
    );
    assert.equal(codesFor(entry('const o: { x?: number } = {}; o.x = 1;')).includes('PG004'), false);
  });
});
