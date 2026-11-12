/**
 * `design:example` / `design:mock` / `design:live`：交互 agent 的可运行入口。
 *
 * 负责：参数解析、示例 / mock / live 三种装配、需求与方案生成、报告 / 简报编译、lint、artifacts 落盘与摘要打印。
 * 不负责：提示词 / 结构化解析（@pg/interaction/prompts|generate）、会话文件格式（@pg/interaction/store）、
 * 真实模型循环（本轮只接线，不运行）。`--example` 与 `--mock` 完全离线，不读环境、不碰 fetch。
 *
 * 退出码：成功交付 0；lint / 生成失败 1；参数、配置、确认、读文件错误 2。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertTaskPath } from '@pg/agent/task-body';
import { ConfigError, loadConfigFromProcess } from '@pg/config';
import type { Config } from '@pg/config';
import { compileBuildBrief, lintBrief } from '@pg/interaction/brief';
import { ConversationError } from '@pg/interaction/conversation';
import type { ConversationIO } from '@pg/interaction/conversation';
import { exampleRequirements, exampleScheme } from '@pg/interaction/example';
import { extractRequirements, GenerationError, proposeScheme } from '@pg/interaction/generate';
import { createIntentHost, proposeIntent } from '@pg/interaction/generate-intent';
import { compileDesignReport } from '@pg/interaction/report';
import { SessionTransitionError } from '@pg/interaction/session';
import {
  assertSessionId,
  DEFAULT_SESSION_ROOT,
  SessionStoreError,
  sessionDir,
  writeArtifacts,
} from '@pg/interaction/store';
import type { ArtifactPaths } from '@pg/interaction/store';
import type { DesignIntent } from '@pg/interaction/design-intent';
import type { DesignScheme, RequirementGraph } from '@pg/interaction/schema';
import type { ChatClient } from '@pg/llm/client';
import { createClient } from '@pg/llm/client';

import { ConversationCliError, parsePreloadedAnswers, runConversationMode } from './design-agent-conversation.ts';
import type { PreloadedAnswer } from './design-agent-conversation.ts';
import { createMockClient } from './design-agent-mock.ts';
import type { MockScript } from './design-agent-mock.ts';
import { withLiveBudget } from './live-budget.ts';

export interface DesignAgentIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface DesignAgentDeps {
  readonly io?: DesignAgentIo;
  /** 测试注入；缺省调用 @pg/config 的 loadConfigFromProcess。 */
  readonly loadConfig?: () => Config;
  /** 测试注入；只有 live 确认后才调用。 */
  readonly createLiveClient?: (config: Config) => ChatClient;
  /** 测试注入；给出时对话完全走 fake IO，不读 stdin。 */
  readonly conversationIO?: ConversationIO;
}

export type DesignAgentMode = 'example' | 'mock' | 'live';

export interface DesignAgentOptions {
  readonly mode: DesignAgentMode;
  readonly sessionId: string;
  readonly outDir: string;
  readonly mockPath: string | undefined;
  readonly taskPath: string | undefined;
  readonly answers: readonly PreloadedAnswer[] | undefined;
  readonly feedback: string | undefined;
  readonly resume: boolean;
  readonly legacyScheme: boolean;
}

export class DesignAgentArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignAgentArgError';
  }
}

export const DESIGN_AGENT_USAGE = `用法：node tools/design-agent.ts <模式> [选项]
  离线示例：--example                         用 exampleRequirements / exampleScheme 生成，不调用模型
  离线 mock：--mock <script.json>              从剧本读取假的 requirements / scheme 工具结果，走真实校验与写文件
  真实模型：--live --task <brief.md>           需 PG_LIVE_CONFIRM=1 且 @pg/config 有效；多轮提问 / 确认 / 修订

  模式三选一。
  --session <id>   会话 id，只允许 [a-z0-9][a-z0-9_-]{0,63}（默认 ses-example-tea / ses-mock-tea / ses-live-tea）
  --out <dir>      会话根目录（默认 ${DEFAULT_SESSION_ROOT}）
  --answers <json> 预置回答，用于测试 / 非交互：字符串数组按提问顺序；
                   或 [{"questionId":"...","answer":"..."}]，确认可用保留 id "confirm"，lint 反馈用 "feedback"
  --feedback <t>   预置一次修改反馈；首次确认提示时自动作为修改意见
  --legacy-scheme  回退到旧 DesignScheme 生成路径，仅用于回归 / 回放
  --resume         恢复 --session 下已有的 session.json，至少继续确认 / 修改
  --help, -h       打印本说明

mock 剧本格式：{ "task"?: "用户原话", "requirements": RequirementGraph, "intent"?: DesignIntent, "scheme"?: DesignScheme }
默认走 intent；--legacy-scheme 时使用剧本里的 scheme。
mock 带 --answers / --feedback / --resume 时也走对话、检查与 session 落盘；否则保持一次性离线路径。
退出码：交付 0；未确认 / lint / 生成失败 1；参数 / 配置 / 确认 / 读文件错误 2。`;

