import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LabelPlacer,
  contrastText,
  escapeHtml,
  escapeXml,
  fileStem,
  fmt,
  formatArea,
  formatElevation,
  measureText,
  planProjection,
  renderLegend,
  renderNorthArrow,
  renderScaleBar,
  spaceColor,
  svgDocument,
  truncateText,
  withAlpha,
} from './preview-core.ts';

test('escapeXml / escapeHtml 转义所有 XML 特殊字符', () => {
  assert.equal(escapeXml('a & b < c > d "e" \'f\''), 'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
});

test('fmt 稳定、不输出 NaN / -0', () => {
  assert.equal(fmt(1.2345, 2), '1.23');
  assert.equal(fmt(-0, 2), '0');
  assert.equal(fmt(Number.NaN), '0');
  assert.equal(fmt(Number.POSITIVE_INFINITY), '0');
});

test('文本测量与裁剪对 CJK / 拉丁文本都可用', () => {
  assert.ok(measureText('茶室', 10) > measureText('ab', 10));
  const cut = truncateText('abcdefghijklmnop', 40, 10);
  assert.ok(cut.endsWith('…'));
  assert.ok(measureText(cut, 10) <= 40);
  assert.equal(truncateText('abc', 0, 10), '');
});

test('文件名片段安全、确定性，不包含路径分隔符', () => {
  assert.equal(fileStem('lv-ground'), 'lv-ground');
  assert.equal(fileStem('../a/b c'), 'a-b-c');
  assert.equal(fileStem('首层'), 'level');
  assert.equal(fileStem('  ..  '), 'level');
});

test('面积、标高与色值辅助', () => {
  assert.equal(formatElevation(0), '±0.00');
  assert.equal(formatElevation(1), '+1.00');
  assert.equal(formatElevation(-2), '−2.00');
  assert.equal(formatArea({ min: [0, 0, 0], max: [3, 1, 4] }), '12.0 m²');
  assert.equal(withAlpha('#ff0000', 0.5), 'rgba(255, 0, 0, 0.5)');
  assert.equal(contrastText('#ffffff'), '#1d2329');
  assert.equal(contrastText('#000000'), '#f7f4ed');
  assert.notEqual(spaceColor('room', 0), spaceColor('room', 1));
});

test('planProjection 把 bounds 等比放进屏幕矩形', () => {
  const projection = planProjection({ min: [0, 0, 0], max: [10, 1, 5] }, { x: 0, y: 0, w: 200, h: 200 });
  assert.ok(Math.abs(projection.scale - 20) < 0.001);
  assert.ok(Math.abs(projection.toX(0) - 0) < 0.001);
  assert.ok(Math.abs(projection.toX(10) - 200) < 0.001);
  assert.ok(Math.abs(projection.toY(0) - 50) < 0.001);
  assert.ok(Math.abs(projection.toY(5) - 150) < 0.001);
  const rect = projection.rect({ min: [2, 0, 1], max: [4, 1, 3] });
  assert.ok(Math.abs(rect.w - 40) < 0.001);
  assert.ok(Math.abs(rect.h - 40) < 0.001);
});

test('LabelPlacer 避让已占位置，空间不足返回 null', () => {
  const placer = new LabelPlacer({ x: 0, y: 0, w: 200, h: 100 });
  const first = placer.place({ lines: ['喝茶区'], preferred: [100, 50], fontSize: 12 });
  const second = placer.place({ lines: ['入口玄关'], preferred: [100, 50], fontSize: 12 });
  assert.ok(first !== null);
  assert.ok(second !== null);
  assert.notDeepEqual(first.rect, second.rect);
  const tiny = new LabelPlacer({ x: 0, y: 0, w: 12, h: 12 });
  assert.equal(tiny.place({ lines: ['太长'], preferred: [6, 6], fontSize: 10 }), null);
});

test('指北针 / 图例 / 比例尺 / SVG 文档带有可读标签且转义标题', () => {
  const legend = renderLegend('图例', [{ label: '房间', color: '#eee1cc' }], 10, 10, 200);
  assert.ok(legend.height > 0);
  assert.match(legend.svg, /图例/);
  assert.match(renderNorthArrow(20, 20), />N</);
  assert.match(renderScaleBar(10, 10, 20), /示意比例尺/);
  const svg = svgDocument('A & B', 100, 80, '<text>ok</text>');
  assert.match(svg, /<title id="preview-title">A &amp; B<\/title>/);
  assert.match(svg, /viewBox="0 0 100 80"/);
});
