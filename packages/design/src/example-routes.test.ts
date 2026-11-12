/**
 * 样例路线的整体检查：id / 名称 / 格数、三版蓝图下全部路线走通、每排座席前通道可达与总数。
 *
 * 全部路线都必须走通（含美食店员工门）；失败即真实断路，不放宽检查、不 skip。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createExample } from './example.ts';
import { createExampleRoutes } from './example-routes.ts';
import { validateRoute } from './routes.ts';

const VARIANTS = ['base', 'wider-shop', 'wider-cinema'] as const;

test('样例路线 id 唯一、名称非空、展开后至少两格', () => {
  const routes = createExampleRoutes('base');
  const ids = routes.map((route) => route.id);
  assert.equal(new Set(ids).size, ids.length, `路线 id 重复：${ids.join('、')}`);
  const blueprint = createExample('base');
  for (const route of routes) {
    assert.equal(route.name.length > 0, true, `${route.id} 缺少名称`);
    const report = validateRoute(blueprint, route);
    assert.equal(report.cellsChecked >= 2, true, `${route.id} 展开后只有 ${String(report.cellsChecked)} 格`);
  }
});

test('全部样例路线在三版蓝图都走通', () => {
  for (const variant of VARIANTS) {
    const blueprint = createExample(variant);
    const failures = createExampleRoutes(variant)
      .map((route) => ({ route, report: validateRoute(blueprint, route) }))
      .filter(({ report }) => report.status !== 'pass')
      .map(({ route, report }) => `${variant}/${route.id}: ${report.firstIssue!.message}`);
    assert.deepEqual(failures, [], `以下路线未走通：\n${failures.join('\n')}`);
  }
});

test('两厅每排都有从侧通道与中央通道到座位前的路线', () => {
  const ids = new Set(createExampleRoutes('base').map((route) => route.id));
  for (const hall of ['w', 'e'] as const) {
    for (let row = 1; row <= 8; row += 1) {
      assert.equal(ids.has(`rt-hall-${hall}-row${String(row)}-side`), true, `${hall} 第 ${String(row)} 排缺侧通道路线`);
      assert.equal(
        ids.has(`rt-hall-${hall}-row${String(row)}-central`),
        true,
        `${hall} 第 ${String(row)} 排缺中央通道路线`,
      );
    }
  }
});

test('样例路线总数为 17 条基础 + 32 条每排座席前 = 49 条', () => {
  assert.equal(createExampleRoutes('base').length, 49);
  const rowRoutes = createExampleRoutes('base').filter((route) => route.id.includes('-row'));
  assert.equal(rowRoutes.length, 32);
});
