/**
 * `npm run model:agent`：草模 agent 入口，`--demo`（离线 mock 演练）与 `--live`（真实模型）二选一。
 *
 * 负责：参数解析；`--demo` 用固定 mock 剧本、`--live` 从 `--task` 读题并按 `@pg/config` 造真实 client；
 *   两者都用真实 `@pg/sandbox/modeling` 隔离执行 + 真实 `@pg/web/model-render` 渲染，跑一次
 *   `runRun` + `createModelingTarget`；写 run 目录与交付；打印结果与退出码。
 * 不负责：请求循环 / 护栏（@pg/agent/runner）、工具逻辑（@pg/agent/modeling-target）、
 *   依赖组装（tools/model-agent-deps.ts）、live 配置与 client（tools/model-agent-live.ts）。
 *
 * `--demo` 明确标注：模型是 mock 剧本、代码是仓库内手写示例；只有沙箱执行与浏览器渲染是真实程序。
 * `--live` 才发真实模型请求，需 owner 明确授权；CLI 只跑一次 run，不批跑。
 * 退出码：交付 0；未交付 / 运行失败 1；参数、配置、确认或读文件错误 2。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createModelingTarget } from '@pg/agent/modeling-target';
import { runRun } from '@pg/agent/runner';
import type { ExternalVersions, RunOutcome, RunnerInput } from '@pg/agent/runner';
import type { ChatClient } from '@pg/llm/client';
import type { Script } from '@pg/llm/mock';
import { MODEL_VERSION } from '@pg/modeling/schema';
import type { ModelDocument } from '@pg/modeling/schema';
import { createModelPrechecker, createModelRunner } from '@pg/sandbox/modeling';
import type { ModelExecution } from '@pg/sandbox/modeling';
import type { RunLimits } from '@pg/store/events';
import { createRunDir } from '@pg/store/run-dir';
import { DEFAULT_CHROME_PATH, renderModelViews } from '@pg/web/model-render';

import {
  DEFAULT_DEMO_OUT,
  MODELING_API,
  MODEL_DEMO_NOTE,
  MODEL_DEMO_TASK,
  buildDemoScript,
  createMockModelRuntime,
  gitSnapshot,
  loadDemoCode,
  modelExternalVersions,
  modelRunId,
  readModelScript,
  readModelSeedCode,
  realClock,
  realSleep,
  sha256Hex,
} from './model-agent-deps.ts';
import { readLiveTask, redactSecret, resolveLiveStartup, tightenCost } from './model-agent-live.ts';
import type { LiveConfigInjection } from './model-agent-live.ts';
import { loadTokenCounter } from './tokens.ts';

/** 一次运行可调的上限；默认 12 轮 / ¥1（demo）/ 240 秒 / 窗口 2 轮（墙钟须大于 180 秒的墙钟窗口）。 */
export interface AgentOptions {
  /** `--demo`（离线 mock）或 `--live`（真实模型）。 */
  readonly mode: 'demo' | 'live';
  /** live 题面路径；demo 为 undefined（用固定演示题面）。 */
  readonly taskPath: string | undefined;
  readonly outDir: string;
  readonly seed: number;
  readonly seedCodePath: string | undefined;
  readonly feedback: string | undefined;
  readonly scriptPath: string | undefined;
  readonly chromePath: string;
  readonly limits: RunLimits;
}

export class AgentArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentArgError';
  }
}

export const AGENT_USAGE = `用法：node tools/model-agent.ts --demo [选项]
      node tools/model-agent.ts --live --task <题面.md> --max-cny <正数> --out <dir> [选项]
  离线演练（--demo）：固定 mock 剧本驱动工具循环，真实 bwrap 执行、真实 Chrome 渲染，不发真实模型请求。
  真实模型（--live）：需 owner 明确授权；只跑一次 run，不批跑，无默认题目与预算。
  --demo 与 --live 恰好给一个。
  --out <dir>            run 目录根（--demo 默认 ${DEFAULT_DEMO_OUT}；--live 必填）
  --task <path>          live 题面文件（必填；拒绝 /sealed/；raw 全文算 hash，喂入正文去引用块与五、六节）
  --seed <int>           沙箱 rng 种子，0–4294967295（默认 7）
  --seed-code <path>     当前稿第 1 版从该文件开始（demo 配合 --script；live 也支持）
  --feedback <text>      追加到题面末尾的用户反馈
  --script <path>        自定义 mock 剧本 JSON（仅 --demo；缺省用内置固定演示剧本）
  --chrome <path>        Chrome 路径（默认 ${DEFAULT_CHROME_PATH}）
  --max-cny <num>        费用上限（--demo 默认 1；--live 必填，必须为正数）
  --max-turns <int>      轮数上限 4–200（默认 20）
  --wall-ms <int>        墙钟上限，须 > 180001（默认 240000；墙钟窗口是距到点 180000ms，低于它开局即进提交窗口）
  --submit-window <int>  提交窗口 1–10（默认 2）`;

