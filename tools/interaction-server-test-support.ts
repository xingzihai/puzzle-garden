import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunOutcome } from '@pg/agent/runner';
import { exampleRequirements } from '@pg/interaction/example';
import type { ReviewReport } from '@pg/interaction/review';
import { RequirementGraph } from '@pg/interaction/schema';
import type { BuildBrief, RequirementGraph as RequirementGraphType } from '@pg/interaction/schema';
import type { DesignIntent } from '@pg/interaction/design-intent';
import type { SessionState } from '@pg/interaction/session';
import type { ArtifactPaths, SessionStoreOptions } from '@pg/interaction/store';
import type { SubmissionOutputMode } from '@pg/interaction/generate';
import type { ChatClient } from '@pg/llm/client';
import type { ChatRequest } from '@pg/llm/schema';
import { EVENTS_SCHEMA_VERSION } from '@pg/store/events';

import type { DesignBuildEvent } from './design-build-runner.ts';
import type {
  WebBuildState,
  WebBuildStarter,
  WebBuildStarterInput,
  WebReviewBuilder,
} from './interaction-server-session.ts';
import { startInteractionServer } from './interaction-server-core.ts';
import type { InteractionServerOptions, RunningInteractionServer } from './interaction-server-core.ts';
import { createMockClient } from './interaction-server-mock.ts';

export interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  readonly buffer: Buffer;
}

export interface SessionBody {
  readonly id: string;
  readonly mode: string;
  readonly status: string;
  readonly stage: string;
  readonly brief: string;
  readonly messages: readonly { readonly role: string; readonly text: string }[];
  readonly questions: readonly { readonly id: string; readonly text: string }[];
  readonly summary: {
    readonly title: string;
    readonly concept: string;
    readonly scope: string;
    readonly scopeLabel: string;
    readonly rooms: readonly string[];
    readonly musts: readonly string[];
    readonly open: readonly string[];
    readonly decisions: readonly string[];
    readonly schemeId: string;
    readonly revision: number;
  } | null;
  readonly previews: readonly { readonly name: string; readonly title: string; readonly url: string }[];
  readonly artifacts: ArtifactPaths | null;
  readonly error: string | null;
  readonly review: ReviewReport | null;
  readonly reviewStale: boolean;
  readonly reviewError: string | null;
  readonly confirmed: boolean;
  readonly confirmedDesignRevision: number | null;
  readonly canStartBuild: boolean;
  readonly canExit: boolean;
  readonly revisions: number;
  readonly checkIssues: readonly string[];
  readonly decisionKind: string | null;
  readonly briefStats: {
    readonly designChars: number;
    readonly taskChars: number;
    readonly gates: readonly string[];
  } | null;
  readonly buildCommand: string;
  readonly build: WebBuildState;
  readonly progressSeq: number;
}

export interface StoredSession {
  readonly stage: string;
  readonly requirements: { readonly revision: number } | null;
  readonly questions: readonly unknown[];
  readonly designs: readonly { readonly meta: { readonly revision: number; readonly status: string } }[];
}

/**
 * 测试进程由 tools/test-no-network.ts 把全局 fetch 换成“直接抛错”，
 * 所以本地回环 API 用 node:http 请求；不触碰任何真实外网。
 */
export function send(
  url: string,
  options: {
    readonly method?: string;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = options.body;
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'GET',
        headers: {
          Connection: 'close',
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: buffer.toString('utf8'),
            buffer,
          });
        });
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export async function postJson(url: string, value: unknown): Promise<HttpResult> {
  return send(url, { method: 'POST', body: JSON.stringify(value) });
}

export function asSession(value: unknown): SessionBody {
  return value as SessionBody;
}

export async function getSession(server: RunningInteractionServer, id: string): Promise<SessionBody> {
  const response = await send(`${server.url}/api/sessions/${id}`);
  assert.equal(response.status, 200);
  return asSession(parseJson(response.text));
}

