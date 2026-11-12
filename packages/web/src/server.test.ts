/**
 * server.ts 的单元测试：纯路由判定、注入式依赖、静态资源擦除与响应写入。
 *
 * 这里不 listen、不联网；真实监听与 HTTP 客户端在 server.integration.test.ts。
 * 读取本包页面源码与 three 文件属于本地文件 I/O，不违反测试禁网约定。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Blueprint } from '@pg/design/schema';
import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';

import {
  DEFAULT_PORT,
  buildReport,
  buildRoofReport,
  buildServerAssets,
  createRequestHandler,
  createServerDeps,
  routeRequest,
  writeResponse,
} from './server.ts';
import type { ReportPayload, RouteResponse, ServerDeps, WritableResponse } from './server.ts';

function reportPayload(): ReportPayload {
  return {
    review: { kind: 'concept', message: '概念草模' },
    report: { issues: [], checkedClearances: 0, status: 'pass' },
    diff: { added: [], removed: [], changed: [], spacesChanged: [] },
    routeReports: [],
  };
}

/** 最小合法方案的原始对象；用于注入依赖时区分不同数据源。 */
function minimalBlueprint(id: string): unknown {
  return {
    id,
    revision: 1,
    title: '测试方案',
    description: '无元素的最小方案',
    levels: [{ id: 'b1', name: 'B1', elevation: -8 }],
    spaces: [],
    elements: [],
    clearances: [],
    notes: [],
  };
}

/** 最小合法 ModelDocument：一个 box 部件；用于 `/api/model` 与模型外壳测试。 */
function minimalModel(): ModelDocument {
  const model = createModel();
  model.box({ id: 'part-box', name: '盒', role: 'volume', color: '#8899aa', size: [2, 3, 4] });
  return model.finish();
}

function fakeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    assets: {
      pageModules: {
        main: 'export const page = "main";',
        scene: 'scene-js',
        controls: 'controls-js',
        'report-parser': 'report-js',
        lathe: 'lathe-js',
        'profile-parser': 'profile-js',
        'example-controls': 'example-controls-js',
        'mesh-viewer': 'mesh-viewer-js',
        'mesh-scene': 'mesh-scene-js',
      },
      vendorFiles: {
        'three.module.js': 'three-module',
        'three.core.js': 'three-core',
        'addons/controls/OrbitControls.js': 'orbit-controls',
      },
    },
    blueprints: [],
    roofBlueprints: [],
    buildReport: () => reportPayload(),
    roofBuildReport: () => reportPayload(),
    ...overrides,
  };
}

/** 只用三个方法的最小假响应，验证 writeResponse 而不是 http 栈。 */
class FakeResponse implements WritableResponse {
  statusCode = 0;
  readonly headers: Record<string, string> = {};
  body: string | undefined;
  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  end(body?: string): void {
    this.body = body;
  }
}

test('routeRequest 返回查看器外壳，带 nosniff / no-store，且不发 CORS 头', () => {
  const response = routeRequest({ method: 'GET', url: '/' }, fakeDeps());
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.ok(response.body.startsWith('<!doctype html>'));
  assert.ok(response.body.includes('id="viewport"'));
});

test('页面模块与 vendor 以 JS Content-Type 返回注入内容', () => {
  const deps = fakeDeps();
  for (const [url, body] of [
    ['/page/main.ts', 'export const page = "main";'],
    ['/page/scene.ts', 'scene-js'],
    ['/page/controls.ts', 'controls-js'],
    ['/page/report-parser.ts', 'report-js'],
    ['/page/lathe.ts', 'lathe-js'],
    ['/page/profile-parser.ts', 'profile-js'],
    ['/page/example-controls.ts', 'example-controls-js'],
    ['/page/mesh-viewer.ts', 'mesh-viewer-js'],
    ['/page/mesh-scene.ts', 'mesh-scene-js'],
    ['/vendor/three.module.js', 'three-module'],
    ['/vendor/three.core.js', 'three-core'],
    ['/vendor/addons/controls/OrbitControls.js', 'orbit-controls'],
  ] as const) {
    const response = routeRequest({ method: 'GET', url }, deps);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8', url);
    assert.equal(response.body, body, url);
  }
});

