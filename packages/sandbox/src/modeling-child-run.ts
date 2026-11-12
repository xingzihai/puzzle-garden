/**
 * modeling-child 的执行主体（MODELING-SPEC §4）：解析 stdin 输入、擦除类型、注册加载钩子、
 * 准备并冻结全局、执行 `build(model)`、用 `createModel()` 收集并交付 ModelDocument。
 *
 * 负责：执行期间的全部逻辑；`write` / `exit` 由 modeling-child.ts 注入，本文件不直接读 stdin / 写 stdout。
 * 不负责：接线（modeling-child.ts）、全局准备细节（child-globals.ts）、预检与宿主进程管理（modeling.ts）。
 *
 * 与体素 child-run 同边界：模型代码不能 import、不能用动态 import、拿不到 Node 全局；差别只在
 * 入口对象是 `Model`（createModel）而不是 `World`，输出是 JSON 文档而不是二进制体素帧。
 */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createModel } from '@pg/modeling/model';

import { prepareGlobals } from './child-globals.ts';
import type { ConsoleCapture } from './child-globals.ts';
import { sanitizeText } from './escape.ts';
import { hashModelDocument, modelChildInputSchema } from './modeling-protocol.ts';
import type { ModelChildError, ModelChildInput, ModelChildReport } from './modeling-protocol.ts';

/** 模型模块的解析名；预检拒绝 import，运行期由加载钩子兜底（与体素 child 同策略）。 */
const ENTRY_SPECIFIER = 'pg:modeling';
/** child 自己的仓库根（末尾带 `/`），用于脱敏报告文本里泄露的宿主路径。 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MAX_ERROR_MESSAGE = 2000;
const MAX_ERROR_NAME = 100;

// TextEncoder / TextDecoder 是全局，child 准备全局时会按白名单删除；在模块加载时（删除之前）建好实例。
const DECODER = new TextDecoder('utf-8', { fatal: true });
const ENCODER = new TextEncoder();

/** 只匹配整行末尾的 pg:modeling 帧；模型可把计算属性名伪装成该前缀，锚定整行避免取到假行号。 */
const FRAME = /^\s+at (?:.*\()?pg:modeling:(\d+):(\d+)\)?$/;

export interface ChildIo {
  readonly write: (bytes: Uint8Array) => void;
  readonly exit: (code: number) => void;
}

function lineFromStack(stack: string | undefined): { readonly line: number; readonly column: number } {
  if (stack === undefined) return { line: 0, column: 0 };
  for (const row of stack.split('\n')) {
    const match = FRAME.exec(row);
    if (match !== null) {
      const line = match[1];
      const column = match[2];
      if (line !== undefined && column !== undefined) return { line: Number(line), column: Number(column) };
    }
  }
  return { line: 0, column: 0 };
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text;
}

/** 读一个可能抛异常的字段（getter、Proxy 都被包住）。 */
function readField(error: unknown, key: string): unknown {
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeString(value: unknown): string | undefined {
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

/** 输入不合 schema / JSON 是宿主缺陷；抛专用前缀让宿主映射成 protocol-error。 */
function parseInput(raw: Uint8Array): ModelChildInput {
  let json: unknown;
  try {
    json = JSON.parse(DECODER.decode(raw)) as unknown;
  } catch {
    throw new Error('PG_PROTOCOL_ERROR: modeling-child 输入不是合法 JSON');
  }
  const parsed = modelChildInputSchema.safeParse(json);
  if (!parsed.success) throw new Error('PG_PROTOCOL_ERROR: modeling-child 输入不合 schema');
  return parsed.data;
}

/** 把模型代码抛出的任意值编成 build-error 报告；每个字段单独 try，不依赖 instanceof。 */
function errorReport(error: unknown, capture: ConsoleCapture | undefined): ModelChildReport {
  const rawStack = readField(error, 'stack');
  const location = lineFromStack(typeof rawStack === 'string' ? rawStack : undefined);
  const rawName = readField(error, 'name');
  const name = typeof rawName === 'string' ? rawName.slice(0, MAX_ERROR_NAME) : 'Error';
  const rawMessage = readField(error, 'message');
  const fallback = safeString(error) ?? '(无法读取 message)';
  const errorInfo: ModelChildError = {
    name,
    message: truncate(typeof rawMessage === 'string' ? rawMessage : fallback),
    line: location.line,
    column: location.column,
  };
  return {
    status: 'build-error',
    error: errorInfo,
    console: capture === undefined ? [] : [...capture.entries],
    consoleTruncated: capture?.truncated ?? 0,
  };
}

/** 写报告前对模型可见文本做控制字符转义与宿主路径脱敏，单一出口。 */
function escapeReport(report: ModelChildReport): ModelChildReport {
  const console = report.console.map((entry) => ({ ...entry, text: sanitizeText(entry.text, REPO_ROOT) }));
  if (report.status !== 'build-error') return { ...report, console };
  return {
    ...report,
    console,
    error: {
      ...report.error,
      name: sanitizeText(report.error.name, REPO_ROOT),
      message: sanitizeText(report.error.message, REPO_ROOT),
    },
  };
}

/** 执行一份输入；调用方保证全局尚未被改动（每次执行一个新进程）。 */
export async function runModelChild(raw: Uint8Array, io: ChildIo): Promise<void> {
  const input = parseInput(raw);
  let report: ModelChildReport;
  let capture: ConsoleCapture | undefined;
  try {
    // 类型擦除必须在删除 WebAssembly 之前完成；擦除结果行列不变。
    const erased = stripTypeScriptTypes(input.code);
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === ENTRY_SPECIFIER) return { url: ENTRY_SPECIFIER, format: 'module', shortCircuit: true };
        if (context.parentURL === ENTRY_SPECIFIER) throw new Error('PG_IMPORT_DENIED: 模型代码不能引入模块。');
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url === ENTRY_SPECIFIER) return { format: 'module', source: erased, shortCircuit: true };
        return nextLoad(url, context);
      },
    });
    const cap = prepareGlobals(globalThis, { seed: input.seed, consoleBytes: input.limits.consoleBytes });
    capture = cap;
    const imported: unknown = await import(ENTRY_SPECIFIER);
    const namespace = imported as { readonly default?: unknown };
    const build = namespace.default;
    if (typeof build !== 'function') throw new Error('模型模块必须 export default function build(model: Model)');
    const buildFn = build as unknown as (model: unknown) => unknown;
    const model = createModel();
    const returned: unknown = buildFn(model);
    // 入口必须同步返回 void；返回 Promise / thenable 或其它值会让模型在 finish 之后继续改模型，
    // 预检的 PG007 已挡一层，这里对绕过预检的代码兜底（响亮的 build-error）。
    if (returned !== undefined) {
      throw new Error('build 必须同步返回 void：不能返回 Promise（thenable）或其它值。');
    }
    // build 同步返回后立即 finish；宿主收文档，不要求作者调用 finish（MODELING-SPEC §3）。
    const document = model.finish();
    report = {
      status: 'ok',
      document,
      documentHash: hashModelDocument(document),
      console: [...cap.entries],
      consoleTruncated: cap.truncated,
    };
  } catch (error) {
    // 从类型擦除开始的一切异常都编成 build-error，绝不让模型代码把宿主逼成 protocol-error。
    report = errorReport(error, capture);
  }
  io.write(ENCODER.encode(JSON.stringify(escapeReport(report))));
  io.exit(0);
}