export async function waitForSession(
  server: RunningInteractionServer,
  id: string,
  predicate: (session: SessionBody) => boolean,
  timeoutMs = 10_000,
): Promise<SessionBody> {
  const deadline = Date.now() + timeoutMs;
  let last: SessionBody | null = null;
  while (Date.now() < deadline) {
    const session = await getSession(server, id);
    last = session;
    if (predicate(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待会话状态超时；最后状态：${JSON.stringify(last)}`);
}

export interface SseEvent {
  readonly event: string;
  readonly id: string | null;
  readonly data: Record<string, unknown>;
}

export interface SseConnection {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly events: readonly SseEvent[];
  waitFor(predicate: (event: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  close(): Promise<void>;
}

/** 本地回环 SSE 客户端：只用于测试，不走 fetch（测试进程禁网）。 */
export function openSse(url: string, headers: Readonly<Record<string, string>> = {}): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { Accept: 'text/event-stream', Connection: 'keep-alive', ...headers },
      },
      (response) => {
        const events: SseEvent[] = [];
        const waiters: {
          readonly predicate: (event: SseEvent) => boolean;
          readonly resolve: (event: SseEvent) => void;
          readonly reject: (error: Error) => void;
          readonly timer: NodeJS.Timeout;
        }[] = [];
        let buffer = '';
        let responseClosed = false;
        const finishWaiters = (): void => {
          for (const waiter of [...waiters]) {
            const found = events.find(waiter.predicate);
            if (found === undefined) continue;
            clearTimeout(waiter.timer);
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(found);
          }
        };
        const consume = (block: string): void => {
          let event = 'message';
          let id: string | null = null;
          const dataLines: string[] = [];
          for (const line of block.split('\n')) {
            if (line === '' || line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            let value = colon === -1 ? '' : line.slice(colon + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            if (field === 'event') event = value;
            else if (field === 'id') id = value;
            else if (field === 'data') dataLines.push(value);
          }
          if (dataLines.length === 0) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(dataLines.join('\n'));
          } catch {
            return;
          }
          if (!isRecordLike(parsed)) return;
          events.push({ event, id, data: parsed });
          finishWaiters();
        };
        response.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          for (;;) {
            const index = buffer.indexOf('\n\n');
            if (index === -1) break;
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            consume(block);
          }
        });
        response.on('end', () => {
          responseClosed = true;
          for (const waiter of [...waiters]) {
            clearTimeout(waiter.timer);
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.reject(new Error(`SSE 在等待事件时结束（HTTP ${String(response.statusCode ?? 0)}）`));
          }
        });
        response.on('error', (error) => {
          responseClosed = true;
          for (const waiter of [...waiters]) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
          }
          waiters.length = 0;
        });
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          events,
          waitFor(predicate, timeoutMs = 10_000) {
            const found = events.find(predicate);
            if (found !== undefined) return Promise.resolve(found);
            return new Promise<SseEvent>((resolveWait, rejectWait) => {
              const timer = setTimeout(() => {
                const index = waiters.findIndex((item) => item.timer === timer);
                if (index !== -1) waiters.splice(index, 1);
                rejectWait(
                  new Error(`等待 SSE 事件超时；已收到：${events.map((item) => item.event).join(', ') || '无'}`),
                );
              }, timeoutMs);
              waiters.push({ predicate, resolve: resolveWait, reject: rejectWait, timer });
            });
          },
          close() {
            for (const waiter of [...waiters]) {
              clearTimeout(waiter.timer);
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.reject(new Error('SSE 连接已关闭'));
            }
            request.destroy();
            if (responseClosed) return Promise.resolve();
            return new Promise<void>((resolveClose) => {
              response.once('close', () => {
                responseClosed = true;
                resolveClose();
              });
              response.destroy();
            });
          },
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

export function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ServerSetup {
  readonly mode?: 'mock' | 'live';
  readonly buildStarter?: WebBuildStarter;
  readonly reviewBuilder?: WebReviewBuilder;
  readonly outputMode?: SubmissionOutputMode;
  readonly onSubscriberCountChange?: (id: string, count: number) => void;
  readonly clientFactory?: () => ChatClient;
  readonly requests?: ChatRequest[];
  readonly maxCostCny?: number | null;
  readonly buildMaxCny?: number;
  readonly sessionWriter?: (state: SessionState, options?: SessionStoreOptions) => Promise<string>;
  readonly artifactWriter?: (dir: string, brief: BuildBrief, intent?: DesignIntent) => Promise<ArtifactPaths>;
}

export async function withServer<T>(
  requirements: RequirementGraphType,
  run: (server: RunningInteractionServer, root: string) => Promise<T>,
  setup: ServerSetup = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pg-interaction-web-'));
  const baseFactory = setup.clientFactory ?? (() => createMockClient({ requirements }));
  const clientFactory = (): ChatClient => {
    const client = baseFactory();
    if (setup.requests === undefined) return client;
    return {
      complete(request, options) {
        setup.requests?.push(request);
        return client.complete(request, options);
      },
    };
  };
  const options: InteractionServerOptions = {
    mode: setup.mode ?? 'mock',
    port: 0,
    sessionRoot: root,
    buildRunRoot: join(root, 'runs'),
    buildLog: () => undefined,
    clientFactory,
    ...(setup.buildStarter === undefined ? {} : { buildStarter: setup.buildStarter }),
    ...(setup.reviewBuilder === undefined ? {} : { reviewBuilder: setup.reviewBuilder }),
    ...(setup.outputMode === undefined ? {} : { outputMode: setup.outputMode }),
    ...(setup.onSubscriberCountChange === undefined ? {} : { onSubscriberCountChange: setup.onSubscriberCountChange }),
    ...(setup.maxCostCny === undefined ? {} : { maxCostCny: setup.maxCostCny }),
    ...(setup.buildMaxCny === undefined ? {} : { buildMaxCny: setup.buildMaxCny }),
    ...(setup.sessionWriter === undefined ? {} : { sessionWriter: setup.sessionWriter }),
    ...(setup.artifactWriter === undefined ? {} : { artifactWriter: setup.artifactWriter }),
  };
  const server = await startInteractionServer(options);
  try {
    return await run(server, root);
  } finally {
    await server.close();
    // 部分用例只等 build 启动、不等收尾；fake starter 可能仍在写 runs/ 下的文件，
    // 直接递归删除会偶发 ENOTEMPTY。给 rm 有界重试，避免把测试时序当成产品失败。
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

export function requirementsWithQuestion(): RequirementGraphType {
  return RequirementGraph.parse({
    ...exampleRequirements(),
    ambiguities: [
      {
        id: 'amb-entry',
        question: '入口放在北侧村道还是南侧稻田一侧？',
        options: ['北侧村道', '南侧稻田'],
        impact: 'high',
        suggestedDefault: '北侧村道进入，南侧保留看景开口',
        status: 'open',
        requirementIds: ['req-view'],
      },
    ],
  });
}

export async function createSession(server: RunningInteractionServer): Promise<SessionBody> {
  const response = await postJson(`${server.url}/api/sessions`, {
    brief: '在村口做一间能坐十个人的小茶室，南边能看见稻田，木石质感，预算克制。',
  });
  assert.equal(response.status, 201);
  const created = parseJson(response.text);
  assert.ok(typeof created === 'object' && created !== null && 'id' in created);
  const id = (created as { readonly id: unknown }).id;
  assert.equal(typeof id, 'string');
  return getSession(server, String(id));
}

export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

export function buildEvent<T extends DesignBuildEvent['type']>(
  type: T,
  turn: number | null,
  body: Extract<DesignBuildEvent, { readonly type: T }>['body'],
  seq: number,
): DesignBuildEvent {
  return { type, turn, body, seq } as DesignBuildEvent;
}

export interface FakeBuildOptions {
  readonly events?: readonly DesignBuildEvent[];
  readonly outcome?: Partial<RunOutcome>;
  readonly gate?: Promise<void>;
  readonly error?: Error;
  readonly pngNames?: readonly string[];
  /** 默认 true：把 events 写成 runDir/events.jsonl，供默认 review builder 读取。 */
  readonly writeEvents?: boolean;
}

export function fakeBuildStarter(options: FakeBuildOptions = {}): {
  readonly starter: WebBuildStarter;
  readonly calls: WebBuildStarterInput[];
} {
  const calls: WebBuildStarterInput[] = [];
  const starter: WebBuildStarter = async (input) => {
    calls.push(input);
    if (options.error !== undefined) throw options.error;
    const runId = `run-fake-${String(calls.length)}`;
    const runDir = join(input.outDir, runId);
    const renderDir = join(runDir, 'delivery', 'render');
    await mkdir(renderDir, { recursive: true });
    const names = options.pngNames ?? ['axon.png', 'plan.png'];
    for (const name of names) await writeFile(join(renderDir, name), PNG_BYTES);
    if (options.writeEvents !== false) {
      const lines = (options.events ?? []).map((event) =>
        JSON.stringify({
          v: EVENTS_SCHEMA_VERSION,
          seq: event.seq,
          ts: '1970-01-01T00:00:00.000Z',
          runId,
          turn: event.turn,
          type: event.type,
          body: event.body,
        }),
      );
      await writeFile(join(runDir, 'events.jsonl'), lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
    }
    input.onStart({ runId, runDir });
    for (const event of options.events ?? []) input.onEvent(event);
    if (options.gate !== undefined) await options.gate;
    const outcome: RunOutcome = {
      runId,
      dir: runDir,
      stopReason: null,
      delivery: { codeVersion: 1, hash: 'fake-hash' },
      costCny: 0.12,
      turns: 1,
      ...options.outcome,
    };
    return {
      outcome,
      runDir,
      delivery: outcome.delivery,
      renders: names.map((name) => join(renderDir, name)),
    };
  };
  return { starter, calls };
}

export function successEvents(): readonly DesignBuildEvent[] {
  const sha = 'a'.repeat(64);
  return [
    buildEvent('turn.start', 1, { elapsedMs: 0, spentCny: 0 }, 0),
    buildEvent(
      'tool.call',
      1,
      { callId: 'call-1', name: 'write_code', arguments: { sha256: sha, bytes: 10 }, parse: 'ok' },
      1,
    ),
    buildEvent(
      'check.result',
      1,
      {
        codeVersion: 1,
        codeSha: sha,
        seed: 0,
        precheck: { kind: 'ok' },
        run: {
          kind: 'ok',
          hash: 'fake-hash',
          cells: 10,
          bounds: [0, 0, 0, 1, 1, 1],
          calls: 1,
          overlaps: { sameLayer: 0, crossLayer: 0 },
          console: 0,
          wallMs: 10,
        },
      },
      2,
    ),
    buildEvent(
      'render.result',
      1,
      {
        purpose: 'deliver',
        kind: 'ok',
        wallMs: 10,
        images: [
          { view: 'axon', png: { sha256: sha, bytes: 2 }, pixelsPerCell: 1, frameFill: 1 },
          { view: 'plan', png: { sha256: sha, bytes: 2 }, pixelsPerCell: 1, frameFill: 1 },
        ],
      },
      3,
    ),
    buildEvent('submit', 1, { callId: 'call-1', codeVersion: 1, accepted: true }, 4),
    buildEvent(
      'run.end',
      1,
      {
        stopReason: null,
        totals: {
          turns: 1,
          requests: 1,
          attempts: 1,
          promptTokens: 1,
          hitTokens: null,
          missTokens: null,
          completionTokens: 1,
          reasoningTokens: 0,
          costCny: 0.12,
          wallMs: 100,
          images: 2,
          imageBytes: 2,
        },
      },
      5,
    ),
  ];
}

export async function createConfirmedSession(server: RunningInteractionServer): Promise<SessionBody> {
  const created = await createSession(server);
  await waitForSession(server, created.id, (session) => session.status === 'waiting_decision');
  const confirmed = await postJson(`${server.url}/api/sessions/${created.id}/decision`, { action: 'confirm' });
  assert.equal(confirmed.status, 200);
  return waitForSession(server, created.id, (session) => session.status === 'done');
}

export async function getBuild(server: RunningInteractionServer, id: string): Promise<WebBuildState> {
  const response = await send(`${server.url}/api/sessions/${id}/build`);
  assert.equal(response.status, 200);
  return parseJson(response.text) as WebBuildState;
}

export async function waitForBuild(
  server: RunningInteractionServer,
  id: string,
  predicate: (build: WebBuildState) => boolean,
  timeoutMs = 10_000,
): Promise<WebBuildState> {
  const deadline = Date.now() + timeoutMs;
  let last: WebBuildState | null = null;
  while (Date.now() < deadline) {
    const build = await getBuild(server, id);
    last = build;
    if (predicate(build)) return build;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待构建状态超时；最后状态：${JSON.stringify(last)}`);
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待条件超时');
}

export async function createSessionId(server: RunningInteractionServer): Promise<string> {
  const response = await postJson(`${server.url}/api/sessions`, {
    brief: '在村口做一间能坐十个人的小茶室，南边能看见稻田，木石质感，预算克制。',
  });
  assert.equal(response.status, 201);
  const created = parseJson(response.text);
  assert.ok(isRecordLike(created));
  const id = created['id'];
  assert.equal(typeof id, 'string');
  return String(id);
}