function value(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next === '' || next.startsWith('--')) {
    throw new DesignAgentArgError(`${flag} 缺少取值。\n${DESIGN_AGENT_USAGE}`);
  }
  return next;
}

function defaultSessionId(mode: DesignAgentMode): string {
  switch (mode) {
    case 'example':
      return 'ses-example-tea';
    case 'mock':
      return 'ses-mock-tea';
    case 'live':
      return 'ses-live-tea';
  }
}

/** 解析 argv（不含 node 与脚本路径）。模式三选一，session id 在这里做路径安全校验。 */
export function parseDesignAgentArgs(argv: readonly string[]): DesignAgentOptions {
  let mode: DesignAgentMode | null = null;
  let session: string | null = null;
  let outDir = DEFAULT_SESSION_ROOT;
  let mockPath: string | undefined;
  let taskPath: string | undefined;
  let answers: readonly PreloadedAnswer[] | undefined;
  let feedback: string | undefined;
  let resume = false;
  let legacyScheme = false;
  let sessionProvided = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    switch (arg) {
      case '--example':
        if (mode !== null) throw new DesignAgentArgError('--example / --mock / --live 只能选一个。');
        mode = 'example';
        break;
      case '--mock':
        if (mode !== null) throw new DesignAgentArgError('--example / --mock / --live 只能选一个。');
        mode = 'mock';
        mockPath = value(argv, index, '--mock');
        index += 1;
        break;
      case '--live':
        if (mode !== null) throw new DesignAgentArgError('--example / --mock / --live 只能选一个。');
        mode = 'live';
        break;
      case '--task':
        taskPath = value(argv, index, '--task');
        index += 1;
        break;
      case '--session':
        session = value(argv, index, '--session');
        sessionProvided = true;
        index += 1;
        break;
      case '--out':
        outDir = value(argv, index, '--out');
        index += 1;
        break;
      case '--answers':
        try {
          answers = parsePreloadedAnswers(value(argv, index, '--answers'));
        } catch (error) {
          if (error instanceof ConversationCliError) throw new DesignAgentArgError(error.message);
          throw error;
        }
        index += 1;
        break;
      case '--feedback':
        feedback = value(argv, index, '--feedback');
        index += 1;
        break;
      case '--legacy-scheme':
        legacyScheme = true;
        break;
      case '--resume':
        resume = true;
        break;
      default:
        throw new DesignAgentArgError(`不认识的参数 ${JSON.stringify(arg)}。\n${DESIGN_AGENT_USAGE}`);
    }
  }

  if (mode === null)
    throw new DesignAgentArgError(`必须指定 --example、--mock 或 --live 之一。\n${DESIGN_AGENT_USAGE}`);
  if (mode === 'live' && taskPath === undefined && !resume) {
    throw new DesignAgentArgError('--live 必须提供 --task <brief.md>（--resume 时除外）。');
  }
  if (mode !== 'live' && taskPath !== undefined) throw new DesignAgentArgError('--task 只用于 --live。');
  if (mode === 'mock' && mockPath === undefined) throw new DesignAgentArgError('--mock 必须提供剧本 JSON 路径。');
  if (resume && !sessionProvided) throw new DesignAgentArgError('--resume 必须与显式 --session <id> 一起使用。');
  if (resume && mode === 'example') throw new DesignAgentArgError('--resume 只用于 --live / --mock。');
  if (mode === 'example' && (answers !== undefined || feedback !== undefined)) {
    throw new DesignAgentArgError('--answers / --feedback 只用于 --live / --mock。');
  }
  const sessionId = assertSessionId(session ?? defaultSessionId(mode));
  return {
    mode,
    sessionId,
    outDir,
    mockPath,
    taskPath,
    answers,
    feedback,
    resume,
    legacyScheme,
  };
}

