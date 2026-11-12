/**
 * §3.2 的语法规则检查 PG001–PG004：对 `building.ts` 的 AST 按语法判定，不做符号解析。
 * 只产出诊断，不排序 / 去重 / 限条数（diagnostics.ts 做），也不管类型诊断（worker-core.ts 做）。
 */
import ts from 'typescript';

import { makeDiagnostic } from './diagnostics.ts';
import type { Diagnostic } from './protocol.ts';

/** 规则版本：规则语义一变就递增，进 `prechecker.version`（SANDBOX-SPEC §6）。 */
export const RULES_VERSION = 2;

/** 沙箱里被删除 / 不应使用的全局标识符（§2.2 删除表 + PG003 表）。 */
const BANNED_IDENTIFIERS: ReadonlySet<string> = new Set([
  'eval',
  'Function',
  'globalThis',
  'Intl',
  'process',
  'Buffer',
  'require',
  'fetch',
  'Request',
  'Response',
  'Headers',
  'WebSocket',
  'EventSource',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  'crypto',
  'navigator',
  'SharedArrayBuffer',
  'Atomics',
  'WebAssembly',
  'BroadcastChannel',
  'MessageChannel',
  'MessagePort',
]);

/** 受确定性限制的属性名；出现在属性访问、字符串下标或对象字面量键上都算。 */
const BANNED_PROPERTIES: ReadonlySet<string> = new Set([
  'localeCompare',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleUpperCase',
  'toLocaleLowerCase',
]);

/**
 * 入口规则的文案。world API 与建模 API 的入口都是
 * `export default function build(<param>: <T>): void`，只有参数类型标签不同；
 * 把签名与标签参数化，让两套预检复用同一份 PG001–PG005 规则，又不互改输出。
 */
export interface EntryText {
  /** 完整入口签名；写进"缺少入口 / 入口不是函数"的提示。 */
  readonly signature: string;
  /** 参数类型标签；写进参数个数不对的提示。 */
  readonly paramLabel: string;
}

/** world API 的入口文案，默认值；不传 entry 时输出与历史逐字相同。 */
export const DEFAULT_ENTRY: EntryText = {
  signature: 'export default function build(world: World): void',
  paramLabel: 'World',
};

const ASSIGNMENT_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
}

function isFunctionNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isDefaultFunction(statement: ts.Statement): statement is ts.FunctionDeclaration {
  return ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
}

/** 除 `export default function build` 之外的任何 export。 */
function isOtherExport(statement: ts.Statement): boolean {
  if (isDefaultFunction(statement)) return false;
  if (ts.isExportAssignment(statement)) return statement.isExportEquals === true;
  if (ts.isExportDeclaration(statement)) return true;
  return hasModifier(statement, ts.SyntaxKind.ExportKeyword);
}

/** 属性访问 / 字符串下标的名字；穿过括号与非空断言。 */
function memberName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  if (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return memberName(expression.expression);
  }
  return undefined;
}

/** 成员链里是否出现 `prototype` / `__proto__`（`X.prototype.y`、`a.b.__proto__` 都算）。 */
function hasPrototypeInChain(expression: ts.Expression): boolean {
  let current: ts.Expression = expression;
  for (;;) {
    const name = memberName(current);
    if (name === 'prototype' || name === '__proto__') return true;
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return false;
  }
}

/** 赋值 / 删除的目标是否是 §3.2 PG004 覆盖的写法。 */
function isForbiddenTarget(expression: ts.Expression): boolean {
  const name = memberName(expression);
  if (name === 'stackTraceLimit' || name === 'prepareStackTrace') {
    if (
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'Error'
    ) {
      return true;
    }
  }
  return hasPrototypeInChain(expression);
}

