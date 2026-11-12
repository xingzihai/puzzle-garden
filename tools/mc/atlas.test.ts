/** atlas.ts：稳定排布、白像素与动画第一帧。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAtlas } from './atlas.ts';

function solid(width: number, height: number, value: number): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba.set([value, value, value, 255], i * 4);
  return { width, height, rgba };
}

test('白像素在 (0,0)，纹理按 key 稳定排布', () => {
  const atlas = buildAtlas(
    new Map([
      ['block/a', solid(16, 16, 10)],
      ['block/b', solid(16, 16, 20)],
    ]),
    64,
  );
  assert.equal(atlas.width, 64);
  assert.deepEqual(Array.from(atlas.rgba.subarray(0, 4)), [255, 255, 255, 255]);
  assert.ok(atlas.placements['block/a'] !== undefined);
  assert.ok(atlas.placements['block/b'] !== undefined);
  const second = buildAtlas(
    new Map([
      ['block/b', solid(16, 16, 20)],
      ['block/a', solid(16, 16, 10)],
    ]),
    64,
  );
  assert.deepEqual(second.placements, atlas.placements);
});

test('动画竖条取第一帧；超宽纹理报错', () => {
  const animated = solid(16, 64, 30);
  const atlas = buildAtlas(new Map([['block/fire', animated]]), 64);
  assert.equal(atlas.placements['block/fire']?.height, 16);
  assert.throws(() => buildAtlas(new Map([['block/wide', solid(100, 16, 1)]]), 64), /超过图集上限/);
  assert.throws(() => buildAtlas(new Map(), 32), /不合法/);
});
