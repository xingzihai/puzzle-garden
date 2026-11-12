/**
 * `design:web` 入口：解析 --mock / --live / --port / --session-root，装配 client 并启动本地网页 demo。
 *
 * 负责：参数与退出码、live 的双重确认（PG_LIVE_CONFIRM=1）、真实 client 装配、打印 URL、SIGINT 关闭。
 * 不负责：HTTP 路由 / 会话状态（interaction-server-core.ts）、mock 样例（interaction-server-mock.ts）。
 *
 * 退出码：成功启动并正常停止 0；参数 / 配置 / 未确认 live 2；启动服务失败 1。
 */
import { fileURLToPath } from 'node:url';

import { ConfigError, loadConfigFromProcess } from '@pg/config';
import type { Config } from '@pg/config';
import type { ChatClient } from '@pg/llm/client';
import { createClient } from '@pg/llm/client';

import { MAX_RUN_CNY } from './agent-massing-args.ts';
import { createMockClient } from './interaction-server-mock.ts';
import { startInteractionServer } from './interaction-server-core.ts';
import type { InteractionServerOptions, RunningInteractionServer } from './interaction-server-core.ts';
import { withLiveBudget } from './live-budget.ts';

export interface InteractionServerCliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface InteractionServerCliDeps {
  readonly io?: InteractionServerCliIo;
  readonly loadConfig?: () => Config;
  /** 只有 live 且确认 / 模型校验通过后才会调用。 */
  readonly createLiveClient?: (config: Config) => ChatClient;
  /** 每个会话调用一次；缺省使用离线 demo requirements / scheme。 */
  readonly createMockClient?: () => ChatClient;
  /** 测试注入；缺省 startInteractionServer。 */
  readonly startServer?: (options: InteractionServerOptions) => Promise<RunningInteractionServer>;
  /** 测试注入；缺省等待 SIGINT / SIGTERM。 */
  readonly waitForStop?: (running: RunningInteractionServer) => Promise<void>;
}

export type InteractionServerMode = 'mock' | 'live';

export interface InteractionServerCliOptions {
  readonly mode: InteractionServerMode;
  readonly port: number;
  readonly sessionRoot: string;
  readonly open: boolean;
  readonly designMode: 'intent' | 'legacy';
}

export class InteractionServerArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InteractionServerArgError';
  }
}

export const DEFAULT_WEB_PORT = 4174;
export const DEFAULT_WEB_SESSION_ROOT = '.work/sessions/web';

export const INTERACTION_SERVER_USAGE = `用法：node tools/interaction-server.ts [--mock | --live] [选项]
  默认实测：不加模式时等同 --live；需要 PG_LIVE_CONFIRM=1 且 @pg/config 有效
  离线 mock：--mock              使用 exampleRequirements / exampleScheme 的假 client，不读 env、不联网
  真实模型：--live                需要 PG_LIVE_CONFIRM=1 且 @pg/config 有效
  --port <n>                      监听端口（只绑定 127.0.0.1，默认 ${String(DEFAULT_WEB_PORT)}；0 表示系统分配）
  --session-root <dir>            会话根目录（默认 ${DEFAULT_WEB_SESSION_ROOT}）
  --legacy-scheme                 回退到旧 DesignScheme 生成路径，仅用于回归
  --open                          仅打印 URL，不自动打开浏览器
  --help, -h                      打印本说明

  页面：输入需求 → agent 提问 → 回答 → 方案摘要 + SVG 预览 → 确认 / 修改 / 退出。
  确认后写出 artifacts；不会在网页里自动执行 design:build。
  退出码：正常停止 0；参数 / 配置 / 未确认 live 2；启动失败 1。`;

function value(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next === '' || next.startsWith('--')) {
    throw new InteractionServerArgError(`${flag} 缺少取值。\n${INTERACTION_SERVER_USAGE}`);
  }
  return next;
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new InteractionServerArgError(`--port 必须是 0–65535 的整数，实际是 ${raw}。`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InteractionServerArgError(`--port 必须是 0–65535 的整数，实际是 ${raw}。`);
  }
  return port;
}

/** 解析 argv（不含 node 与脚本路径）；缺省为 live 实测，--mock 显式切离线。 */
export function parseInteractionServerArgs(argv: readonly string[]): InteractionServerCliOptions {
  let mode: InteractionServerMode | null = null;
  let port = DEFAULT_WEB_PORT;
  let sessionRoot = DEFAULT_WEB_SESSION_ROOT;
  let open = false;
  let designMode: 'intent' | 'legacy' = 'intent';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    switch (arg) {
      case '--mock':
        if (mode !== null) throw new InteractionServerArgError('--mock / --live 只能选一个。');
        mode = 'mock';
        break;
      case '--live':
        if (mode !== null) throw new InteractionServerArgError('--mock / --live 只能选一个。');
        mode = 'live';
        break;
      case '--port':
        port = parsePort(value(argv, index, '--port'));
        index += 1;
        break;
      case '--session-root':
        sessionRoot = value(argv, index, '--session-root');
        index += 1;
        break;
      case '--legacy-scheme':
        designMode = 'legacy';
        break;
      case '--open':
        open = true;
        break;
      default:
        throw new InteractionServerArgError(`不认识的参数 ${JSON.stringify(arg)}。\n${INTERACTION_SERVER_USAGE}`);
    }
  }

  return { mode: mode ?? 'live', port, sessionRoot, open, designMode };
}

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function realClock(): number {
  return performance.now();
}

