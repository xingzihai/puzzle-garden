/**
 * 只读本地 HTTP 服务：把查看器页面、擦除类型后的页面 TS、three 发行文件与方案接口
 * 绑定在 `127.0.0.1` 上（MASSING-SPEC §3、§4）。
 *
 * 负责：路由白名单与安全拒绝（方法 / 路径 / 编码 / 查询串）、Content-Type 与安全响应头、
 * 用 `@pg/design` 的 schema 校验三份方案、生成 `/api/report` 的报告与差异、唯一的监听入口
 * `startMassingServer`。
 * 不负责：页面 DOM 与几何（page/*.ts、shell.ts）、Chrome 驱动（集成测试）、参数解析与信号（cli.ts）。
 *
 * 安全边界：只监听 127.0.0.1；只读白名单资源，绝不按请求拼任意文件路径；不读 env、不写、不 CORS；
 * 请求体一律忽略（没有写接口）。页面数据只来自 schema 校验过的 Blueprint。
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CheckReport } from '@pg/design/checks';
import { checkBlueprint } from '@pg/design/checks';
import type { BlueprintDiff } from '@pg/design/diff';
import { diffBlueprint } from '@pg/design/diff';
import { createMassingExample } from '@pg/design/massing';
import type { Variant } from '@pg/design/massing';
import { createRoofExample } from '@pg/design/roof-example';
import type { RoofVariant } from '@pg/design/roof-example';
import type { RouteReport } from '@pg/design/routes';
import { Blueprint } from '@pg/design/schema';
import type { ModelDocument } from '@pg/modeling/schema';

import { modelViewerHtml, viewerHtml } from './shell.ts';

/** 只监听回环地址；不暴露到局域网。 */
const LOOPBACK_ADDRESS = '127.0.0.1';
/** 原型入口的默认端口（MASSING-SPEC §4）。 */
export const DEFAULT_PORT = 4173;

/** 页面脚本白名单；对应本包的 `src/page/<名字>.ts`。 */
export type PageModule =
  | 'main'
  | 'scene'
  | 'controls'
  | 'report-parser'
  | 'lathe'
  | 'profile-parser'
  | 'example-controls'
  | 'mesh-viewer'
  | 'mesh-scene';
/** 两个样例 id：plaza 是地下广场粗体量，roof 是圆厅旋转壳屋面。 */
export type ExampleId = 'plaza' | 'roof';

/** three 发行文件白名单；键是相对 `node_modules/three` 的路径。 */
export type VendorFile = 'three.module.js' | 'three.core.js' | 'addons/controls/OrbitControls.js';

/** 请求路径 → three 文件；只列出的路径可服务，其余一律 404。 */
const VENDOR_ROUTES: ReadonlyMap<string, VendorFile> = new Map([
  ['/vendor/three.module.js', 'three.module.js'],
  ['/vendor/three.core.js', 'three.core.js'],
  ['/vendor/addons/controls/OrbitControls.js', 'addons/controls/OrbitControls.js'],
]);

/** 三个版本的固定顺序；`/api/blueprints` 数组按此排列，report 也用它取数。 */
const VARIANT_ORDER: readonly Variant[] = ['base', 'wider-shop', 'wider-cinema'];
/** 屋面样例三版的固定顺序；diff 相对第一版 cone。 */
const ROOF_VARIANT_ORDER: readonly RoofVariant[] = ['cone', 'reciprocal', 'curved'];
/** 两个样例 id；无 query 时默认 plaza，保持旧前端兼容。 */
const EXAMPLE_IDS: readonly ExampleId[] = ['plaza', 'roof'];

const HTML_TYPE = 'text/html; charset=utf-8';
const JS_TYPE = 'text/javascript; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';

/** 已读入并擦除类型的静态资源：页面脚本与 three 发行文件。 */
export interface ServerAssets {
  readonly pageModules: Readonly<Record<PageModule, string>>;
  readonly vendorFiles: Readonly<Record<VendorFile, string>>;
}

/** 概念草模的评审标识：说明这不是施工验收，避免前端把空报告当“绿色通过”。 */
export interface ConceptReview {
  readonly kind: 'concept';
  readonly message: string;
}

/** 概念评审固定文案：讲清未做净空 / 路线检查，不能当施工或通行验收。 */
export const CONCEPT_REVIEW_MESSAGE =
  '概念草模：只表达体量与层间坡道；本报告未配置净空检查（0 项）、未做任何路线检查，不代表施工或通行验收通过。';