test('未知路径 404，写方法 405 且带 Allow', () => {
  const deps = fakeDeps();
  assert.equal(routeRequest({ method: 'GET', url: '/etc/passwd' }, deps).status, 404);
  assert.equal(routeRequest({ method: 'GET', url: '/page/other.ts' }, deps).status, 404);
  assert.equal(routeRequest({ method: 'GET', url: '/api/report/extra' }, deps).status, 404);
  const post = routeRequest({ method: 'POST', url: '/' }, deps);
  assert.equal(post.status, 405);
  assert.equal(post.headers['allow'], 'GET, HEAD');
  assert.ok(post.body.includes('GET / HEAD'));
  assert.equal(routeRequest({ method: 'DELETE', url: '/api/blueprints' }, deps).status, 405);
});

test('favicon.ico 在白名单内：GET/HEAD 返回 204，无正文与安全头', () => {
  const deps = fakeDeps();
  for (const method of ['GET', 'HEAD']) {
    const response = routeRequest({ method, url: '/favicon.ico' }, deps);
    assert.equal(response.status, 204, method);
    assert.equal(response.body, '', method);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', method);
    assert.equal(response.headers['cache-control'], 'no-store', method);
  }
  assert.equal(routeRequest({ method: 'GET', url: '/favicon.ico?x=1' }, deps).status, 400);
  assert.equal(routeRequest({ method: 'POST', url: '/favicon.ico' }, deps).status, 405);
});

test('路径穿越、反斜杠与恶意编码一律 400', () => {
  const deps = fakeDeps();
  for (const url of [
    '/../server.ts',
    '/%2e%2e/server.ts',
    '/page/%6dain.ts',
    '/page\\main.ts',
    'page/main.ts',
    '/api/blueprints%00',
  ]) {
    assert.equal(routeRequest({ method: 'GET', url }, deps).status, 400, url);
  }
});

test('未知查询串一律 400', () => {
  const deps = fakeDeps();
  for (const url of ['/?x=1', '/api/blueprints?x=1', '/page/main.ts?x=1', '/vendor/three.module.js?x=1']) {
    assert.equal(routeRequest({ method: 'GET', url }, deps).status, 400, url);
  }
});

test('blueprints：无 query 与 example=plaza 走 plaza，example=roof 走 roof，其余 400', () => {
  const deps = fakeDeps({
    blueprints: [Blueprint.parse(minimalBlueprint('bp-plaza'))],
    roofBlueprints: [Blueprint.parse(minimalBlueprint('bp-roof'))],
  });
  const plazaDefault = routeRequest({ method: 'GET', url: '/api/blueprints' }, deps);
  const plazaExplicit = routeRequest({ method: 'GET', url: '/api/blueprints?example=plaza' }, deps);
  const roof = routeRequest({ method: 'GET', url: '/api/blueprints?example=roof' }, deps);
  assert.equal(plazaDefault.status, 200);
  assert.equal(plazaExplicit.status, 200);
  assert.equal(roof.status, 200);
  const plazaIds = (body: string): readonly unknown[] => JSON.parse(body) as readonly unknown[];
  assert.equal((plazaIds(plazaDefault.body)[0] as { id: string }).id, 'bp-plaza');
  assert.equal((plazaIds(plazaExplicit.body)[0] as { id: string }).id, 'bp-plaza');
  assert.equal((plazaIds(roof.body)[0] as { id: string }).id, 'bp-roof');
  for (const url of [
    '/api/blueprints?example=nope',
    '/api/blueprints?example=roof&example=roof',
    '/api/blueprints?example=roof&variant=cone',
    '/api/blueprints?variant=base',
  ]) {
    assert.equal(routeRequest({ method: 'GET', url }, deps).status, 400, url);
  }
});

