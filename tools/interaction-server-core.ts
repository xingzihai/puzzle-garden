/**
 * 网页 demo 的 HTTP 服务：只监听 127.0.0.1，提供静态页面、JSON API、SVG 预览与请求体上限。
 *
 * 负责：路由、方法校验、1 MiB 请求体上限、路径穿越拒绝、静态资源与 JSON 响应头、
 *       本机服务的 Host / Origin 校验（防 DNS rebinding 与跨站请求伪造）。
 * 不负责：会话状态 / 模型调用 / 预览渲染（interaction-server-session.ts）、参数与 live 配置。
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';

import { HttpError, isRecord, messageOf, SessionManager } from './interaction-server-session.ts';
import type { SessionManagerOptions, WebProgressEvent } from './interaction-server-session.ts';

export type {
  WebBuildEvent,
  WebBuildRender,
  WebBuildState,
  WebBuildStatus,
  WebMessage,
  WebMode,
  WebSnapshot,
} from './interaction-server-session.ts';

export interface InteractionServerOptions extends SessionManagerOptions {
  readonly port: number;
  readonly bodyLimitBytes?: number;
}

export interface RunningInteractionServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const STATIC_FILES = new Map<string, string>([
  ['/', 'index.html'],
  ['/app.js', 'app.js'],
  ['/style.css', 'style.css'],
]);
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
};

function requiredText(body: Record<string, unknown>, key: string, label: string, max: number): string {
  const value = body[key];
  if (typeof value !== 'string') throw new HttpError(400, `${label} 必须是字符串。`);
  const text = value.trim();
  if (text === '') throw new HttpError(400, `${label} 不能为空。`);
  if (text.length > max) throw new HttpError(400, `${label} 过长（最多 ${String(max)} 字符）。`);
  return text;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, '路径包含非法转义。');
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > limit) {
      req.resume();
      reject(new HttpError(413, `请求体超过 ${String(limit)} 字节上限。`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: HttpError): void => {
      if (settled) return;
      settled = true;
      req.resume();
      reject(error);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, `请求体超过 ${String(limit)} 字节上限。`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      fail(new HttpError(400, `读取请求体失败：${messageOf(error)}`));
    });
  });
}

async function readJsonObject(
  req: IncomingMessage,
  limit: number,
  allowEmpty = false,
): Promise<Record<string, unknown>> {
  const body = await readBody(req, limit);
  if (allowEmpty && body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw new HttpError(400, `请求体不是合法 JSON：${messageOf(error)}`);
  }
  if (!isRecord(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象。');
  return parsed;
}

function wantsEventStream(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  if (accept === undefined) return false;
  return accept.split(',').some((part) => part.trim().toLowerCase().startsWith('text/event-stream'));
}

/**
 * 本机服务的 Host 白名单：只接受回环地址，端口必须是本次监听的端口。
 *
 * 没有这道校验时，外部域名可以解析到 127.0.0.1（DNS rebinding），浏览器仍认为
 * 请求同源，于是能读走全部会话（brief、对话、构建命令）。返回 421 而不是 403，
 * 是为了让"打到了错误主机"这件事在日志和测试里一眼可辨。
 */
function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const match = /^(?:\[([0-9a-fA-F:]+)\]|([^:]+))(?::(\d+))?$/.exec(host.trim());
  if (match === null) return false;
  const hostname = (match[1] ?? match[2] ?? '').toLowerCase();
  const portText = match[3];
  const effectivePort = portText === undefined ? 80 : Number(portText);
  if (effectivePort !== port) return false;
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/**
 * 跨站请求伪造：浏览器发出的跨站请求一定带 Origin，本机页面带的 Origin 必然命中白名单。
 * 命令行客户端（curl、测试）不发 Origin，因此"缺失"放行、"存在但不对"拒绝。
 */
function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  return hostAllowed(parsed.host, port);
}

/**
 * 只接受 JSON 的写请求。
 *
 * 这条挡住的是"简单请求"通道：`<form>`、`text/plain`、`multipart/form-data` 不触发
 * CORS 预检，可以打到任意本机端口。强制 JSON 后，跨站请求必须先过预检，而我们不发
 * CORS 头，预检必然失败。
 */
function jsonContentTypeAllowed(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return true;
  if ((req.headers['content-length'] ?? '0') === '0' && req.headers['transfer-encoding'] === undefined) return true;
  const raw = req.headers['content-type'];
  if (raw === undefined) return false;
  return /^application\/json(?:[ \t]*;|$)/i.test(raw.trim());
}

