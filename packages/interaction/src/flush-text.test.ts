import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isFlushMustText } from './flush-text.ts';

test('共享 flush matcher：齐平 / 无高差 / 无台阶 / 不设台阶 / flush', () => {
  for (const text of [
    '齐平',
    '入口与村道齐平',
    '室内外地面无高差',
    '入口无台阶，直接连通村道',
    '入口不设台阶、不设坡道',
    'entry flush with village road',
    'FLUSH ENTRY',
  ]) {
    assert.equal(isFlushMustText(text), true, text);
  }
  assert.equal(isFlushMustText('禁止檐下平台、露台、台阶及室外分区'), false);
  assert.equal(isFlushMustText('普通台阶禁令'), false);
});
