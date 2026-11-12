/**
 * view_building 的执行（AGENT-SPEC §4.3、MODEL-SPEC §3.4）：渲染最近一次执行成功的存档，
 * 返回图片数据与要追加的 user 消息内容（每张图前一段视角说明；图放 user 消息，C13）。
 *
 * 负责：默认两张斜视图、迭代画幅（1024×768）、图片软上限判断、把 `RenderedView` 编成 data URL 与图片块、
 * 按 (存档 hash, views, 画幅) 复用 PNG；生成 tool 消息文本。
 * 不负责：Chrome 生命周期与渲染本身（注入的 render）、把图片块拼进事实行（runner）、同一轮多次调用的取舍（runner）。
 * 本文件是纯函数文件：只 import 纯入口（guards/image、tools/schemas），render 只 import type。
 */

import type { RenderRequest, RenderResult, RenderVersion, RenderedView, ViewName } from '@pg/render/render';

import { viewAllowed } from '@pg/agent/guards/image';
import { VIEW_NAMES } from '@pg/agent/tools/schemas';

/** 迭代默认视角（AGENT-SPEC §4、RENDER-SPEC §11）；交付视角由 runner 用 `DEFAULT_REQUESTS.deliver`。 */
export const DEFAULT_VIEWS: readonly ViewName[] = ['iso-se', 'iso-nw'];
/** 迭代画幅（RENDER-SPEC §5.2 的 `DEFAULT_REQUESTS.iterate`）。纯函数文件不 import render，故写死并在此注明来源。 */
const ITERATE = { width: 1024, height: 768 } as const;

/** 每张图前的视角说明（RENDER-SPEC §5.2 与 §11 的示例写法）。 */
const VIEW_LABELS: Readonly<Record<ViewName, string>> = {
  south: '南立面',
  east: '东立面',
  north: '北立面',
  west: '西立面',
  top: '俯视，北在上',
  'iso-se': '东南斜上 30°',
  'iso-nw': '西北斜上 30°',
  interior: '室内站立高度，横看主空间',
  cutaway: '剖视，移除屋面上部与近侧外墙',
};

/** user 消息内容块：与 `@pg/llm/schema` 的 TextPart / ImagePart 同形，但不 import llm。 */
export type ViewContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

/** 一张渲染好的图；`png` 给 runner 存 blob，`dataUrl` 进请求体。 */
export interface ViewImage {
  readonly view: ViewName;
  readonly png: Uint8Array;
  readonly sha256: string;
  readonly pixelsPerCell: number;
  readonly frameFill: number;
  readonly description: string;
  /** data URL 中 base64 部分的字符数（不含前缀），用于累计图片预算。 */
  readonly imageBytes: number;
  readonly dataUrl: string;
}

/** 按 key 复用 PNG 的显式缓存（DESIGN §5）；runner 传入，view 自己不持有状态。 */
export interface ViewCache {
  get(key: string): readonly ViewImage[] | undefined;
  set(key: string, images: readonly ViewImage[]): void;
}

export interface ViewInput {
  /** 最近一次执行成功的存档字节。 */
  readonly archive: Uint8Array;
  /** 存档对应的当前稿版本。 */
  readonly archiveVersion: number;
  /** 存档 hash，用作记忆键（DESIGN §5）。 */
  readonly archiveHash: string;
  /** 当前稿版本；与 archiveVersion 不同时说明图是旧版。 */
  readonly draftVersion: number | null;
  readonly views?: readonly ViewName[];
  /** 已累计的图片 base64 字节（不含前缀），用于软上限判断（AGENT-SPEC §6.2）。 */
  readonly imageBytes: number;
}

export interface ViewDeps {
  readonly render: (archive: Uint8Array, request: RenderRequest) => Promise<RenderResult>;
  readonly clock: () => number;
  readonly cache?: ViewCache;
}

export type ViewStatus =
  | 'ok'
  | 'image-budget'
  | 'timeout'
  | 'crashed'
  | 'unsupported'
  | 'too-large'
  | 'empty'
  | 'invalid-archive'
  | 'page-error'
  | 'closed';

export interface ViewOk {
  readonly kind: 'ok';
  readonly status: 'ok';
  readonly text: string;
  readonly images: readonly ViewImage[];
  /** 要追加到本轮 user 消息的块；runner 在事实行文本之后拼接。 */
  readonly content: readonly ViewContentPart[];
  /** 这次真的渲染时才有；命中缓存时为 undefined（不重复写 `versions.render`）。 */
  readonly version: RenderVersion | undefined;
  readonly wallMs: number;
  readonly rendered: boolean;
}

export interface ViewFailure {
  readonly kind: 'failed';
  readonly status: Exclude<ViewStatus, 'ok'>;
  readonly text: string;
  readonly wallMs: number;
  /** invalid-archive / page-error / closed 说明宿主有缺陷，runner 应以 `internal-error` 停止（§4.3）。 */
  readonly internal: boolean;
}

