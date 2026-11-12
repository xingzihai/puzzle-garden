/** blockstate.ts：variants / multipart / 条件 / 旋转。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateBlockstate, parseBlockstate } from './blockstate.ts';
import type { ModelReader } from './model-json.ts';

const model = JSON.stringify({
  elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { north: { texture: 'block/stone' } } }],
});
const read: ModelReader = () => model;

test('variants 精确匹配；权重数组固定取第一项', () => {
  const blockstate = parseBlockstate(
    JSON.stringify({
      variants: {
        'facing=east,half=bottom': { model: 'block/m' },
        'facing=west,half=bottom': [
          { model: 'block/m', y: 90 },
          { model: 'block/m', y: 270 },
        ],
        '': { model: 'block/m' },
      },
    }),
  );
  const east = evaluateBlockstate(blockstate, { facing: 'east', half: 'bottom' }, read);
  assert.equal(east.matched, true);
  assert.equal(east.boxes.length, 1);
  const west = evaluateBlockstate(blockstate, { facing: 'west', half: 'bottom' }, read);
  assert.equal(west.boxes.length, 1);
  const other = evaluateBlockstate(blockstate, { facing: 'north', half: 'bottom' }, read);
  assert.equal(other.matched, true);
});

test('multipart 条件支持字符串、OR、AND 与数组', () => {
  const blockstate = parseBlockstate(
    JSON.stringify({
      multipart: [
        { apply: { model: 'block/m' } },
        { when: { north: 'true' }, apply: { model: 'block/m', y: 90 } },
        { when: { OR: [{ east: 'true' }, { west: 'true' }] }, apply: { model: 'block/m', y: 180 } },
        { when: { AND: [{ up: 'true' }, { south: 'low' }] }, apply: { model: 'block/m', y: 270 } },
      ],
    }),
  );
  const boxes = evaluateBlockstate(blockstate, { north: 'true', east: 'true', up: 'true', south: 'low' }, read);
  assert.equal(boxes.matched, true);
  assert.equal(boxes.boxes.length, 4);
});

test('未命中返回 matched=false；空 blockstate 不报错', () => {
  const blockstate = parseBlockstate(JSON.stringify({ variants: { 'facing=east': { model: 'block/m' } } }));
  assert.deepEqual(evaluateBlockstate(blockstate, { facing: 'north' }, read), { boxes: [], matched: false });
  assert.deepEqual(evaluateBlockstate(parseBlockstate('{}'), {}, read), { boxes: [], matched: false });
});
