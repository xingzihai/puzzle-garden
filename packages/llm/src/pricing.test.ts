/**
 * pricing.ts 的测试（MODEL-SPEC §9、C2）。
 * 用 node:crypto 对 JSON.stringify(PRICING) 复算，改动价格却没改 PRICING_VERSION 时测试即红。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { PRICING, PRICING_VERSION } from './pricing.ts';

describe('PRICING_VERSION', () => {
  it('等于 sha256(JSON.stringify(PRICING)) 的前 12 位十六进制', () => {
    const hash = createHash('sha256').update(JSON.stringify(PRICING)).digest('hex').slice(0, 12);
    assert.equal(PRICING_VERSION, hash);
  });

  it('是 12 位小写十六进制字面量', () => {
    assert.match(PRICING_VERSION, /^[0-9a-f]{12}$/);
  });
});

describe('PRICING', () => {
  it('高峰价与官方 2026-10-03 定价页一致（元/百万 token）', () => {
    assert.deepEqual(PRICING.peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 });
    assert.deepEqual(PRICING.offPeak, { cacheHit: 0.02, cacheMiss: 1, output: 4 });
    assert.equal(PRICING.model, 'deepseek-flash');
    assert.equal(PRICING.unit, 'per-1M-tokens');
  });
});
