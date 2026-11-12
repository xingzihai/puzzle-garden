/**
 * 预检公开接口的验收测试（SANDBOX-SPEC §10 第 2–5 条）。
 * 走真实 worker 线程；不依赖 bwrap，属于 npm test。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SandboxError } from './errors.ts';
import { createPrechecker } from './precheck.ts';
import type { PrecheckResult } from './protocol.ts';

/** 与 precheck.ts 的 MAX_CODE_BYTES 同值；不导出内部常量，测试自己写一份。 */
const CODE_LIMIT = 256 * 1024;
const declaration = readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');
const fixturesDir = fileURLToPath(new URL('../../geometry/fixtures/', import.meta.url));

function stripImports(code: string): string {
  return code
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('import '))
    .join('\n');
}

function entry(body: string): string {
  return `export default function build(w: World): void {\n${body}\n}\n`;
}

function codes(result: PrecheckResult): string[] {
  return result.kind === 'failed' ? result.diagnostics.map((d) => d.code) : [];
}

/** 病态样本：16 份自递归元组类型，单独求值会耗尽 1024 MB worker 堆（规格 §10 第 5 条）。 */
function pathological(): string {
  const types: string[] = [];
  const values: string[] = [];
  for (let i = 0; i < 16; i++) {
    types.push(
      `type B${String(i)}<N, A = []> = A['length'] extends N ? A : B${String(i)}<N, [...A, B${String(i)}<N, A>]>;`,
    );
    values.push(`type C${String(i)} = B${String(i)}<999>;`);
  }
  return `${types.join('\n')}\n${values.join('\n')}\nconst s: string = null as unknown as C0;\n${entry('void s;')}`;
}

describe('precheck 验收 2：夹具代表样本', () => {
  test('3 份代表夹具删去 import 后 ok（12 份全量在 precheck.integration.test.ts）', async () => {
    const files = ['f1-pav.A.ts', 'f4-chu.B.ts', 'f5-tow.B.ts'];
    const prechecker = createPrechecker(declaration);
    try {
      for (const file of files) {
        const code = stripImports(readFileSync(`${fixturesDir}/${file}`, 'utf8'));
        assert.deepEqual(await prechecker.check(code), { kind: 'ok' }, file);
      }
    } finally {
      await prechecker.close();
    }
  });
});

describe('precheck 验收 3：坏样本', () => {
  test('各坏样本命中对应诊断码', async () => {
    const prechecker = createPrechecker(declaration);
    try {
      const ts2561 = await prechecker.check(
        entry(`w.plinth({ footprint: rect(-7, -7, 7, 7), height: 1, projetc: 1, material: 'stone_bricks' });`),
      );
      assert.ok(codes(ts2561).includes('TS2561'));
      assert.ok(
        ts2561.kind === 'failed' &&
          ts2561.diagnostics.some((d) => d.code === 'TS2561' && d.message.includes('Did you mean')),
      );

      const anchor = await prechecker.check(
        entry(
          `const base = w.plinth({ footprint: rect(-7, -7, 7, 7), height: 1, material: 'stone_bricks' });\nw.walls({ on: base.edge('north'), height: 4, material: 'oak_planks' });`,
        ),
      );
      assert.ok(codes(anchor).includes('TS2322'));

      const method = await prechecker.check(entry('w.rial({});'));
      assert.ok(codes(method).includes('TS2339'));

      const badEnum = await prechecker.check(
        entry(`w.roof({ footprint: rect(0, 0, 1, 1), y: 1, kind: 'pyramyd', peakY: 3, material: 'oak_planks' });`),
      );
      assert.ok(
        badEnum.kind === 'failed' &&
          badEnum.diagnostics.some((d) => d.code === 'TS2820' && d.message.includes('pyramid')),
      );

      const badMaterial = await prechecker.check(
        entry(`w.plinth({ footprint: rect(-7, -7, 7, 7), height: 1, material: 'stone_brikcs' });`),
      );
      assert.ok(
        badMaterial.kind === 'failed' &&
          badMaterial.diagnostics.some((d) => d.code === 'TS2820' && d.message.includes('stone_bricks')),
      );

      assert.ok(codes(await prechecker.check(`enum Color { Red }\n${entry('void Color.Red;')}`)).includes('TS1294'));
      assert.ok(codes(await prechecker.check(`import fs from 'node:fs';\n${entry('void fs;')}`)).includes('PG001'));
      assert.ok(
        codes(await prechecker.check(`export default async function build(w: World): void { void w; }`)).includes(
          'PG002',
        ),
      );
      assert.ok(codes(await prechecker.check(entry(`eval('1');`))).includes('PG003'));
      assert.ok(codes(await prechecker.check(entry('void Intl;'))).includes('PG003'));
      assert.ok(codes(await prechecker.check(entry(`void 'a'.localeCompare('b');`))).includes('PG003'));
      assert.ok(codes(await prechecker.check(entry('Array.prototype.push = () => {};'))).includes('PG004'));
      assert.ok(codes(await prechecker.check(entry('Error.stackTraceLimit = 0;'))).includes('PG004'));
      assert.ok(
        codes(
          await prechecker.check(`declare const performance: { now(): number };\n${entry('void performance;')}`),
        ).includes('PG005'),
      );

      const nested = `export default function build(w: World): void { void ${'('.repeat(60000)}1${')'.repeat(60000)}; }`;
      assert.deepEqual(codes(await prechecker.check(nested)), ['PG000']);
    } finally {
      await prechecker.close();
    }
  });
});

