/**
 * child 的执行主体（SANDBOX-SPEC §5.1、§7.3）：解析 stdin 输入、擦除类型、注册加载钩子、
 * 准备并冻结全局、执行 `build`、同步合成与编码帧。
 *
 * 负责：执行期间的全部逻辑；`write` / `exit` 由 child.ts 注入，本文件不直接读 stdin / 写 stdout。
 * 不负责：接线（child.ts）、全局准备细节（child-globals.ts）、行号正则（child-callsite.ts）。
 *
 * 关键时序（§5.3）：`build` 同步返回后必须同步合成、同步写出整帧，不能让出事件循环，
 * 否则模型排的微任务会在合成之后继续改 world。因此合成到 write 之间没有任何 `await`。
 */
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

import { writeArchive } from '@pg/core/archive';
import { createBlockTable } from '@pg/core/block-state';
import type { BlockTable } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import { hashGrid } from '@pg/core/hash';
import { createWorld, rect } from '@pg/geometry';

import { createCallSite, lineFromStack } from './child-callsite.ts';
import { prepareGlobals } from './child-globals.ts';
import type { ConsoleCapture } from './child-globals.ts';
import { sanitizeText } from './escape.ts';
import { encodeFrame } from './frame.ts';
import { childInputSchema, DEFAULT_REPORT_BYTES, REPORT_FORMAT_VERSION } from './protocol.ts';
import { limitReport } from './report-limit.ts';
import type { ChildInput, ChildReport } from './protocol.ts';

/** 模型模块的解析名；预检拒绝 import，运行期由加载钩子兜底（§2.3、§7.3）。 */
const ENTRY_SPECIFIER = 'pg:building';
const BLOCK_STATES_PATH = new URL('../../../assets/mc-1.20.1/block-states.json', import.meta.url);
/** child 自己的仓库根（末尾带 `/`），用于脱敏报告文本里泄露的宿主路径（§5.3，F4）。 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MAX_ERROR_MESSAGE = 2000;
/** error.name 截断长度（F3）：堆里可能是模型造的超长字符串。 */
const MAX_ERROR_NAME = 100;

// TextDecoder 是全局，child 准备全局时会按白名单删除；在模块加载时（删除之前）建好实例（F1）。
const DECODER = new TextDecoder();

export interface ChildIo {
  readonly write: (bytes: Uint8Array) => void;
  readonly exit: (code: number) => void;
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text;
}