test('report：plaza 旧写法与 example=plaza 等价；roof 用 cone/reciprocal/curved', () => {
  const deps = fakeDeps();
  assert.equal(routeRequest({ method: 'GET', url: '/api/report?variant=base' }, deps).status, 200);
  assert.equal(
    routeRequest({ method: 'GET', url: '/api/report?example=plaza&variant=wider-cinema' }, deps).status,
    200,
  );
  assert.equal(routeRequest({ method: 'GET', url: '/api/report?variant=base&example=plaza' }, deps).status, 200);
  for (const variant of ['cone', 'reciprocal', 'curved']) {
    assert.equal(routeRequest({ method: 'GET', url: `/api/report?example=roof&variant=${variant}` }, deps).status, 200);
  }
});

test('未知 query、重复键与非法 variant 交叉一律 400', () => {
  const deps = fakeDeps();
  for (const url of [
    '/api/report',
    '/api/report?',
    '/api/report?other=base',
    '/api/report?variant=nope',
    '/api/report?variant=base&x=1',
    '/api/report?variant=base&variant=base',
    '/api/report?variant=%62ase',
    '/api/report?example=nope&variant=base',
    '/api/report?example=roof',
    '/api/report?example=roof&variant=base',
    '/api/report?example=plaza&variant=cone',
    '/api/report?example=roof&variant=cone&variant=reciprocal',
    '/api/report?example=roof&example=roof&variant=cone',
    '/api/report?example=roof&variant=cone&x=1',
  ]) {
    assert.equal(routeRequest({ method: 'GET', url }, deps).status, 400, url);
  }
});

test('blueprints 与 report 走注入数据，JSON Content-Type 正确', () => {
  const deps = fakeDeps();
  const blueprints = routeRequest({ method: 'GET', url: '/api/blueprints' }, deps);
  assert.equal(blueprints.status, 200);
  assert.equal(blueprints.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(blueprints.body), []);
  const report = routeRequest({ method: 'GET', url: '/api/report?variant=wider-shop' }, deps);
  assert.equal(report.status, 200);
  const parsed = JSON.parse(report.body) as ReportPayload;
  assert.equal(parsed.report.status, 'pass');
  assert.equal(parsed.diff.changed.length, 0);
});

test('HEAD 在路由层仍产生 body，由 writeResponse 负责不发送', () => {
  const response = routeRequest({ method: 'HEAD', url: '/page/main.ts' }, fakeDeps());
  assert.equal(response.status, 200);
  assert.equal(response.body, 'export const page = "main";');
});

test('writeResponse 设置状态与头；HEAD 不写 body', () => {
  const route: RouteResponse = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'body' };
  const get = new FakeResponse();
  writeResponse(get, route, 'GET');
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers['content-type'], 'text/plain');
  assert.equal(get.body, 'body');
  const head = new FakeResponse();
  writeResponse(head, route, 'HEAD');
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, undefined);
});

test('createRequestHandler 按请求方法与 URL 分发', () => {
  const handler = createRequestHandler(fakeDeps());
  const response = new FakeResponse();
  handler({ method: 'GET', url: '/page/scene.ts' }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'scene-js');
  const missing = new FakeResponse();
  handler({}, missing);
  assert.equal(missing.statusCode, 405);
});

test('createServerDeps 生成三份概念草模，数组顺序为 base / wider-shop / wider-cinema', () => {
  const deps = createServerDeps();
  assert.equal(deps.blueprints.length, 3);
  const [base, shop, cinema] = deps.blueprints;
  assert.ok(base !== undefined);
  assert.ok(shop !== undefined);
  assert.ok(cinema !== undefined);
  const minX = (blueprint: Blueprint, id: string): number | undefined =>
    blueprint.elements.find((element) => element.id === id)?.bounds.min[0];
  assert.equal(minX(base, 'ms-floor-clothing'), 32);
  assert.equal(minX(shop, 'ms-floor-clothing'), 28);
  assert.equal(minX(cinema, 'ms-floor-clothing'), 32);
  assert.equal(minX(base, 'ms-floor-corridor'), 32);
  assert.equal(minX(shop, 'ms-floor-corridor'), 32);
  assert.equal(minX(cinema, 'ms-floor-corridor'), 24);
  assert.equal(base.revision, 1);
  assert.equal(shop.revision, 2);
  assert.equal(cinema.revision, 2);
});

