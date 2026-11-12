/**
 * 执行帧的编解码（SANDBOX-SPEC §5.3）：magic `PGSB` + u16 协议版本 + u16 保留 + 报告 + 存档。
 * 全部小端；帧后不能有多余字节。
 *
 * 负责：唯一的字节形式与严格解析，结构性错误给出中文原因。
 * 不负责：报告 schema 与 hash 校验（run.ts 做）、存档内容（@pg/core/archive）。
 */
import type { ChildReport } from './protocol.ts';

const MAGIC = Uint8Array.of(0x50, 0x47, 0x53, 0x42); // 'PGSB'
const HEADER_BYTES = 12; // magic 4 · 协议 u16 · 保留 u16 · 报告长度 u32
export const FRAME_PROTOCOL_VERSION = 1;

// TextEncoder / TextDecoder 是全局，child 准备全局时会按白名单删除；在模块加载时（删除之前）
// 各建一个实例，运行期只用实例，不再碰全局（F1）。
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });

/** 编出整帧。报告用 UTF-8 JSON。 */
export function encodeFrame(report: ChildReport, archive: Uint8Array): Uint8Array {
  const reportBytes = ENCODER.encode(JSON.stringify(report));
  const total = HEADER_BYTES + reportBytes.length + 4 + archive.length;
  const out = new Uint8Array(total);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, FRAME_PROTOCOL_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, reportBytes.length, true);
  out.set(reportBytes, HEADER_BYTES);
  view.setUint32(HEADER_BYTES + reportBytes.length, archive.length, true);
  out.set(archive, HEADER_BYTES + reportBytes.length + 4);
  return out;
}

/** 结构解码结果；`ok: false` 表示帧不合法（归 `crashed`，§5.6）。 */
export type FrameDecode =
  | { readonly ok: true; readonly report: unknown; readonly reportLength: number; readonly archive: Uint8Array }
  | { readonly ok: false; readonly reason: string };

/** 严格解析帧：magic / 版本 / 保留位 / 两个长度 / 尾部不得多余。 */
export function decodeFrame(bytes: Uint8Array): FrameDecode {
  if (bytes.length < HEADER_BYTES) return { ok: false, reason: `帧只有 ${String(bytes.length)} 字节，短于头部` };
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) return { ok: false, reason: '帧 magic 不是 PGSB' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== FRAME_PROTOCOL_VERSION) return { ok: false, reason: `帧协议版本是 ${String(version)}` };
  if (view.getUint16(6, true) !== 0) return { ok: false, reason: '帧保留字段不为 0' };
  const reportLength = view.getUint32(8, true);
  const reportEnd = HEADER_BYTES + reportLength;
  if (reportEnd + 4 > bytes.length) return { ok: false, reason: '报告长度超出帧' };
  const archiveLength = view.getUint32(reportEnd, true);
  const expected = reportEnd + 4 + archiveLength;
  if (expected !== bytes.length) {
    return { ok: false, reason: `帧长度 ${String(bytes.length)} 与声明的 ${String(expected)} 不符` };
  }
  let report: unknown;
  try {
    report = JSON.parse(DECODER.decode(bytes.subarray(HEADER_BYTES, reportEnd)));
  } catch {
    return { ok: false, reason: '报告不是合法 UTF-8 JSON' };
  }
  return { ok: true, report, reportLength, archive: bytes.subarray(reportEnd + 4) };
}
