import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SandboxError } from './errors.ts';
import type { PrecheckResult } from './protocol.ts';
import { createPrecheckRuntime } from './worker-core.ts';

const declaration = readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');
const fixturesDir = fileURLToPath(new URL('../../geometry/fixtures/', import.meta.url));
const runtime = createPrecheckRuntime(declaration);

function stripImports(code: string): string {
  return code
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('import '))
    .join('\n');
}

function codes(result: PrecheckResult): string[] {
  return result.kind === 'failed' ? result.diagnostics.map((d) => d.code) : [];
}

function entry(body: string): string {
  return `export default function build(w: World): void {\n${body}\n}\n`;
}

describe('worker-core', () => {
  test('3 份代表夹具删去 import 后对模型可见 world.d.ts 全部 ok', () => {
    const files = ['f1-pav.A.ts', 'f4-chu.B.ts', 'f5-tow.B.ts'];
    for (const file of files) {
      const result = runtime.check(stripImports(readFileSync(`${fixturesDir}/${file}`, 'utf8')));
      assert.deepEqual(result, { kind: 'ok' }, file);
    }
  });

  test('坏样本命中对应的 TS / PG 码', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      [
        'TS2561',
        entry(`w.plinth({ footprint: rect(-7, -7, 7, 7), height: 1, projetc: 1, material: 'stone_bricks' });`),
        'TS2561',
      ],
      [
        'TS2820 方块名',
        entry(`w.plinth({ footprint: rect(-7, -7, 7, 7), height: 1, material: 'stone_brikcs' });`),
        'TS2820',
      ],
      ['TS2339 方法', entry('w.rial({});'), 'TS2339'],
      [
        'TS2820 枚举',
        entry(`w.roof({ footprint: rect(0, 0, 1, 1), y: 1, kind: 'pyramyd', peakY: 3, material: 'oak_planks' });`),
        'TS2820',
      ],
      ['TS1294 enum', `enum Color { Red }\n${entry('void Color.Red;')}`, 'TS1294'],
      ['PG001 import', `import fs from 'node:fs';\n${entry('void fs;')}`, 'PG001'],
      ['PG002 async', `export default async function build(w: World): void { void w; }`, 'PG002'],
      ['PG003 eval', entry(`eval('1');`), 'PG003'],
      ['PG003 Intl', entry('void Intl;'), 'PG003'],
      ['PG003 localeCompare', entry(`void 'a'.localeCompare('b');`), 'PG003'],
      ['PG004 prototype', entry('Array.prototype.push = () => {};'), 'PG004'],
      ['PG004 stackTraceLimit', entry('Error.stackTraceLimit = 0;'), 'PG004'],
      ['PG005 declare', `declare const performance: { now(): number };\n${entry('void performance;')}`, 'PG005'],
    ];
    for (const [name, code, expected] of cases) {
      const result = runtime.check(code);
      assert.equal(result.kind, 'failed', name);
      assert.ok(codes(result).includes(expected), `${name} 期望 ${expected}，实际 ${codes(result).join(',')}`);
    }
  });

  test('锚点类型错命中 TS2322', () => {
    const result = runtime.check(
      entry(
        `const base = w.plinth({ footprint: rect(-7, -7, 7, 7), height: 1, material: 'stone_bricks' });\nw.walls({ on: base.edge('north'), height: 4, material: 'oak_planks' });`,
      ),
    );
    assert.ok(codes(result).includes('TS2322'));
  });

  test('6 万层嵌套括号返回 PG000', () => {
    const code = `export default function build(w: World): void { void ${'('.repeat(60000)}1${')'.repeat(60000)}; }`;
    const result = runtime.check(code);
    assert.equal(result.kind, 'failed');
    assert.deepEqual(codes(result), ['PG000']);
  });

  test('编译宿主是虚拟文件系统：引用宿主任意文件一律 not found，不能把内容回显进诊断', () => {
    // 回归防线：曾经 baseHost.fileExists / readFile 对非白名单路径回落真实文件系统，
    // 生成代码可以 /// <reference path> 读宿主任意文件，再让 TS 把字面量类型打进诊断，
    // 经模型上下文外带出去。
    const secretPath = fileURLToPath(new URL('./worker-core.ts', import.meta.url));
    const referenced = runtime.check(
      `/// <reference path="${secretPath}" />\nexport default function build(w: World): void {}\n`,
    );
    assert.equal(referenced.kind, 'failed');
    // TypeScript 必须认为它不存在，而不是读到内容后发现里面的类型错误。
    assert.deepEqual(codes(referenced), ['TS6053']);

    // 能读到内容才能把字面量类型回显出来；这里必须是"找不到名字"。
    const echoed = runtime.check(
      `/// <reference path="${secretPath}" />\nexport default function build(w: World): void { const x: "WRONG" = HOST_SECRET; }\n`,
    );
    assert.equal(echoed.kind, 'failed');
    assert.ok(codes(echoed).includes('TS2304'));
    // source 字段会回显我们自己的输入（含路径字符串），所以只断言"文件内容特征"不出现。
    const text = JSON.stringify(echoed);
    assert.ok(!text.includes('createPrecheckRuntime'), '诊断里不能出现宿主文件内容');
    assert.ok(!text.includes('baseHost'), '诊断里不能出现宿主文件内容');
  });

  test('声明无效时抛 SandboxError(invalid-declaration)', () => {
    assert.throws(
      () => createPrecheckRuntime('declare const x: number;\nexport { x };'),
      (error: unknown) => error instanceof SandboxError && error.code === 'invalid-declaration',
    );
    assert.throws(
      () => createPrecheckRuntime(''),
      (error: unknown) => error instanceof SandboxError && error.code === 'invalid-declaration',
    );
  });
});
