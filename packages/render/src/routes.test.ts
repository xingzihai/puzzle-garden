/** routes.ts：白名单精确匹配与拒绝（RENDER-SPEC §4.3、§12 第 6 条）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeRequest } from './routes.ts';

test('白名单 10 个路径各返回正确资源键与 Content-Type', () => {
  const cases: readonly [string, string, string][] = [
    ['http://render.invalid/', 'index', 'text/html; charset=utf-8'],
    ['http://render.invalid/src/page/main.ts', 'main', 'text/javascript; charset=utf-8'],
    ['http://render.invalid/src/page/scene.ts', 'scene', 'text/javascript; charset=utf-8'],
    ['http://render.invalid/src/mesh.ts', 'mesh', 'text/javascript; charset=utf-8'],
    ['http://render.invalid/src/mesh-parts.ts', 'mesh-parts', 'text/javascript; charset=utf-8'],
    ['http://render.invalid/src/model-pack.ts', 'model-pack', 'text/javascript; charset=utf-8'],
    ['http://render.invalid/three/three.module.js', 'three', 'text/javascript; charset=utf-8'],
    ['http://render.invalid/three/three.core.js', 'three-core', 'text/javascript; charset=utf-8'],
    ['http://render.invalid/scene.bin', 'scene-bin', 'application/octet-stream'],
    ['http://render.invalid/model-pack.bin', 'model-pack-bin', 'application/octet-stream'],
  ];
  for (const [url, key, contentType] of cases) {
    assert.deepEqual(routeRequest(url, 'GET'), { kind: 'allow', key, contentType }, url);
  }
});

test('查询串、POST、非白名单路径、外域都拒绝', () => {
  const denied: readonly [string, string][] = [
    ['http://render.invalid/scene.bin?x=1', 'GET'],
    ['http://render.invalid/', 'POST'],
    ['http://render.invalid/src/palette.ts', 'GET'],
    ['http://render.invalid/three/three.webgpu.js', 'GET'],
    ['https://example.com/', 'GET'],
    ['http://render.invalid/../package.json', 'GET'],
    ['http://render.invalid/favicon.ico', 'GET'],
    ['not a url', 'GET'],
  ];
  for (const [url, method] of denied) {
    assert.deepEqual(routeRequest(url, method), { kind: 'deny' }, `${method} ${url}`);
  }
});

test('方法大小写不敏感（GET 通过，其他拒绝）', () => {
  assert.equal(routeRequest('http://render.invalid/', 'get').kind, 'allow');
  assert.equal(routeRequest('http://render.invalid/', 'HEAD').kind, 'deny');
});
