/** 指定接口的双向夹具：真实 cube/slab 状态、三轴与来源，含缺格/不支持及有界事实文本；不运行模型代码。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { XZ_MAX, XZ_MIN, Y_MAX, Y_MIN } from '@pg/core/coord';
import { createGrid } from '@pg/core/grid';

import { diagnoseInterfaces, formatInterfaces, interfaceSpecSchema, interfaceSpecsSchema } from './block-interface.ts';
import type { InterfaceResult, InterfaceSpec } from './block-interface.ts';

const registry = loadRegistry();
const states = ['stone', 'oak_slab', 'oak_slab[type=top]', 'oak_slab[type=double]'] as const;

function spec(axis: InterfaceSpec['axis'] = 'y', offset = 0): InterfaceSpec {
  return interfaceSpecSchema.parse({
    name: `节点 ${axis} ${String(offset)}`,
    from: { x: offset, y: 2, z: -32 },
    to: { x: offset + (axis === 'x' ? 1 : 0), y: axis === 'y' ? 3 : 2, z: axis === 'z' ? -31 : -32 },
    axis,
  });
}

function fixture(from: string | null, to: string | null, one = spec(), line = 29): InterfaceResult {
  const grid = createGrid(registry.table);
  const first = grid.defineCall('box', 11, {});
  const last = grid.defineCall('set', line, {});
  if (from !== null) grid.set(one.from.x, one.from.y, one.from.z, parseState(registry.table, from), 0, first);
  if (to !== null) grid.set(one.to.x, one.to.y, one.to.z, parseState(registry.table, to), 0, last);
  const result = diagnoseInterfaces(grid, registry, [one])[0];
  assert.ok(result !== undefined);
  return result;
}

describe('指定接口三轴形状夹具', () => {
  it('cube、上下半砖、双半砖全组合：纵向缝与侧向面接/棱接双向', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      for (const from of states) {
        for (const to of states) {
          const result = fixture(from, to, spec(axis));
          const gap = axis === 'y' ? (from === 'oak_slab' ? 0.5 : 0) + (to.includes('top') ? 0.5 : 0) : 0;
          const edge =
            axis !== 'y' &&
            ((from === 'oak_slab' && to.includes('top')) || (from.includes('top') && to === 'oak_slab'));
          const area =
            axis === 'y'
              ? 1
              : edge
                ? 0
                : (from.includes('slab') && !from.includes('double')) || (to.includes('slab') && !to.includes('double'))
                  ? 0.5
                  : 1;
          assert.equal(result.gap, gap);
          assert.equal(result.area, area);
          assert.equal(result.status, gap > 0 ? 'gap' : edge ? 'edge-only' : 'contact');
          assert.equal(result.fromState, from);
          assert.equal(result.toState, to);
        }
      }
    }
  });

  it('显式 bottom 与默认状态等价；平移跨区块不改变测量', () => {
    const base = fixture('oak_slab[type=bottom]', 'oak_slab[type=top]');
    const moved = fixture('oak_slab', 'oak_slab[type=top]', spec('y', 64));
    assert.equal(base.fromState, 'oak_slab');
    assert.equal(base.gap, 1);
    assert.equal(moved.gap, base.gap);
    assert.equal(moved.area, base.area);
    assert.equal(moved.status, base.status);
  });

  it('两侧缺格、空气或 unsupported 均不伪报 contact；缺格优先', () => {
    for (const [from, to] of [
      [null, 'stone'],
      ['stone', null],
      [null, null],
      ['air', 'stone'],
      ['stone', 'air'],
      ['oak_stairs', null],
    ] as const) {
      const result = fixture(from, to);
      assert.equal(result.status, 'missing');
      assert.equal(result.gap, null);
      assert.equal(result.area, null);
    }
    for (const [from, to] of [
      ['stone', 'oak_stairs'],
      ['oak_fence', 'stone'],
    ] as const) {
      const result = fixture(from, to);
      assert.equal(result.status, 'unsupported');
      assert.equal(result.gap, null);
      assert.equal(result.area, null);
      assert.equal(result.fromState, from);
      assert.equal(result.toState, to);
    }
    assert.deepEqual(diagnoseInterfaces(createGrid(registry.table), registry, []), []);
  });

  it('按最终写入格记录调用编号、API 与行号，未知来源保持 null', () => {
    const one = spec();
    const grid = createGrid(registry.table);
    const old = grid.defineCall('box', 7, {});
    const final = grid.defineCall('set', 31, {});
    grid.set(0, 2, -32, parseState(registry.table, 'oak_slab'), 0, old);
    grid.set(0, 2, -32, parseState(registry.table, 'stone'), 0, final);
    grid.set(0, 3, -32, parseState(registry.table, 'oak_slab'), 0, 0);
    const result = diagnoseInterfaces(grid, registry, [one])[0];
    assert.ok(result !== undefined);
    assert.equal(result.status, 'contact');
    assert.equal(result.fromState, 'stone');
    assert.deepEqual(result.fromSource, { id: final, api: 'set', line: 31 });
    assert.equal(result.toSource, null);
    assert.deepEqual(result.from, one.from);
    assert.deepEqual(result.to, one.to);
    assert.equal(result.axis, 'y');
  });
});

describe('接口 schema 单一定义', () => {
  it('三轴正向相邻通过，未知字段/非整数/非相邻/反向拒绝', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const one = spec(axis);
      assert.equal(interfaceSpecSchema.safeParse(one).success, true);
      for (const bad of [
        { ...one, name: '' },
        { ...one, axis: 'w' },
        { ...one, extra: 1 },
        { ...one, from: { ...one.from, extra: 1 } },
        { ...one, to: { ...one.to, extra: 1 } },
        { ...one, to: one.from },
        { ...one, from: one.to, to: one.from },
        { ...one, from: { ...one.from, x: 0.5 } },
        { ...one, to: { ...one.to, y: Infinity } },
        { ...one, to: { ...one.to, z: one.to.z + 2 } },
      ])
        assert.equal(interfaceSpecSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
    assert.equal(interfaceSpecSchema.safeParse({ name: '缺项' }).success, false);
  });

  it('仅要求非空识别名，不添加 HTML 等无关限制；列表严格限制 32 项', () => {
    const one = { ...spec(), name: '<柱梁> & "接口"\n二行' };
    assert.equal(interfaceSpecSchema.parse(one).name, one.name);
    assert.equal(interfaceSpecsSchema.parse(Array.from({ length: 32 }, () => one)).length, 32);
    assert.equal(interfaceSpecsSchema.safeParse(Array.from({ length: 33 }, () => one)).success, false);
    assert.equal(interfaceSpecsSchema.safeParse({ interfaces: [one] }).success, false);
    assert.equal(interfaceSpecsSchema.safeParse([{ ...one, ignored: true }]).success, false);
    assert.deepEqual(interfaceSpecsSchema.parse([]), []);
  });

  it('core 坐标范围双向：边界相邻可查，越界在 schema 阶段拒绝', () => {
    const one = spec();
    const edge = { ...one, from: { x: XZ_MIN, y: Y_MIN, z: XZ_MAX }, to: { x: XZ_MIN, y: Y_MIN + 1, z: XZ_MAX } };
    assert.equal(interfaceSpecSchema.safeParse(edge).success, true);
    assert.equal(fixture('stone', 'stone', interfaceSpecSchema.parse(edge)).status, 'contact');
    for (const [axis, value] of [
      ['x', XZ_MIN - 1],
      ['x', XZ_MAX + 1],
      ['y', Y_MIN - 1],
      ['y', Y_MAX + 1],
      ['z', XZ_MIN - 1],
      ['z', XZ_MAX + 1],
    ] as const) {
      const from = { ...one.from, [axis]: value };
      const to = { ...one.to, [axis]: axis === 'y' ? value + 1 : value };
      assert.equal(interfaceSpecSchema.safeParse({ ...one, from, to }).success, false);
    }
  });
});

describe('接口工具事实文本', () => {
  it('全部 contact 仍报数量；空清单不声称通过', () => {
    const lines = formatInterfaces([fixture('stone', 'oak_slab')]).join('\n');
    assert.match(lines, /共 1 项，contact 1 \/ gap 0 \/ edge-only 0 \/ missing 0 \/ unsupported 0/);
    assert.match(lines, /指定的 1 项全部 contact/);
    assert.match(lines, /未列节点未检查/);
    assert.match(lines, /不代表整建筑无缺陷或结构承载成立/);
    assert.doesNotMatch(formatInterfaces([]).join('\n'), /全部 contact/);
  });

  it('所有非 contact 都是问题，携带坐标/state/真实来源/gap/area；最多四项', () => {
    const results = [
      fixture('stone', 'oak_slab[type=top]'),
      fixture('oak_slab', 'oak_slab[type=top]', spec('x'), 0),
      fixture(null, 'stone'),
      fixture('stone', 'oak_fence'),
      fixture('oak_slab', 'oak_slab'),
    ];
    const lines = formatInterfaces(results).join('\n');
    assert.match(lines, /contact 0 \/ gap 2 \/ edge-only 1 \/ missing 1 \/ unsupported 1/);
    assert.match(
      lines,
      /\(0,2,-32\) stone（box#1 building.ts:11） → \(0,3,-32\) oak_slab\[type=top\]（set#2 building.ts:29）/,
    );
    assert.match(lines, /gap=0.5 格，投影 area=1 格²/);
    assert.match(lines, /gap=0 格，投影 area=0 格²/);
    assert.match(lines, /缺格（来源未知）/);
    assert.match(lines, /set#2 行号未知/);
    assert.match(lines, /gap=不可测，投影 area=不可测/);
    assert.match(lines, /另有 1 项问题未展开（最多显示 4 项）/);
    assert.match(lines, /unsupported 未判定接触/);
    assert.equal(formatInterfaces(results).filter((line) => line.startsWith('  "')).length, 4);
    assert.doesNotMatch(formatInterfaces(results.slice(0, 4)).join('\n'), /未展开/);
  });
});
