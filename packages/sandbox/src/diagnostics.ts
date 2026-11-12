/**
 * 诊断的规整：把 TypeScript 诊断与规则诊断转成同一结构，排序、去重、截断、限条数。
 * 不负责规则判定（rules.ts）与编译（worker-core.ts）。
 */
import ts from 'typescript';

import type { Diagnostic, PrecheckResult } from './protocol.ts';

/** 单条 message 的字符上限；超出截断并加省略号（SANDBOX-SPEC §3.3）。 */
export const MESSAGE_MAX_CHARS = 600;
/** source 行内容的字符上限。 */
export const SOURCE_MAX_CHARS = 120;
/** 一次返回的诊断条数上限；total 仍是去重后的总数。 */
export const DIAGNOSTIC_LIMIT = 20;

/** 把 0 起的字符偏移转成 1 起的行列（UTF-16 码元）。 */
export function positionOf(sourceFile: ts.SourceFile, start: number): { line: number; column: number } {
  const pos = sourceFile.getLineAndCharacterOfPosition(start);
  return { line: pos.line + 1, column: pos.character + 1 };
}

/** 取第 line（1 起）行的源码，去首尾空白并截到 120 字符。 */
export function sourceLineOf(sourceFile: ts.SourceFile, line: number): string {
  const starts = sourceFile.getLineStarts();
  const start = starts[line - 1] ?? sourceFile.text.length;
  const end = starts[line] ?? sourceFile.text.length;
  return sourceFile.text.slice(start, end).trim().slice(0, SOURCE_MAX_CHARS);
}

/** 按码点（而不是 UTF-16 码元）比较两个字符串。 */
export function compareCodePoints(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const len = Math.min(ai.length, bi.length);
  for (let i = 0; i < len; i++) {
    const x = ai[i]?.codePointAt(0) ?? 0;
    const y = bi[i]?.codePointAt(0) ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (ai.length === bi.length) return 0;
  return ai.length < bi.length ? -1 : 1;
}

/** 截到 600 字符；被截断时在末尾加省略号。 */
export function truncateMessage(message: string): string {
  return message.length > MESSAGE_MAX_CHARS ? `${message.slice(0, MESSAGE_MAX_CHARS)}…` : message;
}

/** 构造一条诊断。start 是源码里的 0 起字符偏移。 */
export function makeDiagnostic(sourceFile: ts.SourceFile, start: number, code: string, message: string): Diagnostic {
  const { line, column } = positionOf(sourceFile, start);
  return { line, column, code, message: truncateMessage(message), source: sourceLineOf(sourceFile, line) };
}

/** 把 TypeScript 诊断转成我们的结构；code 加 `TS` 前缀。 */
export function fromTsDiagnostic(sourceFile: ts.SourceFile, diagnostic: ts.Diagnostic): Diagnostic {
  return makeDiagnostic(
    sourceFile,
    diagnostic.start ?? 0,
    `TS${String(diagnostic.code)}`,
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  );
}

function tupleKey(d: Diagnostic): string {
  return `${String(d.line)}\u0000${String(d.column)}\u0000${d.code}\u0000${d.message}`;
}

/** 排序 → 去重 → 截断到 20 条；total 是去重后的总数。 */
export function normalizeDiagnostics(list: readonly Diagnostic[]): {
  readonly diagnostics: readonly Diagnostic[];
  readonly total: number;
} {
  const sorted = [...list].sort(
    (a, b) =>
      a.line - b.line ||
      a.column - b.column ||
      compareCodePoints(a.code, b.code) ||
      compareCodePoints(a.message, b.message),
  );
  const unique: Diagnostic[] = [];
  let last = '';
  for (const d of sorted) {
    const key = tupleKey(d);
    if (key === last) continue;
    last = key;
    unique.push(d);
  }
  return { diagnostics: unique.slice(0, DIAGNOSTIC_LIMIT), total: unique.length };
}

/** 编译器自身抛 RangeError（嵌套过深）时的结果：一条 PG000。此时连 SourceFile 都建不出来。 */
export function pg000Result(code: string, error: RangeError): PrecheckResult {
  const firstLine = (code.split('\n')[0] ?? '').trim().slice(0, SOURCE_MAX_CHARS);
  return {
    kind: 'failed',
    diagnostics: [
      {
        line: 1,
        column: 1,
        code: 'PG000',
        message: truncateMessage(`代码嵌套过深或结构异常，编译器无法处理：${error.name}`),
        source: firstLine,
      },
    ],
    total: 1,
  };
}
