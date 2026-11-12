/** 导入脚本的哈希函数；导入本身要读官方压缩包，不在单元测试里跑（不联网、不依赖下载产物）。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';

import { EXPECTED_ZIP_SHA256, sha256 } from './import-deepseek-tokenizer.ts';

test('sha256 以前的标准结果', () => {
  assert.equal(sha256(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(EXPECTED_ZIP_SHA256.length, 64);
});

test('assets/deepseek-v4 与 source.json 登记的 sha256 一致', () => {
  const dir = new URL('../assets/deepseek-v4/', import.meta.url);
  const source = z
    .object({
      zipSha256: z.string().regex(/^[a-f0-9]{64}$/),
      files: z.record(
        z.string(),
        z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.int().nonnegative() }),
      ),
    })
    .parse(JSON.parse(readFileSync(new URL('source.json', dir), 'utf8')));
  assert.deepEqual(Object.keys(source.files).sort(), ['tokenizer.json', 'tokenizer_config.json']);
  assert.equal(source.zipSha256, EXPECTED_ZIP_SHA256);
  for (const [name, meta] of Object.entries(source.files)) {
    const bytes = readFileSync(new URL(name, dir));
    assert.equal(sha256(bytes), meta.sha256, name);
    assert.equal(bytes.length, meta.bytes, name);
  }
});