function makeLiveClient(config: Config): ChatClient {
  return createClient({
    config: config.llm,
    fetch: globalThis.fetch,
    sleep: realSleep,
    clock: realClock,
  });
}

async function waitForSignal(running: RunningInteractionServer): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      void running.close().then(
        () => {
          resolve();
        },
        () => {
          resolve();
        },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** 执行一次入口；测试只调用 live 未确认路径。 */
export async function runInteractionServerCli(
  argv: readonly string[],
  deps: InteractionServerCliDeps = {},
): Promise<number> {
  const io = deps.io ?? {
    stdout: (line: string) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(INTERACTION_SERVER_USAGE);
    return 0;
  }

  let options: InteractionServerCliOptions;
  try {
    options = parseInteractionServerArgs(argv);
  } catch (error) {
    if (error instanceof InteractionServerArgError) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }

  let clientFactory: () => ChatClient;
  let liveBuildMaxCny: number | undefined;
  if (options.mode === 'mock') {
    const factory = deps.createMockClient ?? (() => createMockClient());
    clientFactory = () => factory();
  } else {
    let config: Config;
    try {
      config = (deps.loadConfig ?? loadConfigFromProcess)();
    } catch (error) {
      io.stderr(error instanceof ConfigError ? error.message : `读取配置失败：${String(error)}`);
      return 2;
    }
    if (!config.liveConfirm) {
      io.stderr('拒绝真实模型调用：需要 PG_LIVE_CONFIRM=1 作为第二道确认。');
      return 2;
    }
    if (config.llm.model !== 'deepseek-flash') {
      io.stderr(`PG_LLM_MODEL=${config.llm.model} 不在本轮支持范围；只允许 deepseek-flash。`);
      return 2;
    }
    // 模型 run 预算只用于 withLiveBudget 和网页构建上限，不能进入设计提示词。
    // 0 表示关闭宿主护栏，构建退回单次硬上限；模型请求本身仍由 withLiveBudget 记录但不拦截。
    liveBuildMaxCny = config.maxRunCostCny > 0 ? config.maxRunCostCny : MAX_RUN_CNY;
    // 默认装配先用同一配置做一次仅构造、不联网的校验（例如 API key 为空），保持启动期退出码 2；
    // 真正的 client 仍然每个会话新建并单独包装。
    if (deps.createLiveClient === undefined) {
      try {
        makeLiveClient(config);
      } catch (error) {
        io.stderr(`创建 live client 失败：${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
    }
    let sequence = 0;
    // 每个网页会话一个 client + 一个预算包装：spent 不跨会话累计。
    clientFactory = () => {
      sequence += 1;
      const created = (deps.createLiveClient ?? makeLiveClient)(config);
      return withLiveBudget(created, {
        maxCny: config.maxRunCostCny,
        label: `web-${String(Date.now())}-${String(sequence)}`,
        auditDir: '.work/live-audit',
      });
    };
  }

  let running: RunningInteractionServer;
  try {
    running = await (deps.startServer ?? startInteractionServer)({
      mode: options.mode,
      port: options.port,
      sessionRoot: options.sessionRoot,
      clientFactory,
      designMode: options.designMode,
      ...(liveBuildMaxCny === undefined ? {} : { buildMaxCny: liveBuildMaxCny }),
    });
  } catch (error) {
    io.stderr(`启动网页服务失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  io.stdout('拼图花园 · 交互设计台');
  io.stdout(`模式：${options.mode}`);
  io.stdout(`地址：${running.url}`);
  io.stdout(`会话目录：${options.sessionRoot}`);
  io.stdout('按 Ctrl+C 停止；不会自动打开浏览器，也不会自动构建。');
  if (options.open) io.stdout('（--open 仅打印地址，不自动打开浏览器。）');
  await (deps.waitForStop ?? waitForSignal)(running);
  return 0;
}

export async function main(argv: readonly string[], deps: InteractionServerCliDeps = {}): Promise<number> {
  try {
    return await runInteractionServerCli(argv, deps);
  } catch (error) {
    const io = deps.io;
    const message = `运行失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    if (io === undefined) process.stderr.write(`${message}\n`);
    else io.stderr(message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
