/** model-json.ts：parent 继承、纹理变量、UV 默认值、元素旋转。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveModel, rotateModelBoxes } from './model-json.ts';
import type { ModelReader } from './model-json.ts';

const files: Record<string, string> = {
  'assets/minecraft/models/block/block.json': '{}',
  'assets/minecraft/models/block/cube.json': JSON.stringify({
    parent: 'block/block',
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          north: { texture: '#north' },
          south: { texture: '#south' },
          east: { texture: '#east' },
          west: { texture: '#west' },
          up: { texture: '#up' },
          down: { texture: '#down' },
        },
      },
    ],
  }),
  'assets/minecraft/models/block/cube_all.json': JSON.stringify({
    parent: 'block/cube',
    textures: { all: '#texture', down: '#all', up: '#all', north: '#all', east: '#all', south: '#all', west: '#all' },
  }),
  'assets/minecraft/models/block/planks.json': JSON.stringify({
    parent: 'block/cube_all',
    textures: { texture: 'block/oak_planks' },
  }),
  'assets/minecraft/models/block/rotated.json': JSON.stringify({
    elements: [
      {
        from: [6.5, 0, 6.5],
        to: [9.5, 16, 9.5],
        rotation: { origin: [8, 8, 8], axis: 'y', angle: 45 },
        faces: { north: { texture: 'block/stone', uv: [0, 0, 3, 16] } },
      },
    ],
  }),
};
const read: ModelReader = (path) => files[path];

test('parent 链继承 elements，子模型纹理覆盖后重新解析 #变量', () => {
  const model = resolveModel('minecraft:block/planks', read);
  assert.ok(model !== null);
  assert.equal(model.boxes.length, 1);
  const box = model.boxes[0];
  assert.ok(box !== undefined);
  const face = box.faces[0];
  assert.ok(face !== null && face !== undefined);
  assert.equal(face.texture, 'block/oak_planks');
  assert.equal(face.uv.length, 4);
  assert.equal(model.ambientocclusion, true);
  assert.equal(resolveModel('block/missing', read), null);
});

test('45° 元素旋转取 AABB，90° 旋转保持精确', () => {
  const rotated = resolveModel('block/rotated', read);
  assert.ok(rotated !== null);
  const box = rotated.boxes[0];
  assert.ok(box !== undefined);
  assert.ok(box.from[0] < 6.5 && box.to[0] > 9.5);
  const exact = rotateModelBoxes([box], 'y', 90);
  const first = exact[0];
  assert.ok(first !== undefined);
  const from = first.from[0];
  const to = first.to[0];
  assert.ok(Math.abs(to - from) > 0);
});

test('parent 循环明确报错', () => {
  const loop: ModelReader = (path) =>
    path.endsWith('a.json') ? JSON.stringify({ parent: 'block/b' }) : JSON.stringify({ parent: 'block/a' });
  assert.throws(() => resolveModel('block/a', loop), /循环/);
});