function value(args: readonly string[], index: number, flag: string): string {
  const v = args[index + 1];
  if (v === undefined || v === '' || v.startsWith('--')) throw new AgentArgError(`${flag} 缺少取值。\n${AGENT_USAGE}`);
  return v;
}

function intInRange(raw: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw))
    throw new AgentArgError(`${flag} 应为 ${String(min)}–${String(max)} 的整数，实际是 ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < min || n > max) throw new AgentArgError(`${flag} 应在 ${String(min)}–${String(max)} 之间，实际是 ${raw}`);
  return n;
}

function numberPositive(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new AgentArgError(`${flag} 应为正数，实际是 ${JSON.stringify(raw)}`);
  return n;
}

/**
 * 解析 argv（不含 node 与脚本路径）。`--demo` / `--live` 恰好一个；
 * `--live` 必须显式给 `--task`、`--max-cny`、`--out`，不接受 `--script`，没有默认题目 / 预算。
 */
export function parseAgentArgs(argv: readonly string[]): AgentOptions {
  let demo = false;
  let live = false;
  let outDir: string | null = null;
  let taskPath: string | null = null;
  let seed = 7;
  let seedCodePath: string | undefined;
  let feedback: string | undefined;
  let scriptPath: string | undefined;
  let chromePath = DEFAULT_CHROME_PATH;
  let maxCny: number | null = null;
  // 建模任务的默认轮数：真实试跑实测（六角亭）两次在 16–17 轮差一步交付，
  // 其中含类型错误自纠开销，默认上调到 20（决策 #107）。
  let maxTurns = 20;
  // wall-window 护栏在距墙钟到点 180000ms 时进提交窗口；默认墙钟须大于它，否则第一轮就进窗口、
  // view_model 被挡（v0 的 write_code 仍可用，但没有任何看图余地；这是演示能跑通的前提，不是随便挑的数）。
  let wallMs = 240_000;
  let submitWindow = 2;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--demo':
        demo = true;
        break;
      case '--live':
        live = true;
        break;
      case '--task':
        taskPath = value(argv, i, '--task');
        i += 1;
        break;
      case '--out':
        outDir = value(argv, i, '--out');
        i += 1;
        break;
      case '--seed':
        seed = intInRange(value(argv, i, '--seed'), '--seed', 0, 2 ** 32 - 1);
        i += 1;
        break;
      case '--seed-code':
        seedCodePath = value(argv, i, '--seed-code');
        i += 1;
        break;
      case '--feedback':
        feedback = value(argv, i, '--feedback');
        i += 1;
        break;
      case '--script':
        scriptPath = value(argv, i, '--script');
        i += 1;
        break;
      case '--chrome':
        chromePath = value(argv, i, '--chrome');
        i += 1;
        break;
      case '--max-cny':
        maxCny = numberPositive(value(argv, i, '--max-cny'), '--max-cny');
        i += 1;
        break;
      case '--max-turns':
        maxTurns = intInRange(value(argv, i, '--max-turns'), '--max-turns', 4, 200);
        i += 1;
        break;
      case '--wall-ms':
        wallMs = intInRange(value(argv, i, '--wall-ms'), '--wall-ms', 180_001, 2 ** 31 - 1);
        i += 1;
        break;
      case '--submit-window':
        submitWindow = intInRange(value(argv, i, '--submit-window'), '--submit-window', 1, 10);
        i += 1;
        break;
      default:
        throw new AgentArgError(`不认识的参数 ${arg}。\n${AGENT_USAGE}`);
    }
  }

  if (demo === live) {
    throw new AgentArgError(`必须且只能给一个 --demo 或 --live。\n${AGENT_USAGE}`);
  }
  if (live) {
    if (taskPath === null) throw new AgentArgError(`--live 必须给 --task <题面.md>（没有默认题目）。\n${AGENT_USAGE}`);
    if (maxCny === null) throw new AgentArgError(`--live 必须给 --max-cny（没有默认预算）。\n${AGENT_USAGE}`);
    if (outDir === null) throw new AgentArgError(`--live 必须给 --out <dir>（没有默认输出目录）。\n${AGENT_USAGE}`);
    if (scriptPath !== undefined) {
      throw new AgentArgError(`--live 不接受 --script（那是离线 mock 剧本）。\n${AGENT_USAGE}`);
    }
  } else {
    if (taskPath !== null) {
      throw new AgentArgError(`--task 只用于 --live；--demo 使用固定演示题面。\n${AGENT_USAGE}`);
    }
  }
  return {
    mode: live ? 'live' : 'demo',
    taskPath: taskPath ?? undefined,
    outDir: outDir ?? DEFAULT_DEMO_OUT,
    seed,
    seedCodePath,
    feedback,
    scriptPath,
    chromePath,
    limits: { maxCostCny: maxCny ?? 1, maxTurns, wallMs, submitWindow },
  };
}

/** 演练题面：固定要求，`--feedback` 作为追加反馈并入同一条 user 消息。 */
export function agentTask(opts: AgentOptions): string {
  return opts.feedback === undefined ? MODEL_DEMO_TASK : `${MODEL_DEMO_TASK}\n\n用户反馈：${opts.feedback}`;
}

export interface AgentIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** 单测注入点：真实路径不传，走真实墙钟 / bwrap / Chrome / tokenizer。 */
export interface AgentOverrides {
  readonly execute?: (
    code: string,
    options: { readonly seed: number; readonly signal?: AbortSignal },
  ) => Promise<ModelExecution>;
  /** 与 `ModelRender` 同形：`options.signal` 是 tool-stage 合并外部取消与墙钟截止后的信号，必须透传。 */
  readonly render?: (
    document: ModelDocument,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<readonly { readonly name: string; readonly png: Uint8Array }[]>;
  readonly versions?: ExternalVersions;
  readonly countTokens?: (text: string) => number;
  /** runner 的墙钟来源；缺省 `performance.now`。单测可注入受控时钟让真实等待可见。 */
  readonly clock?: () => number;
  /** runner 的墙钟截止定时器；缺省可中止的真实定时器。 */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** live 单测注入：给定时不读环境、不碰 globalThis.fetch。生产不传，走 @pg/config + 真实 fetch。 */
  readonly live?: LiveConfigInjection;
}

function reportAgent(outcome: RunOutcome, io: AgentIo, mode: AgentOptions['mode']): void {
  io.stdout(
    mode === 'live'
      ? '草模 agent（真实模型调用；单次 run，需 owner 明确授权；真实账单以供应商为准）'
      : '草模 agent 演练（离线 mock LLM；真实 bwrap 执行 + 真实 Chrome 渲染；不是真实模型调用）',
  );
  io.stdout(`run 目录: ${outcome.dir}`);
  io.stdout(`停止原因: ${outcome.stopReason ?? 'submitted（已交付）'}`);
  io.stdout(
    mode === 'live'
      ? `花费: ${outcome.costCny === null ? '未计费' : `¥${outcome.costCny.toFixed(4)}`}（按价格表估算，真实账单以供应商为准）`
      : `花费: ${outcome.costCny === null ? '未计费' : `¥${outcome.costCny.toFixed(4)}`}（离线模拟：mock 剧本按请求算，非真实账单）`,
  );
  io.stdout(`轮数: ${String(outcome.turns)}`);
  if (outcome.delivery !== null) {
    io.stdout(`交付: 第 v${String(outcome.delivery.codeVersion)} 版，文档 hash ${outcome.delivery.hash}`);
  }
}

/** 一次 run 的题面与模型来源（demo / live 两者之一）。 */
interface AgentSource {
  readonly task: RunnerInput['task'];
  readonly client: ChatClient;
  readonly mode: RunnerInput['mode'];
  readonly config: RunnerInput['config'];
  /** demo 进 run.start.script；live 为 undefined（没有 mock 剧本）。 */
  readonly script: { readonly name: string; readonly sha256: string } | undefined;
  readonly limits: RunLimits;
}

/** demo 来源：固定演示题面 + 内置或 `--script` 的 mock 剧本，不读环境、不联网。 */
function resolveDemoSource(opts: AgentOptions): AgentSource {
  const demoTask = agentTask(opts);
  const loaded = opts.scriptPath === undefined ? undefined : readModelScript(opts.scriptPath);
  const script: Script =
    loaded?.script ?? buildDemoScript({ task: demoTask, goodCode: loadDemoCode(), note: MODEL_DEMO_NOTE });
  return {
    task: { raw: demoTask, fed: demoTask, source: null },
    client: createMockModelRuntime(script, opts.seed).client,
    mode: 'script',
    config: null,
    script: { name: script.name, sha256: loaded?.sha256 ?? sha256Hex(JSON.stringify(script)) },
    limits: opts.limits,
  };
}

/** 把错误消息里的密钥抹掉再抛出，保留原 stack（main 会打印 stack）。非 Error 原样返回，main 再 String。 */
function redactError(error: unknown, secret: string): unknown {
  if (error instanceof Error) error.message = redactSecret(error.message, secret);
  return error;
}

/** 跑一次 run；参数 / 配置 / 确认 / 读文件错误返回 2，其余由 main 收成退出码 1。 */
export async function runModelAgent(
  argv: readonly string[],
  io: AgentIo,
  overrides: AgentOverrides = {},
): Promise<number> {
  let opts: AgentOptions;
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      io.stdout(AGENT_USAGE);
      return 0;
    }
    opts = parseAgentArgs(argv);
  } catch (error) {
    if (error instanceof AgentArgError) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }

  let seedCode: string | undefined;
  try {
    seedCode = opts.seedCodePath === undefined ? undefined : readModelSeedCode(opts.seedCodePath);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }

  // 参数已解析完，才碰配置 / 剧本：无效参数不会触发 loadConfig 或网络。
  // live 先拿 startup（key 只在内存里，用于错误日志脱敏），再读题面。
  let source: AgentSource;
  let secret = '';
  try {
    if (opts.mode === 'live') {
      const startup = resolveLiveStartup(overrides.live);
      secret = startup.secret;
      source = {
        task: readLiveTask(opts.taskPath ?? '', opts.feedback),
        client: startup.runtime.client,
        mode: 'live',
        config: startup.runtime.config,
        script: undefined,
        // PG_MAX_RUN_COST_CNY 只能收紧命令行 --max-cny。
        limits: tightenCost(opts.limits, startup.runtime.envMaxCny),
      };
    } else {
      source = resolveDemoSource(opts);
    }
  } catch (error) {
    io.stderr(redactSecret(error instanceof Error ? error.message : String(error), secret));
    return 2;
  }

  const countTokens = overrides.countTokens ?? loadTokenCounter().count;
  const prechecker = createModelPrechecker();
  const modelRunner = createModelRunner();
  // 真实墙钟：mock 只替 LLM 请求，真实 bwrap / Chrome 的等待必须计入 wallMs 与事实行，
  // 否则真实等待被虚拟时钟隐藏、墙钟护栏形同虚设。live 与 demo 共用这一对真实时钟 / 定时器。
  const clock = overrides.clock ?? realClock;
  const sleep = overrides.sleep ?? realSleep;
  try {
    // runId 含时间戳与随机后缀；万一撞上已有目录也拒绝，绝不复用 / 覆盖别人的 run 目录。
    const runId = modelRunId(new Date());
    if (existsSync(join(opts.outDir, runId))) throw new Error(`run 目录已存在，拒绝覆盖：${join(opts.outDir, runId)}`);
    const store = createRunDir(opts.outDir, runId);
    const versions = overrides.versions ?? modelExternalVersions(store, prechecker.version, gitSnapshot());
    const target = createModelingTarget({
      execute: overrides.execute ?? ((code, options) => modelRunner.runCode(code, options)),
      // options.signal 由 tool-stage 把外部取消与墙钟截止合并后注入；必须透传，render 才能被中止并 close。
      render:
        overrides.render ??
        ((document, options) =>
          renderModelViews(document, {
            chromePath: opts.chromePath,
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
          })),
      versions: { modelingApi: MODELING_API, modelFormat: MODEL_VERSION },
    });
    const input: RunnerInput = {
      task: source.task,
      seed: opts.seed,
      mode: source.mode,
      variant: 'base',
      config: source.config,
      ...(source.script === undefined ? {} : { script: source.script }),
      ...(seedCode === undefined ? {} : { initialDraft: { code: seedCode } }),
      limits: source.limits,
    };
    const outcome = await runRun(input, {
      target,
      client: source.client,
      store,
      clock,
      sleep,
      countTokens,
      versions,
    });
    reportAgent(outcome, io, opts.mode);
    return outcome.delivery === null ? 1 : 0;
  } catch (error) {
    // runner 已按 internal-error 尽力收尾；这里补一层密钥脱敏，main 打印 stack 时不泄漏 key。
    throw redactError(error, secret);
  } finally {
    await modelRunner.close();
    await prechecker.close();
  }
}

function createDefaultIo(): AgentIo {
  return {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

/** 直接执行入口：把不可预期异常收成退出码 1，不让栈信息成为唯一输出。 */
export async function main(
  argv: readonly string[],
  io: AgentIo = createDefaultIo(),
  overrides: AgentOverrides = {},
): Promise<number> {
  try {
    return await runModelAgent(argv, io, overrides);
  } catch (error) {
    io.stderr(`运行失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
