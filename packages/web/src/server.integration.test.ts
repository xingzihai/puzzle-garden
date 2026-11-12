/**
 * server.ts 的真实本地集成测试：真正 `listen` 于 127.0.0.1 的随机端口，用 node:http 客户端请求。
 *
 * 测试进程禁网（test-no-network 替换 fetch），但本地回环的 node:http 请求不在拦截范围，
 * 因此这里只验服务行为，不访问外网。测试自行关闭启动的服务，不留下常驻进程。
 */

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { test } from 'node:test';

import { startMassingServer } from './server.ts';
import type { RunningServer } from './server.ts';

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** 用原始 path（不归一化 `..`）请求，便于验证路径穿越被拒。 */
function request(server: RunningServer, rawPath: string, method = 'GET'): Promise<HttpResult> {
  const target = new URL(server.url);
  return new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(
      { hostname: target.hostname, port: target.port, path: rawPath, method },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function header(result: HttpResult, name: string): string | undefined {
  const value = result.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

test('真实监听：白名单、安全头、方法与拒绝路径', async (t) => {
  const server = await startMassingServer({ port: 0 });
  t.after(async () => {
    await server.close();
  });
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  await t.test('GET / 返回外壳、安全头，且不发 CORS 头', async () => {
    const result = await request(server, '/');
    assert.equal(result.status, 200);
    assert.equal(header(result, 'content-type'), 'text/html; charset=utf-8');
    assert.equal(header(result, 'x-content-type-options'), 'nosniff');
    assert.equal(header(result, 'cache-control'), 'no-store');
    assert.equal(header(result, 'access-control-allow-origin'), undefined);
    assert.ok(result.body.includes('id="viewport"'));
    assert.ok(result.body.includes('src="/page/main.ts"'));
  });

  await t.test('GET /page/main.ts 返回擦除类型后的 JS', async () => {
    const result = await request(server, '/page/main.ts');
    assert.equal(result.status, 200);
    assert.equal(header(result, 'content-type'), 'text/javascript; charset=utf-8');
    assert.ok(result.body.includes('requestAnimationFrame'));
    assert.ok(!result.body.includes('import type'));
    assert.ok(!result.body.includes('@pg/design'));
  });

  await t.test('GET three 发行文件成功', async () => {
    const three = await request(server, '/vendor/three.module.js');
    assert.equal(three.status, 200);
    assert.ok(three.body.length > 10000);
    assert.ok(three.body.includes('./three.core.js'));
    const orbit = await request(server, '/vendor/addons/controls/OrbitControls.js');
    assert.equal(orbit.status, 200);
    assert.ok(orbit.body.includes('OrbitControls'));
  });

  await t.test('GET /api/blueprints 返回三份方案', async () => {
    const result = await request(server, '/api/blueprints');
    assert.equal(result.status, 200);
    assert.equal(header(result, 'content-type'), 'application/json; charset=utf-8');
    const blueprints: unknown = JSON.parse(result.body);
    assert.ok(Array.isArray(blueprints));
    assert.equal(blueprints.length, 3);
  });

  await t.test('GET /api/report 返回概念评审、report、diff 与空 routeReports', async () => {
    const result = await request(server, '/api/report?variant=base');
    assert.equal(result.status, 200);
    const payload = JSON.parse(result.body) as {
      review: { kind?: unknown; message?: unknown };
      report: unknown;
      diff: unknown;
      routeReports: unknown;
    };
    assert.equal(payload.review.kind, 'concept');
    assert.ok(
      typeof payload.review.message === 'string' && payload.review.message.includes('不代表施工或通行验收通过'),
    );
    assert.ok(payload.report !== null && typeof payload.report === 'object');
    assert.ok(payload.diff !== null && typeof payload.diff === 'object');
    assert.ok(Array.isArray(payload.routeReports));
    assert.equal(payload.routeReports.length, 0);
  });

  await t.test('GET /favicon.ico 返回 204 避免浏览器报错', async () => {
    const result = await request(server, '/favicon.ico');
    assert.equal(result.status, 204);
    assert.equal(result.body, '');
    assert.equal(header(result, 'x-content-type-options'), 'nosniff');
  });

  await t.test('GET /page 白名单新模块返回擦除后的 JS', async () => {
    for (const module of ['lathe', 'profile-parser', 'example-controls'] as const) {
      const result = await request(server, `/page/${module}.ts`);
      assert.equal(result.status, 200, module);
      assert.equal(header(result, 'content-type'), 'text/javascript; charset=utf-8', module);
      assert.ok(!result.body.includes('import type'), module);
      assert.ok(!result.body.includes('eval('), module);
    }
  });

  await t.test('GET /api/blueprints?example=roof 返回三份 lathe 屋面', async () => {
    const result = await request(server, '/api/blueprints?example=roof');
    assert.equal(result.status, 200);
    const blueprints = JSON.parse(result.body) as readonly {
      readonly elements: readonly {
        readonly id: string;
        readonly shape: string;
        readonly profile?: {
          readonly kind: string;
          readonly curvature: number;
          readonly heightSegments: number;
          readonly radialSegments: number;
        };
        readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] };
      }[];
      readonly clearances: readonly unknown[];
    }[];
    assert.equal(blueprints.length, 3);
    const expected = [
      { kind: 'linear', curvature: 0 },
      { kind: 'reciprocal', curvature: 2 },
      { kind: 'reciprocal', curvature: 6 },
    ] as const;
    blueprints.forEach((blueprint, index) => {
      const roof = blueprint.elements.find((element) => element.id === 'roof-profile');
      assert.ok(roof !== undefined);
      assert.equal(roof.shape, 'lathe');
      const spec = expected[index];
      assert.ok(spec !== undefined);
      const profile = roof.profile;
      assert.ok(profile !== undefined);
      assert.equal(profile.kind, spec.kind);
      assert.equal(profile.curvature, spec.curvature);
      assert.equal(profile.heightSegments, 24);
      assert.equal(profile.radialSegments, 48);
      const spanX = (roof.bounds.max[0] ?? 0) - (roof.bounds.min[0] ?? 0);
      assert.equal(spanX / 2, 16);
      assert.equal(blueprint.clearances.length, 0);
    });
  });

  await t.test('GET /api/blueprints?example=plaza 与无 query 一致', async () => {
    const plain = await request(server, '/api/blueprints');
    const explicit = await request(server, '/api/blueprints?example=plaza');
    assert.equal(explicit.status, 200);
    assert.equal(explicit.body, plain.body);
  });

  await t.test('GET /api/report?example=roof&variant=curved 是屋面概念评审', async () => {
    const result = await request(server, '/api/report?example=roof&variant=curved');
    assert.equal(result.status, 200);
    const payload = JSON.parse(result.body) as {
      review: { kind?: unknown; message?: unknown };
      diff: { changed: readonly string[] };
    };
    assert.equal(payload.review.kind, 'concept');
    assert.ok(typeof payload.review.message === 'string' && payload.review.message.includes('函数形体'));
    assert.deepEqual(payload.diff.changed, ['roof-profile']);
  });

  await t.test('example / variant 交叉与重复查询一律 400', async () => {
    assert.equal((await request(server, '/api/blueprints?example=nope')).status, 400);
    assert.equal((await request(server, '/api/blueprints?example=roof&example=roof')).status, 400);
    assert.equal((await request(server, '/api/report?example=roof')).status, 400);
    assert.equal((await request(server, '/api/report?example=roof&variant=base')).status, 400);
    assert.equal((await request(server, '/api/report?example=plaza&variant=cone')).status, 400);
    assert.equal((await request(server, '/api/report?variant=base&variant=base')).status, 400);
  });

  await t.test('未知路径 404、写方法 405、穿越与未知查询 400', async () => {
    assert.equal((await request(server, '/nope')).status, 404);
    assert.equal((await request(server, '/../server.ts')).status, 400);
    assert.equal((await request(server, '/page/%6dain.ts')).status, 400);
    assert.equal((await request(server, '/api/blueprints?x=1')).status, 400);
    const post = await request(server, '/', 'POST');
    assert.equal(post.status, 405);
    assert.equal(header(post, 'allow'), 'GET, HEAD');
  });

  await t.test('HEAD 返回头但不带 body', async () => {
    const result = await request(server, '/', 'HEAD');
    assert.equal(result.status, 200);
    assert.equal(header(result, 'x-content-type-options'), 'nosniff');
    assert.equal(result.body, '');
  });
});
