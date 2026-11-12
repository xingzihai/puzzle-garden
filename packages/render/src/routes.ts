/**
 * 页面请求白名单（RENDER-SPEC §4.3）。
 *
 * 负责：把请求 URL + 方法映射到白名单里的资源键与 Content-Type，或拒绝。
 * 不负责：读文件、擦除类型、发起响应（browser.ts）。纯函数。
 */

export type ResourceKey =
  | 'index'
  | 'main'
  | 'scene'
  | 'mesh'
  | 'mesh-parts'
  | 'model-pack'
  | 'three'
  | 'three-core'
  | 'scene-bin'
  | 'model-pack-bin';

export interface RouteAllow {
  readonly kind: 'allow';
  readonly key: ResourceKey;
  readonly contentType: string;
}

export interface RouteDeny {
  readonly kind: 'deny';
}

const HTML = 'text/html; charset=utf-8';
const JS = 'text/javascript; charset=utf-8';
const OCTET = 'application/octet-stream';

/** 精确路径 → 资源键与 Content-Type。查询串、其他方法、其他路径都拒绝。 */
const WHITELIST: ReadonlyMap<string, { key: ResourceKey; contentType: string }> = new Map([
  ['/', { key: 'index', contentType: HTML }],
  ['/src/page/main.ts', { key: 'main', contentType: JS }],
  ['/src/page/scene.ts', { key: 'scene', contentType: JS }],
  ['/src/mesh.ts', { key: 'mesh', contentType: JS }],
  ['/src/mesh-parts.ts', { key: 'mesh-parts', contentType: JS }],
  ['/src/model-pack.ts', { key: 'model-pack', contentType: JS }],
  ['/three/three.module.js', { key: 'three', contentType: JS }],
  ['/three/three.core.js', { key: 'three-core', contentType: JS }],
  ['/scene.bin', { key: 'scene-bin', contentType: OCTET }],
  ['/model-pack.bin', { key: 'model-pack-bin', contentType: OCTET }],
]);

/** 页面地址固定为 `http://render.invalid/`（`.invalid` 永不解析）。 */
export const PAGE_ORIGIN = 'http://render.invalid';

export function routeRequest(url: string, method: string): RouteAllow | RouteDeny {
  if (method.toUpperCase() !== 'GET') return { kind: 'deny' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'deny' };
  }
  if (parsed.protocol !== 'http:' || parsed.host !== 'render.invalid') return { kind: 'deny' };
  if (parsed.search !== '' || parsed.hash !== '') return { kind: 'deny' };
  const found = WHITELIST.get(parsed.pathname);
  if (found === undefined) return { kind: 'deny' };
  return { kind: 'allow', key: found.key, contentType: found.contentType };
}
