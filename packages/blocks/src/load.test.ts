import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { DEFAULT_ASSETS_DIR, FILES, loadRegistry } from './load.ts';
import { BlocksError } from './registry.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempAssets(files: Partial<Record<keyof typeof FILES, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pg-blocks-'));
  dirs.push(dir);
  for (const [key, content] of Object.entries(files)) {
    const path = join(dir, FILES[key as keyof typeof FILES]);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof BlocksError ? e.code : 'not-blocks-error';
  }
  return undefined;
}

describe('loadRegistry', () => {
  it('默认读仓库 assets/', () => {
    assert.match(DEFAULT_ASSETS_DIR, /assets$/);
    assert.equal(loadRegistry().ids().length, 1003);
  });

  it('可以指定目录', () => {
    const states = JSON.stringify({ blocks: [{ name: 'air', properties: [] }] });
    const registry = JSON.stringify([
      {
        id: 'air',
        zh: '空气',
        shape: 'other',
        family: 'misc',
        color: null,
        colorSource: 'none',
        colorConfidence: 'high',
        props: { luminance: 0, transparent: true, waterloggable: false },
      },
    ]);
    assert.deepEqual(loadRegistry(tempAssets({ states, registry })).ids(), ['air']);
  });

  it('文件缺失或不是 JSON 时报 invalid-registry，并保留原因', () => {
    assert.equal(
      codeOf(() => loadRegistry(tempAssets({}))),
      'invalid-registry',
    );
    const dir = tempAssets({ states: '{', registry: '[]' });
    assert.throws(
      () => loadRegistry(dir),
      (e: unknown) =>
        e instanceof BlocksError && e.message.includes('不是合法的 JSON') && e.cause instanceof SyntaxError,
    );
    assert.throws(() => loadRegistry(tempAssets({ registry: '[]' })), /读不到方块数据文件 .*block-states\.json/);
  });
});
