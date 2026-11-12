/** build-mc-catalog.ts：从合成官方目录生成状态索引与模型包。 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { decodeModelPack, encodeModelPack } from '../packages/render/src/model-pack.ts';
import { buildCatalog } from './build-mc-catalog.ts';
import { pngOf } from './mc/png-fixture.ts';

function write(path: string, data: string | Uint8Array): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, data);
}

function fixture(): { dir: string; blockStates: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pg-catalog-'));
  const mc = join(dir, 'assets', 'minecraft');
  write(
    join(mc, 'blockstates', 'stone.json'),
    JSON.stringify({ variants: { '': { model: 'minecraft:block/stone' } } }),
  );
  write(
    join(mc, 'blockstates', 'oak_fence.json'),
    JSON.stringify({
      multipart: [
        { apply: { model: 'block/oak_fence_post' } },
        { when: { north: 'true' }, apply: { model: 'block/oak_fence_side' } },
        { when: { east: 'true' }, apply: { model: 'block/oak_fence_side', y: 90 } },
        { when: { south: 'true' }, apply: { model: 'block/oak_fence_side', y: 180 } },
        { when: { west: 'true' }, apply: { model: 'block/oak_fence_side', y: 270 } },
      ],
    }),
  );
  write(
    join(mc, 'models', 'block', 'cube_all.json'),
    JSON.stringify({
      elements: [
        {
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: {
            north: { texture: '#all' },
            south: { texture: '#all' },
            east: { texture: '#all' },
            west: { texture: '#all' },
            up: { texture: '#all' },
            down: { texture: '#all' },
          },
        },
      ],
    }),
  );
  write(
    join(mc, 'models', 'block', 'stone.json'),
    JSON.stringify({ parent: 'block/cube_all', textures: { all: 'block/stone' } }),
  );
  write(
    join(mc, 'models', 'block', 'fence_post.json'),
    JSON.stringify({ elements: [{ from: [6, 0, 6], to: [10, 16, 10], faces: { north: { texture: '#texture' } } }] }),
  );
  write(
    join(mc, 'models', 'block', 'fence_side.json'),
    JSON.stringify({ elements: [{ from: [7, 12, 0], to: [9, 15, 9], faces: { north: { texture: '#texture' } } }] }),
  );
  write(
    join(mc, 'models', 'block', 'oak_fence_post.json'),
    JSON.stringify({ parent: 'block/fence_post', textures: { texture: 'block/oak_planks' } }),
  );
  write(
    join(mc, 'models', 'block', 'oak_fence_side.json'),
    JSON.stringify({ parent: 'block/fence_side', textures: { texture: 'block/oak_planks' } }),
  );
  write(
    join(mc, 'textures', 'block', 'stone.png'),
    pngOf(2, 2, Uint8Array.from([100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255])),
  );
  write(
    join(mc, 'textures', 'block', 'oak_planks.png'),
    pngOf(2, 2, Uint8Array.from([180, 140, 80, 255, 180, 140, 80, 255, 180, 140, 80, 255, 180, 140, 80, 255])),
  );
  const blockStates = join(dir, 'block-states.json');
  write(
    blockStates,
    JSON.stringify({
      blocks: [
        { name: 'stone', properties: [] },
        {
          name: 'oak_fence',
          properties: [
            { name: 'east', type: 'bool', values: ['true', 'false'], default: 'false' },
            { name: 'north', type: 'bool', values: ['true', 'false'], default: 'false' },
            { name: 'south', type: 'bool', values: ['true', 'false'], default: 'false' },
            { name: 'waterlogged', type: 'bool', values: ['true', 'false'], default: 'false' },
            { name: 'west', type: 'bool', values: ['true', 'false'], default: 'false' },
          ],
        },
      ],
    }),
  );
  return { dir, blockStates };
}

test('生成状态索引、16 组连接、图集与可解码模型包', () => {
  const { dir, blockStates } = fixture();
  try {
    const built = buildCatalog({
      assetsDir: dir,
      blockStatesPath: blockStates,
      outCatalog: join(dir, 'catalog.json'),
      outPack: join(dir, 'model-pack.bin'),
    });
    assert.equal(built.catalog.states['stone'], 1);
    assert.equal(built.catalog.defaults['oak_fence'], built.catalog.connections['oak_fence']?.[0]);
    assert.equal(built.catalog.connections['oak_fence']?.length, 16);
    assert.equal(new Set(built.catalog.connections['oak_fence']).size, 16);
    assert.ok(built.stats.textures >= 2);
    const decoded = decodeModelPack(encodeModelPack(built.pack));
    assert.equal(decoded.models.length, built.pack.models.length);
    assert.ok(decoded.atlas.rgba.length > 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