function checkEntry(sourceFile: ts.SourceFile, push: (node: ts.Node, message: string) => void, text: EntryText): void {
  const statements = sourceFile.statements;
  const defaults = statements.filter(isDefaultFunction);
  const defaultAssignments = statements.filter(
    (s): s is ts.ExportAssignment => ts.isExportAssignment(s) && !s.isExportEquals,
  );
  const otherExports = statements.filter(isOtherExport);

  const entry = defaults.length === 1 && defaultAssignments.length === 0 ? defaults[0] : undefined;
  if (entry === undefined) {
    if (defaultAssignments.length > 0) {
      push(defaultAssignments[0] ?? sourceFile, `入口必须是同步函数 ${text.signature}。`);
    } else {
      push(sourceFile, `缺少入口：必须有一个 ${text.signature}。`);
    }
  } else {
    if (entry.name?.text !== 'build') push(entry, '入口函数名必须是 build，且参数恰好一个。');
    else if (entry.parameters.length !== 1) push(entry, `入口函数必须恰好一个参数（${text.paramLabel}）。`);
  }
  const surplus = otherExports[0];
  if (surplus !== undefined) push(surplus, '只能有入口一个 export：删除多余的 export，辅助代码不要导出。');
}

/** 对一份 `building.ts` 收集全部规则诊断；`text` 缺省是 world API 文案。 */
export function collectRuleDiagnostics(sourceFile: ts.SourceFile, text: EntryText = DEFAULT_ENTRY): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (node: ts.Node, code: string, message: string): void => {
    out.push(makeDiagnostic(sourceFile, node.getStart(sourceFile), code, message));
  };
  const pg001 = (node: ts.Node): void => {
    push(node, 'PG001', '不能引入模块：World、rect 已是全局名字，直接使用。');
  };
  const pg002 = (node: ts.Node, message: string): void => {
    push(node, 'PG002', message);
  };
  const pg003 = (node: ts.Node, name: string, kind: '标识符' | '属性'): void => {
    push(node, 'PG003', `${kind} ${name} 在沙箱里不可用（隔离 / 确定性），请改用已提供的全局名字。`);
  };
  const pg004 = (node: ts.Node): void => {
    push(node, 'PG004', '内置对象只读：不能给内置对象或原型赋值，也不能删除它们的属性。');
  };
  const pg005 = (node: ts.Node): void => {
    push(node, 'PG005', '不能用 declare：全局名字由沙箱提供，declare 出来的名字在运行期未必存在。');
  };

  checkEntry(
    sourceFile,
    (node, message) => {
      pg002(node, message);
    },
    text,
  );

  const visit = (node: ts.Node): void => {
    // PG001
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) pg001(node);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) pg001(node);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) pg001(node);
    else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) pg001(node);
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      pg001(node);
    }

    // PG002：async / await / 生成器 / yield
    if (isFunctionNode(node)) {
      if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) pg002(node, '入口与所有函数都必须是同步的：不能用 async。');
      if (
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) &&
        node.asteriskToken !== undefined
      ) {
        pg002(node, '不能用生成器函数（function* / yield）。');
      }
    }
    if (ts.isAwaitExpression(node)) pg002(node, '不能用 await：所有函数必须是同步的。');
    if (ts.isYieldExpression(node)) pg002(node, '不能用 yield：生成器不可用。');
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) pg002(node, '不能用 for await...of。');

    // PG005：declare（F1）——声明出来的名字可能与运行期全局不一致，一律拒绝。
    if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) pg005(node);

    // PG003
    if (ts.isIdentifier(node)) {
      if (BANNED_IDENTIFIERS.has(node.text)) pg003(node, node.text, '标识符');
      else if (BANNED_PROPERTIES.has(node.text)) pg003(node, node.text, '属性');
    } else if (ts.isStringLiteral(node) && BANNED_PROPERTIES.has(node.text)) {
      pg003(node, node.text, '属性');
    }

    // PG004
    if (ts.isBinaryExpression(node) && ASSIGNMENT_TOKENS.has(node.operatorToken.kind)) {
      if (isForbiddenTarget(node.left)) pg004(node.left);
    } else if (ts.isDeleteExpression(node) && isForbiddenTarget(node.expression)) {
      pg004(node.expression);
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}