function lastEventIdOf(req: IncomingMessage): number | null {
  const header = req.headers['last-event-id'];
  const raw = Array.isArray(header) ? header[0] : header;
  let value = raw;
  if (value === undefined) {
    try {
      value = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('lastEventId') ?? undefined;
    } catch {
      value = undefined;
    }
  }
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

function sseFrame(event: string, data: unknown, id?: number): string {
  const idLine = id === undefined ? '' : `id: ${String(id)}\n`;
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

class InteractionHttpServer {
  private readonly manager: SessionManager;
  private readonly mode: SessionManagerOptions['mode'];
  private readonly bodyLimit: number;
  private readonly staticRoot: string;
  /** 实际监听端口；`port: 0` 时只有 listen 之后才确定，因此可变。 */
  private port: number;

  constructor(options: InteractionServerOptions) {
    this.manager = new SessionManager(options);
    this.mode = options.mode;
    this.bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
    this.staticRoot = join(import.meta.dirname, 'interaction-web');
    this.port = options.port;
  }

  /** 把系统分配的端口写回来，Host / Origin 校验要用它。 */
  setPort(port: number): void {
    this.port = port;
  }

  async ready(): Promise<void> {
    await this.manager.loadPersisted();
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.route(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        this.json(res, error.status, { error: error.message }, error.allow);
        return;
      }
      this.json(res, 500, { error: `服务器内部错误：${messageOf(error)}` });
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const host = req.headers.host;
    if (!hostAllowed(host, this.port)) {
      throw new HttpError(421, `拒绝服务的主机名：${host ?? '(缺失)'}。本服务只接受 127.0.0.1 / localhost。`);
    }
    if (!originAllowed(req.headers.origin, this.port)) {
      throw new HttpError(403, `拒绝跨站请求：Origin ${req.headers.origin ?? ''} 不在白名单。`);
    }
    if (!jsonContentTypeAllowed(req)) {
      throw new HttpError(415, '写请求必须使用 Content-Type: application/json。');
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      throw new HttpError(400, '请求路径不合法。');
    }

    const staticFile = STATIC_FILES.get(pathname);
    if (staticFile !== undefined) {
      if (method !== 'GET') throw new HttpError(405, '静态资源只允许 GET。', 'GET');
      const raw = await readFile(join(this.staticRoot, staticFile), 'utf8');
      const body =
        staticFile === 'index.html'
          ? raw.replace('{{MODE_LABEL}}', this.mode === 'mock' ? 'mock · 离线' : 'live · 真实模型')
          : raw;
      const extension = staticFile.slice(staticFile.lastIndexOf('.') + 1);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      });
      res.end(body);
      return;
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (!pathname.startsWith('/api/')) throw new HttpError(404, '没有这个页面。');
    await this.api(req, res, method, pathname);
  }

  private async api(req: IncomingMessage, res: ServerResponse, method: string, pathname: string): Promise<void> {
    if (pathname === '/api/sessions') {
      if (method !== 'POST') throw new HttpError(405, '创建会话只允许 POST。', 'POST');
      const body = await readJsonObject(req, this.bodyLimit);
      const brief = requiredText(body, 'brief', 'brief', 20_000);
      this.json(res, 201, { id: this.manager.create(brief) });
      return;
    }

    const parts = pathname
      .split('/')
      .filter((part) => part !== '')
      .map(decodeSegment);
    if (parts[0] !== 'api' || parts[1] !== 'sessions' || parts[2] === undefined) {
      throw new HttpError(404, '没有这个 API。');
    }
    const id = parts[2];

    if (parts.length === 3) {
      if (method !== 'GET') throw new HttpError(405, '读取会话只允许 GET。', 'GET');
      this.json(res, 200, this.manager.get(id));
      return;
    }

    if (parts.length === 4 && parts[3] === 'stream') {
      if (method !== 'GET') throw new HttpError(405, '进度流只允许 GET。', 'GET');
      this.stream(req, res, id);
      return;
    }

    if (parts.length === 4 && parts[3] === 'answers') {
      if (method !== 'POST') throw new HttpError(405, '提交回答只允许 POST。', 'POST');
      const body = await readJsonObject(req, this.bodyLimit);
      this.json(res, 200, this.manager.answer(id, body));
      return;
    }

    if (parts.length === 4 && parts[3] === 'decision') {
      if (method !== 'POST') throw new HttpError(405, '提交决定只允许 POST。', 'POST');
      const body = await readJsonObject(req, this.bodyLimit);
      this.json(res, 200, this.manager.decide(id, body));
      return;
    }

    if (parts.length === 4 && parts[3] === 'conflict-decision') {
      if (method !== 'POST') throw new HttpError(405, '冲突选择只允许 POST。', 'POST');
      const body = await readJsonObject(req, this.bodyLimit);
      this.json(res, 200, await this.manager.chooseConflict(id, body));
      return;
    }

    if (parts.length === 4 && parts[3] === 'review-decision') {
      if (method !== 'POST') throw new HttpError(405, '提交评审决定只允许 POST。', 'POST');
      const body = await readJsonObject(req, this.bodyLimit);
      this.json(res, 200, await this.manager.reviewDecision(id, body));
      return;
    }

    if (parts.length === 4 && parts[3] === 'review-waiver') {
      if (method !== 'POST') throw new HttpError(405, '提交必须项豁免只允许 POST。', 'POST');
      const body = await readJsonObject(req, this.bodyLimit);
      this.json(res, 200, await this.manager.waiveReviewMust(id, body));
      return;
    }

    if (parts.length === 4 && parts[3] === 'review-retry') {
      if (method !== 'POST') throw new HttpError(405, '重试评审只允许 POST。', 'POST');
      this.json(res, 200, await this.manager.retryReview(id));
      return;
    }

    if (parts.length === 4 && parts[3] === 'build') {
      if (method === 'POST') {
        const body = await readJsonObject(req, this.bodyLimit, true);
        this.manager.startBuild(id, body);
        this.json(res, 202, { status: 'running' });
        return;
      }
      if (method === 'GET') {
        this.json(res, 200, this.manager.getBuild(id));
        return;
      }
      throw new HttpError(405, '构建只允许 GET 或 POST。', 'GET, POST');
    }

    if (parts.length === 6 && parts[3] === 'build' && parts[4] === 'renders' && parts[5] !== undefined) {
      if (method !== 'GET') throw new HttpError(405, '渲染图只允许 GET。', 'GET');
      const name = parts[5];
      const png = await this.manager.buildRender(id, name);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(png);
      return;
    }

    if (parts.length === 5 && parts[3] === 'preview' && parts[4] !== undefined) {
      if (method !== 'GET') throw new HttpError(405, '预览只允许 GET。', 'GET');
      const svg = await this.manager.preview(id, parts[4]);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES['svg'] ?? 'image/svg+xml',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
      res.end(svg);
      return;
    }

    throw new HttpError(404, '没有这个 API。');
  }

  /** 单会话 SSE：先发快照 / 缺失事件，再持续推送；断开时退订并清理心跳。 */
  private stream(req: IncomingMessage, res: ServerResponse, id: string): void {
    if (!wantsEventStream(req)) {
      throw new HttpError(406, '进度流只提供 text/event-stream；请使用 EventSource 订阅。');
    }
    // 先校验会话存在（未知 id 在写响应头前返回 404）。
    const snapshot = this.manager.get(id);
    const afterSeq = lastEventIdOf(req);
    // 服务重启后 Last-Event-ID 可能大于新进程的序号：退回最近事件，让页面按快照重建。
    const replay = this.manager.progressSince(
      id,
      afterSeq !== null && afterSeq > snapshot.progressSeq ? null : afterSeq,
    );

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    res.write(sseFrame('snapshot', snapshot));

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      if (!res.writableEnded) res.end();
    };
    const send = (event: WebProgressEvent): void => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(sseFrame(event.kind, event, event.seq));
      } catch {
        cleanup();
      }
    };

    unsubscribe = this.manager.subscribe(id, send);
    for (const event of replay) send(event);
    heartbeat = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(': keep-alive\n\n');
      } catch {
        cleanup();
      }
    }, 15_000);
    heartbeat.unref();
    req.on('close', () => {
      cleanup();
    });
    res.on('close', () => {
      cleanup();
    });
    res.on('error', () => {
      cleanup();
    });
  }

  private json(res: ServerResponse, status: number, value: unknown, allow: string | null = null): void {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(allow === null ? {} : { Allow: allow }),
    });
    res.end(body);
  }
}

/** 启动服务；只监听 127.0.0.1。port 传 0 时由系统分配（测试用）。 */
export async function startInteractionServer(options: InteractionServerOptions): Promise<RunningInteractionServer> {
  const app = new InteractionHttpServer(options);
  await app.ready();
  const server = createServer((req, res) => {
    void app.handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('无法读取监听端口。');
  }
  app.setPort(address.port);
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeAllConnections();
  });
}
