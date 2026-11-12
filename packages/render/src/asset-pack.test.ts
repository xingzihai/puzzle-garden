/** asset-pack.ts：本机官方资源探测、结构校验与 fallback 状态。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { encodeModelPack, emptyModelPack } from './model-pack.ts';
import {
  assetStatus,
  CATALOG_FILE,
  hasImportedManifest,
  loadMcAssetPack,
  MANIFEST_FILE,
  MODEL_PACK_FILE,
  parseCatalog,
} from './asset-pack.ts';

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'pg-assets-'));
}

function catalog(): Record<string, unknown> {
  return {
    mcVersion: '1.20.1',
    states: { oak_stairs: 3 },
    connections: { oak_fence: Array.from({ length: 16 }, (_value, index) => index + 1) },
    defaults: { oak_stairs: 2 },
    coverage: { blocks: 10, states: 20, models: 30, textures: 40 },
  };
}

test('目录不存在返回 missing，状态写 fallback 与原因', () => {
  const dir = temp();
  try {
    const load = loadMcAssetPack(dir);
    assert.equal(load.kind, 'missing');
    const status = assetStatus(load);
    assert.equal(status.source, 'fallback');
    assert.match(status.reason ?? '', /未找到官方资源包/);
    assert.equal(hasImportedManifest(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读取 catalog + model-pack，official 状态带覆盖统计', () => {
  const dir = temp();
  try {
    writeFileSync(join(dir, CATALOG_FILE), JSON.stringify(catalog()));
    writeFileSync(join(dir, MODEL_PACK_FILE), encodeModelPack(emptyModelPack()));
    writeFileSync(join(dir, MANIFEST_FILE), '{}\n');
    const load = loadMcAssetPack(dir);
    assert.equal(load.kind, 'ok');
    assert.equal(load.pack.catalog.coverage.models, 30);
    assert.equal(load.pack.bytes.byteLength > 24, true);
    const status = assetStatus(load);
    assert.deepEqual(
      { source: status.source, models: status.models, blocks: status.coveredBlocks, textures: status.textures },
      { source: 'official', models: 30, blocks: 10, textures: 40 },
    );
    assert.equal(hasImportedManifest(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('坏 JSON / 缺字段 / 坏模型包都返回 invalid', () => {
  const dir = temp();
  try {
    writeFileSync(join(dir, CATALOG_FILE), '{');
    writeFileSync(join(dir, MODEL_PACK_FILE), encodeModelPack(emptyModelPack()));
    assert.equal(loadMcAssetPack(dir).kind, 'invalid');
    writeFileSync(join(dir, CATALOG_FILE), JSON.stringify({ ...catalog(), coverage: undefined }));
    assert.equal(loadMcAssetPack(dir).kind, 'invalid');
    writeFileSync(join(dir, CATALOG_FILE), JSON.stringify(catalog()));
    writeFileSync(join(dir, MODEL_PACK_FILE), new Uint8Array(3));
    assert.equal(loadMcAssetPack(dir).kind, 'invalid');
    assert.throws(() => parseCatalog({ ...catalog(), mcVersion: 'x' }), /mcVersion/);
    assert.throws(() => parseCatalog({ ...catalog(), states: { a: 70000 } }), /65535/);
    assert.throws(() => parseCatalog({ ...catalog(), connections: { a: [1] } }), /长度 16/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
