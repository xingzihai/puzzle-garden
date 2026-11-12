/**
 * mock 的 HTTP 层（MODEL-SPEC §6）：把"计划"变成真实形状的 Response（状态码、SSE 字节流、断流、挂起），
 * 以及测试用的虚拟时间。剧本 fetch（mock.ts）与回放 fetch（mock-replay.ts）共用。
 *
 * 负责：Response 与 ReadableStream 的构造；signal 取消时按 fetch 的约定以 AbortError 结束。
 * 不负责：决定回什么（mock.ts / mock-replay.ts）；SSE 字节的切法（mock-sse.ts）。
 */

import { createHash } from 'node:crypto';

import { mulberry32 } from '@pg/core/rng';

import { encodeSse } from './mock-sse.ts';

/** 回放退化取消：发完部分内容后若干毫秒内调用方没有再次取消，说明检测规则变了（§6.4）。 */
/** 剧本（或原 run 的尝试）已用尽仍有请求。 */
export class MockExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockExhausted';
  }
}

export class ReplayDiverged extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayDiverged';
  }
}

// ───────────────────────── 虚拟时间 ─────────────────────────

export interface VirtualTime {
  readonly clock: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 已登记、尚未到期的计时器数。 */
  pending(): number;
}

/**
 * 测试用虚拟时间：只有在所有微任务都跑完（进程里没有别的进展）时，才把时钟拨到最早的计时器并唤醒它。
 * mock fetch 的字节流只用微任务推进，所以"挂起"的流只能靠计时器（超时、空闲超时、退避）结束，测试不真实等待。
 */
export function createVirtualTime(start = 0): VirtualTime {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; id: number; fire: () => void }>();
  let driving = false;

  const drive = (): void => {
    if (driving) return;
    driving = true;
    setImmediate(() => {
      driving = false;
      const earliest = [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (earliest === undefined) return;
      timers.delete(earliest.id);
      now = Math.max(now, earliest.at);
      earliest.fire();
      if (timers.size > 0) drive();
    });
  };

  return {
    clock: () => now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        const id = nextId++;
        const onAbort = (): void => {
          timers.delete(id);
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        timers.set(id, {
          at: now + Math.max(0, ms),
          id,
          fire: () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
        });
        drive();
      }),
    pending: () => timers.size,
  };
}

function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError');
}

// ───────────────────────── 响应构造 ─────────────────────────

export type Plan =
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'network-error' }
  | { readonly kind: 'hang-before-headers' }
  | { readonly kind: 'stream'; readonly chunks: readonly Uint8Array[]; readonly end: StreamEnd };

type StreamEnd =
  | { readonly kind: 'close' }
  | { readonly kind: 'hang' }
  | { readonly kind: 'hang-then-diverge'; readonly afterMs: number; readonly message: string };

export interface PlanDeps {
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function respond(plan: Plan, signal: AbortSignal | null | undefined, deps: PlanDeps): Promise<Response> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  switch (plan.kind) {
    case 'status':
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: `mock HTTP ${String(plan.status)}` } }), {
          status: plan.status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    case 'network-error':
      return Promise.reject(new TypeError('fetch failed（mock：连接失败）'));
    case 'hang-before-headers':
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(abortError());
        });
      });
    case 'stream':
      return Promise.resolve(
        new Response(sseStream(plan.chunks, plan.end, signal, deps), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
  }
}

/** 逐块交出字节；之后按 end 关闭、挂起，或挂起若干毫秒后以 ReplayDiverged 出错。signal 取消时以 AbortError 出错。 */
function sseStream(
  chunks: readonly Uint8Array[],
  end: StreamEnd,
  signal: AbortSignal | null | undefined,
  deps: PlanDeps,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => {
        try {
          controller.error(abortError());
        } catch {
          // 流已经关闭：取消来得太晚，无事可做
        }
      });
    },
    async pull(controller) {
      const next = chunks[index];
      if (next !== undefined) {
        index += 1;
        controller.enqueue(next);
        return;
      }
      if (end.kind === 'close') {
        controller.close();
        return;
      }
      if (end.kind === 'hang-then-diverge' && deps.sleep !== undefined && signal !== null && signal !== undefined) {
        try {
          await deps.sleep(end.afterMs, signal);
        } catch {
          return; // 调用方在等待期间取消：与原 run 一致，流已由 abort 监听器置错
        }
        controller.error(new ReplayDiverged(end.message));
        return;
      }
      await new Promise<never>(() => undefined); // 挂起：只有 signal 取消能结束
    },
  });
}

/** 截取前 n 字节（跨块）。 */
export function takeBytes(chunks: readonly Uint8Array[], n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let left = n;
  for (const chunk of chunks) {
    if (left <= 0) break;
    out.push(chunk.subarray(0, Math.min(left, chunk.length)));
    left -= chunk.length;
  }
  return out;
}

export const encoder = new TextEncoder();

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function rngFor(seed: number, step: number): () => number {
  return mulberry32((seed ^ Math.imul(step + 1, 0x9e3779b1)) >>> 0);
}

function readBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== 'string')
    throw new TypeError('mock fetch 只接受字符串请求体（client 发送的是 serializeRequest 的结果）');
  return body;
}

/** 断流 / 挂起用的占位字节：一个部分响应（没有 finish_reason、usage 与 [DONE]），截到哪里都不完整。 */
export function placeholderChunks(rng: () => number): Uint8Array[] {
  const partial = {
    content: 'mock 占位内容，用于断流与挂起。',
    reasoning: '',
    arguments: [],
    timing: { firstByteMs: 0, totalMs: 0 },
  };
  return encodeSse(partial, rng, { id: 'mock-drop' });
}

/** 把"按请求体出计划"的函数包成 fetch；计划函数抛出的错（expect 不满足、strict 不一致）作为 fetch 的 rejection 交出。 */
export function planFetch(plan: (body: string) => Plan, deps: PlanDeps = {}): typeof fetch {
  return (_input, init) => {
    let p: Plan;
    try {
      p = plan(readBody(init));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return respond(p, init?.signal, deps);
  };
}
