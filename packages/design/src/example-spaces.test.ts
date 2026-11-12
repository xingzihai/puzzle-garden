/** 空间范围与元素归属的好坏样本：variant 宽度同步、前缀映射命中、未知前缀不硬塞。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boxes } from './example-geometry.ts';
import { spaces, withSpaces } from './example-spaces.ts';

test('spaces 随 variant 宽度参数：衣服店与西影厅空间范围跟着变', () => {
  const base = spaces(32, 32);
  const widerShop = spaces(28, 32);
  const widerCinema = spaces(32, 24);
  const clothingBase = base.find((item) => item.id === 'sp-clothing');
  const clothingWider = widerShop.find((item) => item.id === 'sp-clothing');
  const cinemaBase = base.find((item) => item.id === 'sp-cine-w');
  const cinemaWider = widerCinema.find((item) => item.id === 'sp-cine-w');
  assert.ok(clothingBase);
  assert.ok(clothingWider);
  assert.ok(cinemaBase);
  assert.ok(cinemaWider);
  assert.equal(clothingBase.bounds.min[0], 32);
  assert.equal(clothingWider.bounds.min[0], 28);
  assert.equal(cinemaBase.bounds.min[0], 32);
  assert.equal(cinemaWider.bounds.min[0], 24);
});

test('withSpaces 按前缀映射，未知前缀不硬塞空间', () => {
  const elements = boxes('b1', [
    ['el-shop-counter', '柜台', 'furnishing', [0, 0, 0], [1, 1, 1], '#111111'],
    ['el-unknown-thing', '未知', 'wall', [0, 0, 0], [1, 1, 1], '#222222'],
  ]);
  const mapped = withSpaces(elements);
  assert.equal(mapped[0]?.spaceId, 'sp-clothing');
  assert.equal(mapped[1] !== undefined && 'spaceId' in mapped[1], false);
});
