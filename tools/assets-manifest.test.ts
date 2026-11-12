import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareManifest } from './assets-manifest.ts';

const A = { sha256: 'a'.repeat(64), bytes: 1 };
const B = { sha256: 'b'.repeat(64), bytes: 1 };

describe('compareManifest', () => {
  it('一致时无问题', () => {
    assert.deepEqual(compareManifest({ x: A }, { x: A }), []);
  });

  it('缺失、被改、多出分别报出', () => {
    assert.deepEqual(compareManifest({ x: A, y: A }, { x: B, z: A }), ['内容被改：x', '缺失：y', '清单外的文件：z']);
  });

  it('只有字节数不同也算被改', () => {
    assert.deepEqual(compareManifest({ x: A }, { x: { ...A, bytes: 2 } }), ['内容被改：x']);
  });
});
