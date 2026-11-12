/**
 * 三维草模查看器的命令行入口（MASSING-SPEC §4）。
 *
 * 负责：解析 `--port`（默认 4173，0 由系统分配）、启动 `startMassingServer`、打印 URL 与
 * Ctrl-C 提示、收到 SIGINT / SIGTERM 时优雅关闭再退出。
 * 不负责：路由与静态资源（server.ts）、页面代码（page/*.ts）。
 *
 * 参数解析与运行流程用依赖注入拆开，便于单测不启动服务；直接执行时的信号注册是唯一 I/O 组装。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { ModelDocument } from '@pg/modeling/schema';
import type { ModelDocument as ModelDocumentType } from '@pg/modeling/schema';

import type { RunningServer } from './server.ts';
import { DEFAULT_PORT, startMassingServer } from './server.ts';

/** 信号的来源；`process` 满足此接口，单测用假件替换。 */
export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export type CliParseResult =
  | { readonly kind: 'run'; readonly port: number; readonly modelPath?: string }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string };

/** 运行 CLI 所需的全部 I/O；产品路径由 `createDefaultIo` 组装。 */
export interface CliIo {
  readonly argv: readonly string[];
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly startServer: (options: {
    readonly port: number;
    readonly model?: ModelDocumentType;
  }) => Promise<RunningServer>;
  readonly waitForShutdown: () => Promise<NodeJS.Signals>;
  /** 读取模型 JSON 文本；产品路径为 readFileSync，单测注入而不碰磁盘。 */
  readonly readText: (path: string) => string;
}

const HELP_LINES: readonly string[] = [
  '三维草模查看器',
  '',
  '用法：',
  '  node packages/web/src/cli.ts [--port <0–65535 的整数>] [--model <模型 JSON 路径>]',
  '',
  '选项：',
  `  --port <整数>   监听端口，默认 ${String(DEFAULT_PORT)}；传 0 由系统分配`,
  '  --model <路径>  读取并用 ModelDocument schema 校验模型 JSON，启动函数草模查看器',
  '  --help, -h      显示本帮助并退出',
];

/** 只接受 0–65535 的十进制整数；不接受前导 `+`、小数、空串。 */
function parsePort(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) return undefined;
  return value;
}

/** 解析参数；未知参数与非法取值都返回可读错误，不静默忽略。 */
export function parseCliArgs(argv: readonly string[]): CliParseResult {
  let port = DEFAULT_PORT;
  let modelPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--port') {
      const raw = argv[index + 1];
      if (raw === undefined) return { kind: 'error', message: '--port 缺少取值（0–65535 的整数）' };
      const parsed = parsePort(raw);
      if (parsed === undefined) return { kind: 'error', message: `--port 取值非法：${raw}；需要 0–65535 的整数` };
      port = parsed;
      index += 1;
      continue;
    }
    if (arg === '--model') {
      const raw = argv[index + 1];
      if (raw === undefined || raw === '') return { kind: 'error', message: '--model 缺少取值（模型 JSON 路径）' };
      if (modelPath !== undefined) return { kind: 'error', message: '--model 只能出现一次' };
      modelPath = raw;
      index += 1;
      continue;
    }
    return { kind: 'error', message: `未知参数：${arg}；用法见 --help` };
  }
  return modelPath === undefined ? { kind: 'run', port } : { kind: 'run', port, modelPath };
}

/** 注册 SIGINT / SIGTERM，返回第一个到达的信号；触发后移除两个监听器。 */
export function createSignalWaiter(signals: SignalSource): Promise<NodeJS.Signals> {
  return new Promise<NodeJS.Signals>((resolve) => {
    function finish(signal: NodeJS.Signals): void {
      signals.off('SIGINT', onSigint);
      signals.off('SIGTERM', onSigterm);
      resolve(signal);
    }
    function onSigint(): void {
      finish('SIGINT');
    }
    function onSigterm(): void {
      finish('SIGTERM');
    }
    signals.on('SIGINT', onSigint);
    signals.on('SIGTERM', onSigterm);
  });
}

/** 执行一次 CLI；返回进程退出码（0 正常、2 参数或模型文件错误）。 */
export async function runCli(io: CliIo): Promise<number> {
  const parsed = parseCliArgs(io.argv);
  if (parsed.kind === 'help') {
    for (const line of HELP_LINES) io.stdout(line);
    return 0;
  }
  if (parsed.kind === 'error') {
    io.stderr(parsed.message);
    io.stderr('用法：node packages/web/src/cli.ts [--port <0–65535 的整数>] [--model <模型 JSON 路径>]');
    return 2;
  }
  let model: ModelDocumentType | undefined;
  if (parsed.modelPath !== undefined) {
    const loaded = loadModel(io, parsed.modelPath);
    if (!loaded.ok) {
      // 模型文件无效一律响亮退出，不静默回退到预制查看器。
      io.stderr(loaded.message);
      return 2;
    }
    model = loaded.model;
  }
  const server = await io.startServer(model === undefined ? { port: parsed.port } : { port: parsed.port, model });
  io.stdout(`三维草模查看器已启动：${server.url}`);
  io.stdout(model === undefined ? '按 Ctrl-C 停止服务。' : '函数草模模式：按 Ctrl-C 停止服务。');
  await io.waitForShutdown();
  await server.close();
  io.stdout('服务已停止。');
  return 0;
}

type LoadedModel =
  { readonly ok: true; readonly model: ModelDocumentType } | { readonly ok: false; readonly message: string };

/** 读取并校验模型文件：读 / JSON / zod 三层失败都返回可读消息，由调用方响亮退出。 */
function loadModel(io: CliIo, path: string): LoadedModel {
  let text: string;
  try {
    text = io.readText(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `读取模型文件失败（${path}）：${message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `模型文件 ${path} 不是合法 JSON：${message}` };
  }
  const parsed = ModelDocument.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；');
    return { ok: false, message: `模型文件 ${path} 不符合 ModelDocument schema：${issues}` };
  }
  return { ok: true, model: parsed.data };
}

/** 产品 I/O：真实进程参数、stdout/stderr、真实服务与信号。 */
export function createDefaultIo(): CliIo {
  return {
    argv: process.argv.slice(2),
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    startServer: (options) => startMassingServer(options),
    waitForShutdown: () => createSignalWaiter(process),
    readText: (path) => readFileSync(path, 'utf8'),
  };
}

/** 直接 `node cli.ts` 执行（而非被 import）时启动；否则什么都不做。 */
function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isDirectExecution()) {
  void runCli(createDefaultIo())
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`启动失败：${message}\n`);
      process.exitCode = 1;
    });
}