describe('precheck 验收 4：诊断规整', () => {
  test('排序、20 条上限与 total、source 行内容', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `  w.missing${String(i)}({});`);
    const code = `export default function build(w: World): void {\n${lines.join('\n')}\n}\n`;
    const prechecker = createPrechecker(declaration);
    try {
      const result = await prechecker.check(code);
      assert.equal(result.kind, 'failed');
      assert.equal(result.total, 25);
      assert.equal(result.diagnostics.length, 20);
      const keys = result.diagnostics.map((d) => [String(d.line), String(d.column), d.code, d.message].join(':'));
      const positions = result.diagnostics.map((d): readonly [number, number] => [d.line, d.column]);
      assert.deepEqual(
        positions,
        [...positions].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      );
      assert.equal(new Set(keys).size, keys.length);
      assert.ok(result.diagnostics[0]?.source.includes('w.missing0'));
    } finally {
      await prechecker.close();
    }
  });

  test('超长 message 截到 600 字符加省略号', async () => {
    const prechecker = createPrechecker(declaration);
    try {
      const result = await prechecker.check(entry(`w.${'x'.repeat(700)}({});`));
      assert.equal(result.kind, 'failed');
      const first = result.diagnostics[0]!;
      assert.equal(first.message.length, 601);
      assert.ok(first.message.endsWith('…'));
    } finally {
      await prechecker.close();
    }
  });
});

describe('precheck 验收 5：超时与内存', () => {
  test('timeoutMs 2000 返回 timeout，随后 check 正常', async () => {
    const prechecker = createPrechecker(declaration, { timeoutMs: 2000 });
    try {
      assert.deepEqual(await prechecker.check(pathological()), { kind: 'timeout', limitMs: 2000 });
      assert.deepEqual(await prechecker.check(entry('void w;')), { kind: 'ok' });
    } finally {
      await prechecker.close();
    }
  });

  test('F7：超时后重建 worker 的时间不计入下一次请求，正常代码不超时', async () => {
    // 300ms 只够一次热检查；重建 worker（约 0.5s 启动 + 预热）若计入，正常代码必然 timeout。
    const prechecker = createPrechecker(declaration, { timeoutMs: 300 });
    try {
      assert.deepEqual(await prechecker.check(pathological()), { kind: 'timeout', limitMs: 300 });
      assert.deepEqual(await prechecker.check(entry('void w;')), { kind: 'ok' });
    } finally {
      await prechecker.close();
    }
  });
});

describe('precheck 接口细节', () => {
  test('version 稳定且随声明变化', async () => {
    const a = createPrechecker(declaration);
    const b = createPrechecker(declaration);
    const c = createPrechecker(`${declaration}\n// 变体\n`);
    try {
      assert.equal(a.version, b.version);
      assert.notEqual(a.version, c.version);
      assert.match(a.version, /^[0-9a-f]{64}$/);
    } finally {
      await Promise.all([a.close(), b.close(), c.close()]);
    }
  });

  test('超过 256 KiB 直接 too-large，不进编译器', async () => {
    const prechecker = createPrechecker(declaration);
    try {
      const result = await prechecker.check('x'.repeat(CODE_LIMIT + 1));
      assert.deepEqual(result, { kind: 'too-large', bytes: CODE_LIMIT + 1, limit: CODE_LIMIT });
    } finally {
      await prechecker.close();
    }
  });

  test('并发 check 被串行化且各自正确', async () => {
    const prechecker = createPrechecker(declaration);
    try {
      const results = await Promise.all([
        prechecker.check(entry('void w;')),
        prechecker.check(entry('w.rial({});')),
        prechecker.check(entry('void w;')),
      ]);
      assert.deepEqual(
        results.map((r) => r.kind),
        ['ok', 'failed', 'ok'],
      );
    } finally {
      await prechecker.close();
    }
  });

  test('close 后 check 拒绝', async () => {
    const prechecker = createPrechecker(declaration);
    await prechecker.close();
    await assert.rejects(prechecker.check(entry('void w;')), (error: unknown) => error instanceof SandboxError);
  });
});
