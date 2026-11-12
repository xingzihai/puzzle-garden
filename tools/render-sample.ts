/**
 * 人工样张（RENDER-SPEC §12 第 8 条，不进门禁）：把 12 份几何夹具按交付视角渲染到
 * `.work/render-samples/`，并生成 index.html 便于人工看图。图片不入库。
 *
 * 用法：node tools/render-sample.ts [夹具名 …]   （缺省渲染全部 12 份）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { API_VERSION, createWorld } from '@pg/geometry';
import type { World } from '@pg/geometry';

import { DEFAULT_REQUESTS, createRenderer } from '@pg/render/render';

import a1 from '../packages/geometry/fixtures/f1-pav.A.ts';
import b1 from '../packages/geometry/fixtures/f1-pav.B.ts';
import a2 from '../packages/geometry/fixtures/f2-res.A.ts';
import b2 from '../packages/geometry/fixtures/f2-res.B.ts';
import a3 from '../packages/geometry/fixtures/f3-stu.A.ts';
import b3 from '../packages/geometry/fixtures/f3-stu.B.ts';
import a4 from '../packages/geometry/fixtures/f4-chu.A.ts';
import b4 from '../packages/geometry/fixtures/f4-chu.B.ts';
import a5 from '../packages/geometry/fixtures/f5-tow.A.ts';
import b5 from '../packages/geometry/fixtures/f5-tow.B.ts';
import a6 from '../packages/geometry/fixtures/f6-crt.A.ts';
import b6 from '../packages/geometry/fixtures/f6-crt.B.ts';

const FIXTURES: Readonly<Record<string, (w: World) => void>> = {
  'f1-pav.A': a1,
  'f1-pav.B': b1,
  'f2-res.A': a2,
  'f2-res.B': b2,
  'f3-stu.A': a3,
  'f3-stu.B': b3,
  'f4-chu.A': a4,
  'f4-chu.B': b4,
  'f5-tow.A': a5,
  'f5-tow.B': b5,
  'f6-crt.A': a6,
  'f6-crt.B': b6,
};

function archiveOf(build: (w: World) => void): Uint8Array {
  const host = createWorld(loadRegistry().table);
  build(host.world);
  return writeArchive(host.compose().grid, API_VERSION);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

async function main(): Promise<void> {
  const registry = loadRegistry();
  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : Object.keys(FIXTURES);
  const outDir = fileURLToPath(new URL('../.work/render-samples/', import.meta.url));
  mkdirSync(outDir, { recursive: true });

  const renderer = createRenderer(registry);
  const timings: number[] = [];
  const rows: string[] = [];
  try {
    for (const name of names) {
      const build = FIXTURES[name];
      if (build === undefined) throw new Error(`未知夹具 ${name}`);
      const started = performance.now();
      const result = await renderer.render(archiveOf(build), DEFAULT_REQUESTS.deliver);
      if (result.kind !== 'ok') throw new Error(`${name} 渲染失败：${result.kind}`);
      const ms = performance.now() - started;
      timings.push(ms);
      mkdirSync(join(outDir, name), { recursive: true });
      const cells: string[] = [];
      for (const image of result.images) {
        const file = `${image.view}.png`;
        writeFileSync(join(outDir, name, file), image.png);
        cells.push(
          `<figure><img src="${name}/${file}" loading="lazy"><figcaption>${image.view} · ${String(
            Math.round(image.pixelsPerCell * 100) / 100,
          )} px/格 · 填框 ${(image.frameFill * 100).toFixed(1)}%</figcaption></figure>`,
        );
      }
      rows.push(
        `<section><h2>${name} <small>${String(Math.round(ms))} ms · ${String(result.scene.faces)} 面</small></h2>${cells.join('')}</section>`,
      );
      console.log(
        `${name}: ${String(Math.round(ms))} ms · ${String(result.scene.cells)} 格 · ${String(result.scene.faces)} 面`,
      );
    }
  } finally {
    await renderer.close();
  }

  const html = [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>渲染样张</title>',
    '<style>body{font-family:sans-serif;background:#e8edf2;margin:16px}h2{font-size:18px}small{color:#666;font-weight:400}',
    'section{margin-bottom:32px}figure{display:inline-block;margin:4px;background:#fff;padding:4px}',
    'img{max-width:420px;display:block}figcaption{font-size:12px;color:#444}</style></head><body>',
    `<h1>渲染样张 · ${String(names.length)} 份夹具</h1>`,
    ...rows,
    '</body></html>',
  ].join('\n');
  writeFileSync(join(outDir, 'index.html'), html);

  const total = timings.reduce((sum, t) => sum + t, 0);
  console.log(
    `\n共 ${String(names.length)} 份 · 总耗时 ${String(Math.round(total))} ms · 单栋中位 ${String(Math.round(median(timings)))} ms`,
  );
  console.log(`样张目录：${outDir}`);
}

await main();
