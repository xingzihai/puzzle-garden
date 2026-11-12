/**
 * `@pg/sandbox/precheck` 的公开入口：在常驻 worker 线程里跑类型预检，宿主侧负责
 * 代码大小上限、墙钟超时、OOM 后重建 worker 与调用串行化。
 */
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import ts from 'typescript';

import { SandboxError } from './errors.ts';
import { MAX_CODE_BYTES, workerReadySchema, workerResponseSchema } from './protocol.ts';
import type { PrecheckResult, WorkerRequest } from './protocol.ts';
import { RULES_VERSION } from './rules.ts';
import type { EntryText } from './rules.ts';

/** 预检墙钟默认值；病态类型在 10 s 内没结果就不值得等（§3.5）。 */
const DEFAULT_TIMEOUT_MS = 10_000;
/** worker 的 V8 老生代上限；正常热进程约 150 MB，留 6 倍余量（§3.5）。 */
const MEMORY_LIMIT_MIB = 1024;
/** worker 栈上限；够 TypeScript 递归，同时让过深嵌套尽早抛 RangeError（§3.5）。 */
const STACK_SIZE_MB = 4;

export interface PrecheckOptions {
  readonly timeoutMs?: number;
  /** 全局声明 shim；建模预检用它把 `Model` 桥接成全局。缺省为 world API。 */
  readonly globalsText?: string;
  /** 入口规则文案；建模预检用它把错误信息写成 `build(model: Model)`。缺省为 world API。 */
  readonly entry?: EntryText;
  /**
   * 类型级入口核对的目标参数类型名（建模为 `Model`）；给出时核对入口能接收该类型且返回 void。
   * 缺省不核对，world 预检行为不变。
   */
  readonly expectedEntryType?: string;
}

export interface Prechecker {
  readonly check: (code: string) => Promise<PrecheckResult>;
  /** sha256(world.d.ts + typescript 版本 + 预检规则版本)；进第 9 步的事件流。 */
  readonly version: string;
  readonly close: () => Promise<void>;
}

function computeVersion(declaration: string, options: PrecheckOptions): string {
  const hash = createHash('sha256')
    .update(declaration, 'utf8')
    .update('\u0000', 'utf8')
    .update(ts.version, 'utf8')
    .update('\u0000', 'utf8')
    .update(String(RULES_VERSION), 'utf8');
  // globalsText / entry 只在提供时纳入：world 预检（都不传）的 version 与历史逐字相同。
  if (options.globalsText !== undefined) hash.update('\u0000', 'utf8').update(options.globalsText, 'utf8');
  if (options.entry !== undefined) {
    hash
      .update('\u0000', 'utf8')
      .update(options.entry.signature, 'utf8')
      .update('\u0000', 'utf8')
      .update(options.entry.paramLabel, 'utf8');
  }
  if (options.expectedEntryType !== undefined) {
    hash.update('\u0000', 'utf8').update(options.expectedEntryType, 'utf8');
  }
  return hash.digest('hex');
}

