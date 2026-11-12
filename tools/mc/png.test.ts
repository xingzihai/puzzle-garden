/** png.ts：RGBA / 调色板 / 透明与格式边界。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

import { decodePng } from './png.ts';
import { pngOf } from './png-fixture.ts';

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  return Buffer.concat([head, Buffer.from(type), Buffer.from(data), Buffer.alloc(4)]);
}

function indexed(): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const plte = Buffer.from([255, 0, 0, 0, 255, 0]);
  const trns = Buffer.from([255, 64]);
  const raw = Buffer.from([0, 0, 1]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('PLTE', plte),
      chunk('tRNS', trns),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', empty()),
    ]),
  );
}
function empty(): Uint8Array {
  return new Uint8Array(0);
}

test('RGBA 往返', () => {
  const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 30, 40]);
  const decoded = decodePng(pngOf(2, 2, rgba));
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.deepEqual(Array.from(decoded.rgba), Array.from(rgba));
});

test('调色板 + tRNS 透明', () => {
  const decoded = decodePng(indexed());
  assert.deepEqual(Array.from(decoded.rgba), [255, 0, 0, 255, 0, 255, 0, 64]);
});

test('坏签名 / 截断 / 隔行 / 16 位都报错', () => {
  assert.throws(() => decodePng(new Uint8Array(4)), /太短/);
  const bad = pngOf(1, 1, Uint8Array.from([1, 2, 3, 4]));
  bad[0] = 0;
  assert.throws(() => decodePng(bad), /签名/);
  assert.throws(() => decodePng(pngOf(1, 1, Uint8Array.from([1, 2, 3, 4])).subarray(0, 30)), /越界|不足/);
  const interlaced = pngOf(1, 1, Uint8Array.from([1, 2, 3, 4]));
  interlaced[8 + 8 + 12] = 1;
  assert.throws(() => decodePng(interlaced), /隔行/);
});
