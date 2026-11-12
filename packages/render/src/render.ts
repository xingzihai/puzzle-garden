/**
 * @pg/render 公开接口（RENDER-SPEC §4.1）。
 *
 * 负责：参数校验、读存档、网格化、面数上限、逐视角取景、调度 browser.ts、组装 RenderResult 与 RenderVersion。
 * 不负责：Chrome 生命周期与页面协议（browser.ts）。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';

import type { BlockRegistry } from '@pg/blocks/registry';
import { readArchive } from '@pg/core/archive';
import { CoreError, XZ_MIN, XZ_MAX, Y_MIN, Y_MAX } from '@pg/core/coord';
import { z } from 'zod';

import { BrowserFailure, BrowserHost, FLAGS } from './browser.ts';
import type { InitInfo } from './browser.ts';
import { assetStatus, loadMcAssetPack } from './asset-pack.ts';
import type { AssetLoad, AssetStatus, McAssetPack } from './asset-pack.ts';
import { VIEW_NAMES, viewFrame } from './camera.ts';
import type { BBox, CameraSpec, ViewName, ViewFrame } from './camera.ts';
import { RenderError } from './errors.ts';
import { countFaces, PROTOCOL_VERSION } from './mesh.ts';
import type { RenderModelPack } from './model-pack.ts';
import { decodeModelPack } from './model-pack.ts';
import { buildScene } from './scene-buffer.ts';

export type { ViewName } from './camera.ts';

export interface RendererOptions {
  readonly chromePath?: string;
  readonly launchTimeoutMs?: number;
  readonly renderTimeoutMs?: number;
  readonly maxCells?: number;
  readonly maxFaces?: number;
  /** 显式注入资源包；null 强制 fallback，缺省自动探测 `.work/mc-assets/1.20.1/`。 */
  readonly assets?: McAssetPack | null;
  /** 自定义资源目录（便于测试与多版本并存）。 */
  readonly assetDir?: string;
}

export interface RenderRequest {
  readonly views: readonly ViewName[];
  readonly width: number;
  readonly height: number;
  /** 闭区间整数格窗口；必须包含全部可画格。缺省按当前建筑自动取景。 */
  readonly framingBounds?: BBox;
}

export interface RenderedView {
  readonly view: ViewName;
  readonly png: Uint8Array;
  readonly sha256: string;
  readonly camera: CameraSpec;
  readonly pixelsPerCell: number;
  /** 有 framingBounds 时是该窗口的投影框/面积比，不是实际实体外框。 */
  readonly bbox: readonly [number, number, number, number];
  readonly frameFill: number;
  readonly framingBounds?: BBox;
}

export interface SceneStats {
  readonly cells: number;
  readonly faces: number;
  readonly belowGround: number;
  readonly skipped: number;
  readonly fallbackColor: readonly string[];
  readonly simplified: Readonly<Record<string, number>>;
  readonly blockedRequests: number;
  /** 官方资源状态；fallback 时 reason 说明原因。 */
  readonly assets: AssetStatus;
  /** 使用官方模型几何的格数。 */
  readonly officialCells: number;
}

export interface RenderVersion {
  readonly protocol: number;
  readonly chrome: string;
  readonly puppeteer: string;
  readonly three: string;
  readonly flags: readonly string[];
  readonly webglRenderer: string;
  readonly cpuModel: string;
  readonly assets: AssetStatus;
}

export type RenderResult =
  | {
      readonly kind: 'ok';
      readonly images: readonly RenderedView[];
      readonly scene: SceneStats;
      readonly version: RenderVersion;
      readonly wallMs: number;
    }
  | { readonly kind: 'invalid-archive'; readonly message: string }
  | { readonly kind: 'empty'; readonly belowGround: number }
  | {
      readonly kind: 'too-large';
      readonly what: 'cells' | 'faces' | 'span' | 'volume' | 'palette';
      readonly value: number;
      readonly limit: number;
    }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'timeout' | 'crashed' | 'page-error'; readonly detail: string; readonly wallMs: number }
  | { readonly kind: 'closed' };

export interface Renderer {
  render(archive: Uint8Array, request: RenderRequest): Promise<RenderResult>;
  version(): Promise<RenderVersion>;
  close(): Promise<void>;
}

const DEFAULTS: Required<Omit<RendererOptions, 'assets' | 'assetDir'>> = {
  chromePath: '/usr/bin/google-chrome',
  launchTimeoutMs: 15000,
  renderTimeoutMs: 30000,
  maxCells: 4_000_000,
  maxFaces: 8_000_000,
};

const DETAIL_LIMIT = 600;

const optionsSchema = z
  .object({
    chromePath: z.string().min(1).optional(),
    launchTimeoutMs: z.number().int().positive().optional(),
    renderTimeoutMs: z.number().int().positive().optional(),
    maxCells: z.number().int().positive().optional(),
    maxFaces: z.number().int().positive().optional(),
    assets: z.unknown().optional(),
    assetDir: z.string().min(1).optional(),
  })
  .strict();