export type ViewResult = ViewOk | ViewFailure;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 纯 TS 的 base64 编码；纯函数文件不能用 Buffer（STANDARDS §7）。 */
function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64.charAt(b0 >> 2);
    out += BASE64.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    out += b1 === undefined ? '=' : BASE64.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    out += b2 === undefined ? '=' : BASE64.charAt(b2 & 0x3f);
  }
  return out;
}

function descriptionOf(view: ViewName, pixelsPerCell: number): string {
  return `${view}（${VIEW_LABELS[view]}，正交，1 格 ≈ ${String(Math.round(pixelsPerCell))} 像素）`;
}

function toViewImage(view: RenderedView): ViewImage {
  const b64 = base64(view.png);
  return {
    view: view.view,
    png: view.png,
    sha256: view.sha256,
    pixelsPerCell: view.pixelsPerCell,
    frameFill: view.frameFill,
    description: descriptionOf(view.view, view.pixelsPerCell),
    imageBytes: b64.length,
    dataUrl: `data:image/png;base64,${b64}`,
  };
}

function okResult(
  input: ViewInput,
  images: readonly ViewImage[],
  version: RenderVersion | undefined,
  rendered: boolean,
  started: number,
  deps: ViewDeps,
): ViewOk {
  const stale =
    input.draftVersion !== null && input.draftVersion !== input.archiveVersion
      ? `图是第 v${String(input.archiveVersion)} 版（当前稿第 v${String(input.draftVersion)} 版尚未检查）。`
      : '';
  const content: ViewContentPart[] = [];
  for (const image of images) {
    content.push({ type: 'text', text: image.description });
    content.push({ type: 'image_url', image_url: { url: image.dataUrl } });
  }
  return {
    kind: 'ok',
    status: 'ok',
    text: `已渲染第 v${String(input.archiveVersion)} 版 ${String(images.length)} 张，图附在本轮末尾。${stale}`,
    images,
    content,
    version,
    wallMs: deps.clock() - started,
    rendered,
  };
}

function failureFromRender(
  result: Exclude<RenderResult, { kind: 'ok' }>,
  started: number,
  deps: ViewDeps,
): ViewFailure {
  const wallMs = deps.clock() - started;
  switch (result.kind) {
    case 'invalid-archive':
      return {
        kind: 'failed',
        status: 'invalid-archive',
        text: `存档读不回：${result.message}`,
        wallMs,
        internal: true,
      };
    case 'empty':
      return { kind: 'failed', status: 'empty', text: '存档里没有地面以上的方块：没有渲染。', wallMs, internal: false };
    case 'too-large':
      return {
        kind: 'failed',
        status: 'too-large',
        text: `建筑太大（${result.what} ${String(result.value)} 超过 ${String(result.limit)}）：没有渲染。`,
        wallMs,
        internal: false,
      };
    case 'unsupported':
      return {
        kind: 'failed',
        status: 'unsupported',
        text: `本机无法启动 Chrome：${result.reason}`,
        wallMs,
        internal: false,
      };
    case 'timeout':
      return { kind: 'failed', status: 'timeout', text: '渲染超时。', wallMs, internal: false };
    case 'crashed':
      return { kind: 'failed', status: 'crashed', text: '渲染进程异常退出。', wallMs, internal: false };
    case 'page-error':
      return { kind: 'failed', status: 'page-error', text: `页面出错：${result.detail}`, wallMs, internal: true };
    case 'closed':
      return { kind: 'failed', status: 'closed', text: '渲染器已关闭。', wallMs, internal: true };
  }
}

/**
 * 渲染最近一次执行成功的存档。图片累计超过软上限时直接拒绝，不调用 render（AGENT-SPEC §6.2）。
 * `views` 数量非法属宿主 / 参数解析缺陷，抛 RangeError（schemas 已限 1–4）。
 */
export async function viewBuilding(input: ViewInput, deps: ViewDeps): Promise<ViewResult> {
  const started = deps.clock();
  const views = input.views ?? DEFAULT_VIEWS;
  if (views.length < 1 || views.length > 4) {
    throw new RangeError(`view_building 的 views 数量应在 1–4，实际是 ${String(views.length)}`);
  }
  if (!viewAllowed(input.imageBytes)) {
    return {
      kind: 'failed',
      status: 'image-budget',
      text: '累计图片已超过上限，view_building 不再可用。',
      wallMs: deps.clock() - started,
      internal: false,
    };
  }

  const key = `${input.archiveHash}|${views.join(',')}|${String(ITERATE.width)}x${String(ITERATE.height)}`;
  const cached = deps.cache?.get(key);
  if (cached !== undefined) return okResult(input, cached, undefined, false, started, deps);

  const result = await deps.render(input.archive, {
    views: [...views],
    width: ITERATE.width,
    height: ITERATE.height,
  });
  if (result.kind !== 'ok') return failureFromRender(result, started, deps);

  const images = result.images.map(toViewImage);
  deps.cache?.set(key, images);
  return okResult(input, images, result.version, true, started, deps);
}

/** 供 runner / 测试断言工具名与参数一致：view_building 的合法视角集合。 */
export { VIEW_NAMES };