/** 读一个可能抛异常的字段（getter、Proxy 都被包住）；失败或非字符串时由调用方兜底（F2）。 */
function readField(error: unknown, key: string): unknown {
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** `String(x)` 对 `Object.create(null)` 之类会抛；包一层，失败返回 undefined（F2）。 */
function safeString(value: unknown): string | undefined {
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

/** 输入不合 schema / JSON 是宿主缺陷；抛专用前缀让宿主映射成 protocol-error（§5.2）。 */
function parseInput(raw: Uint8Array): ChildInput {
  let json: unknown;
  try {
    json = JSON.parse(DECODER.decode(raw)) as unknown;
  } catch {
    throw new Error('PG_PROTOCOL_ERROR: child 输入不是合法 JSON');
  }
  const parsed = childInputSchema.safeParse(json);
  if (!parsed.success) throw new Error('PG_PROTOCOL_ERROR: child 输入不合 schema');
  // §5.2：注入了文档却没有颜色候选表，默认材质映射无从解析，是宿主缺陷而不是模型错误。
  const assets = parsed.data.assets;
  if (assets !== undefined && assets.documents.length > 0 && assets.colorCandidates.length === 0) {
    throw new Error('PG_PROTOCOL_ERROR: assets.documents 非空但 colorCandidates 为空（宿主缺陷）');
  }
  return parsed.data;
}

function buildTable(): BlockTable {
  const text = readFileSync(BLOCK_STATES_PATH, 'utf8');
  const data: unknown = JSON.parse(text) as unknown;
  return createBlockTable(data);
}

/**
 * 把模型代码抛出的任意值编成 build-error 报告（F2）。不依赖 `instanceof`：模型可以 throw
 * `Object.create(null)`、Proxy、带抛错 getter 的对象；每个字段单独 try，取不到就用兜底值。
 */
function errorReport(error: unknown, table: BlockTable, capture: ConsoleCapture | undefined): ChildReport {
  const rawStack = readField(error, 'stack');
  const location = lineFromStack(typeof rawStack === 'string' ? rawStack : undefined);
  const rawName = readField(error, 'name');
  const name = typeof rawName === 'string' ? rawName.slice(0, MAX_ERROR_NAME) : 'Error';
  const rawMessage = readField(error, 'message');
  const fallback = safeString(error) ?? '(无法读取 message)';
  const message = truncate(typeof rawMessage === 'string' ? rawMessage : fallback);
  return {
    reportFormat: REPORT_FORMAT_VERSION,
    status: 'build-error',
    error: { name, message, line: location.line, column: location.column },
    hash: hashGrid(createGrid(table)),
    calls: 0,
    overlaps: [],
    console: capture === undefined ? [] : [...capture.entries],
    consoleTruncated: capture?.truncated ?? 0,
  };
}

/** 写报告前对模型可见文本做控制字符转义与宿主路径脱敏（F4），单一出口。 */
function escapeReport(report: ChildReport): ChildReport {
  return {
    ...report,
    ...(report.error === undefined
      ? {}
      : {
          error: {
            ...report.error,
            name: sanitizeText(report.error.name, REPO_ROOT),
            message: sanitizeText(report.error.message, REPO_ROOT),
          },
        }),
    console: report.console.map((entry) => ({ ...entry, text: sanitizeText(entry.text, REPO_ROOT) })),
  };
}

/** 执行一份输入；调用方保证全局尚未被改动（每次执行一个新进程）。 */
export async function runChild(raw: Uint8Array, io: ChildIo): Promise<void> {
  const input = parseInput(raw);
  const table = buildTable();
  let report: ChildReport;
  let archive: Uint8Array;
  let capture: ConsoleCapture | undefined;
  try {
    // 类型擦除必须在删除 WebAssembly 之前完成（C1 / §2.2）；擦除结果行列不变。
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
    // 真实 globalThis 具备索引签名以外的具体属性，这里按可变全局对象处理是安全的：本文件是唯一改动点。
    const cap = prepareGlobals(globalThis, {
      seed: input.seed,
      consoleBytes: input.limits.consoleBytes,
      extras: { rect },
    });
    capture = cap;
    // §5.2：宿主注入的草模文档与颜色候选在这里进世界；createWorld 与 voxelize 各自二次校验。
    const host = createWorld(table, {
      callSite: createCallSite(),
      ...(input.assets === undefined ? {} : { massing: input.assets }),
    });
    const imported: unknown = await import(ENTRY_SPECIFIER);
    const namespace = imported as { readonly default?: unknown };
    const build = namespace.default;
    if (typeof build !== 'function') throw new Error('模型模块必须 export default function build');
    const buildFn = build as unknown as (world: unknown) => unknown;
    buildFn(host.world);
    // build 同步返回后不得 await：立即同步合成、编码、写出（§5.3）。
    const composition = host.compose();
    archive = writeArchive(composition.grid, input.apiVersion);
    report = {
      reportFormat: REPORT_FORMAT_VERSION,
      status: 'ok',
      hash: hashGrid(composition.grid),
      calls: composition.grid.calls().length,
      overlaps: [...composition.overlaps],
      overlapSummary: composition.overlapSummary,
      console: [...cap.entries],
      consoleTruncated: cap.truncated,
    };
  } catch (error) {
    // 从类型擦除开始的一切异常都编成 build-error 帧，绝不让模型代码把宿主逼成 protocol-error（F2）。
    archive = new Uint8Array(0);
    report = errorReport(error, table, capture);
  }
  // 先脱敏再截断：截断按最终编码口径算字节（escapeReport 可能让文本变长）。超限只截 overlaps，
  // 截断后仍超（如 console 过大）则原样交给宿主归 crashed（§5.3）。
  io.write(encodeFrame(limitReport(escapeReport(report), DEFAULT_REPORT_BYTES), archive));
  io.exit(0);
}
