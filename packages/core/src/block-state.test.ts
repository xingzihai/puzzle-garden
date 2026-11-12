import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { createBlockTable, formatState, isAir, parseState } from './block-state.ts';
import type { BlockTable } from './block-state.ts';
import { CoreError } from './coord.ts';

const DATA: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../assets/mc-1.20.1/block-states.json'), 'utf8'),
);
const table = createBlockTable(DATA);

function fmt(text: string, t: BlockTable = table): string {
  return formatState(parseState(t, text));
}

function errorOf(fn: () => unknown): CoreError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CoreError) return e;
    throw e;
  }
  throw new Error('预期报错，实际没有');
}

describe('createBlockTable', () => {
  it('接受真实数据', () => {
    assert.equal(table.blocks.size, 1003);
  });

  it('坏数据报错，信息里有路径', () => {
    const bad: unknown[] = [
      null,
      {},
      { blocks: [] },
      { blocks: [{ name: 'stone', properties: [] }] },
      {
        blocks: [
          { name: 'air', properties: [] },
          { name: 'air', properties: [] },
        ],
      },
      { blocks: [{ name: 'Air', properties: [] }] },
      {
        blocks: [
          { name: 'air', properties: [] },
          { name: 'x', properties: [{ name: 'p', type: 'enum', values: ['a'], default: 'b' }] },
        ],
      },
      {
        blocks: [
          { name: 'air', properties: [] },
          { name: 'x', properties: [{ name: 'p', type: 'enum', values: ['a', 'a'], default: 'a' }] },
        ],
      },
      {
        blocks: [
          { name: 'air', properties: [] },
          {
            name: 'x',
            properties: [
              { name: 'p', type: 'bool', values: ['true', 'false'], default: 'true' },
              { name: 'p', type: 'bool', values: ['true', 'false'], default: 'true' },
            ],
          },
        ],
      },
    ];
    for (const d of bad) assert.equal(errorOf(() => createBlockTable(d)).code, 'invalid-block-table');
    assert.match(
      errorOf(() => createBlockTable({ blocks: [{ name: 'Air', properties: [] }] })).message,
      /blocks\.0\.name/,
    );
  });
});

