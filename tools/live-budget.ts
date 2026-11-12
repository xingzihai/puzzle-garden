/**
 * 交互层 live 的硬预算守卫与 usage 审计（CLI / 网页共用）。
 *
 * 负责：每次请求前用 `reserveFor` 预留金额、必要时收敛 `max_tokens`、预算不足时直接拒绝而不调用底层 client；
 *   在重试前用预留金额做保守上界检查；按 attempt 的 `charge` 结算花费，并逐行追加审计 JSONL。
 * 不负责：具体生成流程、提示词预算说明（@pg/interaction）、真实网络调用（@pg/llm/client）。
 *
 * `maxCny === 0` 只关闭硬护栏，仍然累计花费并写审计。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { costOf, reserveFor } from '@pg/llm/cost';
import type { AttemptRecord, ChatClient, ChatOutcome, CompleteOptions } from '@pg/llm/client';
import type { ChatRequest, LlmFailure, Usage } from '@pg/llm/schema';

const DEFAULT_AUDIT_DIR = '.work/live-audit';
const MAX_FILE_LABEL = 80;

export interface LiveBudgetOptions {
  /** 0 = 关闭预算硬护栏，但仍记审计。 */
  readonly maxCny: number;
  readonly label?: string;
  /** 默认 '.work/live-audit'。 */
  readonly auditDir?: string;
  readonly now?: () => Date;
}

export interface LiveBudgetClient extends ChatClient {
  readonly spentCny: number;
}

/** 文件名只保留可移植字符；中文等会话标签会变成下划线。 */
function safeFileLabel(label: string): string {
  const cleaned = label
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, MAX_FILE_LABEL);
  return cleaned === '' ? 'live' : cleaned;
}

/**
 * 失败尝试的 usage 也可能不带缓存字段（例如客户端没拿到完整 usage）。
 * 缺失时按全部未命中估算，保证花费是上界而不是 0。
 */
function costOfAttempt(usage: Usage | null): number {
  if (usage === null) return 0;
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, usage.prompt_tokens - hit);
  return costOf({
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
    completion_tokens: usage.completion_tokens,
  });
}

/** 请求的输入上界：messages + 工具定义 + system（system 也在 messages 里，这里按规格保守重复计入）。 */
function requestBytes(request: ChatRequest): number {
  const systemBytes = request.messages.reduce(
    (total, message) => (message.role === 'system' ? total + Buffer.byteLength(message.content, 'utf8') : total),
    0,
  );
  return (
    Buffer.byteLength(JSON.stringify(request.messages), 'utf8') +
    Buffer.byteLength(JSON.stringify(request.tools), 'utf8') +
    systemBytes
  );
}

function countImages(request: ChatRequest): number {
  let count = 0;
  for (const message of request.messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'image_url') count += 1;
    }
  }
  return count;
}

function budgetFailure(spentCny: number, maxCny: number): LlmFailure {
  return {
    class: 'cancelled',
    code: 'budget-exceeded',
    status: null,
    retriable: false,
    message:
      `预算不足：已花 ¥${spentCny.toFixed(6)} / 上限 ¥${maxCny.toFixed(6)}，` +
      '剩余额度不足以预留至少 2000 个输出 token；本次请求未发送。',
  };
}

/**
 * 包装一个 ChatClient：每次 complete 前做硬预算预留，并按每次 attempt 的 charge 结算花费。
 * 预算拒绝用 failed outcome 表达（不抛异常），调用方的重试 / 错误路径保持原样。
 */
export function withLiveBudget(client: ChatClient, options: LiveBudgetOptions): LiveBudgetClient {
  const auditDir = options.auditDir ?? DEFAULT_AUDIT_DIR;
  const label = options.label ?? 'live';
  const auditFile = join(auditDir, `${safeFileLabel(label)}.jsonl`);
  const now = options.now ?? ((): Date => new Date());

  let spentCny = 0;
  let prevPromptTokens = 0;
  let first = true;
  let auditReady = false;

  function writeAudit(record: AttemptRecord, costCny: number): void {
    try {
      if (!auditReady) {
        mkdirSync(auditDir, { recursive: true });
        auditReady = true;
      }
      appendFileSync(
        auditFile,
        `${JSON.stringify({
          ts: now().toISOString(),
          label,
          attempt: record.attempt,
          outcome: record.outcome,
          charge: record.charge,
          usage: record.usage,
          costCny,
        })}\n`,
        'utf8',
      );
    } catch {
      // 审计是旁路：磁盘不可写不应该打断设计会话；硬预算仍由内存计数保证。
    }
  }

  function account(record: AttemptRecord, reservedCny: number): void {
    let costCny = 0;
    if (record.charge === 'reserve') {
      // 收到 200 后断流 / 超时 / 解析失败：服务端可能已经计费，按本次 complete 的预留全额结算。
      costCny = reservedCny;
    } else if (record.charge === 'usage' && record.usage !== null) {
      costCny = costOfAttempt(record.usage);
    }
    spentCny += costCny;
    if (record.usage !== null) {
      prevPromptTokens = record.usage.prompt_tokens;
      // 只有拿到 usage 才认为首轮已结束；否则下一次仍按 first 多留 2048 token 的保守余量。
      first = false;
    }
    writeAudit(record, costCny);
  }

  return {
    get spentCny(): number {
      return spentCny;
    },

    async complete(request: ChatRequest, opts: CompleteOptions): Promise<ChatOutcome> {
      let guarded = request;

      // maxCny === 0 时仍调用 reserveFor：只用于给 charge='reserve' 的 attempt 一个审计上界，
      // 不拿它收敛 max_tokens，也不因为 stop 拒绝请求。
      const reserve = reserveFor({
        prevPromptTokens,
        first,
        newBytes: requestBytes(request),
        newMessages: request.messages.length,
        newImages: countImages(request),
        spentCny,
        limitCny: options.maxCny > 0 ? options.maxCny : Number.POSITIVE_INFINITY,
      });
      if ('stop' in reserve) {
        return { kind: 'failed', failure: budgetFailure(spentCny, options.maxCny) };
      }
      const reservedCny = reserve.reservedCny;

      if (options.maxCny > 0) {
        const maxTokens =
          request.max_tokens === undefined ? reserve.maxTokens : Math.min(request.max_tokens, reserve.maxTokens);
        guarded = { ...request, max_tokens: maxTokens };
      }

      const wrapped: CompleteOptions = {
        ...opts,
        beforeRetry: (info) => {
          // 先调用原回调（保留调用方的日志 / 停止语义），但预算 stop 优先。
          if (opts.beforeRetry(info) === 'stop') return 'stop';
          // 底层先问 beforeRetry、后 onAttempt 报告刚失败的 attempt：此时 spentCny 还不含刚失败的这次。
          // 用 (info.attempt + 1) 次预留做保守上界，确保允许下一次 attempt 后总花费不会越过上限。
          if (options.maxCny > 0 && spentCny + reservedCny * (info.attempt + 1) > options.maxCny) {
            return 'stop';
          }
          return 'continue';
        },
        onAttempt: (record) => {
          account(record, reservedCny);
          opts.onAttempt(record);
        },
      };
      return client.complete(guarded, wrapped);
    },
  };
}
