/**
 * render-archive 的端到端集成测试：真实调 Chrome 出一份存档的交付 6 向图，并确认不残留 Chrome 进程。
 * 需要本机 Chrome；找不到时跳过。本文件不在 `npm run check` 里跑，由 `npm run test:integration` 触发。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { API_VERSION, createWorld, rect } from '@pg/geometry';
import type { World } from '@pg/geometry';

const CHROME = '/usr/bin/google-chrome';
const root = fileURLToPath(new URL('..', import.meta.url));

function archiveOf(): Uint8Array {
  const host = createWorld(loadRegistry().table);
  const build = (w: World): void => {
    const base = w.plinth({ footprint: rect(-2, -2, 2, 2), height: 1, project: 1, material: 'stone_bricks' });
    w.walls({ on: base, height: 4, material: 'oak_planks' });
  };
  build(host.world);
  return writeArchive(host.compose().grid, API_VERSION);
}

test('render-archive 出一份存档的 6 向图且不残留 Chrome', { skip: !existsSync(CHROME) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-render-archive-'));
  try {
    const pgar = join(dir, 'mini.pgar');
    writeFileSync(pgar, archiveOf());
    const outDir = join(dir, 'out');
    const result = spawnSync(process.execPath, ['tools/render-archive.ts', pgar, '--out', outDir], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(result.status, 0, result.stderr);
    const files = readdirSync(join(outDir, 'mini')).filter((file) => file.endsWith('.png'));
    assert.deepEqual(files.sort(), ['east.png', 'iso-se.png', 'north.png', 'south.png', 'top.png', 'west.png']);
    for (const file of files) assert.ok(statSync(join(outDir, 'mini', file)).size > 0);
    const pgrep = spawnSync('pgrep', ['-f', `pg-render-${String(result.pid)}-`], { encoding: 'utf8' });
    assert.equal(pgrep.stdout.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