function workerErrorCode(error: Error): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export function createPrechecker(declaration: string, options: PrecheckOptions = {}): Prechecker {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const version = computeVersion(declaration, options);
  let worker: Worker | null = null;
  /** worker 建好运行时并预热完成的就绪 promise；超时 / 退出后置 null（F7）。 */
  let ready: Promise<void> | null = null;
  let nextId = 1;
  let closed = false;
  // 明确串行化：线程内一次只检查一份代码（§3.5）。用闭包变量而不是模块级 let（STANDARDS §2）。
  let queue: Promise<void> = Promise.resolve();

  function spawn(): Worker {
    let target: Worker;
    try {
      target = new Worker(new URL('./precheck-worker.ts', import.meta.url), {
        workerData: {
          declaration,
          ...(options.globalsText === undefined ? {} : { globalsText: options.globalsText }),
          ...(options.entry === undefined ? {} : { entry: options.entry }),
          ...(options.expectedEntryType === undefined ? {} : { expectedEntryType: options.expectedEntryType }),
        },
        resourceLimits: { maxOldGenerationSizeMb: MEMORY_LIMIT_MIB, stackSizeMb: STACK_SIZE_MB },
      });
    } catch (error) {
      throw new SandboxError(
        'spawn-failed',
        `无法启动预检线程：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    worker = target;
    ready = new Promise<void>((resolveReady, rejectReady) => {
      const onReady = (raw: unknown): void => {
        if (!workerReadySchema.safeParse(raw).success) return;
        cleanup();
        resolveReady();
      };
      const onExit = (): void => {
        cleanup();
        discard(target);
        rejectReady(new SandboxError('internal', '预检线程在就绪前退出。'));
      };
      const onError = (error: Error): void => {
        cleanup();
        discard(target);
        rejectReady(error);
      };
      const cleanup = (): void => {
        target.off('message', onReady);
        target.off('exit', onExit);
        target.off('error', onError);
      };
      target.on('message', onReady);
      target.once('exit', onExit);
      target.once('error', onError);
    });
    // runOnce 会消费这个拒绝；再挂一个空 catch，避免无人等待时出现未处理的拒绝。
    ready.catch(() => undefined);
    return target;
  }

  function ensureWorker(): Worker {
    if (worker === null) return spawn();
    return worker;
  }

  /** 当前 worker 已被判定不可用：清空引用，下一次请求重建（F7）。 */
  function discard(target: Worker): void {
    if (worker === target) {
      worker = null;
      ready = null;
    }
  }

  // 创建即预热：worker 在后台加载 typescript、建运行时并空跑一次（§3.5），就绪后才开始超时计时。
  spawn();

  function runOnce(code: string): Promise<PrecheckResult> {
    const target = ensureWorker();
    const readiness = ready ?? Promise.resolve();
    // 超时从 worker 就绪后开始：重建 worker 的启动 / 预热时间不计入请求（F7）。
    return readiness.then(
      () =>
        new Promise<PrecheckResult>((resolve, reject) => {
          const id = nextId++;
          let settled = false;
          const finish = (action: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            target.off('message', onMessage);
            target.off('exit', onExit);
            target.off('error', onError);
            action();
          };
          const timer = setTimeout(() => {
            discard(target);
            void target.terminate();
            finish(() => {
              resolve({ kind: 'timeout', limitMs: timeoutMs });
            });
          }, timeoutMs);
          const onMessage = (raw: unknown): void => {
            // 就绪消息可能先到；不是本请求的响应，忽略。
            if (workerReadySchema.safeParse(raw).success) return;
            const parsed = workerResponseSchema.safeParse(raw);
            if (!parsed.success) {
              finish(() => {
                reject(new SandboxError('protocol-error', '预检线程返回了不合协议的消息。'));
              });
              return;
            }
            const message = parsed.data;
            if (message.id !== id) return;
            finish(() => {
              if (message.ok) resolve(message.result);
              else reject(new SandboxError('invalid-declaration', message.error.message));
            });
          };
          const onExit = (): void => {
            discard(target);
            finish(() => {
              reject(new SandboxError('internal', '预检线程在返回结果前退出。'));
            });
          };
          const onError = (error: Error): void => {
            discard(target);
            if (workerErrorCode(error) === 'ERR_WORKER_OUT_OF_MEMORY') {
              finish(() => {
                resolve({ kind: 'out-of-memory', limitMiB: MEMORY_LIMIT_MIB });
              });
            } else {
              finish(() => {
                reject(new SandboxError('internal', `预检线程异常：${error.message}`));
              });
            }
          };
          target.on('message', onMessage);
          target.on('exit', onExit);
          target.on('error', onError);
          const request: WorkerRequest = { id, code };
          target.postMessage(request);
        }),
    );
  }

  function check(code: string): Promise<PrecheckResult> {
    if (closed) return Promise.reject(new SandboxError('internal', '预检器已关闭。'));
    const bytes = Buffer.byteLength(code, 'utf8');
    if (bytes > MAX_CODE_BYTES) return Promise.resolve({ kind: 'too-large', bytes, limit: MAX_CODE_BYTES });
    const run = queue.then(() => runOnce(code));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function close(): Promise<void> {
    closed = true;
    const target = worker;
    worker = null;
    if (target !== null) await target.terminate();
  }

  return { check, close, version };
}

export { SandboxError } from './errors.ts';
export type { Diagnostic, PrecheckResult } from './protocol.ts';