const SCOPE_LABEL: Readonly<Record<DesignScheme['meta']['scope'], string>> = {
  exterior: '外观',
  'exterior+entry': '外观 + 入口',
  'exterior+interior': '外观 + 完整室内',
};

function printSummary(
  io: DesignAgentIo,
  scheme: DesignScheme,
  requirements: RequirementGraph,
  paths: ArtifactPaths,
): void {
  const rooms = scheme.spaces.filter((space) => space.kind === 'room').map((space) => space.name);
  const musts = requirements.requirements
    .filter((requirement) => requirement.priority === 'must' && requirement.status !== 'rejected')
    .map((requirement) => `[${requirement.id}] ${requirement.text}`);
  io.stdout(`设计报告摘要：${scheme.meta.title}`);
  io.stdout(`- 方案：${scheme.meta.id} v${String(scheme.meta.revision)}（${SCOPE_LABEL[scheme.meta.scope]}）`);
  io.stdout(`- 概念：${scheme.meta.concept}`);
  io.stdout(`- 主要空间：${rooms.length === 0 ? '无' : rooms.join('、')}`);
  io.stdout(`- 必须项：${musts.length === 0 ? '无' : musts.join('；')}`);
  io.stdout(`- 未决：${scheme.open.length === 0 ? '无' : scheme.open.map((item) => item.question).join('；')}`);
  io.stdout(`- 会话目录：${paths.sessionDir}`);
  const files = [paths.design, paths.task, paths.spec, paths.gates, paths.promptMeta];
  if (paths.designIntent !== undefined) files.push(paths.designIntent);
  for (const path of files) io.stdout(`  - ${path}`);
}

async function deliver(
  io: DesignAgentIo,
  scheme: DesignScheme,
  requirements: RequirementGraph,
  options: DesignAgentOptions,
  intent?: DesignIntent,
): Promise<number> {
  const brief = compileBuildBrief(scheme, requirements);
  const issues = lintBrief(brief, requirements);
  if (issues.length > 0) {
    io.stderr(`构建简报 lint 未通过（${String(issues.length)} 项），不写 artifacts：`);
    for (const issue of issues) io.stderr(`- [${issue.code}] ${issue.message}`);
    return 1;
  }
  const report = compileDesignReport(scheme, requirements);
  if (report !== brief.designMarkdown) {
    io.stderr('内部错误：compileDesignReport 与 compileBuildBrief 生成的 design.md 不一致。');
    return 1;
  }
  const dir = sessionDir(options.sessionId, { root: options.outDir });
  const paths = await writeArtifacts(dir, brief, intent);
  printSummary(io, scheme, requirements, paths);
  return 0;
}

