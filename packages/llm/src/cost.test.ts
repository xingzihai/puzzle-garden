/**
 * cost.ts 的测试（MODEL-SPEC §9）。
 * 覆盖：v0.2 账本复算、usage 字段缺失抛错、§4.3 推演表逐行复现、预留的硬约束性质测试。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { costOf, LAST_GASP_MIN_OUTPUT_TOKENS, reserveFor } from './cost.ts';
import type { CostUsage } from './cost.ts';

describe('costOf', () => {
  it('复算 v0.2 账本一条记录（模型-SPEC §9）：高峰价合计 ¥0.5934584', () => {
    const usage: CostUsage = {
      prompt_cache_hit_tokens: 3_368_960,
      prompt_cache_miss_tokens: 65_070,
      completion_tokens: 41_070,
    };
    const cny = costOf(usage);
    assert.ok(Math.abs(cny - 0.5934584) < 1e-9);
    assert.equal(cny.toFixed(5), '0.59346');
  });

  it('只认官方三个字段名；缺失或非法时抛错（v0.2 对不上导致成本算成 0）', () => {
    assert.throws(() => costOf({} as CostUsage), /prompt_cache_hit_tokens/);
    assert.throws(
      () => costOf({ prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 1 } as CostUsage),
      /completion_tokens/,
    );
    assert.throws(
      () =>
        costOf({
          prompt_cache_hit_tokens: 1.5,
          prompt_cache_miss_tokens: 0,
          completion_tokens: 0,
        }),
      /prompt_cache_hit_tokens/,
    );
  });
});

describe('reserveFor：MODEL-SPEC §4.3 推演表（上限 ¥3.50）', () => {
  it('第 34 轮请求前：进入窗口，maxTokens 6734、inputUpper 123064、reserved 0.30', () => {
    const r = reserveFor({
      prevPromptTokens: 120_000,
      first: false,
      newBytes: 3_000,
      newMessages: 2,
      newImages: 0,
      spentCny: 3.2,
      limitCny: 3.5,
    });
    assert.ok(!('stop' in r));
    assert.equal(r.inputUpper, 123_064);
    assert.equal(r.maxTokens, 6734);
    assert.equal(r.reservedCny, 0.3);
  });

  it('第 34 轮结算：实际 118000/5000/1500 → ¥0.02672', () => {
    const cny = costOf({
      prompt_cache_hit_tokens: 118_000,
      prompt_cache_miss_tokens: 5_000,
      completion_tokens: 1_500,
    });
    assert.ok(Math.abs(cny - 0.02672) < 1e-9);
    assert.ok(Math.abs(3.2 + cny - 3.22672) < 1e-9);
  });

  it('第 35 轮请求前：inputUpper 126064、maxTokens 2644', () => {
    const r = reserveFor({
      prevPromptTokens: 123_000,
      first: false,
      newBytes: 3_000,
      newMessages: 2,
      newImages: 0,
      spentCny: 3.22672,
      limitCny: 3.5,
    });
    assert.ok(!('stop' in r));
    assert.equal(r.inputUpper, 126_064);
    assert.equal(r.maxTokens, 2644);
  });

  it('第 36 轮请求前：maxTokens < 2000 → stop', () => {
    const r = reserveFor({
      prevPromptTokens: 123_000,
      first: false,
      newBytes: 3_000,
      newMessages: 2,
      newImages: 0,
      spentCny: 3.25,
      limitCny: 3.5,
    });
    assert.deepEqual(r, { stop: true });
  });

  it('首次请求额外 +2048，图片按 1024 token 计', () => {
    const r = reserveFor({
      prevPromptTokens: 0,
      first: true,
      newBytes: 1_000,
      newMessages: 2,
      newImages: 1,
      spentCny: 0,
      limitCny: 3.5,
    });
    assert.ok(!('stop' in r));
    assert.equal(r.inputUpper, 1_000 + 32 * 2 + 1024 + 2048);
  });

  it('maxTokens 上限 40000；恰好 2000 允许，1999 停止', () => {
    const big = reserveFor({
      prevPromptTokens: 0,
      first: false,
      newBytes: 0,
      newMessages: 0,
      newImages: 0,
      spentCny: 0,
      limitCny: 1000,
    });
    assert.ok(!('stop' in big));
    assert.equal(big.maxTokens, 40_000);

    const exact = reserveFor({
      prevPromptTokens: 0,
      first: false,
      newBytes: 0,
      newMessages: 0,
      newImages: 0,
      spentCny: 0,
      limitCny: 0.016, // 2000 × 8/1e6
    });
    assert.ok(!('stop' in exact));
    assert.equal(exact.maxTokens, 2000);

    const below = reserveFor({
      prevPromptTokens: 0,
      first: false,
      newBytes: 0,
      newMessages: 0,
      newImages: 0,
      spentCny: 0,
      limitCny: 0.0159999,
    });
    assert.deepEqual(below, { stop: true });
  });

  it('非法计数抛错', () => {
    const base = {
      prevPromptTokens: 0,
      first: false,
      newBytes: 0,
      newMessages: 0,
      newImages: 0,
      spentCny: 0,
      limitCny: 1,
    };
    assert.throws(() => reserveFor({ ...base, newMessages: -1 }), /newMessages/);
    assert.throws(() => reserveFor({ ...base, newBytes: 0.5 }), /newBytes/);
  });
});

describe('reserveFor：提交窗口最后一口气', () => {
  const nearLimit = {
    prevPromptTokens: 36_000,
    first: false,
    newBytes: 3_000,
    newMessages: 2,
    newImages: 0,
    spentCny: 1.417,
    limitCny: 1.5,
  } as const;

  it('剩余 ¥0.083 + submit：常规预留 stop，最后一口气允许 256–1024 token', () => {
    assert.deepEqual(reserveFor(nearLimit), { stop: true });
    const r = reserveFor({ ...nearLimit, submitLastGasp: { recentCostsCny: [0.0413] } });
    assert.ok(!('stop' in r));
    assert.equal(r.lastGasp, true);
    assert.ok(r.maxTokens >= LAST_GASP_MIN_OUTPUT_TOKENS && r.maxTokens <= 1024);
    assert.ok(1.417 + r.reservedCny <= 1.5 + 1e-12, '硬约束不得突破');
  });

  it('剩余 ¥0.01：即使允许最后一口气也拒绝', () => {
    assert.deepEqual(reserveFor({ ...nearLimit, spentCny: 1.49, submitLastGasp: { recentCostsCny: [0.0413] } }), {
      stop: true,
    });
  });

  it('没有最近真实花费 / 剩余不大于最近花费：无法可靠估算，保持 stop', () => {
    assert.deepEqual(reserveFor({ ...nearLimit, submitLastGasp: { recentCostsCny: [] } }), { stop: true });
    assert.deepEqual(reserveFor({ ...nearLimit, submitLastGasp: { recentCostsCny: [0] } }), { stop: true });
    assert.deepEqual(
      reserveFor({
        prevPromptTokens: 24_000,
        first: false,
        newBytes: 3_000,
        newMessages: 2,
        newImages: 0,
        spentCny: 1.44,
        limitCny: 1.5,
        submitLastGasp: { recentCostsCny: [0.07] },
      }),
      { stop: true },
    );
  });

  it('普通 write/edit 不传 submitLastGasp：仍按原 2000 门槛拒绝', () => {
    assert.deepEqual(reserveFor(nearLimit), { stop: true });
    const normal = reserveFor({
      prevPromptTokens: 0,
      first: false,
      newBytes: 0,
      newMessages: 0,
      newImages: 0,
      spentCny: 0,
      limitCny: 0.0159999,
    });
    assert.deepEqual(normal, { stop: true });
  });
});

describe('reserveFor：硬约束 spent + reserved ≤ limit', () => {
  it('任意请求序列（花费用 costOf 累加）下都成立', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ hit: fc.nat(200_000), miss: fc.nat(200_000), completion: fc.nat(40_000) }), {
          maxLength: 30,
        }),
        fc.nat(1_000_000_000),
        (usages, limitOcta) => {
          const spentOcta = usages.reduce(
            (sum, u) =>
              sum +
              Math.round(
                costOf({
                  prompt_cache_hit_tokens: u.hit,
                  prompt_cache_miss_tokens: u.miss,
                  completion_tokens: u.completion,
                }) * 1e8,
              ),
            0,
          );
          const r = reserveFor({
            prevPromptTokens: 0,
            first: false,
            newBytes: 0,
            newMessages: 0,
            newImages: 0,
            spentCny: spentOcta / 1e8,
            limitCny: limitOcta / 1e8,
          });
          if ('stop' in r) return;
          assert.ok(spentOcta + Math.round(r.reservedCny * 1e8) <= limitOcta);
          assert.ok(r.maxTokens >= 2000 && r.maxTokens <= 40_000);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('最后一口气也成立：spent + reserved ≤ limit，且输出上限 256–1024', () => {
    fc.assert(
      fc.property(fc.nat(1_000_000_000), fc.nat(1_000_000_000), fc.nat(200_000), (limitOcta, spentOcta, recentOcta) => {
        const r = reserveFor({
          prevPromptTokens: 36_000,
          first: false,
          newBytes: 3_000,
          newMessages: 2,
          newImages: 0,
          spentCny: spentOcta / 1e8,
          limitCny: limitOcta / 1e8,
          submitLastGasp: { recentCostsCny: [recentOcta / 1e8] },
        });
        if ('stop' in r || r.lastGasp !== true) return;
        assert.ok(spentOcta + Math.round(r.reservedCny * 1e8) <= limitOcta);
        assert.ok(r.maxTokens >= LAST_GASP_MIN_OUTPUT_TOKENS && r.maxTokens <= 1024);
      }),
      { numRuns: 200 },
    );
  });
});
