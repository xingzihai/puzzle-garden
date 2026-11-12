/** model-pack.ts：PGMP 编解码、边界与图集布局。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeModelPack,
  emptyModelPack,
  encodeModelPack,
  MODEL_PACK_MAGIC,
  MODEL_PACK_VERSION,
} from './model-pack.ts';
import type { RenderModelPack } from './model-pack.ts';

function pack(): RenderModelPack {
  const rgba = new Uint8Array(4 * 4 * 4);
  rgba.set([255, 255, 255, 255], 0);
  return {
    models: [
      {
        boxes: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: [
              { uv: [0, 0, 4, 4], tint: false, rotation: 0 },
              { uv: [1, 1, 4, 4], tint: true, rotation: 1 },
              null,
              null,
              { uv: [2, 2, 4, 4], tint: false, rotation: 2 },
              null,
            ],
          },
        ],
      },
    ],
    atlas: { width: 4, height: 4, rgba },
  };
}

test('编码 → 解码保持模型、UV、tint、旋转与图集', () => {
  const encoded = encodeModelPack(pack());
  assert.equal(String.fromCharCode(...encoded.subarray(0, 4)), MODEL_PACK_MAGIC);
  assert.equal(new DataView(encoded.buffer).getUint16(4, true), MODEL_PACK_VERSION);
  const decoded = decodeModelPack(encoded);
  assert.equal(decoded.models.length, 1);
  const model = decoded.models[0];
  assert.ok(model !== undefined);
  const box = model.boxes[0];
  assert.ok(box !== undefined);
  assert.deepEqual(box.from, [0, 0, 0]);
  assert.deepEqual(box.to, [16, 16, 16]);
  const face0 = box.faces[0];
  const face1 = box.faces[1];
  assert.ok(face0 !== null && face0 !== undefined);
  assert.ok(face1 !== null && face1 !== undefined);
  assert.equal(face0.tint, false);
  assert.equal(face1.tint, true);
  assert.equal(face1.rotation, 1);
  assert.equal(box.faces[2], null);
  assert.deepEqual(face0.uv, [0, 0, 4, 4]);
  assert.equal(decoded.atlas.width, 4);
  assert.equal(decoded.atlas.height, 4);
  assert.equal(decoded.atlas.rgba.length, 64);
});

test('空包可编码，且解码结果稳定', () => {
  const decoded = decodeModelPack(encodeModelPack(emptyModelPack()));
  assert.equal(decoded.models.length, 0);
  assert.deepEqual(Array.from(decoded.atlas.rgba), [255, 255, 255, 255]);
});

test('坏 magic / 版本 / 长度 / 图集尺寸都明确报错', () => {
  const good = encodeModelPack(pack());
  const badMagic = Uint8Array.from(good);
  badMagic[0] = 0;
  assert.throws(() => decodeModelPack(badMagic), /magic/);
  const badVersion = Uint8Array.from(good);
  new DataView(badVersion.buffer).setUint16(4, 99, true);
  assert.throws(() => decodeModelPack(badVersion), /版本/);
  assert.throws(() => decodeModelPack(good.subarray(0, 20)), /不足头部|短于/);
  assert.throws(() => decodeModelPack(good.subarray(0, good.length - 1)), /尾部|缺少/);
  const badBoxes = pack();
  assert.throws(() => encodeModelPack({ ...badBoxes, models: [{ boxes: [] }] }), /不能没有盒子/);
  assert.throws(
    () => encodeModelPack({ ...badBoxes, atlas: { width: 3, height: 4, rgba: new Uint8Array(4) } }),
    /图集/,
  );
});
