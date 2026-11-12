/**
 * blobs 的测试（MODEL-SPEC §7.1、§8）：sha256 内容寻址、去重、缺失与非法 sha 报错。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createBlobStore, sha256Hex } from './blobs.ts';

const dir = mkdtempSync(join(tmpdir(), 'pg-store-blobs-'));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('blobs', () => {
  it('好样本：相同字节两次 put 只写一份，读回逐字节相同', () => {
    const store = createBlobStore(join(dir, 'a'));
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const first = store.put(bytes);
    const second = store.put(Uint8Array.from([1, 2, 3, 4]));
    assert.deepEqual(first, second);
    assert.equal(first.bytes, 4);
    assert.deepEqual(first.sha256, sha256Hex(bytes));
    assert.equal(readdirSync(join(dir, 'a')).length, 1);
    assert.deepEqual([...store.get(first.sha256)], [1, 2, 3, 4]);
    assert.equal(store.has(first.sha256), true);
  });

  it('不同字节得到不同 sha 与不同文件', () => {
    const store = createBlobStore(join(dir, 'b'));
    const a = store.put(Uint8Array.from([1]));
    const b = store.put(Uint8Array.from([2]));
    assert.notEqual(a.sha256, b.sha256);
    assert.equal(readdirSync(join(dir, 'b')).length, 2);
  });

  it('sha256Hex 空输入的金标', () => {
    assert.equal(sha256Hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('坏样本：缺失 blob、非法 sha 抛错', () => {
    const store = createBlobStore(join(dir, 'c'));
    assert.throws(() => store.get('a'.repeat(64)), /blob 不存在/);
    assert.throws(() => store.get('not-a-sha'), /64 位小写十六进制/);
    assert.throws(() => store.has('../escape'), /64 位小写十六进制/);
  });

  it('blobs 目录里不会被 sha 之外的路径写入', () => {
    const store = createBlobStore(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'leftover'), 'x');
    store.put(Uint8Array.from([9]));
    assert.equal(readdirSync(join(dir, 'd')).includes('leftover'), true);
  });
});
