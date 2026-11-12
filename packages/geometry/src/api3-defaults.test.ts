/**
 * API 3 夹具 hash 回归：6 个新可选参数加入后，12 个人工方案重写的网格 hash。
 *
 * - f2-res.A、f2-res.B、f4-chu.A、f5-tow.A 的常量仍是 API 2 基线，证明"不传新参数时缺省几何不变"
 *   （f4-chu.A 的 `sill: 1 → storey: 0` 是等价改写，hash 不变）。
 * - 其余 8 个夹具按 GEOMETRY-SPEC §8 改成使用新参数，几何有意改变；常量同步更新，作为回归门禁。
 * - 2026-10-04（API 5）：steps / stair 不再写 y ≤ 0 的格（地表那一级不写方块，决策 #21），
 *   10 个含 steps 的夹具 hash 更新；f6 无 steps，hash 不变。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { hashGrid } from '@pg/core/hash';
import { createWorld } from './index.ts';
import type { World } from './index.ts';
import a1 from '../fixtures/f1-pav.A.ts';
import b1 from '../fixtures/f1-pav.B.ts';
import a2 from '../fixtures/f2-res.A.ts';
import b2 from '../fixtures/f2-res.B.ts';
import a3 from '../fixtures/f3-stu.A.ts';
import b3 from '../fixtures/f3-stu.B.ts';
import a4 from '../fixtures/f4-chu.A.ts';
import b4 from '../fixtures/f4-chu.B.ts';
import a5 from '../fixtures/f5-tow.A.ts';
import b5 from '../fixtures/f5-tow.B.ts';
import a6 from '../fixtures/f6-crt.A.ts';
import b6 from '../fixtures/f6-crt.B.ts';

const registry = loadRegistry();
const CASES: Readonly<Record<string, { readonly build: (w: World) => void; readonly hash: string }>> = {
  'f1-pav.A': { build: a1, hash: '1e165e2456bdde0a2cb413b020ed1e65' },
  'f1-pav.B': { build: b1, hash: '27f130aaded10ff768911ce1d8072a28' },
  'f2-res.A': { build: a2, hash: '7a72fe24ca9d27f28842e8334f59331f' },
  'f2-res.B': { build: b2, hash: '583b3bf107a6854fe08b12e4ee9a9ade' },
  'f3-stu.A': { build: a3, hash: '550ac4036eaa5d795ef32caa7a1a4a9e' },
  'f3-stu.B': { build: b3, hash: '6bf942526ff36e1af309c68965665d05' },
  'f4-chu.A': { build: a4, hash: 'e82fe98c2848a138de297678ee9aaca9' },
  'f4-chu.B': { build: b4, hash: '55abb95edd70996d2193c195d6ee066f' },
  'f5-tow.A': { build: a5, hash: 'ce1ecec84669be14d3127df1fe5887df' },
  'f5-tow.B': { build: b5, hash: '9c9749f01821cacb1c04b64b46490fab' },
  'f6-crt.A': { build: a6, hash: 'a999f627625b9c42e6371aa3b5db53ad' },
  'f6-crt.B': { build: b6, hash: '0f18dc68ee87e316997605fef899964c' },
};

for (const [name, c] of Object.entries(CASES))
  test(`${name} 夹具 hash`, () => {
    const host = createWorld(registry.table);
    c.build(host.world);
    assert.equal(hashGrid(host.compose().grid), c.hash);
  });
