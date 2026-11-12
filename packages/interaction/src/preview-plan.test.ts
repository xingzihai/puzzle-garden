import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleScheme } from './example.ts';
import { DesignScheme } from './scheme.ts';
import { planFileNames, renderPlanSvg, renderSiteSvg } from './preview-plan.ts';

const BAD = /undefined|NaN/;
const RAW_AMP = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i;

test('总平面包含分区、建筑范围、入口、指北针与比例尺', () => {
  const scheme = exampleScheme();
  const svg = renderSiteSvg(scheme);
  assert.match(svg, /<svg /);
  assert.match(svg, /总平面/);
  assert.match(svg, /檐下平台/);
  assert.match(svg, /南侧草地/);
  assert.match(svg, /建筑主体/);
  assert.match(svg, /入口 · 北/);
  assert.match(svg, />N</);
  assert.match(svg, /示意比例尺/);
  assert.match(svg, /建筑主体（buildingBounds）/);
  assert.doesNotMatch(svg, BAD);
  assert.doesNotMatch(svg, RAW_AMP);
});

test('楼层平面包含空间面积、墙、门窗、家具、动线与入口', () => {
  const scheme = exampleScheme();
  const level = scheme.levels[0];
  assert.ok(level !== undefined);
  const svg = renderPlanSvg(scheme, level);
  assert.match(svg, /首层平面/);
  assert.match(svg, /喝茶区/);
  assert.match(svg, /48\.0 m² 外包/);
  assert.match(svg, /入口玄关/);
  assert.match(svg, /北侧入口门/);
  assert.match(svg, /南向看景窗/);
  assert.match(svg, /中央长桌/);
  assert.match(svg, /入口动线/);
  assert.match(svg, /入口 · 北/);
  assert.match(svg, /plan-entry-arrow/);
  assert.match(svg, /墙（wall 条带）/);
  assert.match(svg, /面积 = 地面投影外包/);
  assert.match(svg, /示意比例尺/);
  assert.doesNotMatch(svg, BAD);
  assert.doesNotMatch(svg, RAW_AMP);
});

test('没有空间的楼层输出提示而不是报错', () => {
  const base = exampleScheme();
  const level = base.levels[0];
  assert.ok(level !== undefined);
  const scheme = DesignScheme.parse({
    ...base,
    levels: [...base.levels, { id: 'lv-empty', name: '二层', elevation: 5, height: 3 }],
  });
  const empty = scheme.levels.find((item) => item.id === 'lv-empty');
  assert.ok(empty !== undefined);
  const svg = renderPlanSvg(scheme, empty);
  assert.match(svg, /本层暂无空间数据/);
  assert.doesNotMatch(svg, BAD);
});

test('平面文件名与楼层顺序一致', () => {
  const scheme = exampleScheme();
  assert.deepEqual(planFileNames(scheme.levels), ['plan-lv-ground.svg']);
});
