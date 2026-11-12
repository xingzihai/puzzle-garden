/** zip.ts：中央目录、store/deflate、CRC 与路径筛选。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import { readZipDirectory, readZipEntry, zipEntriesUnder } from './zip.ts';

function zip(entries: readonly { name: string; data: Uint8Array; deflate?: boolean }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const stored = deflateRawSync(entry.data);
    const data = entry.deflate === true ? stored : Buffer.from(entry.data);
    const method = entry.deflate === true ? 8 : 0;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBytes, eocd]));
}

test('读取 store / deflate 条目并按前缀筛选', () => {
  const data = zip([
    { name: 'assets/minecraft/blockstates/stone.json', data: Buffer.from('{"a":1}') },
    { name: 'assets/minecraft/textures/block/stone.png', data: Buffer.from([1, 2, 3, 4]), deflate: true },
    { name: 'assets/minecraft/textures/block/', data: Buffer.from('') },
  ]);
  const entries = readZipDirectory(data);
  assert.equal(entries.length, 3);
  const states = zipEntriesUnder(entries, 'assets/minecraft/blockstates/');
  assert.equal(states.length, 1);
  const stateEntry = states[0];
  assert.ok(stateEntry !== undefined);
  assert.equal(new TextDecoder().decode(readZipEntry(data, stateEntry)), '{"a":1}');
  const png = zipEntriesUnder(entries, 'assets/minecraft/textures/block/').find((entry) => entry.name.endsWith('.png'));
  assert.ok(png !== undefined);
  assert.deepEqual(Array.from(readZipEntry(data, png)), [1, 2, 3, 4]);
});

test('坏 zip / 路径越界 / CRC 错误都报错', () => {
  assert.throws(() => readZipDirectory(new Uint8Array(10)), /ZIP/);
  const data = zip([{ name: 'a.txt', data: Buffer.from('hello') }]);
  const entry = readZipDirectory(data)[0];
  assert.ok(entry !== undefined);
  const corrupt = Uint8Array.from(data);
  corrupt[35] = 0;
  assert.throws(() => readZipEntry(corrupt, entry), /CRC|越界|签名/);
  const changed = Uint8Array.from(data);
  const view = new DataView(changed.buffer);
  const central = view.getUint32(changed.length - 6, true);
  view.setUint32(central + 20, 9999, true);
  const bad = readZipDirectory(changed)[0];
  assert.ok(bad !== undefined);
  assert.throws(() => readZipEntry(changed, bad), /越界|CRC/);
});
