import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleScheme } from './example.ts';
import { AREA } from './preview-plan-draw.ts';
import { renderAxonSvg } from './preview-axon.ts';

const BAD = /undefined|NaN/;
const RAW_AMP = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i;

test('轴测图包含体量、主要空间、屋面、家具与方向说明', () => {
  const scheme = exampleScheme();
  const svg = renderAxonSvg(scheme);
  assert.match(svg, /<svg /);
  assert.match(svg, /轴测体量/);
  assert.match(svg, /喝茶区/);
  assert.match(svg, /双坡屋面/);
  assert.match(svg, /家具体块/);
  assert.match(svg, /首层 · \+1\.00/);
  assert.match(svg, /固定视角：东南向/);
  assert.match(svg, /等轴测 · 无真实透视/);
  assert.match(svg, /屋面半透明以露出空间/);
  assert.doesNotMatch(svg, BAD);
  assert.doesNotMatch(svg, RAW_AMP);
});

test('单层空间也会生成盒子与家具，不依赖外部资源', () => {
  const scheme = exampleScheme();
  const svg = renderAxonSvg(scheme);
  assert.ok((svg.match(/<path /g) ?? []).length > 20);
  assert.doesNotMatch(svg, /<image|href="http|@import|url\(http/i);
  assert.ok(AREA.w > 0);
});
