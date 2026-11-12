/**
 * 预检的实际编译器：在内存虚拟文件系统里对照 `world.d.ts` 检查 `building.ts`，跑 PG 规则。
 * 不启动线程（precheck-worker.ts 提供线程外壳），不处理超时 / OOM（precheck.ts 的宿主负责）。
 */
import ts from 'typescript';
import { basename, dirname, resolve, sep } from 'node:path';

import { fromTsDiagnostic, makeDiagnostic, normalizeDiagnostics, pg000Result } from './diagnostics.ts';
import { SandboxError } from './errors.ts';
import type { Diagnostic, PrecheckResult } from './protocol.ts';
import { DEFAULT_ENTRY, collectRuleDiagnostics } from './rules.ts';
import type { EntryText } from './rules.ts';

const WORLD_FILE = '/world.d.ts';
const GLOBALS_FILE = '/globals.d.ts';
const BUILDING_FILE = '/building.ts';

/**
 * §2.2 的全局名字。放在根目录下的虚拟文件：TypeScript 的模块解析要求所在目录真实存在，
 * 而 `/` 一定存在；文件名只影响宿主缺陷信息，不进模型诊断（那里固定写 building.ts）。
 */
const GLOBALS_TEXT = `import type * as W from './world.js';

declare global {
  type World = W.World;
  type Material = W.Material;
  type Surface = W.Surface;
  type Facade = W.Facade;
  const rect: typeof W.rect;
  const console: {
    log(...args: readonly unknown[]): void;
    warn(...args: readonly unknown[]): void;
    error(...args: readonly unknown[]): void;
  };
}
`;

/** 与仓库 tsconfig 的严格度对齐，但不开 noUnused*（未用变量对建筑无害），并只暴露 ES2023 lib。 */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  erasableSyntaxOnly: true,
  verbatimModuleSyntax: true,
  target: ts.ScriptTarget.ES2023,
  lib: ['lib.es2023.d.ts'],
  types: [],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
};

/**
 * 唯一允许读取的真实目录：TypeScript 自带的 `lib/`。
 *
 * 预检必须能拿到 `lib.es2023*.d.ts`（否则连 `Array` 都不认识），而它只可能来自
 * 安装好的 typescript 包。除这个目录外，编译器宿主对任何路径都必须表现为"文件不存在"，
 * 否则生成代码可以用 `/// <reference path>` 或 `import` 读到宿主任意文件，再借 TS 诊断
 * 把内容（字面量类型、声明文本）回显到模型上下文里 —— 那是一条完整的本地文件外带通道。
 */
const TYPESCRIPT_LIB_DIR = dirname(ts.getDefaultLibFilePath(COMPILER_OPTIONS));

/** TypeScript 的 lib 目录归一化一次，后面按前缀比对；Windows 上大小写不敏感，统一转小写。 */
const LIB_DIR_PREFIX = `${resolve(TYPESCRIPT_LIB_DIR)}${sep}`.toLowerCase();

/** 该路径是否是 TypeScript 自带 lib 目录下的 `lib.*.d.ts`（唯一的真实文件读取白名单）。 */
function isAllowedLibFile(fileName: string): boolean {
  let normalized: string;
  try {
    normalized = resolve(fileName);
  } catch {
    return false;
  }
  if (!normalized.toLowerCase().startsWith(LIB_DIR_PREFIX)) return false;
  const base = basename(normalized);
  return base.startsWith('lib.') && base.endsWith('.d.ts');
}

