import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ts from 'typescript';

import {
  DIAGNOSTIC_LIMIT,
  MESSAGE_MAX_CHARS,
  compareCodePoints,
  fromTsDiagnostic,
  makeDiagnostic,
  normalizeDiagnostics,
  pg000Result,
  positionOf,
  sourceLineOf,
  truncateMessage,
} from './diagnostics.ts';
import type { Diagnostic } from './protocol.ts';

function diagnostic(line: number, column = 1, code = 'TS1', message = 'm'): Diagnostic {
  return { line, column, code, message, source: `line ${String(line)}` };
}

describe('diagnostics', () => {
  const sourceFile = ts.createSourceFile('building.ts', 'abc\ndefgh', ts.ScriptTarget.Latest, true);

  test('positionOf 返回 1 起的行列', () => {
    assert.deepEqual(positionOf(sourceFile, 0), { line: 1, column: 1 });
    assert.deepEqual(positionOf(sourceFile, 4), { line: 2, column: 1 });
    assert.deepEqual(positionOf(sourceFile, 6), { line: 2, column: 3 });
  });

  test('sourceLineOf 去首尾空白并截到 120 字符', () => {
    const padded = ts.createSourceFile('b.ts', `  ${'x'.repeat(200)}  \n`, ts.ScriptTarget.Latest, true);
    assert.equal(sourceLineOf(sourceFile, 1), 'abc');
    assert.equal(sourceLineOf(padded, 1).length, 120);
    assert.equal(sourceLineOf(sourceFile, 9), '');
  });

  test('compareCodePoints 按码点而不是 UTF-16 码元', () => {
    assert.equal(compareCodePoints('a', 'b'), -1);
    assert.equal(compareCodePoints('b', 'a'), 1);
    assert.equal(compareCodePoints('a', 'a'), 0);
    assert.equal(compareCodePoints('a', 'ab'), -1);
    assert.equal(compareCodePoints('ab', 'a'), 1);
    // U+1F600 的 UTF-16 首码元 0xD83D < U+E000，但码点 0x1F600 > 0xE000。
    assert.equal(compareCodePoints('\u{1F600}', '\uE000'), 1);
  });

  test('truncateMessage 只在超过 600 字符时加省略号', () => {
    assert.equal(truncateMessage('a'.repeat(MESSAGE_MAX_CHARS)), 'a'.repeat(MESSAGE_MAX_CHARS));
    const long = truncateMessage('a'.repeat(MESSAGE_MAX_CHARS + 1));
    assert.equal(long.length, MESSAGE_MAX_CHARS + 1);
    assert.ok(long.endsWith('…'));
  });

  test('makeDiagnostic 填 line / column / source', () => {
    const d = makeDiagnostic(sourceFile, 4, 'PG001', '不能引入模块');
    assert.deepEqual(d, { line: 2, column: 1, code: 'PG001', message: '不能引入模块', source: 'defgh' });
  });

  test('fromTsDiagnostic 加 TS 前缀并 flatten 多行消息', () => {
    const diagnosticIn: ts.Diagnostic = {
      category: ts.DiagnosticCategory.Error,
      code: 2339,
      file: sourceFile,
      start: 5,
      length: 1,
      messageText: {
        messageText: '外层',
        category: ts.DiagnosticCategory.Error,
        code: 1,
        next: [{ messageText: '内层', category: ts.DiagnosticCategory.Error, code: 1 }],
      },
    };
    const d = fromTsDiagnostic(sourceFile, diagnosticIn);
    assert.equal(d.code, 'TS2339');
    assert.equal(d.line, 2);
    assert.equal(d.column, 2);
    assert.equal(d.message, '外层\n  内层');
  });

  test('normalizeDiagnostics 排序、去重并按上限截断', () => {
    const raw = [
      diagnostic(3, 2, 'TS2'),
      diagnostic(1, 5, 'PG001'),
      diagnostic(1, 5, 'PG001'),
      diagnostic(1, 4, 'TS9'),
    ];
    const { diagnostics, total } = normalizeDiagnostics(raw);
    assert.equal(total, 3);
    assert.deepEqual(
      diagnostics.map((d) => `${String(d.line)}:${String(d.column)}:${d.code}`),
      ['1:4:TS9', '1:5:PG001', '3:2:TS2'],
    );

    const many = Array.from({ length: DIAGNOSTIC_LIMIT + 5 }, (_, i) => diagnostic(i + 1));
    const capped = normalizeDiagnostics(many);
    assert.equal(capped.total, DIAGNOSTIC_LIMIT + 5);
    assert.equal(capped.diagnostics.length, DIAGNOSTIC_LIMIT);
  });

  test('pg000Result 固定为 1:1 的 PG000', () => {
    const result = pg000Result('  export default function build(w: World): void {}', new RangeError('x'));
    assert.equal(result.kind, 'failed');
    assert.equal(result.total, 1);
    assert.equal(result.diagnostics[0]!.code, 'PG000');
    assert.equal(result.diagnostics[0]!.line, 1);
    assert.equal(result.diagnostics[0]!.column, 1);
    assert.ok(result.diagnostics[0]!.source.startsWith('export default'));
  });
});