/** 屋面概念评审文案：只表达旋转壳的函数形体，不宣称曲面已被施工级验证。 */
export const ROOF_REVIEW_MESSAGE =
  '概念草模：只表达圆厅旋转壳屋面的函数形体（半径按 profile 反算，非施工曲面）；未做净空、通行或施工检查，不代表施工验收通过。';

/** `/api/report` 响应体：概念评审标识、净空报告、相对 base 的真实差异与不适用字段。 */
export interface ReportPayload {
  readonly review: ConceptReview;
  /** 当前版本的 checkBlueprint 结果；概念草模 clearances 为空，0 项不是检查通过的证据。 */
  readonly report: CheckReport;
  readonly diff: BlueprintDiff;
  /** 概念草模不适用代表路线：为兼容旧前端恒为空数组，不要调用 @pg/design/routes。 */
  readonly routeReports: readonly RouteReport[];
}

/** 路由逻辑的注入依赖：单测用假件替换文件与数据，产品路径由 `createServerDeps` 组装。 */
export interface ServerDeps {
  readonly assets: ServerAssets;
  /** 三份 plaza 概念草模，顺序 base / wider-shop / wider-cinema。 */
  readonly blueprints: readonly Blueprint[];
  /** 三份 roof 概念草模，顺序 cone / reciprocal / curved。 */
  readonly roofBlueprints: readonly Blueprint[];
  /** 生成 plaza 某版本的检查报告与相对 base 的差异。 */
  readonly buildReport: (variant: Variant) => ReportPayload;
  /** 生成 roof 某版本的检查报告与相对 cone 的差异。 */
  readonly roofBuildReport: (variant: RoofVariant) => ReportPayload;
  /**
   * 可选的自定义函数模型（`npm run massing -- --model`）。存在时 `/` 提供函数草模外壳，
   * `/api/model` 返回它；缺省时保持 plaza / roof 预制查看器的行为不变。
   */
  readonly model?: ModelDocument;
}

export interface StartServerOptions {
  readonly port?: number;
  readonly deps?: ServerDeps;
  /** 注入自定义模型；与 `deps.model` 二选一，若都给出以本字段为准。 */
  readonly model?: ModelDocument;
}

/** 运行中的服务：`url` 可直接打开，`close` 幂等。 */
export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface RouteRequest {
  readonly method: string;
  readonly url: string;
}

/** 路由结果：不依赖 http 对象，单测可直接断言。 */
export interface RouteResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** `writeResponse` 只需要这三件事，便于单测用假件替换 ServerResponse。 */
export interface WritableResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/** 请求只需要方法与目标；IncomingMessage 结构上满足此接口。 */
export interface IncomingRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>> | undefined;
}

/**
 * Host 必须是回环地址。
 *
 * 这个服务是只读的（没有写接口，请求体一律忽略），所以 CSRF 不成立；但外部域名
 * 解析到 127.0.0.1（DNS rebinding）时，浏览器仍认为同源，能把这些页面与示例蓝图读走。
 * 端口不做校验：Host 里的域名本身就足以区分"打到了本机"和"被人借道"。
 */
