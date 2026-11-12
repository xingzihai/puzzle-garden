import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBlockTable } from '@pg/core/block-state';
import fc from 'fast-check';

import { colorCandidates, nearestColorBlock } from './color.ts';
import type { MassingColorCandidate } from './color.ts';
import { loadRegistry } from './load.ts';
import { BlockRegistry } from './registry.ts';
import type { BlockInfo } from './registry.ts';

/** 合成注册表：createBlockTable 只要求一张合法表，查询走传入的 infos。 */
const table = createBlockTable({ blocks: [{ name: 'air', properties: [] }] });

function block(over: Partial<BlockInfo> & { id: string }): BlockInfo {
  return {
    id: over.id,
    zh: over.zh ?? '测试方块',
    shape: over.shape ?? 'cube',
    family: over.family ?? 'stone',
    color: over.color ?? { source: 'texture', rgb: 0x112233, confidence: 'high' },
    luminance: over.luminance ?? 0,
    transparent: over.transparent ?? false,
  };
}

const registryOf = (...infos: BlockInfo[]): BlockRegistry => new BlockRegistry(table, infos);

describe('colorCandidates', () => {
  it('只保留 cube / 有颜色 / 置信度非 low / 非透明 / 无发光，按 id 升序', () => {
    const registry = registryOf(
      block({ id: 'keep_cube' }),
      block({ id: 'no_shape', shape: 'stairs' }),
      block({ id: 'no_color', color: { source: 'none' } }),
      block({ id: 'low_conf', color: { source: 'texture', rgb: 0x010203, confidence: 'low' } }),
      block({ id: 'see_through', transparent: true }),
      block({ id: 'glows', luminance: 15 }),
      block({ id: 'keep2', family: 'wood', color: { source: 'tint', rgb: 0x445566, confidence: 'medium' } }),
    );
    assert.deepEqual(colorCandidates(registry), [
      { id: 'keep2', rgb: 0x445566, family: 'wood' },
      { id: 'keep_cube', rgb: 0x112233, family: 'stone' },
    ]);
    assert.ok(Object.isFrozen(colorCandidates(registry)));
  });

  it('真实注册表：结果与独立筛选一致、按码点升序', () => {
    const registry = loadRegistry();
    const actual = colorCandidates(registry);
    const expected: MassingColorCandidate[] = [];
    for (const id of registry.ids()) {
      const info = registry.get(id)!;
      if (info.shape !== 'cube') continue;
      if (info.color.source === 'none') continue;
      if (info.color.confidence === 'low') continue;
      if (info.transparent) continue;
      if (info.luminance !== 0) continue;
      expected.push({ id: info.id, rgb: info.color.rgb, family: info.family });
    }
    assert.deepEqual(actual, expected);
    assert.ok(actual.length > 0);
    assert.ok(actual.every((c, i) => i === 0 || (actual[i - 1]?.id ?? '') < c.id));
    assert.ok(actual.every((c) => Number.isInteger(c.rgb) && c.rgb >= 0 && c.rgb <= 0xffffff));
  });
});

describe('nearestColorBlock', () => {
  const candidates: readonly MassingColorCandidate[] = [
    { id: 'black', rgb: 0x000000, family: 'stone' },
    { id: 'white', rgb: 0xffffff, family: 'quartz' },
    { id: 'red', rgb: 0xff0000, family: 'terracotta' },
  ];

  it('精确命中返回该候选', () => {
    assert.equal(nearestColorBlock(0xff0000, candidates).id, 'red');
  });

  it('整数平方距离最小（不取平方根也不取整）', () => {
    assert.equal(nearestColorBlock(0xfe0000, candidates).id, 'red');
    assert.equal(nearestColorBlock(0x0000ff, candidates).id, 'black');
  });

  it('距离相同按 id 码点升序，与输入顺序无关', () => {
    const tie: readonly MassingColorCandidate[] = [
      { id: 'b', rgb: 0x808081, family: 'stone' },
      { id: 'a', rgb: 0x80807f, family: 'stone' },
    ];
    assert.equal(nearestColorBlock(0x808080, tie).id, 'a');
    assert.equal(nearestColorBlock(0x808080, [...tie].reverse()).id, 'a');
  });

  it('候选为空时响亮抛错', () => {
    assert.throws(() => nearestColorBlock(0x000000, []), /没有候选方块/);
  });

  it('性质：结果属于候选、距离不劣于任何候选、与输入顺序无关', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffff }),
        fc.uniqueArray(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 6 }),
            rgb: fc.integer({ min: 0, max: 0xffffff }),
            family: fc.constant<MassingColorCandidate['family']>('stone'),
          }),
          { minLength: 1, maxLength: 8, selector: (c) => c.id },
        ),
        (rgb, list) => {
          const pick = nearestColorBlock(rgb, list);
          const chain = (c: MassingColorCandidate): number => {
            const dr = ((rgb >> 16) & 0xff) - ((c.rgb >> 16) & 0xff);
            const dg = ((rgb >> 8) & 0xff) - ((c.rgb >> 8) & 0xff);
            const db = (rgb & 0xff) - (c.rgb & 0xff);
            return dr * dr + dg * dg + db * db;
          };
          assert.ok(list.includes(pick));
          assert.ok(list.every((c) => chain(pick) <= chain(c)));
          assert.equal(nearestColorBlock(rgb, [...list].reverse()).id, pick.id);
        },
      ),
      { numRuns: 200 },
    );
  });
});