/** 宿主缺陷（生成的声明有错）时抛这个；worker 会把它转成 invalid-declaration 响应。 */
function invalidDeclaration(sourceFile: ts.SourceFile, diagnostic: ts.Diagnostic): SandboxError {
  const where = sourceFile.fileName === WORLD_FILE ? 'world.d.ts' : 'globals.d.ts';
  return new SandboxError(
    'invalid-declaration',
    `${where} 无法通过类型检查（TS${String(diagnostic.code)}）：${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
  );
}

/** 只保留虚拟声明文件的诊断，忽略 lib 的噪音（skipLibCheck 关闭时 lib 也可能报错）。 */
function declarationDiagnostics(program: ts.Program): ts.Diagnostic[] {
  const files = [WORLD_FILE, GLOBALS_FILE]
    .map((name) => program.getSourceFile(name))
    .filter((f): f is ts.SourceFile => f !== undefined);
  const out = [...program.getGlobalDiagnostics()];
  for (const file of files) {
    out.push(...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file));
  }
  return out;
}

export interface PrecheckRuntime {
  readonly check: (code: string) => PrecheckResult;
}

/** 可选替换：建模预检用 `Model` 全局桥接与建模入口文案；缺省时行为与 world 预检逐字相同。 */
export interface RuntimeOptions {
  /** 全局声明 shim 文本；缺省用 world 的 GLOBALS_TEXT。 */
  readonly globalsText?: string;
  /** 入口规则文案；缺省用 DEFAULT_ENTRY（World）。 */
  readonly entry?: EntryText;
  /**
   * 类型级入口核对：给出全局类型名（建模为 `Model`）时，用真实 checker 核对入口函数能接收该类型
   * 且返回 void。world 预检不传，行为不变。规则层的名字 / 参数个数检查挡不住 `build(model: number)`
   * 或 `build(model: Model): Promise<void>`，而 TS 的 void 可赋值性会吞掉非 void 返回，必须单独查。
   */
  readonly expectedEntryType?: string;
}

/** 入口必须是 `export default function build(...)`（默认函数声明）。 */
function isDefaultBuild(statement: ts.Statement): statement is ts.FunctionDeclaration {
  if (!ts.isFunctionDeclaration(statement)) return false;
  return ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

/**
 * 用 checker 核对入口签名：第一个参数能接收 `expectedTypeName`（Model→param compatible），返回类型
 * 必须是 void。名字 / 参数个数由 rules.ts 负责；这里只补类型级（PG006 / PG007）。
 */
function entrySignatureDiagnostics(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  expectedTypeName: string,
): Diagnostic[] {
  const entry = sourceFile.statements.find(isDefaultBuild);
  if (entry === undefined) return []; // 缺入口由 rules.ts 报，不重复。
  const checker = program.getTypeChecker();
  const out: Diagnostic[] = [];
  const param = entry.parameters[0];
  if (param !== undefined) {
    const symbol = checker.resolveName(expectedTypeName, sourceFile, ts.SymbolFlags.Type, false);
    const expected = symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
    if (expected !== undefined) {
      const paramType = checker.getTypeAtLocation(param);
      if (!checker.isTypeAssignableTo(expected, paramType)) {
        out.push(
          makeDiagnostic(
            sourceFile,
            param.getStart(sourceFile),
            'PG006',
            `入口参数必须能接收 ${expectedTypeName}（如 ${expectedTypeName} 本身），实际是 ${checker.typeToString(paramType)}。`,
          ),
        );
      }
    }
  }
  const signature = checker.getSignatureFromDeclaration(entry);
  if (signature !== undefined) {
    const returnType = checker.getReturnTypeOfSignature(signature);
    if (checker.typeToString(returnType) !== 'void') {
      const typeNode = entry.type;
      out.push(
        makeDiagnostic(
          sourceFile,
          typeNode?.getStart(sourceFile) ?? entry.getStart(sourceFile),
          'PG007',
          `入口必须同步返回 void，实际返回 ${checker.typeToString(returnType)}（不能返回 Promise 或其它值）。`,
        ),
      );
    }
  }
  return out;
}

/** 建一个可复用的编译运行时；声明只解析并校验一次。 */
export function createPrecheckRuntime(declaration: string, options: RuntimeOptions = {}): PrecheckRuntime {
  const globalsText = options.globalsText ?? GLOBALS_TEXT;
  const entry = options.entry ?? DEFAULT_ENTRY;
  const expectedEntryType = options.expectedEntryType;
  const worldSource = ts.createSourceFile(WORLD_FILE, declaration, ts.ScriptTarget.Latest, true);
  const globalsSource = ts.createSourceFile(GLOBALS_FILE, globalsText, ts.ScriptTarget.Latest, true);
  const baseHost = ts.createCompilerHost(COMPILER_OPTIONS);
  const originalGetSourceFile = baseHost.getSourceFile.bind(baseHost);
  const libCache = new Map<string, ts.SourceFile>();
  let buildingText = 'export default function build(w: World): void {}';
  let buildingSource = ts.createSourceFile(BUILDING_FILE, buildingText, ts.ScriptTarget.Latest, true);

  baseHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName === WORLD_FILE) return worldSource;
    if (fileName === GLOBALS_FILE) return globalsSource;
    if (fileName === BUILDING_FILE) return buildingSource;
    // 离开白名单就不存在：不能让 getSourceFile 落到真实文件系统上。
    if (!isAllowedLibFile(fileName)) return undefined;
    const cached = libCache.get(fileName);
    if (cached !== undefined && shouldCreateNewSourceFile !== true) return cached;
    const source = originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    // 宿主单测里会按声明变体建多个运行时，缓存 lib 能显著降低重复解析成本。
    if (source !== undefined && shouldCreateNewSourceFile !== true) libCache.set(fileName, source);
    return source;
  };
  const originalFileExists = baseHost.fileExists.bind(baseHost);
  const originalReadFile = baseHost.readFile.bind(baseHost);
  baseHost.fileExists = (fileName) =>
    fileName === WORLD_FILE ||
    fileName === GLOBALS_FILE ||
    fileName === BUILDING_FILE ||
    (isAllowedLibFile(fileName) && originalFileExists(fileName));
  baseHost.readFile = (fileName) => {
    if (fileName === WORLD_FILE) return declaration;
    if (fileName === GLOBALS_FILE) return globalsText;
    if (fileName === BUILDING_FILE) return buildingText;
    return isAllowedLibFile(fileName) ? originalReadFile(fileName) : undefined;
  };
  // 模块解析也走宿主：不锁死的话 `import` 会解析到真实目录树（含 node_modules 与仓库源码）。
  // 虚拟文件都在根目录下，因此 `dirname(WORLD_FILE)` 必须表现为存在，否则 globals 的
  // `import './world.js'` 连解析都走不下去（TypeScript 要求所在目录真实存在）。
  const virtualRoot = resolve(dirname(WORLD_FILE));
  const originalDirectoryExists = baseHost.directoryExists?.bind(baseHost);
  if (originalDirectoryExists !== undefined) {
    baseHost.directoryExists = (directoryName) => {
      const normalized = resolve(directoryName).toLowerCase();
      if (normalized === virtualRoot.toLowerCase()) return true;
      if (normalized.startsWith(LIB_DIR_PREFIX)) return originalDirectoryExists(directoryName);
      return false;
    };
  }
  const originalGetDirectories = baseHost.getDirectories?.bind(baseHost);
  if (originalGetDirectories !== undefined) {
    baseHost.getDirectories = (directoryName) => {
      const normalized = resolve(directoryName).toLowerCase();
      // 根目录只暴露虚拟文件，不列举宿主的真实子目录（否则等于泄漏目录结构）。
      if (normalized === virtualRoot.toLowerCase()) return [];
      return normalized.startsWith(LIB_DIR_PREFIX) ? originalGetDirectories(directoryName) : [];
    };
  }
  const originalRealpath = baseHost.realpath?.bind(baseHost);
  if (originalRealpath !== undefined) {
    baseHost.realpath = (fileName) => (isAllowedLibFile(fileName) ? originalRealpath(fileName) : fileName);
  }
  // noEmit 下不该有写入；真被调用时一律拒绝，避免任何路径变成写通道。
  baseHost.writeFile = () => undefined;

  // 声明校验只做一次：skipLibCheck 会压掉声明里的语义错误（包括解析不到 world），必须单独查。
  const validation = ts.createProgram(
    [WORLD_FILE, GLOBALS_FILE],
    { ...COMPILER_OPTIONS, skipLibCheck: false },
    baseHost,
  );
  const bad = declarationDiagnostics(validation)[0];
  if (bad !== undefined) {
    const file = bad.file ?? validation.getSourceFile(WORLD_FILE) ?? worldSource;
    throw invalidDeclaration(file, bad);
  }

  let oldProgram: ts.Program | undefined;

  const check = (code: string): PrecheckResult => {
    buildingText = code;
    try {
      buildingSource = ts.createSourceFile(BUILDING_FILE, code, ts.ScriptTarget.Latest, true);
      const program =
        oldProgram === undefined
          ? ts.createProgram({
              rootNames: [WORLD_FILE, GLOBALS_FILE, BUILDING_FILE],
              options: COMPILER_OPTIONS,
              host: baseHost,
            })
          : ts.createProgram({
              rootNames: [WORLD_FILE, GLOBALS_FILE, BUILDING_FILE],
              options: COMPILER_OPTIONS,
              host: baseHost,
              oldProgram,
            });
      oldProgram = program;
      const tsDiagnostics = [
        ...program.getSyntacticDiagnostics(buildingSource),
        ...program.getSemanticDiagnostics(buildingSource),
      ].map((diagnostic) => fromTsDiagnostic(buildingSource, diagnostic));
      const entryDiagnostics =
        expectedEntryType === undefined ? [] : entrySignatureDiagnostics(program, buildingSource, expectedEntryType);
      const { diagnostics, total } = normalizeDiagnostics([
        ...tsDiagnostics,
        ...entryDiagnostics,
        ...collectRuleDiagnostics(buildingSource, entry),
      ]);
      return total === 0 ? { kind: 'ok' } : { kind: 'failed', diagnostics, total };
    } catch (error) {
      if (error instanceof RangeError) return pg000Result(code, error);
      throw error;
    }
  };

  return { check };
}