function loopbackHostHeader(headers: IncomingRequest['headers']): boolean {
  const raw = headers?.['host'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return false;
  const match = /^(?:\[([0-9a-fA-F:]+)\]|([^:]+))(?::\d+)?$/.exec(value.trim());
  if (match === null) return false;
  const hostname = (match[1] ?? match[2] ?? '').toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

// ---------------------------------------------------------------------------
// 真实依赖组装（读本包 TS、three 发行文件与三份方案）
// ---------------------------------------------------------------------------

/** 页面源码擦除类型后作为 ES 模块提供（MASSING-SPEC §1：不增加打包器）。 */
function stripModule(source: string): string {
  return stripTypeScriptTypes(source, { mode: 'strip' });
}

/** 读取并擦除页面脚本、读取 three 的 module / core / OrbitControls。 */
export function buildServerAssets(): ServerAssets {
  const pageDir = fileURLToPath(new URL('./page/', import.meta.url));
  const threeMain = fileURLToPath(import.meta.resolve('three'));
  const threeBuild = dirname(threeMain);
  return {
    pageModules: {
      main: stripModule(readFileSync(join(pageDir, 'main.ts'), 'utf8')),
      scene: stripModule(readFileSync(join(pageDir, 'scene.ts'), 'utf8')),
      controls: stripModule(readFileSync(join(pageDir, 'controls.ts'), 'utf8')),
      'report-parser': stripModule(readFileSync(join(pageDir, 'report-parser.ts'), 'utf8')),
      lathe: stripModule(readFileSync(join(pageDir, 'lathe.ts'), 'utf8')),
      'profile-parser': stripModule(readFileSync(join(pageDir, 'profile-parser.ts'), 'utf8')),
      'example-controls': stripModule(readFileSync(join(pageDir, 'example-controls.ts'), 'utf8')),
      'mesh-viewer': stripModule(readFileSync(join(pageDir, 'mesh-viewer.ts'), 'utf8')),
      'mesh-scene': stripModule(readFileSync(join(pageDir, 'mesh-scene.ts'), 'utf8')),
    },
    vendorFiles: {
      'three.module.js': readFileSync(threeMain, 'utf8'),
      'three.core.js': readFileSync(join(threeBuild, 'three.core.js'), 'utf8'),
      'addons/controls/OrbitControls.js': readFileSync(
        fileURLToPath(import.meta.resolve('three/addons/controls/OrbitControls.js')),
        'utf8',
      ),
    },
  };
}

/**
 * 生成一份概念版本的报告数据：概念评审标识 + checkBlueprint(target) + 相对 base 的真实差异。
 *
 * 概念草模不跑代表路线（不 import / 不调用 @pg/design/routes 的检查），
 * routeReports 恒为空数组仅为旧前端兼容；report 的 0 项净空是“未配置检查”，不是绿色通过，
 * 前端应优先读 review.kind === 'concept' 与 review.message。方案集合缺该版本是编码错误，直接抛出。
 */
export function buildReport(blueprints: readonly Blueprint[], variant: Variant): ReportPayload {
  const target = blueprints[VARIANT_ORDER.indexOf(variant)];
  const base = blueprints[0];
  if (target === undefined || base === undefined) {
    throw new Error(`方案集合缺少 variant：${variant}`);
  }
  return {
    review: { kind: 'concept', message: CONCEPT_REVIEW_MESSAGE },
    report: checkBlueprint(target),
    diff: diffBlueprint(base, target),
    routeReports: [],
  };
}

/**
 * 生成 roof 某版本的报告：屋面专用概念评审 + checkBlueprint(target) + 相对 cone 的真实差异。
 *
 * 屋面只有函数形体（profile + 包围盒反算半径），没有净空 / 路线 / 施工检查；
 * routeReports 同样恒为空数组。方案集合缺该版本是编码错误，直接抛出。
 */
export function buildRoofReport(blueprints: readonly Blueprint[], variant: RoofVariant): ReportPayload {
  const target = blueprints[ROOF_VARIANT_ORDER.indexOf(variant)];
  const base = blueprints[0];
  if (target === undefined || base === undefined) {
    throw new Error(`屋面方案集合缺少 variant：${variant}`);
  }
  return {
    review: { kind: 'concept', message: ROOF_REVIEW_MESSAGE },
    report: checkBlueprint(target),
    diff: diffBlueprint(base, target),
    routeReports: [],
  };
}

/** 组装产品依赖：schema 校验后的 plaza + roof 概念草模 + 静态资源。只读，无外部状态。 */
export function createServerDeps(): ServerDeps {
  const blueprints = VARIANT_ORDER.map((variant) => Blueprint.parse(createMassingExample(variant)));
  const roofBlueprints = ROOF_VARIANT_ORDER.map((variant) => Blueprint.parse(createRoofExample(variant)));
  return {
    assets: buildServerAssets(),
    blueprints,
    roofBlueprints,
    buildReport: (variant) => buildReport(blueprints, variant),
    roofBuildReport: (variant) => buildRoofReport(roofBlueprints, variant),
  };
}

// ---------------------------------------------------------------------------
// 路由（纯函数：不改文件、不碰网络）
// ---------------------------------------------------------------------------

function baseHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    // 本地查看器仍禁止 MIME 嗅探与缓存，避免浏览器把文本当脚本或缓存旧模块。
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
}

function textResponse(status: number, message: string, extra: Readonly<Record<string, string>> = {}): RouteResponse {
  return { status, headers: { ...baseHeaders(TEXT_TYPE), ...extra }, body: `${message}\n` };
}

function htmlResponse(body: string): RouteResponse {
  return { status: 200, headers: baseHeaders(HTML_TYPE), body };
}

function jsResponse(body: string): RouteResponse {
  return { status: 200, headers: baseHeaders(JS_TYPE), body };
}

function jsonResponse(status: number, value: unknown): RouteResponse {
  return { status, headers: baseHeaders(JSON_TYPE), body: JSON.stringify(value) };
}

/** 204：无正文。用于浏览器自动请求的 favicon，避免控制台出现 404。 */
function noContentResponse(): RouteResponse {
  return {
    status: 204,
    headers: { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
    body: '',
  };
}

/** 拆出原始 path 与 query；不做 URL 归一化，避免 `..` 被折叠成合法路径。 */
function splitTarget(target: string): readonly [string, string] {
  const question = target.indexOf('?');
  if (question < 0) return [target, ''];
  return [target.slice(0, question), target.slice(question + 1)];
}

/** 任何编码字节、反斜杠或 `..` 都拒绝；白名单路径本身不需要百分号编码。 */
function isForbiddenPath(path: string): boolean {
  return !path.startsWith('/') || path.includes('%') || path.includes('\\') || path.includes('..');
}

function pageModuleFor(path: string): PageModule | undefined {
  if (!path.startsWith('/page/') || !path.endsWith('.ts')) return undefined;
  const name = path.slice('/page/'.length, path.length - '.ts'.length);
  if (
    name === 'main' ||
    name === 'scene' ||
    name === 'controls' ||
    name === 'report-parser' ||
    name === 'lathe' ||
    name === 'profile-parser' ||
    name === 'example-controls' ||
    name === 'mesh-viewer' ||
    name === 'mesh-scene'
  ) {
    return name;
  }
  return undefined;
}

type QueryResult =
  | { readonly kind: 'ok'; readonly params: ReadonlyMap<string, string> }
  | { readonly kind: 'error'; readonly message: string };

/** 解析查询串为参数表：拒绝未知键、重复键与缺少 `=` 的段；空串返回空表。 */
function parseQuery(query: string, allowed: readonly string[]): QueryResult {
  const params = new Map<string, string>();
  if (query === '') return { kind: 'ok', params };
  for (const pair of query.split('&')) {
    const equals = pair.indexOf('=');
    if (equals < 0) return { kind: 'error', message: `查询参数缺少取值：${pair}` };
    const key = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if (!allowed.includes(key)) return { kind: 'error', message: `未知查询参数：${key}；允许 ${allowed.join('、')}` };
    if (params.has(key)) return { kind: 'error', message: `查询参数重复：${key}` };
    params.set(key, value);
  }
  return { kind: 'ok', params };
}

function exampleOf(value: string): ExampleId | undefined {
  for (const example of EXAMPLE_IDS) {
    if (example === value) return example;
  }
  return undefined;
}

function plazaVariantOf(value: string): Variant | undefined {
  for (const variant of VARIANT_ORDER) {
    if (variant === value) return variant;
  }
  return undefined;
}

function roofVariantOf(value: string): RoofVariant | undefined {
  for (const variant of ROOF_VARIANT_ORDER) {
    if (variant === value) return variant;
  }
  return undefined;
}

/**
 * 把请求映射为响应。拒绝顺序：写方法 → 非法路径 → 路径/查询白名单。
 * 白名单之外一律 404，未知查询串一律 400。
 */
export function routeRequest(request: RouteRequest, deps: ServerDeps): RouteResponse {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return textResponse(405, `只允许 GET / HEAD，收到 ${method}`, { allow: 'GET, HEAD' });
  }
  const [path, query] = splitTarget(request.url);
  if (isForbiddenPath(path)) return textResponse(400, `非法请求路径：${path}`);
  if (path === '/favicon.ico') {
    if (query !== '') return textResponse(400, `未知查询串：${query}`);
    return noContentResponse();
  }
  if (path === '/') {
    if (query !== '') return textResponse(400, `未知查询串：${query}`);
    // 有注入模型时进入函数草模外壳；否则保持 plaza / roof 预制查看器不变。
    return htmlResponse(deps.model === undefined ? viewerHtml() : modelViewerHtml());
  }
  const pageModule = pageModuleFor(path);
  if (pageModule !== undefined) {
    if (query !== '') return textResponse(400, `未知查询串：${query}`);
    return jsResponse(deps.assets.pageModules[pageModule]);
  }
  const vendorFile = VENDOR_ROUTES.get(path);
  if (vendorFile !== undefined) {
    if (query !== '') return textResponse(400, `未知查询串：${query}`);
    return jsResponse(deps.assets.vendorFiles[vendorFile]);
  }
  if (path === '/api/model') {
    if (query !== '') return textResponse(400, `未知查询串：${query}`);
    // 只有以 --model 启动（注入了模型）才返回 200；预制查看器下明确 404。
    if (deps.model === undefined) return textResponse(404, '未注入模型：本服务未以 --model 启动');
    return jsonResponse(200, deps.model);
  }
  if (path === '/api/blueprints') {
    const parsed = parseQuery(query, ['example']);
    if (parsed.kind === 'error') return textResponse(400, parsed.message);
    const rawExample = parsed.params.get('example') ?? 'plaza';
    const example = exampleOf(rawExample);
    if (example === undefined) {
      return textResponse(400, `未知 example：${rawExample}；允许 ${EXAMPLE_IDS.join('、')}`);
    }
    return jsonResponse(200, example === 'roof' ? deps.roofBlueprints : deps.blueprints);
  }
  if (path === '/api/report') {
    const parsed = parseQuery(query, ['example', 'variant']);
    if (parsed.kind === 'error') return textResponse(400, parsed.message);
    const rawExample = parsed.params.get('example') ?? 'plaza';
    const example = exampleOf(rawExample);
    if (example === undefined) {
      return textResponse(400, `未知 example：${rawExample}；允许 ${EXAMPLE_IDS.join('、')}`);
    }
    const rawVariant = parsed.params.get('variant');
    if (rawVariant === undefined) return textResponse(400, '缺少 variant 查询参数');
    if (example === 'plaza') {
      const variant = plazaVariantOf(rawVariant);
      if (variant === undefined) {
        return textResponse(400, `未知 plaza variant：${rawVariant}；允许 ${VARIANT_ORDER.join('、')}`);
      }
      return jsonResponse(200, deps.buildReport(variant));
    }
    const variant = roofVariantOf(rawVariant);
    if (variant === undefined) {
      return textResponse(400, `未知 roof variant：${rawVariant}；允许 ${ROOF_VARIANT_ORDER.join('、')}`);
    }
    return jsonResponse(200, deps.roofBuildReport(variant));
  }
  return textResponse(404, `未知路径：${path}`);
}

/** HEAD 只回响应头；其余方法按 body 返回。 */
export function writeResponse(response: WritableResponse, route: RouteResponse, method: string): void {
  response.statusCode = route.status;
  for (const [name, value] of Object.entries(route.headers)) response.setHeader(name, value);
  if (method.toUpperCase() === 'HEAD') response.end();
  else response.end(route.body);
}

/** 返回 node:http 的请求监听器；单测可直接喂假 req / res。 */
export function createRequestHandler(deps: ServerDeps): (request: IncomingRequest, response: WritableResponse) => void {
  return (request, response) => {
    const method = request.method ?? '';
    const url = request.url ?? '';
    // 只读服务没有写接口，CSRF 不适用；但 Host 不校验就能被 DNS rebinding 借浏览器读走页面。
    // 单测构造的假请求不带 headers，视为本机调用直接放行。
    if (request.headers !== undefined && !loopbackHostHeader(request.headers)) {
      writeResponse(response, textResponse(421, `拒绝服务的主机名：${String(request.headers['host'])}`), method);
      return;
    }
    writeResponse(response, routeRequest({ method, url }, deps), method);
  };
}

// ---------------------------------------------------------------------------
// 监听与关闭
// ---------------------------------------------------------------------------

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function listen(deps: ServerDeps, port: number): Promise<RunningServer> {
  const server = createServer(createRequestHandler(deps));
  return new Promise<RunningServer>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, LOOPBACK_ADDRESS, () => {
      server.removeListener('error', onError);
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        url: `http://${LOOPBACK_ADDRESS}:${String(actualPort)}`,
        close: () => closeServer(server),
      });
    });
  });
}

/**
 * 启动只读查看器服务。`port` 缺省 4173，传 0 由系统分配（测试用）。
 * 只监听 127.0.0.1；调用方负责在结束时 `close()`（cli.ts 接 SIGINT / SIGTERM）。
 */
export function startMassingServer(options: StartServerOptions = {}): Promise<RunningServer> {
  return Promise.resolve()
    .then(() => options.deps ?? createServerDeps())
    .then((base) => {
      // 注入模型时覆盖 deps.model；不注入时完全沿用预制依赖，旧行为不变。
      const deps: ServerDeps = options.model === undefined ? base : { ...base, model: options.model };
      return listen(deps, options.port ?? DEFAULT_PORT);
    });
}