test('公开蓝图是粗骨架：无 wall / furnishing / glazing，stair 全是楔体，体量少', () => {
  const deps = createServerDeps();
  for (const blueprint of deps.blueprints) {
    for (const element of blueprint.elements) {
      assert.notEqual(element.kind, 'wall');
      assert.notEqual(element.kind, 'furnishing');
      assert.notEqual(element.kind, 'glazing');
    }
    const stairs = blueprint.elements.filter((element) => element.kind === 'stair');
    assert.ok(stairs.length > 0);
    for (const stair of stairs) {
      assert.notEqual(stair.shape, 'box');
      assert.ok(stair.shape === 'wedge-x' || stair.shape === 'wedge-z');
    }
    assert.ok(blueprint.elements.length < 100, `体量应少，实际 ${String(blueprint.elements.length)}`);
    assert.equal(blueprint.clearances.length, 0);
  }
});

/** 空间完整字段的稳定签名，用来独立算出期望的 spacesChanged（不复用 diff.ts 的实现）。 */
function spaceSignature(space: Blueprint['spaces'][number]): string {
  return JSON.stringify([
    space.id,
    space.name,
    space.level,
    space.bounds.min,
    space.bounds.max,
    space.role,
    space.color,
  ]);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 两份方案都存在的空间里字段发生变化的 id，按 id 排序。 */
function changedSpaceIds(before: Blueprint, after: Blueprint): string[] {
  const beforeById = new Map(before.spaces.map((space) => [space.id, spaceSignature(space)]));
  return after.spaces
    .filter((space) => beforeById.get(space.id) !== undefined && beforeById.get(space.id) !== spaceSignature(space))
    .map((space) => space.id)
    .sort(compareIds);
}

test('buildReport 返回概念评审、未配置检查的 report 与空 routeReports（不再做路线检查）', () => {
  const deps = createServerDeps();
  for (const variant of ['base', 'wider-shop', 'wider-cinema'] as const) {
    const payload = buildReport(deps.blueprints, variant);
    assert.equal(payload.review.kind, 'concept', variant);
    assert.ok(payload.review.message.includes('未配置净空检查'), variant);
    assert.ok(payload.review.message.includes('不代表施工或通行验收通过'), variant);
    assert.equal(payload.report.checkedClearances, 0, variant);
    assert.deepEqual([...payload.report.issues], [], variant);
    assert.deepEqual(payload.routeReports, [], variant);
  }
  assert.throws(() => buildReport([], 'base'), /缺少 variant/);
});

test('buildReport 的 spacesChanged 与蓝图实际空间改动一致', () => {
  const deps = createServerDeps();
  const base = deps.blueprints[0];
  assert.ok(base !== undefined);
  const indexOf = { base: 0, 'wider-shop': 1, 'wider-cinema': 2 } as const;
  for (const variant of ['base', 'wider-shop', 'wider-cinema'] as const) {
    const target = deps.blueprints[indexOf[variant]];
    assert.ok(target !== undefined);
    const payload = buildReport(deps.blueprints, variant);
    const expected = changedSpaceIds(base, target);
    assert.deepEqual([...payload.diff.spacesChanged], expected, variant);
    if (variant === 'base') {
      assert.deepEqual(expected, []);
    } else {
      assert.ok(expected.length > 0, variant);
      assert.ok(payload.diff.changed.length > 0, variant);
    }
  }
});

test('最小空方案不会伪报 route 错误，概念评审仍明确未验收', () => {
  const payload = buildReport([Blueprint.parse(minimalBlueprint('bp-test'))], 'base');
  assert.equal(payload.routeReports.length, 0);
  assert.ok(payload.report.issues.every((issue) => !issue.code.startsWith('route:')));
  assert.equal(payload.report.checkedClearances, 0);
  assert.equal(payload.review.kind, 'concept');
  assert.ok(payload.review.message.includes('不代表施工或通行验收通过'));
});

test('createServerDeps 的 roofBlueprints 顺序为 cone / reciprocal / curved，profile 与半径来自 schema', () => {
  const deps = createServerDeps();
  assert.equal(deps.roofBlueprints.length, 3);
  const expected = [
    { kind: 'linear', curvature: 0 },
    { kind: 'reciprocal', curvature: 2 },
    { kind: 'reciprocal', curvature: 6 },
  ] as const;
  deps.roofBlueprints.forEach((blueprint, index) => {
    assert.equal(blueprint.id, 'bp-roof-lathe');
    assert.equal(blueprint.revision, index + 1);
    const roof = blueprint.elements.find((element) => element.id === 'roof-profile');
    assert.ok(roof !== undefined);
    assert.equal(roof.shape, 'lathe');
    const profile = roof.profile;
    const spec = expected[index];
    assert.ok(profile !== undefined);
    assert.ok(spec !== undefined);
    assert.equal(profile.kind, spec.kind);
    assert.equal(profile.curvature, spec.curvature);
    assert.equal(profile.heightSegments, 24);
    assert.equal(profile.radialSegments, 48);
    // 半径信息在 schema：x/z 跨度相等且为偶数（轴在整数中心），半径 = 跨度 / 2。
    const spanX = roof.bounds.max[0] - roof.bounds.min[0];
    const spanZ = roof.bounds.max[2] - roof.bounds.min[2];
    assert.equal(spanX, spanZ);
    assert.equal(spanX % 2, 0);
    assert.equal(spanX / 2, 16);
    assert.equal(roof.bounds.min[1], 12);
    assert.equal(roof.bounds.max[1], 36);
    assert.equal(blueprint.clearances.length, 0);
  });
});

test('buildRoofReport：屋面概念评审 + 相对 cone 的差异', () => {
  const deps = createServerDeps();
  const cone = buildRoofReport(deps.roofBlueprints, 'cone');
  assert.equal(cone.review.kind, 'concept');
  assert.ok(cone.review.message.includes('函数形体'));
  assert.ok(cone.review.message.includes('不代表施工验收通过'));
  assert.deepEqual(cone.diff, { added: [], removed: [], changed: [], spacesChanged: [] });
  for (const variant of ['reciprocal', 'curved'] as const) {
    const payload = buildRoofReport(deps.roofBlueprints, variant);
    assert.deepEqual([...payload.diff.changed], ['roof-profile'], variant);
    assert.deepEqual([...payload.diff.spacesChanged], [], variant);
    assert.equal(payload.report.checkedClearances, 0, variant);
    assert.deepEqual(payload.routeReports, [], variant);
  }
  assert.throws(() => buildRoofReport([], 'cone'), /缺少 variant/);
});

test('roof 路由用注入的 roofBuildReport，与 plaza 相互独立', () => {
  const deps = fakeDeps({
    roofBuildReport: () => ({ ...reportPayload(), review: { kind: 'concept', message: 'roof-injected' } }),
  });
  const plaza = routeRequest({ method: 'GET', url: '/api/report?example=plaza&variant=base' }, deps);
  const roof = routeRequest({ method: 'GET', url: '/api/report?example=roof&variant=curved' }, deps);
  assert.equal((JSON.parse(plaza.body) as ReportPayload).review.message, '概念草模');
  assert.equal((JSON.parse(roof.body) as ReportPayload).review.message, 'roof-injected');
});

test('buildServerAssets 擦除页面类型、读取全部白名单模块与 three，且不含 eval', () => {
  const assets = buildServerAssets();
  for (const module of [
    'main',
    'scene',
    'controls',
    'report-parser',
    'lathe',
    'profile-parser',
    'example-controls',
    'mesh-viewer',
    'mesh-scene',
  ] as const) {
    const source = assets.pageModules[module];
    assert.ok(source.length > 0, module);
    assert.ok(!source.includes('import type'), module);
    assert.ok(!source.includes('interface '), module);
    assert.ok(!source.includes("from '@pg/design"), module);
    assert.ok(!source.includes('eval('), module);
    assert.ok(!source.includes('new Function'), module);
  }
  assert.ok(assets.pageModules.main.includes('requestAnimationFrame'));
  assert.ok(assets.pageModules.scene.includes('parseBlueprints'));
  assert.ok(assets.pageModules.controls.includes('overallPose'));
  assert.ok(assets.pageModules.lathe.includes('latheGeometry'));
  assert.ok(assets.pageModules['profile-parser'].includes('parseLatheProfile'));
  assert.ok(assets.pageModules['example-controls'].includes('EXAMPLE_OPTIONS'));
  assert.ok(assets.pageModules['mesh-scene'].length > 0);
  assert.ok(assets.pageModules['mesh-scene'].includes('parseModelDocument'));
  assert.ok(assets.pageModules['mesh-viewer'].includes('pgModelReady'));
  assert.ok(assets.vendorFiles['three.module.js'].length > 10000);
  assert.ok(assets.vendorFiles['three.core.js'].length > 10000);
  assert.ok(assets.vendorFiles['addons/controls/OrbitControls.js'].includes('OrbitControls'));
});

test('无模型时 /api/model 返回 404，/ 仍是预制查看器外壳', () => {
  const deps = fakeDeps();
  const missing = routeRequest({ method: 'GET', url: '/api/model' }, deps);
  assert.equal(missing.status, 404);
  assert.ok(missing.body.includes('未注入模型'));
  const home = routeRequest({ method: 'GET', url: '/' }, deps);
  assert.equal(home.status, 200);
  assert.ok(home.body.includes('id="viewport"'));
  assert.ok(!home.body.includes('mesh-viewport'));
});

test('注入模型时 /api/model 返回 200，/ 切到函数草模外壳', () => {
  const model = minimalModel();
  const deps = fakeDeps({ model });
  const response = routeRequest({ method: 'GET', url: '/api/model' }, deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  const parsed = JSON.parse(response.body) as ModelDocument;
  assert.equal(parsed.version, 2);
  assert.equal(parsed.parts[0]?.id, 'part-box');
  assert.deepEqual(parsed, model);

  const home = routeRequest({ method: 'GET', url: '/' }, deps);
  assert.equal(home.status, 200);
  assert.ok(home.body.includes('id="mesh-viewport"'));
  assert.ok(home.body.includes('src="/page/mesh-viewer.ts"'));
  assert.ok(!home.body.includes('id="viewport"'));
});

test('model 路由的查询串与写方法仍被拒', () => {
  const deps = fakeDeps({ model: minimalModel() });
  assert.equal(routeRequest({ method: 'GET', url: '/api/model?x=1' }, deps).status, 400);
  assert.equal(routeRequest({ method: 'POST', url: '/api/model' }, deps).status, 405);
});

test('默认端口为 4173', () => {
  assert.equal(DEFAULT_PORT, 4173);
});

test('createRequestHandler 拒绝非回环 Host（DNS rebinding），回环与 localhost 放行', () => {
  const handler = createRequestHandler(fakeDeps());

  const rebound = new FakeResponse();
  handler({ method: 'GET', url: '/', headers: { host: 'evil.example' } }, rebound);
  assert.equal(rebound.statusCode, 421);

  const reboundWithPort = new FakeResponse();
  handler({ method: 'GET', url: '/', headers: { host: 'evil.example:4173' } }, reboundWithPort);
  assert.equal(reboundWithPort.statusCode, 421);

  for (const host of ['127.0.0.1:4173', 'localhost:4173', '[::1]:4173', '127.0.0.1']) {
    const ok = new FakeResponse();
    handler({ method: 'GET', url: '/', headers: { host } }, ok);
    assert.equal(ok.statusCode, 200, `host ${host} 应放行`);
  }

  // 没有 headers 的调用（单测里的裸请求）保持原行为。
  const bare = new FakeResponse();
  handler({ method: 'GET', url: '/' }, bare);
  assert.equal(bare.statusCode, 200);
});
