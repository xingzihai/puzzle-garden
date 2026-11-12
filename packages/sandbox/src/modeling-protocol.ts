/**
 * 建模隔离执行的宿主 / child 共享契约（docs/MODELING-SPEC.md §4）。
 *
 * 负责：child 输入（代码、种子、console 额度）、child 输出（成功文档 / 构建错误）、默认时长与
 * 输出上限、代码与文档的 sha256。宿主与 child 共用同一份 schema（STANDARDS §3）。
 * 不负责：进程管理、类型预检、结果分类（modeling.ts）、网格生成（@pg/modeling）。
 *
 * 与体素 child（protocol.ts）分开：建模输出是 JSON（ModelDocument），不是体素二进制帧，字段不复用。
 */
import { createHash } from 'node:crypto';

import { ModelDocument } from '@pg/modeling/schema';
import { z } from 'zod';

import { consoleEntrySchema } from './protocol.ts';

/** child 输入协议版本；输入结构变化时加 1。 */
export const MODEL_CHILD_PROTOCOL_VERSION = 1;
/** 默认墙钟上限（MODELING-SPEC §4）。 */
export const DEFAULT_MODEL_TIMEOUT_MS = 5000;
/** 默认输出上限 16 MiB（MODELING-SPEC §4）。 */
export const DEFAULT_MODEL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** 建模代码 UTF-8 字节上限 256 KiB；与体素预检同口径（MODELING-SPEC §4）。 */
export const MAX_MODEL_CODE_BYTES = 256 * 1024;
/** console 捕获额度；与体素 child 一致（SANDBOX-SPEC §5.4）。 */
export const MODEL_CONSOLE_BYTES = 8192;
/** 建模子进程的 stderr 诊断片段上限。 */
export const MODEL_STDERR_BYTES = 64 * 1024;

/** 宿主通过 stdin 写给 modeling-child 的一份 JSON。 */
export const modelChildInputSchema = z
  .strictObject({
    protocol: z.literal(MODEL_CHILD_PROTOCOL_VERSION),
    code: z.string().refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_MODEL_CODE_BYTES, {
      message: `代码超过 ${String(MAX_MODEL_CODE_BYTES)} 字节上限`,
    }),
    seed: z
      .int()
      .min(0)
      .max(2 ** 32 - 1),
    limits: z.strictObject({ consoleBytes: z.int().positive() }),
  })
  .readonly();
export type ModelChildInput = z.infer<typeof modelChildInputSchema>;

/** build 抛错时给模型看的位置；line / column 为 0 表示不在模型代码里。 */
export const modelChildErrorSchema = z
  .strictObject({
    name: z.string(),
    message: z.string(),
    line: z.int().min(0),
    column: z.int().min(0),
  })
  .readonly();
export type ModelChildError = z.infer<typeof modelChildErrorSchema>;

/**
 * modeling-child 写进 stdout 的报告。成功带完整 ModelDocument 与 documentHash；宿主用同一
 * schema 复验（内含 ModelDocument 二次校验）并复算 documentHash（MODELING-SPEC §4）。
 */
export const modelChildReportSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('ok'),
      document: ModelDocument,
      documentHash: z.string().min(1),
      console: z.array(consoleEntrySchema),
      consoleTruncated: z.int().min(0),
    })
    .readonly(),
  z
    .strictObject({
      status: z.literal('build-error'),
      error: modelChildErrorSchema,
      console: z.array(consoleEntrySchema),
      consoleTruncated: z.int().min(0),
    })
    .readonly(),
]);
export type ModelChildReport = z.infer<typeof modelChildReportSchema>;

/** 代码 sha256（UTF-8）；宿主据原始代码直接算。 */
export function hashModelCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * ModelDocument 的 sha256。child 与宿主都先经同一 zod schema 解析，键序稳定，序列化确定；
 * 宿主据此复验 child 报的 documentHash，防 child 输出与声明不符。
 */
export function hashModelDocument(document: ModelDocument): string {
  return createHash('sha256').update(JSON.stringify(document), 'utf8').digest('hex');
}