describe('parseState / formatState', () => {
  it('抽查：oak_stairs 的默认值被省略', () => {
    assert.equal(fmt('oak_stairs[facing=north]'), 'oak_stairs');
    assert.equal(fmt('oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]'), 'oak_stairs');
    const s = parseState(table, 'minecraft:oak_stairs[waterlogged=true,facing=east]');
    assert.equal(s.name, 'oak_stairs');
    assert.deepEqual(s.props, { facing: 'east', waterlogged: 'true' });
    assert.equal(formatState(s), 'oak_stairs[facing=east,waterlogged=true]');
  });

  it('去前缀、空方括号、属性排序', () => {
    assert.equal(fmt('minecraft:stone'), 'stone');
    assert.equal(fmt('stone[]'), 'stone');
    assert.equal(fmt('oak_stairs[shape=outer_left,half=top]'), 'oak_stairs[half=top,shape=outer_left]');
  });

  it('三种空气都规范为 air', () => {
    for (const a of ['air', 'cave_air', 'void_air', 'minecraft:cave_air']) {
      const s = parseState(table, a);
      assert.equal(formatState(s), 'air');
      assert.ok(isAir(s));
    }
    assert.ok(!isAir(parseState(table, 'stone')));
  });

  it('BlockState 不可变', () => {
    const s = parseState(table, 'oak_stairs[facing=east]');
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.props));
  });

  it('语法错误', () => {
    const cases: [string, RegExp][] = [
      ['Stone', /大写/],
      ['stone ', /空白/],
      ['oak_stairs[facing=east, half=top]', /空白/],
      ['oak_stairs[facing=east,]', /逗号/],
      ['oak_stairs[,facing=east]', /逗号/],
      ['oak_stairs[facing=east,facing=west]', /facing 重复/],
      ['oak_stairs[facing]', /名=值/],
      ['oak_stairs[facing=]', /名=值/],
      ['oak_stairs[facing=east', /语法错误/],
      ['', /语法错误/],
      ['stone-brick', /语法错误/],
      ['mc:stone', /语法错误/],
      ['oak_stairs[facing=east][half=top]', /语法错误/],
    ];
    for (const [text, re] of cases) {
      const e = errorOf(() => parseState(table, text));
      assert.equal(e.code, 'invalid-state-syntax', text);
      assert.match(e.message, re, text);
    }
  });

  it('未知方块：附拼写建议', () => {
    const e = errorOf(() => parseState(table, 'stonee'));
    assert.equal(e.code, 'unknown-block');
    assert.match(e.message, /未知方块 stonee.*是不是 stone？/);
    assert.doesNotMatch(errorOf(() => parseState(table, 'qqqqqqqqqqqq')).message, /是不是/);
  });

  it('未知属性：列出可用属性', () => {
    const e = errorOf(() => parseState(table, 'oak_stairs[facin=east]'));
    assert.equal(e.code, 'unknown-property');
    assert.match(e.message, /可用属性：facing, half, shape, waterlogged。是不是 facing？/);
    assert.match(errorOf(() => parseState(table, 'stone[facing=east]')).message, /stone 没有任何属性/);
  });

  it('非法取值：列出合法取值', () => {
    const e = errorOf(() => parseState(table, 'oak_stairs[facing=up]'));
    assert.equal(e.code, 'invalid-property-value');
    assert.match(e.message, /合法取值：north, south, west, east/);
    assert.match(errorOf(() => parseState(table, 'oak_stairs[facing=eats]')).message, /是不是 east？/);
  });

  it('取值多于 12 个时只列前 12 个并注明总数', () => {
    const e = errorOf(() => parseState(table, 'acacia_hanging_sign[rotation=16]'));
    assert.match(e.message, /0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 等（共 16 个）/);
  });

  it('建议不唯一时不给建议', () => {
    const t = createBlockTable({
      blocks: [
        { name: 'air', properties: [] },
        { name: 'ab', properties: [] },
        { name: 'ac', properties: [] },
      ],
    });
    assert.doesNotMatch(errorOf(() => parseState(t, 'ad')).message, /是不是/);
    assert.match(errorOf(() => parseState(t, 'abx')).message, /是不是 ab？/);
  });
});

describe('性质', () => {
  // 从真实方块表随机生成状态文本：随机方块、随机子集属性、随机顺序、随机带不带前缀。
  const blocks = [...table.blocks.entries()];
  const stateText = fc
    .record({
      bi: fc.nat(blocks.length - 1),
      picks: fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 8 }),
      prefix: fc.boolean(),
    })
    .map(({ bi, picks, prefix }) => {
      const [name, def] = blocks[bi]!;
      const props = [...def.props.entries()];
      const chosen = new Map<string, string>();
      for (const [pi, vi] of picks) {
        if (props.length === 0) break;
        const [pname, pdef] = props[pi % props.length]!;
        chosen.set(pname, pdef.values[vi % pdef.values.length]!);
      }
      const body = [...chosen].map(([k, v]) => `${k}=${v}`).join(',');
      return `${prefix ? 'minecraft:' : ''}${name}${body === '' ? '' : `[${body}]`}`;
    });

  it('解析 → 格式化 → 解析，结果不变；规范化幂等', () => {
    fc.assert(
      fc.property(stateText, (text) => {
        const once = fmt(text);
        const twice = fmt(once);
        assert.equal(twice, once);
        assert.deepEqual(parseState(table, once).props, parseState(table, text).props);
      }),
      { numRuns: 500 },
    );
  });

  it('属性书写顺序不影响规范形式', () => {
    fc.assert(
      fc.property(stateText, (text) => {
        const m = /^(.*?)\[(.*)\]$/.exec(text);
        if (m === null) return;
        const reversed = `${m[1]!}[${m[2]!.split(',').reverse().join(',')}]`;
        assert.equal(fmt(reversed), fmt(text));
      }),
    );
  });
});
