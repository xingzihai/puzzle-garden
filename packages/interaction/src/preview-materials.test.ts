import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleScheme } from './example.ts';
import { DesignScheme } from './scheme.ts';
import { renderMaterialsSvg } from './preview-materials.ts';

const BAD = /undefined|NaN/;
const RAW_AMP = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i;

test('材质板按 role 分组并显示材料名、block、role 与色值', () => {
  const scheme = exampleScheme();
  const svg = renderMaterialsSvg(scheme);
  assert.match(svg, /<svg /);
  assert.match(svg, /材质板/);
  assert.match(svg, /fill="#191d22"/);
  assert.match(svg, /结构 STRUCTURE/);
  assert.match(svg, /墙体 WALL/);
  assert.match(svg, /屋面 ROOF/);
  assert.match(svg, /浅灰石基座/);
  assert.match(svg, /stone_bricks/);
  assert.match(svg, /#9a9a92/);
  assert.match(svg, /结构 · structure/);
  assert.ok(svg.indexOf('结构 STRUCTURE') < svg.indexOf('墙体 WALL'));
  assert.ok(svg.indexOf('墙体 WALL') < svg.indexOf('屋面 ROOF'));
  assert.doesNotMatch(svg, BAD);
  assert.doesNotMatch(svg, RAW_AMP);
});

test('未指定色值的材料显示斜线占位而不是 undefined', () => {
  const base = exampleScheme();
  const scheme = DesignScheme.parse({
    ...base,
    materials: base.materials.map((material, index) => (index === 0 ? { ...material, color: null } : material)),
  });
  const svg = renderMaterialsSvg(scheme);
  assert.match(svg, /missing-color/);
  assert.match(svg, /未指定/);
  assert.match(svg, /color: null/);
  assert.doesNotMatch(svg, BAD);
});
