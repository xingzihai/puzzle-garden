/**
 * 网页构建状态：把 `design-build-runner` 的事件映射成短日志，维护 turns / 花费 / 交付 / 渲染图。
 *
 * 负责：单会话构建状态机、最近 50 条事件、从 runDir/delivery/render 列 PNG、每会话一个进行中的构建。
 * 不负责：HTTP 路由 / 请求体解析（interaction-server-core.ts）、会话与方案（interaction-server-session.ts）。
 * 事件只保留短文本，不透传 body / blob / env。
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ReviewReport } from '@pg/interaction/review';
import type { BuildSpec } from '@pg/interaction/schema';

import type { DesignBuildEvent, DesignBuildRunResult, DesignBuildStartInfo } from './design-build-runner.ts';
import { DELIVERY_RENDER_NAME, startDesignBuild } from './design-build-runner.ts';

export {
  buildRunReview,
  defaultWebReviewBuilder,
  readPersistedRunReview,
  readRunReviewEvidence,
  writeRunReview,
} from './run-review.ts';
export type { BuildRunReviewInput } from './run-review.ts';

export type WebBuildStatus = 'idle' | 'running' | 'done' | 'failed';

export interface WebBuildEvent {
  readonly seq: number;
  readonly type: string;
  readonly text: string;
}

export interface WebBuildRender {
  readonly name: string;
  readonly url: string;
  readonly downloadUrl: string;
}

export interface WebBuildDelivery {
  readonly codeVersion: number;
  readonly hash: string;
}

export interface WebBuildState {
  readonly status: WebBuildStatus;
  readonly turns: number;
  readonly currentAction: string;
  readonly events: readonly WebBuildEvent[];
  readonly runDir: string | null;
  readonly costCny: number | null;
  readonly delivery: WebBuildDelivery | null;
  readonly renders: readonly WebBuildRender[];
  readonly error: string | null;
  readonly stopReason: string | null;
}

export interface WebBuildStarterInput {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly outDir: string;
  readonly seed: number;
  readonly maxCny: number;
  readonly onStart: (info: DesignBuildStartInfo) => void;
  readonly onEvent: (event: DesignBuildEvent) => void;
}

export type WebBuildStarter = (input: WebBuildStarterInput) => Promise<DesignBuildRunResult>;

/** 构建生命周期 hooks；默认不注入，保持旧构造方式行为不变。 */
export interface BuildTrackerHooks {
  readonly onStart?: (info: DesignBuildStartInfo) => void;
  readonly onFinish?: (result: DesignBuildRunResult) => void | Promise<void>;
  readonly onError?: (error: unknown) => void | Promise<void>;
}

/** 构建结果 → ReviewReport；测试可注入 fake，避免依赖真实 events.jsonl。 */
export type WebReviewBuilder = (input: {
  readonly spec: BuildSpec;
  readonly result: DesignBuildRunResult;
  /** 当前 BuildSpec 工件路径；缺省时从 runDir/build-spec.json 推导。 */
  readonly specPath?: string;
  /** 由当前 requirements + confirmed scheme 重跑 planner 得到的 verified 映射。 */
  readonly verifiedMustObjects?: Readonly<Record<string, readonly string[]>>;
}) => ReviewReport | Promise<ReviewReport>;

interface BuildRecord {
  status: WebBuildStatus;
  turns: number;
  currentAction: string;
  eventCount: number;
  events: WebBuildEvent[];
  runDir: string | null;
  costCny: number | null;
  delivery: WebBuildDelivery | null;
  renders: WebBuildRender[];
  error: string | null;
  stopReason: string | null;
}

const MAX_WEB_EVENTS = 50;
const MAX_EVENT_TEXT = 200;

function idleRecord(): BuildRecord {
  return {
    status: 'idle',
    turns: 0,
    currentAction: '尚未启动构建',
    eventCount: 0,
    events: [],
    runDir: null,
    costCny: null,
    delivery: null,
    renders: [],
    error: null,
    stopReason: null,
  };
}

