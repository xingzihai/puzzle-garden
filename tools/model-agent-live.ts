/**
 * `model:agent --live` 的真实模型支撑：读题面、按 `@pg/config` 造真实 client、授权校验与密钥脱敏。
 *
 * 负责：从 `--task` 文件读原题（raw 全文算 hash，fed 只含正文一至四节）；把 `Config.llm` 组装成 ChatClient；
 *   校验模型在价格表里、`PG_LIVE_CONFIRM=1` 已确认；`PG_MAX_RUN_COST_CNY` 只收紧 `--max-cny`；日志脱敏。
 * 不负责：argv 解析与退出码（model-agent.ts）、主循环与请求记录（@pg/agent/runner）、隔离执行 / 渲染（CLI 注入）。
 * 本文件不读 process.env：生产配置走 `@pg/config` 的 `loadConfigFromProcess`，测试注入 {@link LiveConfigInjection}。
 * 真实 HTTP 只发生在调用方传入的 `fetch`（生产是 globalThis.fetch）；单测注入剧本 fetch，绝不发真实请求。
 */

import { readFileSync } from 'node:fs';

import type { RunnerInput } from '@pg/agent/runner';
import { assertTaskPath, extractTaskBody } from '@pg/agent/task-body';
import { loadConfigFromProcess } from '@pg/config';
import type { Config } from '@pg/config';
import { createClient } from '@pg/llm/client';
import type { ChatClient } from '@pg/llm/client';

import { realClock, realSleep } from './model-agent-deps.ts';

/** 价格表里唯一的模型；其它 `PG_LLM_MODEL` 一律拒发真实调用（MODEL-SPEC §3.5）。 */
export const LIVE_MODEL = 'deepseek-flash';

/** 未设 `PG_LIVE_CONFIRM=1`：第二道确认缺失，入口用退出码 2（AGENT-SPEC §11）。 */
export class LiveConfirmError extends Error {
  constructor() {
    super('拒绝真实模型调用：请设置环境变量 PG_LIVE_CONFIRM=1 作为第二道确认（AGENT-SPEC §11）。');
    this.name = 'LiveConfirmError';
  }
}

/** live 运行时：真实 client + 进 run.start.config 的公开字段（不含 apiKey，C16）。 */
export interface LiveRuntime {
  readonly client: ChatClient;
  readonly config: { readonly baseUrl: string; readonly timeoutMs: number };
  /** `PG_MAX_RUN_COST_CNY`（> 0 才生效）；runner 的上限取它与 `--max-cny` 的较小值。 */
  readonly envMaxCny: number | undefined;
}

/**
 * 单测注入点：给定后不再调 `@pg/config`、不碰 `globalThis.fetch`。
 * `client` 直接给时完全替代 createClient；只给 `fetch` 时用它造 client（剧本 fetch，不联网）。
 */
export interface LiveConfigInjection {
  readonly llm: Config['llm'];
  readonly maxRunCostCny: number;
  readonly liveConfirm: boolean;
  readonly fetch?: typeof fetch;
  readonly client?: ChatClient;
}

/** live 启动结果：runtime 进主循环，secret 只喂给 {@link redactSecret}。 */
export interface LiveStartup {
  readonly runtime: LiveRuntime;
  /** apiKey；绝不写进事件、交付、stdout / stderr（client 自身也会 scrub 报错）。 */
  readonly secret: string;
}

/** 只接受价格表里的模型；其它名字拼出可读错误，不静默发请求。 */
export function assertLiveModel(model: string): void {
  if (model !== LIVE_MODEL) {
    throw new Error(`PG_LLM_MODEL=${model} 不在价格表里，拒绝发起真实调用；应设为 ${LIVE_MODEL}。`);
  }
}

/** 从可能含密钥的文本里抹掉密钥，避免日志泄漏；空密钥原样返回。 */
export function redactSecret(text: string, secret: string): string {
  if (secret === '') return text;
  return text.split(secret).join('***');
}

/**
 * 真实题面：`raw` 是文件原文（进 `task.sha256`，hash 必须对原文准确）；
 * `fed` 只含标题与一至四节，引用块（`>`，可能带来源路径）与五、六节不喂给模型（AGENT-SPEC §2.1）。
 */
export function readLiveTask(taskPath: string, feedback: string | undefined): RunnerInput['task'] {
  assertTaskPath(taskPath);
  let raw: string;
  try {
    raw = readFileSync(taskPath, 'utf8');
  } catch (error) {
    throw new Error(`题面 ${taskPath} 读不到（${error instanceof Error ? error.message : String(error)}）。`, {
      cause: error,
    });
  }
  const body = extractTaskBody(raw).text;
  const fed = feedback === undefined ? body : `${body.trimEnd()}\n\n用户反馈：${feedback}\n`;
  return { raw, fed, source: taskPath };
}

/**
 * `PG_MAX_RUN_COST_CNY` 只能收紧 `--max-cny`，不能放宽：更小时取它；
 * 未设 / 为 0（关闭护栏）/ 更大时保持命令行值。与 `@pg/agent/cli-args` 的 `tightenLimits` 同语义，
 * 该模块未在包 exports 里，故在此保留一份（改一处要同步另一处）。
 */
export function tightenCost<T extends { readonly maxCostCny: number }>(limits: T, envMaxCny: number | undefined): T {
  if (envMaxCny === undefined || envMaxCny <= 0 || envMaxCny >= limits.maxCostCny) return limits;
  return { ...limits, maxCostCny: envMaxCny };
}

/** 用 `@pg/config` 或注入配置造 live 启动结果；注入缺省时读环境、真实 fetch 联网。 */
export function resolveLiveStartup(injection?: LiveConfigInjection): LiveStartup {
  let cfg: LiveConfigInjection;
  if (injection !== undefined) {
    cfg = injection;
  } else {
    const loaded = loadConfigFromProcess();
    cfg = { llm: loaded.llm, maxRunCostCny: loaded.maxRunCostCny, liveConfirm: loaded.liveConfirm };
  }
  assertLiveModel(cfg.llm.model);
  if (!cfg.liveConfirm) throw new LiveConfirmError();
  const client =
    cfg.client ??
    createClient({
      config: { baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, timeoutMs: cfg.llm.timeoutMs },
      // 真实时钟 / 定时器与 mock 演练共用同一对 realClock / realSleep；client 只负责 SSE，不另起循环。
      fetch: cfg.fetch ?? globalThis.fetch,
      sleep: realSleep,
      clock: realClock,
    });
  return {
    runtime: {
      client,
      config: { baseUrl: cfg.llm.baseUrl, timeoutMs: cfg.llm.timeoutMs },
      envMaxCny: cfg.maxRunCostCny > 0 ? cfg.maxRunCostCny : undefined,
    },
    secret: cfg.llm.apiKey,
  };
}