function readMockScript(path: string): MockScript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new DesignAgentArgError(
      `读取 mock 剧本 ${path} 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DesignAgentArgError('mock 剧本必须是 JSON 对象。');
  }
  const record = parsed as Record<string, unknown>;
  if (
    !Object.hasOwn(record, 'requirements') ||
    (!Object.hasOwn(record, 'scheme') && !Object.hasOwn(record, 'intent'))
  ) {
    throw new DesignAgentArgError('mock 剧本必须包含 requirements，以及 intent 或 scheme 至少一个。');
  }
  const task = record['task'] as string | undefined;
  if (task !== undefined && typeof task !== 'string') {
    throw new DesignAgentArgError('mock 剧本的 task 必须是字符串。');
  }
  return {
    task: task ?? '离线 mock：请设计一座小型建筑。',
    requirements: record['requirements'],
    intent: record['intent'],
    scheme: record['scheme'],
  };
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

function loadTask(taskPath: string): string {
  assertTaskPath(taskPath);
  try {
    return readFileSync(taskPath, 'utf8');
  } catch (error) {
    throw new DesignAgentArgError(
      `读取题面 ${taskPath} 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runLive(io: DesignAgentIo, options: DesignAgentOptions, deps: DesignAgentDeps): Promise<number> {
  if (options.taskPath === undefined && !options.resume) {
    throw new DesignAgentArgError('--live 必须提供 --task <brief.md>（--resume 时除外）。');
  }
  const task = options.taskPath === undefined ? '' : loadTask(options.taskPath);

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

  let client: ChatClient;
  try {
    const liveClient = (deps.createLiveClient ?? makeLiveClient)(config);
    client = withLiveBudget(liveClient, {
      maxCny: config.maxRunCostCny,
      label: options.sessionId,
      auditDir: '.work/live-audit',
    });
  } catch (error) {
    io.stderr(`创建 live client 失败：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const result = await runConversationMode(client, {
    sessionId: options.sessionId,
    outDir: options.outDir,
    task,
    answers: options.answers,
    feedback: options.feedback,
    resume: options.resume,
    designMode: options.legacyScheme ? 'legacy' : 'intent',
    say: io.stdout,
    ...(deps.conversationIO === undefined ? {} : { conversationIO: deps.conversationIO }),
  });
  return result.brief === null ? 1 : 0;
}

/** 真正执行一次入口；参数 / 配置 / 确认错误返回 2，生成或 lint 失败返回 1。 */
export async function runDesignAgent(argv: readonly string[], deps: DesignAgentDeps = {}): Promise<number> {
  const io = deps.io ?? {
    stdout: (line: string) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(DESIGN_AGENT_USAGE);
    return 0;
  }

  let options: DesignAgentOptions;
  try {
    options = parseDesignAgentArgs(argv);
  } catch (error) {
    if (
      error instanceof DesignAgentArgError ||
      error instanceof SessionStoreError ||
      error instanceof ConversationCliError
    ) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }

  try {
    if (options.mode === 'example') {
      io.stdout('离线示例：使用 exampleRequirements / exampleScheme，不调用模型。');
      return await deliver(io, exampleScheme(), exampleRequirements(), options);
    }
    if (options.mode === 'mock' && options.mockPath !== undefined) {
      const script = readMockScript(options.mockPath);
      io.stdout(`离线 mock：从 ${options.mockPath} 读取工具结果，不调用模型、不联网。`);
      const client = createMockClient(script);
      if (options.answers !== undefined || options.feedback !== undefined || options.resume) {
        const result = await runConversationMode(client, {
          sessionId: options.sessionId,
          outDir: options.outDir,
          task: script.task,
          answers: options.answers,
          feedback: options.feedback,
          resume: options.resume,
          designMode: options.legacyScheme ? 'legacy' : 'intent',
          say: io.stdout,
          ...(deps.conversationIO === undefined ? {} : { conversationIO: deps.conversationIO }),
        });
        return result.brief === null ? 1 : 0;
      }
      const requirements = await extractRequirements(client, { userText: script.task });
      if (options.legacyScheme) {
        const scheme = await proposeScheme(client, requirements.value);
        return await deliver(io, scheme.value, requirements.value, options);
      }
      const generated = await proposeIntent(
        client,
        requirements.value,
        createIntentHost(requirements.value, { schemeId: 'scheme-tea' }),
      );
      return await deliver(io, generated.scheme, requirements.value, options, generated.intent);
    }
    return await runLive(io, options, deps);
  } catch (error) {
    if (
      error instanceof DesignAgentArgError ||
      error instanceof SessionStoreError ||
      error instanceof ConversationCliError ||
      error instanceof ConversationError
    ) {
      io.stderr(error.message);
      return 2;
    }
    if (error instanceof GenerationError) {
      io.stderr(`生成失败（${error.code}）：${error.message}`);
      return 1;
    }
    if (error instanceof SessionTransitionError) {
      io.stderr(`会话状态错误：${error.message}`);
      return 1;
    }
    io.stderr(`运行失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  }
}

/** 直接执行入口：不把未预期异常变成裸栈输出。 */
export async function main(argv: readonly string[], deps: DesignAgentDeps = {}): Promise<number> {
  try {
    return await runDesignAgent(argv, deps);
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
