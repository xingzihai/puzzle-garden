/**
 * 执行结果分类（SANDBOX-SPEC §5.6）：按退出码、stderr、超时、输出上限与已解析的报告归到
 * `ok` / `build-error` / `timeout` / `out-of-memory` / `output-too-large` / `crashed` 之一。
 *
 * `protocol-error` 不在这里：它只用于宿主或 sandbox 自身的缺陷（报告不合 schema、hash 不一致、
 * 存档读不回），由 run.ts 抛 SandboxError（§5.6、§6）。
 * 不负责：启动、读流、解码帧。
 */
import type { ChildReport } from './protocol.ts';

export type OutcomeKind = 'ok' | 'build-error' | 'timeout' | 'out-of-memory' | 'output-too-large' | 'crashed';

export interface ClassifyInput {
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly stderrHead: string;
  /** 帧结构合法且报告过 schema 时的报告；否则 null（缺失或损坏的帧归 crashed）。 */
  readonly report: ChildReport | null;
  readonly reportOverLimit: boolean;
  readonly archiveOverLimit: boolean;
}

/** 只按退出码判 OOM；bwrap 把结束方式透传为退出码，signal 恒为 null（§5.6）。 */
function isOutOfMemory(exitCode: number | null, stderrHead: string): boolean {
  if (exitCode === 134 && stderrHead.includes('heap out of memory')) return true;
  if (exitCode === 133 && stderrHead.includes('Fatal process out of memory')) return true;
  return false;
}

export function classifyOutcome(input: ClassifyInput): OutcomeKind {
  if (input.timedOut) return 'timeout';
  if (input.reportOverLimit) return 'crashed';
  if (input.archiveOverLimit) return 'output-too-large';
  if (isOutOfMemory(input.exitCode, input.stderrHead)) return 'out-of-memory';
  if (input.report === null) return 'crashed';
  if (input.report.status === 'build-error') return 'build-error';
  if (input.exitCode !== 0) return 'crashed';
  return 'ok';
}
