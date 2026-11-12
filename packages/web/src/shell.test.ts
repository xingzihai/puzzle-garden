/**
 * shell.ts 的单元测试：页面外壳包含稳定的 id、明确的控件标签、importmap 与脚本入口，
 * 且不含内联模型代码。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { modelViewerHtml, viewerHtml } from './shell.ts';

const REQUIRED_IDS = [
  'viewport',
  'example',
  'variant',
  'level',
  'surface',
  'spaces',
  'clip-axis',
  'clip-value',
  'curvature',
  'curve-info',
  'changes',
  'view-overall',
  'view-top',
  'notes',
  'selection-details',
  'report',
  'changes-summary',
  'status',
];

test('viewerHtml 是完整的 HTML 文档并确定性输出', () => {
  const html = viewerHtml();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('</html>'));
  assert.equal(html, viewerHtml());
});

test('viewerHtml 提供 three 与 addons 的 importmap，且只指向模块脚本入口', () => {
  const html = viewerHtml();
  assert.ok(html.includes('type="importmap"'));
  assert.ok(html.includes('"three":"/vendor/three.module.js"'));
  assert.ok(html.includes('"three/addons/":"/vendor/addons/"'));
  assert.ok(html.includes('src="/page/main.ts"'));
  assert.ok(html.includes('type="module"'));
});

test('viewerHtml 含全部控件 id 与明确标签', () => {
  const html = viewerHtml();
  for (const id of REQUIRED_IDS) assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  assert.ok(html.includes('样例'));
  assert.ok(html.includes('版本'));
  assert.ok(html.includes('楼层'));
  assert.ok(html.includes('显示地表实体'));
  assert.ok(html.includes('显示空间范围'));
  assert.ok(html.includes('剖切轴'));
  assert.ok(html.includes('剖切位置'));
  assert.ok(html.includes('高亮修改元素'));
  assert.ok(html.includes('整体视角'));
  assert.ok(html.includes('俯视'));
});

test('viewerHtml 提供 plaza / roof 两个样例与屋面曲率滑杆', () => {
  const html = viewerHtml();
  assert.ok(html.includes('id="example"'));
  assert.ok(html.includes('<option value="plaza"'));
  assert.ok(html.includes('<option value="roof"'));
  assert.ok(html.includes('id="curvature" min="0" max="20" step="1"'));
  assert.ok(html.includes('id="curve-panel" hidden'));
  assert.ok(html.includes('屋面曲率'));
  assert.ok(html.includes('本地参数预览未保存'));
});

test('viewerHtml 默认打开空间范围，文案用空间 / 体量与概念说明', () => {
  const html = viewerHtml();
  assert.ok(html.includes('id="spaces" checked'), '空间范围默认应勾选');
  assert.ok(html.includes('选中空间 / 体量'));
  assert.ok(html.includes('概念说明'));
  assert.ok(!html.includes('选中构件'));
  assert.ok(!html.includes('净空检查'));
});

test('viewerHtml 声明预制演练、不含内联模型代码', () => {
  const html = viewerHtml();
  assert.ok(html.includes('预制修改演练'));
  assert.ok(html.includes('非自然语言 agent'));
  assert.ok(!html.includes('@pg/design'));
  assert.ok(!html.includes('createExample'));
  assert.ok(!html.includes('new Function'));
});

test('viewerHtml 转义自定义标题', () => {
  const html = viewerHtml({ title: '<b>危险</b>&"x"' });
  assert.ok(html.includes('&lt;b&gt;危险&lt;/b&gt;&amp;&quot;x&quot;'));
  assert.ok(!html.includes('<b>危险</b>'));
});

const MODEL_IDS = [
  'mesh-viewport',
  'mesh-view-overall',
  'mesh-view-top',
  'mesh-view-side',
  'mesh-clip-axis',
  'mesh-clip-value',
  'mesh-selection-details',
  'mesh-status',
];

test('modelViewerHtml 是完整的 HTML 文档并确定性输出，只指向 mesh-viewer 入口', () => {
  const html = modelViewerHtml();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('</html>'));
  assert.equal(html, modelViewerHtml());
  assert.ok(html.includes('type="importmap"'));
  assert.ok(html.includes('"three":"/vendor/three.module.js"'));
  assert.ok(html.includes('src="/page/mesh-viewer.ts"'));
  for (const id of MODEL_IDS) assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  assert.ok(html.includes('整体视角'));
  assert.ok(html.includes('俯视'));
  assert.ok(html.includes('侧视'));
  assert.ok(html.includes('函数草模'));
  assert.ok(html.includes('任意函数建模'));
});

test('modelViewerHtml 剖切轴 / 位置控件齐备，默认不剖切且滑杆禁用', () => {
  const html = modelViewerHtml();
  for (const axis of ['none', 'x', 'y', 'z']) assert.ok(html.includes(`<option value="${axis}"`), axis);
  assert.ok(html.includes('id="mesh-clip-value"'));
  assert.ok(html.includes('disabled'));
  assert.ok(html.includes('范围按实际顶点浮点取值'));
});

test('modelViewerHtml 不含内联模型代码或 HTML 注入面', () => {
  const html = modelViewerHtml();
  assert.ok(!html.includes('@pg/modeling'));
  assert.ok(!html.includes('createModel'));
  assert.ok(!html.includes('new Function'));
  assert.ok(html.includes('不接收可执行脚本'));
});

test('modelViewerHtml 转义自定义标题', () => {
  const html = modelViewerHtml({ title: '<b>危险</b>&"x"' });
  assert.ok(html.includes('&lt;b&gt;危险&lt;/b&gt;&amp;&quot;x&quot;'));
  assert.ok(!html.includes('<b>危险</b>'));
});
