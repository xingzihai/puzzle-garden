/**
 * worker 线程外壳：常驻一个线程持有 TypeScript 编译缓存，串行处理宿主发来的检查请求。
 * 只做消息接线；编译与规则逻辑在 worker-core.ts（可被主线程单测覆盖）。
 *
 * 线程启动时就把运行时建好并跑一次空检查预热（SANDBOX-SPEC §3.5）：createPrechecker 一创建就
 * 在后台付掉 worker 启动 + import typescript + 声明校验的约 0.45 s，首次真实 check 只余约 0.1 s。
 */
import { parentPort, workerData } from 'node:worker_threads';

import { SandboxError } from './errors.ts';
import { workerDataSchema, workerRequestSchema } from './protocol.ts';
import type { WorkerResponse } from './protocol.ts';
import { createPrecheckRuntime } from './worker-core.ts';
import type { PrecheckRuntime } from './worker-core.ts';

function errorResponse(id: number, error: unknown): WorkerResponse {
  const code =
    error instanceof SandboxError && error.code === 'invalid-declaration' ? 'invalid-declaration' : 'internal';
  return { ok: false, id, error: { code, message: error instanceof Error ? error.message : String(error) } };
}

function main(): void {
  const port = parentPort;
  if (port === null) return;
  const data = workerDataSchema.parse(workerData);
  let runtime: PrecheckRuntime | undefined;
  let startupError: unknown;
  try {
    runtime = createPrecheckRuntime(data.declaration, {
      ...(data.globalsText === undefined ? {} : { globalsText: data.globalsText }),
      ...(data.entry === undefined ? {} : { entry: data.entry }),
      ...(data.expectedEntryType === undefined ? {} : { expectedEntryType: data.expectedEntryType }),
    });
    // 预热：建一次 program 与诊断，让 V8 JIT 和声明 SourceFile 缓存先热。
    runtime.check('export default function build(w: World): void {}');
  } catch (error) {
    startupError = error;
  }

  // 无论建运行时是否成功都通知就绪：宿主据此才开始超时计时（F7）；失败时请求会收到错误响应。
  port.postMessage({ type: 'ready' });

  port.on('message', (raw: unknown) => {
    const request = workerRequestSchema.safeParse(raw);
    if (!request.success) return;
    const { id, code } = request.data;
    let response: WorkerResponse;
    if (runtime === undefined) {
      response = errorResponse(id, startupError ?? new Error('预检线程未就绪'));
    } else {
      try {
        response = { ok: true, id, result: runtime.check(code) };
      } catch (error) {
        response = errorResponse(id, error);
      }
    }
    port.postMessage(response);
  });
}

main();
