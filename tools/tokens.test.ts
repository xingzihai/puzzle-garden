/** token 计数与官方参考实现一致；以前的标准结果来自 Python `tokenizers` 0.22.1 + 同一份 tokenizer.json（决策 #65）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadTokenCounter } from './tokens.ts';

/**
 * 以前的标准结果：2026-10-02 用 Python `tokenizers` 0.22.1 加载 assets/deepseek-v4/tokenizer.json、
 * `encode(text, add_special_tokens=False).ids` 得到。覆盖中英日文、emoji、数字三位切分、空白与换行、特殊 token。
 */
const GOLDEN: readonly (readonly [string, readonly number[]])[] = [
  ['Hello!', [19923, 3]],
  ['', []],
  [' ', [223]],
  ['  hello  world ', [223, 44388, 223, 2058, 223]],
  ['\n\n', [271]],
  ['a\r\nb', [67, 204, 201, 68]],
  ['x = 12345678;', [90, 438, 223, 6895, 18009, 2597, 29]],
  [
    "world.roof({ on: hall, kind: 'gable', pitch: 0.5 });",
    [
      29616, 102817, 2154, 13588, 377, 28, 14085, 14, 3576, 28, 905, 73, 679, 1780, 18920, 28, 223, 18, 16, 23, 837,
      3171,
    ],
  ],
  [
    '台基：承托轮廓向四边外挑，顶部可承托外墙。',
    [2426, 1475, 768, 3413, 5721, 44878, 1427, 1786, 2220, 1244, 7460, 303, 48731, 653, 3413, 5721, 109119, 320],
  ],
  ['屋面roof混合mixed中文English', [108735, 307, 2154, 14769, 122545, 21134, 17530]],
  ['ひらがなカタカナ', [40259, 4970, 2936, 2942, 15961, 11767, 15961, 27071]],
  ['émoji 🏯 test', [619, 7129, 7063, 7351, 240, 110, 1950]],
  [
    "'stone_brick_stairs[facing=east,half=bottom]'",
    [9, 15399, 9181, 8264, 13088, 5851, 79083, 8721, 91343, 648, 58575, 3652, 31, 43714, 63, 9],
  ],
  ['<｜begin▁of▁sentence｜>', [0]],
  ['1234567890', [6895, 18009, 25744, 18]],
  ['!!!???...', [34513, 50640, 1613]],
  ['\t\tindent', [200, 200, 655, 309]],
  ["don't won't", [20385, 1664, 5646, 1664]],
];

const counter = loadTokenCounter();

test('与官方参考实现逐 token 一致', () => {
  for (const [text, ids] of GOLDEN) assert.deepEqual(counter.encode(text), ids, JSON.stringify(text));
});

test('计数等于编码长度；版本取官方压缩包 sha256 前 12 位', () => {
  assert.equal(counter.count('台基：承托轮廓向四边外挑，顶部可承托外墙。'), 18);
  assert.equal(counter.count(''), 0);
  assert.equal(counter.version, 'e7310d1dafe0');
});
