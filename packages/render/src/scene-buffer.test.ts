/** scene-buffer.ts：挑选、统计、排序、上限与二进制布局（RENDER-SPEC §4.2、§12 第 5 条）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Grid } from '@pg/core/grid';

import {
  CELL_BYTES,
  HEADER_BYTES,
  PAINT,
  PALETTE_ITEM_BYTES,
  PALETTE_ITEM_BYTES_V2,
  parseScene,
  PROTOCOL_VERSION,
} from './mesh.ts';
import { buildScene } from './scene-buffer.ts';

const registry = loadRegistry();
const table = registry.table;

function gridOf(cells: readonly [number, number, number, string][]): Grid {
  const grid = createGrid(table);
  for (const [x, y, z, block] of cells) grid.set(x, y, z, parseState(table, block), 0, 0);
  return grid;
}

test('y ≤ 0 不进表且计入 belowGround；skip 计入 skipped', () => {
  const built = buildScene(
    gridOf([
      [0, 5, 0, 'stone'],
      [0, 1, 0, 'stone'],
      [0, 0, 0, 'stone'],
      [1, -1, 0, 'stone'],
      [2, 5, 0, 'barrier'],
      [3, 5, 0, 'light'],
      [4, 5, 0, 'structure_void'],
    ]),
    registry,
    1_000_000,
  );
  assert.equal(built.kind, 'ok');
  assert.equal(built.stats.cells, 2);
  assert.equal(built.stats.belowGround, 2);
  assert.equal(built.stats.skipped, 3);
});

test('全部 y ≤ 0 时返回 empty 且 belowGround 正确', () => {
  const built = buildScene(
    gridOf([
      [0, 0, 0, 'stone'],
      [1, -1, 0, 'stone'],
    ]),
    registry,
    1_000_000,
  );
  assert.deepEqual(built, { kind: 'empty', belowGround: 2 });
});

test('字节布局与排序：origin/size、格按 (dy,dz,dx) 升序、调色板按首次出现', () => {
  const built = buildScene(
    gridOf([
      [5, 2, 5, 'stone'],
      [3, 3, 3, 'glass'],
      [4, 3, 4, 'stone'],
    ]),
    registry,
    1_000_000,
  );
  assert.equal(built.kind, 'ok');
  const parsed = parseScene(built.buffer);
  assert.deepEqual(parsed.origin, [3, 2, 3]);
  assert.deepEqual(parsed.size, [3, 2, 3]);
  for (let i = 1; i < parsed.cells.length; i += 1) {
    const a = parsed.cells[i - 1];
    const b = parsed.cells[i];
    assert.ok(a !== undefined && b !== undefined);
    const ak = a.dy * 1e6 + a.dz * 1e3 + a.dx;
    const bk = b.dy * 1e6 + b.dz * 1e3 + b.dx;
    assert.ok(ak < bk, `第 ${String(i)} 格未按 (dy,dz,dx) 升序`);
  }
  assert.equal(parsed.paletteCount, 2);
  // 先出现的格（y=2 的 stone，dy=0）→ 调色板下标 0。
  assert.equal(parsed.palette[0]?.paint, 1);
  const rebuilt = buildScene(
    gridOf([
      [5, 2, 5, 'stone'],
      [3, 3, 3, 'glass'],
      [4, 3, 4, 'stone'],
    ]),
    registry,
    1_000_000,
  );
  if (rebuilt.kind !== 'ok') throw new Error('重建失败');
  assert.deepEqual(Array.from(built.buffer), Array.from(rebuilt.buffer));
});

test('fallbackColor 去重排序；small 按形态计入 simplified，新画法不再计入', () => {
  const built = buildScene(
    gridOf([
      [0, 2, 0, 'black_banner'],
      [1, 2, 0, 'white_banner'],
      [2, 2, 0, 'oak_stairs'],
      [3, 2, 0, 'oak_door'],
      [4, 2, 0, 'white_carpet'],
      [5, 2, 0, 'oak_log'],
      [6, 2, 0, 'chest'],
      [7, 2, 0, 'oak_sign'],
      [8, 2, 0, 'grass'],
    ]),
    registry,
    1_000_000,
  );
  assert.equal(built.kind, 'ok');
  assert.deepEqual(built.stats.fallbackColor, ['black_banner', 'white_banner']);
  assert.deepEqual(built.stats.simplified, { other: 2 });
});

test('调色板第 8 字节承载 params[3]，v2 追加模型 id；旧 v1 仍可解析', () => {
  const built = buildScene(
    gridOf([
      [0, 2, 0, 'oak_door[facing=south,half=upper,hinge=right,open=true]'],
      [1, 2, 0, 'oak_log[axis=x]'],
      [2, 2, 0, 'oak_trapdoor[facing=west,half=top,open=true]'],
    ]),
    registry,
    1_000_000,
  );
  assert.equal(built.kind, 'ok');
  const parsed = parseScene(built.buffer);
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(
    new DataView(built.buffer.buffer, built.buffer.byteOffset, built.buffer.byteLength).getUint16(4, true),
    2,
  );
  const door = parsed.palette.find((entry) => entry.paint === PAINT.door);
  assert.ok(door !== undefined);
  assert.deepEqual(door.params, [2, 1, 1, 1]);
  assert.equal(door.model, 0);
  const log = parsed.palette.find((entry) => entry.paint === PAINT.axis_cube);
  assert.ok(log !== undefined);
  assert.equal(log.params[0], 1);
  const trapdoor = parsed.palette.find((entry) => entry.paint === PAINT.trapdoor);
  assert.ok(trapdoor !== undefined);
  assert.equal(trapdoor.params[3], 1);
  // 调色板按首次出现排序，第一项是 y=2、z=0、x=0 的门；第 8 字节是 open。
  assert.equal(built.buffer[HEADER_BYTES + 7], 1);

  // 手工把 v2 格表降级成 v1，确认旧场景仍能读。
  const v1 = new Uint8Array(HEADER_BYTES + parsed.paletteCount * PALETTE_ITEM_BYTES + parsed.cellCount * CELL_BYTES);
  v1.set(built.buffer.subarray(0, HEADER_BYTES));
  new DataView(v1.buffer).setUint16(4, 1, true);
  let src = HEADER_BYTES;
  let dst = HEADER_BYTES;
  for (let i = 0; i < parsed.paletteCount; i += 1) {
    v1.set(built.buffer.subarray(src, src + PALETTE_ITEM_BYTES), dst);
    src += PALETTE_ITEM_BYTES_V2;
    dst += PALETTE_ITEM_BYTES;
  }
  v1.set(built.buffer.subarray(src), dst);
  const old = parseScene(v1);
  assert.equal(old.version, 1);
  assert.equal(old.palette[0]?.model, 0);
  assert.equal(old.cellCount, parsed.cellCount);
});

test('上限：cells 越界', () => {
  const cells: [number, number, number, string][] = [];
  for (let x = 0; x < 10; x += 1) cells.push([x, 5, 0, 'stone']);
  const built = buildScene(gridOf(cells), registry, 5);
  assert.deepEqual(built, { kind: 'too-large', what: 'cells', value: 10, limit: 5 });
});

test('上限：span 越界（单轴 > 65535）', () => {
  const built = buildScene(
    gridOf([
      [0, 1, 0, 'stone'],
      [70000, 1, 0, 'stone'],
    ]),
    registry,
    1_000_000,
  );
  assert.equal(built.kind, 'too-large');
  assert.equal(built.what, 'span');
  assert.equal(built.value, 70001);
  assert.equal(built.limit, 65535);
});

test('上限：volume 越界（> 6400 万）', () => {
  const built = buildScene(
    gridOf([
      [0, 1, 0, 'stone'],
      [499, 1, 0, 'stone'],
      [0, 1, 499, 'stone'],
      [0, 300, 0, 'stone'],
    ]),
    registry,
    1_000_000,
  );
  assert.equal(built.kind, 'too-large');
  assert.equal(built.what, 'volume');
  assert.equal(built.value, 500 * 300 * 500);
});

test('注入官方目录时写模型 id、统计 officialCells，并按邻居连接掩码查表', () => {
  const built = buildScene(
    gridOf([
      [0, 2, 0, 'stone'],
      [1, 2, 0, 'oak_fence'],
    ]),
    registry,
    1_000_000,
    {
      mcVersion: '1.20.1',
      states: { stone: 20 },
      connections: { oak_fence: Array.from({ length: 16 }, (_v, i) => 100 + i) },
      defaults: { stone: 20, oak_fence: 100 },
      coverage: { blocks: 2, states: 1, models: 116, textures: 1 },
    },
  );
  assert.equal(built.kind, 'ok');
  assert.equal(built.stats.officialCells, 2);
  const parsed = parseScene(built.buffer);
  const stone = parsed.palette.find((entry) => entry.model === 20);
  assert.ok(stone !== undefined);
  // 栅栏西侧是 stone → 掩码 8 → connections[8] = 108。
  assert.ok(parsed.palette.some((entry) => entry.model === 108));
});