function runningRecord(): BuildRecord {
  return {
    status: 'running',
    turns: 0,
    currentAction: '构建已启动…',
    eventCount: 0,
    events: [],
    runDir: null,
    costCny: null,
    delivery: null,
    renders: [],
    error: null,
    stopReason: null,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= MAX_EVENT_TEXT ? oneLine : `${oneLine.slice(0, MAX_EVENT_TEXT - 1)}…`;
}

function displayText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function describeEvent(event: DesignBuildEvent): string | null {
  switch (event.type) {
    case 'turn.start':
      return `第 ${String(event.turn ?? 0)} 轮开始`;
    case 'llm.request':
      return '模型请求中';
    case 'llm.response':
      return '模型回复';
    case 'tool.call':
      return `调用 ${displayText(event.body.name, '未知工具')}`;
    case 'tool.result':
      return `工具结果 ${displayText(event.body.status, 'unknown')}`;
    case 'check.result': {
      if (event.body.precheck.kind !== 'ok') return '检查：precheck-failed';
      const run = event.body.run;
      if (run === null) return '检查：not-finished';
      return run.kind === 'ok' ? '检查：ok' : run.kind === 'build-error' ? '检查：build-error' : '检查：not-finished';
    }
    case 'render.result':
      return `渲染 ${String(event.body.images.length)} 张`;
    case 'submit':
      return '已提交';
    case 'delivery':
      return '交付已写入';
    case 'run.end': {
      const rawCost = event.body.totals.costCny;
      const spend = typeof rawCost === 'number' && Number.isFinite(rawCost) ? `花费 ¥${rawCost.toFixed(4)}` : '未计费';
      const stopReason = displayText(event.body.stopReason, '');
      return stopReason === '' ? `完成 · ${spend}` : `停止：${stopReason} · ${spend}`;
    }
    // 其余事件不进入网页日志：blob / 内部版本 / 子运行细节对页面没有价值。
    case 'run.start':
    case 'prompt.system':
    case 'versions.render':
    case 'llm.attempt':
    case 'code.version':
    case 'model.check':
    case 'facts':
    case 'guard':
    case 'model.delivery':
    case 'subrun.result':
      return null;
  }
}

async function listRenders(runDir: string, sessionId: string): Promise<WebBuildRender[]> {
  let entries;
  try {
    entries = await readdir(join(runDir, 'delivery', 'render'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && DELIVERY_RENDER_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/build/renders/${encodeURIComponent(name)}`;
      return { name, url, downloadUrl: url };
    });
}

/** 单会话构建跟踪器：同一时间最多一个 running；事件只留最近 50 条。 */
export class BuildTracker {
  private readonly starter: WebBuildStarter;
  private readonly log: (line: string) => void;
  private readonly hooks: BuildTrackerHooks;
  private record: BuildRecord = idleRecord();
  /** 运行中收到 reset 时，等本轮收尾后再清空，避免旧构建结果覆盖新 revision。 */
  private resetAfterRun = false;

  constructor(starter: WebBuildStarter, log: (line: string) => void = () => undefined, hooks: BuildTrackerHooks = {}) {
    this.starter = starter;
    this.log = log;
    this.hooks = hooks;
  }

  get running(): boolean {
    return this.record.status === 'running';
  }

  snapshot(): WebBuildState {
    return {
      status: this.record.status,
      turns: this.record.turns,
      currentAction: this.record.currentAction,
      events: this.record.events.map((event) => ({ ...event })),
      runDir: this.record.runDir,
      costCny: this.record.costCny,
      delivery: this.record.delivery === null ? null : { ...this.record.delivery },
      renders: this.record.renders.map((render) => ({ ...render })),
      error: this.record.error,
      stopReason: this.record.stopReason,
    };
  }

  /** 新设计 revision 确认后清空上一轮构建结果，允许重新构建；运行中延后到收尾。 */
  reset(): void {
    if (this.record.status === 'running') {
      this.resetAfterRun = true;
      return;
    }
    this.record = idleRecord();
  }

  /** 仅允许在 idle / done / failed 时启动；调用方负责把 running 映射成 409。 */
  start(input: Omit<WebBuildStarterInput, 'onStart' | 'onEvent'>): WebBuildState {
    this.resetAfterRun = false;
    this.record = runningRecord();
    // 让 HTTP 202 先返回，再开始读 artifacts / 装配构建依赖。
    setTimeout(() => {
      void this.run(input);
    }, 0);
    return this.snapshot();
  }

  /** 已知渲染图的只读路径；名字不合法、未完成枚举或不在列表里返回 null。 */
  renderPath(name: string): string | null {
    if (!DELIVERY_RENDER_NAME.test(name)) return null;
    if (this.record.runDir === null || !this.record.renders.some((render) => render.name === name)) return null;
    return join(this.record.runDir, 'delivery', 'render', name);
  }

  private push(event: DesignBuildEvent): void {
    if (event.type === 'turn.start') {
      this.record.turns = event.turn ?? 0;
      this.record.costCny = event.body.spentCny;
    }
    if (event.type === 'run.end') {
      const totals = event.body.totals;
      this.record.turns = totals.turns;
      this.record.costCny = totals.costCny;
      this.record.stopReason = typeof event.body.stopReason === 'string' ? event.body.stopReason : null;
      if (this.record.stopReason !== null) {
        this.record.status = 'failed';
        this.record.error = `停止原因：${this.record.stopReason}`;
      }
    }
    const text = describeEvent(event);
    if (text === null) return;
    this.record.eventCount += 1;
    this.record.events.push({
      seq: Number.isSafeInteger(event.seq) ? event.seq : this.record.eventCount,
      type: event.type,
      text: shortText(text),
    });
    if (this.record.events.length > MAX_WEB_EVENTS) {
      this.record.events.splice(0, this.record.events.length - MAX_WEB_EVENTS);
    }
    this.record.currentAction = shortText(text);
  }

  private notifyStart(info: DesignBuildStartInfo): void {
    try {
      this.hooks.onStart?.(info);
    } catch (error) {
      // hook 失败只记录日志；已完成的构建状态不允许被观察者改写。
      this.log(`[build] onStart hook 失败：${errorMessage(error)}`);
    }
  }

  private async notifyFinish(result: DesignBuildRunResult): Promise<void> {
    try {
      await this.hooks.onFinish?.(result);
    } catch (error) {
      this.log(`[build] onFinish hook 失败：${errorMessage(error)}`);
    }
  }

  private async notifyError(error: unknown): Promise<void> {
    try {
      await this.hooks.onError?.(error);
    } catch (hookError) {
      this.log(`[build] onError hook 失败：${errorMessage(hookError)}`);
    }
  }

  private async run(input: Omit<WebBuildStarterInput, 'onStart' | 'onEvent'>): Promise<void> {
    const record = this.record;
    try {
      const result = await this.starter({
        ...input,
        onStart: (info) => {
          record.runDir = info.runDir;
          record.currentAction = '构建已启动';
          this.notifyStart(info);
        },
        onEvent: (event) => {
          try {
            this.push(event);
          } catch {
            // 事件映射失败不应中断构建；真实事件已由 RunWriter 校验并落盘。
          }
        },
      });
      record.runDir = result.runDir;
      record.turns = result.outcome.turns;
      record.costCny = result.outcome.costCny;
      record.delivery = result.delivery;
      record.renders = await listRenders(result.runDir, input.sessionId);
      if (result.delivery !== null && result.outcome.stopReason === null) {
        record.currentAction = '构建完成';
        record.error = null;
        // 先让会话写完 post-review / review，再把构建置为 done；否则测试清理或页面轮询会抢在评审落盘前。
        await this.notifyFinish(result);
        record.status = 'done';
      } else {
        record.stopReason = result.outcome.stopReason;
        record.error =
          result.outcome.stopReason === null ? '构建结束但没有交付。' : `停止原因：${result.outcome.stopReason}`;
        record.currentAction = record.error;
        await this.notifyError(new Error(record.error));
        record.status = 'failed';
      }
    } catch (error) {
      record.status = 'failed';
      record.error = `构建失败：${errorMessage(error)}`;
      record.currentAction = record.error;
      await this.notifyError(error);
    }
    this.log(`[build] ${input.sessionId} ${record.status}：${record.currentAction}`);
    if (this.resetAfterRun) {
      this.resetAfterRun = false;
      this.record = idleRecord();
    }
  }
}

/** 网页默认 starter：走真实 `startDesignBuild`；只有 live 会话会走到这里。 */
export function defaultBuildStarter(input: WebBuildStarterInput): Promise<DesignBuildRunResult> {
  return startDesignBuild({
    sessionDir: input.sessionDir,
    outDir: input.outDir,
    seed: input.seed,
    maxCny: input.maxCny,
    onStart: input.onStart,
    onEvent: input.onEvent,
  });
}
