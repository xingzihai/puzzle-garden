import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleScheme } from './example.ts';
import { DesignScheme } from './scheme.ts';
import { previewSummary, renderPreviewBundle } from './preview.ts';

const RAW_AMP = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i;

test('bundle 包含 site、每层平面、axon、section、materials 与 index.html', () => {
  const scheme = exampleScheme();
  const bundle = renderPreviewBundle(scheme);
  assert.deepEqual(
    bundle.files.map((file) => file.name),
    ['site.svg', 'plan-lv-ground.svg', 'axon.svg', 'section.svg', 'materials.svg'],
  );
  for (const file of bundle.files) {
    assert.ok(file.title.length > 0);
    assert.match(file.svg, /^<svg /);
    assert.doesNotMatch(file.svg, /undefined|NaN/);
    assert.doesNotMatch(file.svg, RAW_AMP);
  }
  assert.match(bundle.indexHtml, /^<!doctype html>/);
  assert.match(bundle.indexHtml, /稻田茶亭/);
  assert.match(bundle.indexHtml, /src="site\.svg"/);
  assert.match(bundle.indexHtml, /src="materials\.svg"/);
  assert.match(bundle.indexHtml, /href="plan-lv-ground\.svg"/);
  assert.match(bundle.indexHtml, /文件/);
  assert.doesNotMatch(bundle.indexHtml, /https?:\/\//);
});

test('索引页转义标题与概念中的 HTML / XML 特殊字符', () => {
  const base = exampleScheme();
  const scheme = DesignScheme.parse({
    ...base,
    meta: { ...base.meta, title: 'A & B <C>', concept: 'concept & <test>' },
  });
  const bundle = renderPreviewBundle(scheme);
  assert.match(bundle.indexHtml, /A &amp; B &lt;C&gt;/);
  assert.match(bundle.indexHtml, /concept &amp; &lt;test&gt;/);
  assert.doesNotMatch(bundle.indexHtml, RAW_AMP);
  assert.match(bundle.files[0]?.svg ?? '', /A &amp; B &lt;C&gt;/);
});

test('同一输入两次生成逐字节相同', () => {
  const scheme = exampleScheme(3);
  const first = renderPreviewBundle(scheme);
  const second = renderPreviewBundle(exampleScheme(3));
  assert.equal(first.indexHtml, second.indexHtml);
  for (let index = 0; index < first.files.length; index += 1) {
    assert.equal(first.files[index]?.svg, second.files[index]?.svg);
    assert.equal(first.files[index]?.name, second.files[index]?.name);
  }
});

test('摘要报告文件数与版本', () => {
  const scheme = exampleScheme(2);
  const bundle = renderPreviewBundle(scheme);
  assert.equal(previewSummary(scheme, bundle), '稻田茶亭 v2 · 5 个 SVG + index.html');
});