const viewNameSchema = z.enum(VIEW_NAMES);

const pointSchema = z.tuple([
  z.number().int().min(XZ_MIN).max(XZ_MAX),
  z.number().int().min(Y_MIN).max(Y_MAX),
  z.number().int().min(XZ_MIN).max(XZ_MAX),
]);
const framingBoundsSchema = z.object({ min: pointSchema, max: pointSchema }).superRefine((bounds, ctx) => {
  for (const axis of [0, 1, 2] as const) {
    const span = bounds.max[axis] - bounds.min[axis] + 1;
    // 沿用场景单轴上限；窗口不分配稠密格表，无需限制体积。
    if (span < 1 || span > 65535)
      ctx.addIssue({ code: 'custom', path: ['max', axis], message: 'min 必须 ≤ max，闭区间跨度必须在 1–65535 格' });
  }
});

const requestSchema = z.object({
  views: z
    .array(viewNameSchema)
    .min(1)
    .max(VIEW_NAMES.length)
    .refine((views) => new Set(views).size === views.length, { message: 'views 不能重复' }),
  width: z.number().int().min(256).max(4096),
  height: z.number().int().min(256).max(4096),
  framingBounds: framingBoundsSchema.optional(),
});

function zodMessage(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.join('.') || '(根)'}：${i.message}`).join('；');
}

export const DEFAULT_REQUESTS: Readonly<Record<'iterate' | 'deliver', RenderRequest>> = {
  iterate: { views: ['iso-se', 'iso-nw'], width: 1024, height: 768 },
  deliver: { views: ['iso-se', 'south', 'east', 'north', 'west', 'top'], width: 2048, height: 1536 },
};

function decodePng(dataUrl: string): Uint8Array {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('pgView 返回的不是 PNG data URL');
  return new Uint8Array(Buffer.from(dataUrl.slice(prefix.length), 'base64'));
}

function truncate(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

function failureResult(failure: BrowserFailure, started: number): RenderResult {
  const wallMs = Date.now() - started;
  if (failure.kind === 'unsupported') return { kind: 'unsupported', reason: truncate(failure.detail) };
  return { kind: failure.kind, detail: truncate(failure.detail), wallMs };
}

function puppeteerVersion(): string {
  const require = createRequire(import.meta.url);
  const path = require.resolve('puppeteer-core/package.json');
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return z.object({ version: z.string() }).parse(raw).version;
}

/** 创建渲染器；不启动 Chrome，第一次 render / version 时才启动（RENDER-SPEC §9）。 */
export function createRenderer(registry: BlockRegistry, options: RendererOptions = {}): Renderer {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success)
    throw new RenderError('invalid-request', `RendererOptions 不合法：${zodMessage(parsed.error.issues)}`);
  const opts = parsed.data;
  const host = new BrowserHost({
    chromePath: opts.chromePath ?? DEFAULTS.chromePath,
    launchTimeoutMs: opts.launchTimeoutMs ?? DEFAULTS.launchTimeoutMs,
  });
  const maxCells = opts.maxCells ?? DEFAULTS.maxCells;
  const maxFaces = opts.maxFaces ?? DEFAULTS.maxFaces;
  const renderTimeoutMs = opts.renderTimeoutMs ?? DEFAULTS.renderTimeoutMs;
  const puppeteer = puppeteerVersion();

  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let cachedVersion: RenderVersion | undefined;
  let assetLoad: AssetLoad | undefined;
  let decodedPack: RenderModelPack | undefined;
  let assetsResolved = false;

  function ensureAssets(): AssetLoad {
    if (assetsResolved && assetLoad !== undefined) return assetLoad;
    assetsResolved = true;
    let loaded: AssetLoad;
    if (options.assets === null) {
      loaded = {
        kind: 'missing',
        path: '(disabled)',
        reason: '调用方显式传入 assets: null，本次使用 fallback。',
      };
    } else if (options.assets !== undefined) {
      loaded = { kind: 'ok', pack: options.assets };
    } else {
      loaded = loadMcAssetPack(opts.assetDir);
    }
    if (loaded.kind === 'ok') {
      try {
        decodedPack = decodeModelPack(loaded.pack.bytes);
      } catch (error) {
        loaded = { kind: 'invalid', path: loaded.pack.path, reason: `模型包不合法：${String(error)}` };
      }
    }
    assetLoad = loaded;
    return loaded;
  }

  function packOf(load: AssetLoad): McAssetPack | undefined {
    return load.kind === 'ok' ? load.pack : undefined;
  }

  function versionOf(chrome: string, init: InitInfo): RenderVersion {
    return {
      protocol: PROTOCOL_VERSION,
      chrome,
      puppeteer,
      three: init.three,
      flags: FLAGS,
      webglRenderer: init.webglRenderer,
      cpuModel: cpus()[0]?.model ?? '',
      assets: assetStatus(ensureAssets()),
    };
  }

  async function doRender(archive: Uint8Array, request: z.output<typeof requestSchema>): Promise<RenderResult> {
    const started = Date.now();
    const deadline = started + renderTimeoutMs;

    let grid;
    try {
      grid = readArchive(registry.table, archive).grid;
    } catch (error) {
      if (error instanceof CoreError && error.code === 'invalid-archive') {
        return { kind: 'invalid-archive', message: truncate(error.message) };
      }
      throw error;
    }

    const assets = ensureAssets();
    const pack = packOf(assets);
    const built = buildScene(grid, registry, maxCells, pack?.catalog);
    if (built.kind === 'empty') return { kind: 'empty', belowGround: built.belowGround };
    if (built.kind === 'too-large')
      return { kind: 'too-large', what: built.what, value: built.value, limit: built.limit };

    const faces = countFaces(built.buffer, pack === undefined ? undefined : decodedPack);
    if (faces > maxFaces) return { kind: 'too-large', what: 'faces', value: faces, limit: maxFaces };

    const bounds = request.framingBounds ?? built.bbox;
    for (const axis of [0, 1, 2] as const) {
      if (built.bbox.min[axis] < bounds.min[axis] || built.bbox.max[axis] > bounds.max[axis])
        throw new RenderError(
          'invalid-request',
          `framingBounds ${JSON.stringify(bounds)} 未包含全部可画格的包围盒 ${JSON.stringify(built.bbox)}（轴 ${String(axis)}），拒绝裁剪`,
        );
    }
    const frames: ViewFrame[] = request.views.map((view) => viewFrame(view, bounds, request.width, request.height));
    host.setModelPack(pack?.bytes);
    let views: Awaited<ReturnType<BrowserHost['renderViews']>>;
    try {
      views = await host.renderViews(
        built.buffer,
        frames.map((frame, index) => ({ view: request.views[index] ?? 'south', camera: frame.camera })),
        request.width,
        request.height,
        deadline,
      );
    } catch (error) {
      return failureResult(
        error instanceof BrowserFailure ? error : new BrowserFailure('page-error', String(error)),
        started,
      );
    }

    if (views.faceCount !== faces) {
      return {
        kind: 'page-error',
        detail: truncate(`面数不一致：宿主 ${String(faces)}，页面 ${String(views.faceCount)}`),
        wallMs: Date.now() - started,
      };
    }

    let images: RenderedView[];
    try {
      images = frames.map((frame, index) => {
        const png = decodePng(views.dataUrls[index] ?? '');
        return {
          view: request.views[index] ?? 'south',
          png,
          sha256: createHash('sha256').update(Buffer.from(png)).digest('hex'),
          camera: frame.camera,
          pixelsPerCell: frame.pixelsPerCell,
          bbox: frame.bbox,
          frameFill: frame.frameFill,
          ...(request.framingBounds === undefined ? {} : { framingBounds: request.framingBounds }),
        };
      });
    } catch (error) {
      return { kind: 'page-error', detail: truncate(String(error)), wallMs: Date.now() - started };
    }

    const version = versionOf(views.chrome, views.init);
    cachedVersion = version;
    return {
      kind: 'ok',
      images,
      scene: {
        cells: built.stats.cells,
        faces,
        belowGround: built.stats.belowGround,
        skipped: built.stats.skipped,
        fallbackColor: built.stats.fallbackColor,
        simplified: built.stats.simplified,
        blockedRequests: views.blockedRequests,
        assets: assetStatus(assets),
        officialCells: built.stats.officialCells,
      },
      version,
      wallMs: Date.now() - started,
    };
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    render(archive: Uint8Array, request: RenderRequest): Promise<RenderResult> {
      if (closed) return Promise.resolve({ kind: 'closed' });
      const parsedRequest = requestSchema.safeParse(request);
      if (!parsedRequest.success) {
        throw new RenderError('invalid-request', `RenderRequest 不合法：${zodMessage(parsedRequest.error.issues)}`);
      }
      return enqueue(() => doRender(archive, parsedRequest.data));
    },
    version(): Promise<RenderVersion> {
      if (closed) {
        if (cachedVersion !== undefined) return Promise.resolve(cachedVersion);
        return Promise.reject(new RenderError('invalid-request', '渲染器已关闭，且没有缓存过版本'));
      }
      return enqueue(async () => {
        if (cachedVersion !== undefined) return cachedVersion;
        const deadline = Date.now() + renderTimeoutMs;
        try {
          const result = await host.version(deadline);
          cachedVersion = versionOf(result.chrome, result.init);
          return cachedVersion;
        } catch (error) {
          const failure = error instanceof BrowserFailure ? error : new BrowserFailure('page-error', String(error));
          throw new RenderError('invalid-request', `version 失败：${truncate(failure.detail)}`);
        }
      });
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      return enqueue(() => host.close());
    },
  };
}
