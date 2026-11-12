import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createBlockTable, parseState } from '@pg/core/block-state';

import { BlocksError, FAMILIES, SHAPES, createRegistry } from './registry.ts';

const ASSETS = join(import.meta.dirname, '../../../assets');
const STATES = JSON.parse(readFileSync(join(ASSETS, 'mc-1.20.1/block-states.json'), 'utf8')) as unknown;
const RECORDS = JSON.parse(readFileSync(join(ASSETS, 'v02/registry/blocks.json'), 'utf8')) as Record<string, unknown>[];
const registry = createRegistry(STATES, RECORDS);

/** 深拷贝真实数据后按需修改，构造坏样本。 */
function mutated(fn: (records: Record<string, unknown>[]) => void): Record<string, unknown>[] {
  const copy = structuredClone(RECORDS);
  fn(copy);
  return copy;
}

function find(records: Record<string, unknown>[], id: string): Record<string, unknown> {
  const r = records.find((x) => x['id'] === id);
  assert.ok(r !== undefined, id);
  return r;
}

function rejects(states: unknown, records: unknown, re: RegExp): BlocksError {
  let err: unknown;
  try {
    createRegistry(states, records);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof BlocksError, `应当报错：${String(re)}`);
  assert.equal(err.code, 'invalid-registry');
  assert.match(err.message, re);
  return err;
}

describe('createRegistry：真实数据', () => {
  it('1003 个方块，按码点升序', () => {
    const ids = registry.ids();
    assert.equal(ids.length, 1003);
    assert.ok(ids.every((id, i) => i === 0 || (ids[i - 1] ?? '') < id));
    assert.ok(Object.isFrozen(ids));
  });

  it('抽查', () => {
    assert.deepEqual(registry.get('oak_stairs'), {
      id: 'oak_stairs',
      zh: '橡木楼梯',
      shape: 'stairs',
      family: 'wood',
      color: { source: 'texture', rgb: 10650447, confidence: 'high' },
      luminance: 0,
      transparent: false,
    });
    assert.deepEqual(registry.get('black_banner')?.color, { source: 'none' });
    assert.equal(registry.get('glowstone')?.luminance, 15);
    assert.ok(Object.isFrozen(registry.get('glowstone')));
  });

  it('get 只接受规范 id', () => {
    assert.equal(registry.get('minecraft:stone'), undefined);
    assert.equal(registry.get('Stone'), undefined);
    assert.equal(registry.get('stone')?.zh, '石头');
  });

  it('空气：info 看规范名，get 按数据原样', () => {
    assert.equal(registry.info(parseState(registry.table, 'cave_air')).id, 'air');
    assert.equal(registry.get('cave_air')?.id, 'cave_air');
    assert.notEqual(registry.get('cave_air')?.zh, registry.get('air')?.zh);
  });

  it('table 可以直接给 core 用', () => {
    assert.equal(registry.info(parseState(registry.table, 'oak_stairs[facing=east]')).zh, '橡木楼梯');
  });

  it('info：状态出自另一张方块表、本注册表里没有时报 unknown-block', () => {
    const other = createBlockTable({
      blocks: [
        { name: 'air', properties: [] },
        { name: 'not_a_block', properties: [] },
      ],
    });
    assert.throws(
      () => registry.info(parseState(other, 'not_a_block')),
      (e: unknown) => e instanceof BlocksError && e.code === 'unknown-block' && e.message.includes('not_a_block'),
    );
  });

  it('形态与材质族清单与数据一致（数据里每种都出现）', () => {
    const shapes = new Set(registry.ids().map((id) => registry.get(id)?.shape));
    const families = new Set(registry.ids().map((id) => registry.get(id)?.family));
    assert.deepEqual([...shapes].sort(), [...SHAPES].sort());
    assert.deepEqual([...families].sort(), [...FAMILIES].sort());
  });
});

describe('createRegistry：坏数据', () => {
  it('block-states 不合法：包装 core 的错误', () => {
    const err = rejects({ blocks: [] }, RECORDS, /block-states/);
    assert.equal((err.cause as { name?: unknown }).name, 'CoreError');
  });

  it('两份数据的方块集合不同', () => {
    rejects(
      STATES,
      mutated((r) => r.splice(0, 1)),
      /acacia_button 在 block-states 里有，在 blocks\.json 里没有/,
    );
    rejects(
      STATES,
      mutated((r) => r.push({ ...find(r, 'stone'), id: 'zzz_extra' })),
      /zzz_extra 在 blocks\.json 里有，在 block-states 里没有/,
    );
  });

  it('未按 id 升序或重复', () => {
    rejects(
      STATES,
      mutated((r) => r.reverse()),
      /未按 id 码点严格升序/,
    );
    rejects(
      STATES,
      mutated((r) => r.splice(1, 0, structuredClone(r[0]!))),
      /第 1 项 acacia_button 未按 id 码点严格升序/,
    );
  });

  it('color 与 colorSource 不一致', () => {
    rejects(
      STATES,
      mutated((r) => {
        find(r, 'stone')['color'] = null;
      }),
      /stone：color 为 null 当且仅当 colorSource 为 none/,
    );
    rejects(
      STATES,
      mutated((r) => {
        find(r, 'black_banner')['color'] = 1;
      }),
      /black_banner：color 为 null/,
    );
    rejects(
      STATES,
      mutated((r) => {
        find(r, 'stone')['color'] = 0x1000000;
      }),
      /blocks\.json \d+\.color/,
    );
  });

  it('waterloggable 与 waterlogged 属性不一致', () => {
    rejects(
      STATES,
      mutated((r) => {
        (find(r, 'oak_stairs')['props'] as Record<string, unknown>)['waterloggable'] = false;
      }),
      /oak_stairs：waterloggable=false，但 block-states 里有 waterlogged/,
    );
  });

  it('luminance 越界、zh 为空、未知 shape / family', () => {
    const cases: [(r: Record<string, unknown>) => void, RegExp][] = [
      [(r) => ((r['props'] as Record<string, unknown>)['luminance'] = 16), /props\.luminance/],
      [(r) => ((r['props'] as Record<string, unknown>)['luminance'] = 1.5), /props\.luminance/],
      [(r) => (r['zh'] = ''), /\.zh/],
      [(r) => (r['shape'] = 'blob'), /\.shape/],
      [(r) => (r['family'] = 'cheese'), /\.family/],
    ];
    for (const [edit, re] of cases) {
      rejects(
        STATES,
        mutated((rs) => {
          edit(find(rs, 'stone'));
        }),
        re,
      );
    }
  });

  it('问题多于 5 条时只列前 5 条并注明总数', () => {
    rejects(
      STATES,
      mutated((r) => {
        for (const x of r) x['color'] = null;
      }),
      /共 \d+ 条，只列前 5 条/,
    );
    rejects(STATES, [], /\(根\)/);
  });
});
