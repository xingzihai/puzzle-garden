import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleScheme } from './example.ts';
import { DesignScheme } from './scheme.ts';
import { SECTION_PLOT, renderSectionSvg } from './preview-section.ts';

const BAD = /undefined|NaN/;
const RAW_AMP = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i;

test('关键剖面穿过最大房间，含标高、楼板、屋面、空间与家具高度', () => {
  const scheme = exampleScheme();
  const svg = renderSectionSvg(scheme);
  assert.match(svg, /<svg /);
  assert.match(svg, /关键剖面 A–A/);
  assert.match(svg, /穿过最大空间「喝茶区」/);
  assert.match(svg, /切割线 X = /);
  assert.match(svg, /首层 \+1\.00/);
  assert.match(svg, /楼板 \+1\.00/);
  assert.match(svg, /檐口 \+5\.00/);
  assert.match(svg, /屋脊 \+8\.00/);
  assert.match(svg, /喝茶区/);
  assert.match(svg, /中央长桌 2\.0m/);
  assert.match(svg, /示意剖面/);
  assert.match(svg, /示意比例尺/);
  assert.doesNotMatch(svg, BAD);
  assert.doesNotMatch(svg, RAW_AMP);
  assert.ok(SECTION_PLOT.w > 0);
});

test('平屋面剖面也能生成，不依赖坡屋顶字段', () => {
  const base = exampleScheme();
  const scheme = DesignScheme.parse({
    ...base,
    roof: {
      ...base.roof,
      form: 'flat',
      pitchDegrees: 0,
      eaveHeight: 5,
      ridgeHeight: 5,
      overhang: 1,
    },
  });
  const svg = renderSectionSvg(scheme);
  assert.match(svg, /平屋面 \+5\.00/);
  assert.doesNotMatch(svg, BAD);
});
