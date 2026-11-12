/**
 * @pg/llm 的错误归一（MODEL-SPEC §5.2）。
 *
 * 负责：把各处的失败构造成 `LlmFailure`，并用 `LlmError` 携带它抛给调用方。
 * 不负责：判断哪些错可重试后的退避策略（client.ts 用 failure.retriable 与 code 决定）。
 * 本文件是纯函数：不做 I/O；message 必须已脱敏且 ≤ 400 字符（schema 会再校验一次）。
 */

import { LlmFailure } from './schema.ts';

export class LlmError extends Error {
  readonly failure: LlmFailure;

  constructor(failure: LlmFailure) {
    super(failure.message);
    this.name = 'LlmError';
    this.failure = failure;
  }
}

export function isLlmError(value: unknown): value is LlmError {
  return value instanceof LlmError;
}

const MAX_MESSAGE = 400;

function makeFailure(failure: LlmFailure): LlmFailure {
  return LlmFailure.parse({ ...failure, message: failure.message.slice(0, MAX_MESSAGE) });
}

/** DNS、连接被拒或重置、TLS；或响应头之前的超时、空闲超时。一律可重试、记 ¥0。 */
export function transportFailure(code: 'network' | 'timeout' | 'idle-timeout', message: string): LlmFailure {
  return makeFailure({ class: 'transport', code, status: null, retriable: true, message });
}

/** HTTP 错误码。429 与 5xx 可重试；其余 4xx 不可重试（402 余额不足要人处理）。 */
export function httpFailure(status: number): LlmFailure {
  if (status === 429) {
    return makeFailure({ class: 'http', code: 'http_429', status, retriable: true, message: 'HTTP 429：请求被限流' });
  }
  if (status >= 400 && status < 500) {
    return makeFailure({
      class: 'http',
      code: 'http_4xx',
      status,
      retriable: false,
      message: `HTTP ${String(status)}：请求被拒绝`,
    });
  }
  return makeFailure({
    class: 'http',
    code: 'http_5xx',
    status,
    retriable: true,
    message: `HTTP ${String(status)}：服务端故障或繁忙`,
  });
}

/** JSON 坏了、非法 UTF-8、[DONE] 后无 usage、多余数据等。不可重试。 */
export function invalidResponse(message: string, code = 'invalid-response'): LlmFailure {
  return makeFailure({ class: 'invalid-response', code, status: null, retriable: false, message });
}

/** 服务端以 `insufficient_system_resource` / `aborted` 结束，但带了 usage。按 usage 结算，可重试。 */
export function truncatedFailure(code: 'insufficient_system_resource' | 'aborted'): LlmFailure {
  return makeFailure({ class: 'truncated', code, status: null, retriable: true, message: `生成被中断：${code}` });
}

/** 调用方 signal 取消。不可重试，按预留全额结算。 */
export function cancelledFailure(): LlmFailure {
  return makeFailure({
    class: 'cancelled',
    code: 'cancelled',
    status: null,
    retriable: false,
    message: '调用方取消了请求',
  });
}
