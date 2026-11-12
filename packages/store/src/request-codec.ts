/**
 * 请求体去重存放（MODEL-SPEC §7.4、§9）。
 *
 * 负责：把 `ChatRequest` 拆成「请求清单 + 消息 blob + PNG blob」，以及由清单与 blob 逐字节还原请求体。
 *   - 每条消息用 store 的规范 JSON 单独存一份；图片块的 data URL 换成 `{"$png":"<sha256>"}`，PNG 另存；
 *   - 清单 = 请求里除 messages 外的字段 + 各消息 blob 的 sha256；
 *   - 还原时先用 `@pg/llm/schema` 的 `serializeRequest` 序列化，保证与原始请求体逐字节相同。
 * 不负责：落盘与 sha256 实现（run-dir.ts / blobs.ts，两者注入 hash 与读取函数）。
 * 本文件是纯函数：不做 I/O，不读全局可变状态。
 */

import { ChatRequest, ChatRequestParams, Message, serializeRequest } from '@pg/llm/schema';
import { z } from 'zod';

import { canonicalJson } from './canonical-json.ts';

const PNG_PREFIX = 'data:image/png;base64,';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 由调用方注入的 sha256（十六进制小写），避免纯函数文件依赖 `node:crypto`。 */
export type Sha256 = (bytes: Uint8Array) => string;

/** 请求清单（MODEL-SPEC §7.4）：除 messages 外的参数，加各消息 blob 的 sha256。 */
export const RequestManifest = z.strictObject({
  params: ChatRequestParams,
  messages: z.array(z.string().regex(SHA256_PATTERN)).min(1),
});
export type RequestManifest = z.infer<typeof RequestManifest>;

export interface EncodedBlob {
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface EncodedRequest {
  readonly manifest: RequestManifest;
  /** 需要落盘的 blob（消息规范 JSON 与 PNG 原始字节），已按 sha256 去重。 */
  readonly blobs: readonly EncodedBlob[];
}

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Uint8Array → base64；分块避免 `String.fromCharCode(...arr)` 的参数上限。 */
function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x2000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 把消息里的图片块换成 `{$png: sha}`，并把 PNG 原始字节收进 `pngs`（保持数组顺序）。 */
function extractPngs(value: unknown, pngs: EncodedBlob[], hash: Sha256): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => extractPngs(item, pngs, hash));
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    if (record['type'] === 'image_url' && typeof record['image_url'] === 'object' && record['image_url'] !== null) {
      const image = record['image_url'] as Readonly<Record<string, unknown>>;
      const url = image['url'];
      if (typeof url === 'string' && url.startsWith(PNG_PREFIX)) {
        const bytes = base64ToBytes(url.slice(PNG_PREFIX.length));
        const sha256 = hash(bytes);
        pngs.push({ sha256, bytes });
        return { $png: sha256 };
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = extractPngs(item, pngs, hash);
    return out;
  }
  return value;
}

/** 把存储形态的 `{$png: sha}` 还原成图片块。 */
function restorePngs(value: unknown, read: (sha256: string) => Uint8Array): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => restorePngs(item, read));
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const sha256 = record['$png'];
    if (typeof sha256 === 'string') {
      return { type: 'image_url', image_url: { url: `${PNG_PREFIX}${bytesToBase64(read(sha256))}` } };
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = restorePngs(item, read);
    return out;
  }
  return value;
}

/**
 * 把请求拆成清单与 blob 列表。请求先按 `ChatRequest` 校验；同一消息或同一 PNG 在本请求内只出现一次。
 */
export function encodeRequest(request: ChatRequest, hash: Sha256): EncodedRequest {
  const parsed = ChatRequest.parse(request);
  const blobs = new Map<string, EncodedBlob>();
  const messages: string[] = [];
  for (const message of parsed.messages) {
    const pngs: EncodedBlob[] = [];
    const stored = canonicalJson(extractPngs(message, pngs, hash));
    const bytes = utf8Encode(stored);
    const sha256 = hash(bytes);
    blobs.set(sha256, { sha256, bytes });
    messages.push(sha256);
    for (const png of pngs) blobs.set(png.sha256, png);
  }
  const params = RequestManifest.shape.params.parse({
    model: parsed.model,
    tools: parsed.tools,
    thinking: parsed.thinking,
    max_tokens: parsed.max_tokens,
    reasoning_effort: parsed.reasoning_effort,
    ...(parsed.response_format === undefined ? {} : { response_format: parsed.response_format }),
    stream: parsed.stream,
    stream_options: parsed.stream_options,
  });
  return { manifest: { params, messages }, blobs: [...blobs.values()] };
}

/**
 * 由清单与 blob 读取函数重建 `ChatRequest`。文件缺失由 `read` 抛错，不静默补默认值。
 */
export function decodeRequest(
  manifest: RequestManifest,
  read: (sha256: string) => Uint8Array,
): z.infer<typeof ChatRequest> {
  const parsed = RequestManifest.parse(manifest);
  const messages = parsed.messages.map((sha256) =>
    Message.parse(restorePngs(JSON.parse(utf8Decode(read(sha256))) as unknown, read)),
  );
  return ChatRequest.parse({ ...parsed.params, messages });
}

/** 还原后的请求体文本；与原始 `serializeRequest` 逐字节相同（MODEL-SPEC §7.4）。 */
export function serializeDecoded(manifest: RequestManifest, read: (sha256: string) => Uint8Array): string {
  return serializeRequest(decodeRequest(manifest, read));
}
