/**
 * 报告超限时的截断（SANDBOX-SPEC §5.3）：报告（UTF-8 JSON）超过 `reportBytes` 时，把 `overlaps`
 * 截为前 256 项（保持原排序）并加 `overlapsTruncated`，完整合成的 overlapSummary 原样保留。
 * 让宿主仍能拿到调用数与测量，不必整轮归 `crashed`。
 *
 * 负责：纯截断计算与字节数；不负责：编帧（frame.ts）、schema（protocol.ts）、超限判定与分类（宿主 run.ts）。
 * 本文件是纯函数：不读 I/O。
 */
import type { ChildReport } from './protocol.ts';

/** 报告超限时 `overlaps` 保留的条数；改这里要同步 SANDBOX-SPEC §5.3 与 AGENT-SPEC §5。 */
export const OVERLAPS_KEPT = 256;

const encoder = new TextEncoder();

/** 报告 UTF-8 JSON 字节数；与 `encodeFrame` 的编码口径一致（STANDARDS §3）。 */
export function reportByteLength(report: ChildReport): number {
  return encoder.encode(JSON.stringify(report)).length;
}

/**
 * 报告超过 `limitBytes` 时截断 `overlaps` 到前 256 项，累加 `overlapsTruncated`（正整数）。
 * 未超限原样返回；超限但 `overlaps` 已 ≤ 256（例如 console 过大）时无法再缩，也原样返回，
 * 由宿主按超限归 `crashed`（保持既有行为）。
 */
export function limitReport(report: ChildReport, limitBytes: number): ChildReport {
  if (reportByteLength(report) <= limitBytes) return report;
  const kept = report.overlaps.slice(0, OVERLAPS_KEPT);
  const dropped = report.overlaps.length - kept.length;
  if (dropped <= 0) return report;
  return { ...report, overlaps: kept, overlapsTruncated: (report.overlapsTruncated ?? 0) + dropped };
}
