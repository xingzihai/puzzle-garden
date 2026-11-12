/**
 * run 目录（MODEL-SPEC §7.1、§7.2、§8）。
 *
 * 负责：`.work/runs/<runId>/` 的建目录、`events.jsonl` 追加与读回（校验 seq 连续与 body schema）、
 *       blob 读写、交付文件落盘；写入前做路径白名单、单行大小与密钥/data:image 扫描。
 * 不负责：事件的业务语义（agent 的 runner）、请求编码（request-codec.ts）、trace 派生（derive.ts）。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

import type { z } from 'zod';

import { createBlobStore } from './blobs.ts';
import {
  clampEventBody,
  EVENT_SCHEMAS,
  EVENTS_SCHEMA_VERSION,
  parseEvent,
  type Event,
  type EventBody,
  type EventType,
  type Ref,
} from './events.ts';
import { RequestManifest, serializeDecoded } from './request-codec.ts';

/** 单行事件上限（MODEL-SPEC §7.2）。 */
export const MAX_EVENT_BYTES = 256 * 1024;

const SK_PATTERN = /sk-[A-Za-z0-9_-]{16,}/;

export interface DeliveryFile {
  /** 相对 `delivery/` 的路径，用 `/` 分隔。 */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface RunWriter {
  readonly dir: string;
  readonly runId: string;
  /** 校验并追加一条事件，返回它的 seq。 */
  append<T extends EventType>(type: T, turn: number | null, body: EventBody<T>): number;
  putBlob(bytes: Uint8Array): Ref;
  writeDelivery(files: readonly DeliveryFile[]): void;
  close(): void;
}

export interface RunReader {
  readonly dir: string;
  /** 读全部事件；seq 必须从 0 连续递增，schema 与末行完整性都在这里校验。 */
  events(): readonly Event[];
  blob(sha256: string): Uint8Array;
  /** 还原 seq 处的 `llm.request` 请求体字节（MODEL-SPEC §7.4、§8）。 */
  request(seq: number): Uint8Array;
}

/** 路径片段白名单：拒绝空、`.`、`..`、分隔符与控制字符（STANDARDS §7）。 */
function assertSafeSegment(segment: string, what: string): void {
  let hasControl = false;
  for (let i = 0; i < segment.length; i += 1) {
    if (segment.charCodeAt(i) < 0x20) {
      hasControl = true;
      break;
    }
  }
  if (segment === '' || segment === '.' || segment === '..' || /[/\\]/.test(segment) || hasControl) {
    throw new Error(`${what} 含非法路径片段：${JSON.stringify(segment)}`);
  }
}

/** 写入前扫描：单行过大、data:image、疑似 API key 都拒绝（MODEL-SPEC §7.2）。 */
function assertLineSafe(line: string): void {
  if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
    throw new Error(`事件行超过 ${String(MAX_EVENT_BYTES)} 字节：大对象应先 putBlob，事件里只放 { sha256, bytes }`);
  }
  if (line.includes('data:image')) throw new Error('事件行含 data:image：图片应只存 blob，事件里放引用');
  if (SK_PATTERN.test(line)) throw new Error('事件行疑似含 API key（sk- 长串）：拒绝写入');
}

export function createRunDir(root: string, runId: string): RunWriter {
  assertSafeSegment(runId, 'runId');
  const dir = join(root, runId);
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  const store = createBlobStore(join(dir, 'blobs'));
  const eventsPath = join(dir, 'events.jsonl');
  let fd: number | null = null;
  let nextSeq = 0;

  return {
    dir,
    runId,
    append<T extends EventType>(type: T, turn: number | null, body: EventBody<T>): number {
      // 模型 / 编译器 / 渲染输出可能超长；先按记录层上限截断，保证任何输入都不会让 append 抛错。
      const clamped = clampEventBody(type, body);
      // 各 schema 的 parse 联合签名互不兼容；按基础 ZodType 调用，入参是 unknown，安全。
      const parsed: unknown = (EVENT_SCHEMAS[type] as z.ZodType).parse(clamped);
      const seq = nextSeq;
      const line = JSON.stringify({
        v: EVENTS_SCHEMA_VERSION,
        seq,
        ts: new Date().toISOString(),
        runId,
        turn,
        type,
        body: parsed,
      });
      assertLineSafe(line);
      fd ??= openSync(eventsPath, 'a');
      writeSync(fd, `${line}\n`);
      nextSeq += 1;
      return seq;
    },
    putBlob(bytes: Uint8Array): Ref {
      return store.put(bytes);
    },
    writeDelivery(files: readonly DeliveryFile[]): void {
      const base = join(dir, 'delivery');
      for (const file of files) {
        const segments = file.path.split('/');
        for (const segment of segments) assertSafeSegment(segment, `delivery 路径 ${file.path}`);
        const target = join(base, ...segments);
        const rel = relative(base, target);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`delivery 路径越出目录：${file.path}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.bytes);
      }
    },
    close(): void {
      if (fd !== null) {
        closeSync(fd);
        fd = null;
      }
    },
  };
}

export function openRunDir(dir: string): RunReader {
  const eventsPath = join(dir, 'events.jsonl');
  const store = createBlobStore(join(dir, 'blobs'));
  let cached: readonly Event[] | null = null;

  const load = (): readonly Event[] => {
    if (cached !== null) return cached;
    if (!existsSync(eventsPath)) throw new Error(`events.jsonl 不存在：${eventsPath}`);
    const text = readFileSync(eventsPath, 'utf8');
    if (text.length > 0 && !text.endsWith('\n')) {
      throw new Error(`events.jsonl 第 ${String(text.split('\n').length)} 行不完整（进程被杀或写入被截断）`);
    }
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const events: Event[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const lineNo = index + 1;
      if (line.trim() === '') throw new Error(`events.jsonl 第 ${String(lineNo)} 行为空`);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `events.jsonl 第 ${String(lineNo)} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      let event: Event;
      try {
        event = parseEvent(value);
      } catch (error) {
        throw new Error(
          `events.jsonl 第 ${String(lineNo)} 行：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (event.seq !== index) {
        throw new Error(`events.jsonl 第 ${String(lineNo)} 行的 seq=${String(event.seq)}，应为 ${String(index)}`);
      }
      events.push(event);
    }
    cached = events;
    return events;
  };

  return {
    dir,
    events: load,
    blob(sha256: string): Uint8Array {
      return store.get(sha256);
    },
    request(seq: number): Uint8Array {
      const event = load().find((candidate) => candidate.seq === seq && candidate.type === 'llm.request');
      if (event?.type !== 'llm.request') throw new Error(`seq=${String(seq)} 不是 llm.request 事件`);
      const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(store.get(event.body.manifest.sha256));
      const manifest = RequestManifest.parse(JSON.parse(manifestText) as unknown);
      return new TextEncoder().encode(serializeDecoded(manifest, (sha256) => store.get(sha256)));
    },
  };
}
