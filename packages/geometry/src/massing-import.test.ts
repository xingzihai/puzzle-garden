/**
 * 草模导入构件（MASSING-CONVERSION-SPEC §5–§7、§9）：放置与旋转、材质优先级、错误码、
 * 冲突两种调用顺序、部件嵌套、调用来源、句柄数值与确定性。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { measureFloating } from '@pg/analysis/floating';
import { measureReach } from '@pg/analysis/reach';
import { loadRegistry } from '@pg/blocks/load';
import { hashGrid } from '@pg/core/hash';
import { XZ_MAX, Y_MAX } from '@pg/core/coord';
import type { MassingColorCandidate } from '@pg/blocks/color';
import { createModel } from '@pg/modeling/model';
import type { ModelDocument, Role } from '@pg/modeling/schema';

import { createWorld, MassingError, rect } from './index.ts';
import type { MassingAssets, World, WorldHost } from './index.ts';

const loaded = loadRegistry();
const table = loaded.table;
type Cell = readonly [number, number, number];

const DEFAULT_CANDIDATES: readonly MassingColorCandidate[] = [{ id: 'stone', rgb: 0x808080, family: 'stone' }];

interface BoxSpec {
  readonly id: string;
  readonly role?: Role;
  readonly color?: string;
  readonly material?: string;
  readonly size: readonly [number, number, number];
  readonly translate?: readonly [number, number, number];
}

/** 用真实建模 API 造文档：网格校验由 @pg/modeling 保证，本测试只关心转换与集成。 */
function makeDocument(specs: readonly BoxSpec[]): ModelDocument {
  const model = createModel();
  for (const spec of specs) {
    model.box({
      id: spec.id,
      name: `部件 ${spec.id}`,
      role: spec.role ?? 'volume',
      color: spec.color ?? '#808080',
      ...(spec.material === undefined ? {} : { material: spec.material }),
      size: [spec.size[0], spec.size[1], spec.size[2]],
      ...(spec.translate === undefined
        ? {}
        : { transform: { translate: [spec.translate[0], spec.translate[1], spec.translate[2]] } }),
    });
  }
  return model.finish();
}

function makeAssets(
  document: ModelDocument,
  candidates: readonly MassingColorCandidate[] = DEFAULT_CANDIDATES,
  id = 'a',
): MassingAssets {
  return { documents: [{ id, document }], colorCandidates: candidates };
}

function makeWorld(document: ModelDocument, candidates?: readonly MassingColorCandidate[], id?: string): WorldHost {
  return createWorld(table, { massing: makeAssets(document, candidates, id) });
}

function expectMassingError(run: () => unknown, code: MassingError['code'], keyword: RegExp): void {
  let error: unknown;
  try {
    run();
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof MassingError, `期望 MassingError，实际 ${String(error)}`);
  assert.equal(error.code, code);
  assert.match(error.message, keyword);
}

/** 故意传类型不允许的运行时选项，验证 schema 的严格校验（静态签名之外）。 */
function runRaw(world: World, id: string, options: unknown): unknown {
  const call = world.massingImport as unknown as (id: string, options?: unknown) => unknown;
  return call(id, options);
}

/** 合成网格里全部实体格，按 (x,y,z) 升序；本测试的世界只含导入件（冲突场景除外）。 */
function cellsOf(host: WorldHost): Cell[] {
  return [...host.compose().grid.cells()]
    .map((c): Cell => [c.x, c.y, c.z])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

function snapshot(host: WorldHost): string {
  const { grid, overlaps } = host.compose();
  return `${hashGrid(grid)}:${String(grid.calls().length)}:${String(overlaps.length)}`;
}

describe('massingImport 放置与旋转', () => {
  it('at 默认 [0,1,0]：局部格平移到世界格，句柄给出世界包围盒与 counts', () => {
    const host = makeWorld(makeDocument([{ id: 'box', size: [2, 1, 1] }]));
    const handle = host.world.massingImport('a');
    assert.equal(host.world.get(0, 1, 0), 'stone');
    assert.equal(host.world.get(1, 1, 0), 'stone');
    assert.equal(host.world.get(2, 1, 0), 'air');
    assert.equal(host.world.get(0, 0, 0), 'air', '文档 y=0 贴在地表顶面，不落 y=0');
    assert.deepEqual(handle.bounds, { min: [0, 1, 0], max: [1, 1, 0] });
    assert.deepEqual(handle.parts, [
      { id: 'box', name: '部件 box', role: 'volume', bounds: { min: [0, 1, 0], max: [1, 1, 0] }, cellCount: 2 },
    ]);
    assert.deepEqual(handle.counts, {
      parts: 1,
      cells: 2,
      triangles: 12,
      shellParts: 0,
      solidParts: 1,
      emptyParts: 0,
      leakyParts: 0,
      isolatedCells: 0,
      isolatedRemoved: 0,
    });
  });

  it('显式整数 at（含负坐标）精确平移', () => {
    const host = makeWorld(makeDocument([{ id: 'box', size: [2, 1, 1] }]));
    host.world.massingImport('a', { at: [-5, 2, -3] });
    assert.deepEqual(cellsOf(host), [
      [-5, 2, -3],
      [-4, 2, -3],
    ]);
  });

  it('四种旋转按 §6 的格索引公式映射', () => {
    const expected: Readonly<Record<0 | 90 | 180 | 270, readonly Cell[]>> = {
      0: [
        [0, 1, 0],
        [1, 1, 0],
        [2, 1, 0],
        [0, 1, 1],
        [1, 1, 1],
        [2, 1, 1],
      ],
      90: [
        [-1, 1, 0],
        [-2, 1, 0],
        [-1, 1, 1],
        [-2, 1, 1],
        [-1, 1, 2],
        [-2, 1, 2],
      ],
      180: [
        [-1, 1, -1],
        [-2, 1, -1],
        [-3, 1, -1],
        [-1, 1, -2],
        [-2, 1, -2],
        [-3, 1, -2],
      ],
      270: [
        [0, 1, -1],
        [0, 1, -2],
        [0, 1, -3],
        [1, 1, -1],
        [1, 1, -2],
        [1, 1, -3],
      ],
    };
    for (const rotate of [0, 90, 180, 270] as const) {
      const host = makeWorld(makeDocument([{ id: 'box', size: [3, 1, 2] }]));
      const handle = host.world.massingImport('a', { rotate });
      const want = expected[rotate]
        .map((c): Cell => [c[0], c[1], c[2]])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      assert.deepEqual(cellsOf(host), want, `rotate=${String(rotate)}`);
      const xs = expected[rotate].map((c) => c[0]);
      const zs = expected[rotate].map((c) => c[2]);
      assert.deepEqual(handle.bounds, {
        min: [Math.min(...xs), 1, Math.min(...zs)],
        max: [Math.max(...xs), 1, Math.max(...zs)],
      });
    }
  });

  it('at 非整数 / rotate 非 90 倍数 / 未知键都报 options-invalid，且失败原子', () => {
    const host = makeWorld(makeDocument([{ id: 'box', size: [2, 1, 1] }]));
    const before = snapshot(host);
    expectMassingError(() => host.world.massingImport('a', { at: [0.5, 1, 0] }), 'options-invalid', /文档部件 id 有/);
    expectMassingError(() => host.world.massingImport('a', { at: [0, 1.5, 0] }), 'options-invalid', /at/);
    expectMassingError(() => runRaw(host.world, 'a', { rotate: 45 }), 'options-invalid', /rotate|90/);
    expectMassingError(() => runRaw(host.world, 'a', { overrides: {} }), 'options-invalid', /overrides|无法识别/);
    expectMassingError(() => host.world.massingImport('a', { thickness: 0 }), 'options-invalid', /thickness/);
    assert.equal(snapshot(host), before, '失败调用不留下写入');
  });

  it('任一格 y<1 整次拒绝：below-ground 带最低格与部件 id', () => {
    const host = makeWorld(makeDocument([{ id: 'low', size: [2, 1, 1] }]));
    const before = snapshot(host);
    expectMassingError(
      () => host.world.massingImport('a', { at: [0, 0, 0] }),
      'below-ground',
      /low.*\(0, 0, 0\)|\(0, 0, 0\).*low/,
    );
    assert.equal(snapshot(host), before);
  });

  it('越界整次拒绝：out-of-range 带最小越界格（x 与 y 两个方向）', () => {
    const xHost = makeWorld(makeDocument([{ id: 'wide', size: [3, 1, 1] }]));
    expectMassingError(
      () => xHost.world.massingImport('a', { at: [XZ_MAX - 1, 1, 0] }),
      'out-of-range',
      new RegExp(String(XZ_MAX + 1)),
    );
    const yHost = makeWorld(makeDocument([{ id: 'tall', size: [1, 2, 1] }]));
    expectMassingError(
      () => yHost.world.massingImport('a', { at: [0, Y_MAX, 0] }),
      'out-of-range',
      new RegExp(String(Y_MAX + 1)),
    );
  });

  it('thickness 与 solid 同传由内核报 options-invalid', () => {
    const host = makeWorld(makeDocument([{ id: 'box', role: 'volume', size: [2, 2, 2] }]));
    expectMassingError(() => host.world.massingImport('a', { thickness: 2 }), 'options-invalid', /thickness.*solid/);
  });

  it('empty-import：空文档不返回空句柄', () => {
    const empty: ModelDocument = { version: 2, parts: [] };
    const host = makeWorld(empty);
    expectMassingError(() => host.world.massingImport('a'), 'empty-import', /没有可写入的格/);
  });

  it('asset-missing：未注入资产或 id 未登记', () => {
    const plain = createWorld(table);
    expectMassingError(() => plain.world.massingImport('a'), 'asset-missing', /找不到草模资产 a/);
    const host = makeWorld(makeDocument([{ id: 'box', size: [1, 1, 1] }]));
    expectMassingError(() => host.world.massingImport('missing'), 'asset-missing', /missing/);
  });

  it('limit-exceeded：单次导入超过 500000 格', () => {
    const host = makeWorld(makeDocument([{ id: 'big', role: 'roof', size: [501, 500, 2] }]));
    expectMassingError(() => host.world.massingImport('a'), 'limit-exceeded', /500000|上限/);
  });
});

describe('massingImport 材质优先级', () => {
  it('默认 role+color：候选表取最近色', () => {
    const host = makeWorld(makeDocument([{ id: 'box', color: '#808080', size: [2, 1, 1] }]));
    host.world.massingImport('a');
    assert.equal(host.world.get(0, 1, 0), 'stone');
  });

  it('文档部件 material 优先于默认映射', () => {
    const host = makeWorld(makeDocument([{ id: 'box', material: 'stone_bricks', size: [2, 1, 1] }]));
    host.world.massingImport('a');
    assert.equal(host.world.get(0, 1, 0), 'stone_bricks');
  });

  it('options.material 优先于部件 material', () => {
    const host = makeWorld(makeDocument([{ id: 'box', material: 'stone_bricks', size: [2, 1, 1] }]));
    host.world.massingImport('a', { material: 'oak_planks' });
    assert.equal(host.world.get(0, 1, 0), 'oak_planks');
  });

  it('options.materials 逐部件覆盖并优先于 options.material', () => {
    const document = makeDocument([
      { id: 'first', color: '#808080', size: [2, 1, 1] },
      { id: 'second', color: '#808080', size: [2, 1, 1], translate: [3, 0, 0] },
    ]);
    const host = makeWorld(document);
    host.world.massingImport('a', { material: 'oak_planks', materials: { second: 'deepslate_tiles' } });
    assert.equal(host.world.get(0, 1, 0), 'oak_planks');
    assert.equal(host.world.get(3, 1, 0), 'deepslate_tiles');
  });

  it('未知方块带 CoreError 拼写建议原文', () => {
    const host = makeWorld(makeDocument([{ id: 'box', size: [2, 1, 1] }]));
    expectMassingError(
      () => host.world.massingImport('a', { material: 'stone_brikcs' }),
      'material-invalid',
      /是不是 stone_bricks/,
    );
  });

  it('空气材质拒绝', () => {
    const host = makeWorld(makeDocument([{ id: 'box', size: [2, 1, 1] }]));
    expectMassingError(() => host.world.massingImport('a', { material: 'air' }), 'material-invalid', /空气/);
  });

  it('部件 material 未知也走 material-invalid', () => {
    const host = makeWorld(makeDocument([{ id: 'box', material: 'not_a_block', size: [2, 1, 1] }]));
    expectMassingError(() => host.world.massingImport('a'), 'material-invalid', /not_a_block/);
  });

  it('materials 含不存在的部件 id 报 options-invalid', () => {
    const host = makeWorld(makeDocument([{ id: 'box', size: [1, 1, 1] }]));
    expectMassingError(
      () => host.world.massingImport('a', { materials: { nope: 'stone' } }),
      'options-invalid',
      /materials 含不存在的部件 id nope.*\[box\]/,
    );
  });

  it('默认映射候选表为空报 material-missing', () => {
    const host = makeWorld(makeDocument([{ id: 'box', color: '#808080', size: [2, 1, 1] }]), []);
    expectMassingError(() => host.world.massingImport('a'), 'material-missing', /候选|颜色表/);
  });
});

describe('massingImport 写入、来源与部件', () => {
  it('整次一次 commit：同一 callId、结构层、args 摘要含 id/at/rotate/mode/thickness/material(s)', () => {
    const host = createWorld(table, {
      callSite: () => 42,
      massing: makeAssets(makeDocument([{ id: 'roof', role: 'roof', size: [2, 1, 1] }])),
    });
    host.world.massingImport('a', {
      at: [1, 2, 3],
      rotate: 90,
      mode: 'shell',
      thickness: 2,
      material: 'stone',
      cleanup: 'none',
    });
    const { grid } = host.compose();
    const calls = grid.calls();
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.api, 'massingImport');
    assert.equal(call.line, 42);
    assert.deepEqual(JSON.parse(call.args), {
      id: 'a',
      at: [1, 2, 3],
      rotate: 90,
      mode: 'shell',
      thickness: 2,
      material: 'stone',
      cleanup: 'none',
    });
    for (const cell of grid.cells()) assert.equal(cell.call, call.id, '所有格同一 callId');
    assert.equal(host.world.get(0, 2, 3), 'stone');
  });

  it('部件按文档序嵌套在当前 world.part 作用域下，空格部件也登记', () => {
    const document = makeDocument([
      { id: 'first', size: [2, 1, 1] },
      { id: 'stray', size: [1, 1, 1], translate: [10, 0, 0] },
    ]);
    const host = makeWorld(document);
    host.world.part('外层', () => {
      const handle = host.world.massingImport('a');
      assert.equal(handle.parts.length, 2);
      const stray = handle.parts[1];
      assert.ok(stray !== undefined);
      assert.equal(stray.cellCount, 0, '孤立格默认清理，第二部件为空');
      assert.equal(stray.bounds, null);
    });
    const parts = host.compose().grid.parts();
    assert.deepEqual(parts, [
      { id: 1, name: '外层', parent: 0 },
      { id: 2, name: '部件 first', parent: 1 },
      { id: 3, name: '部件 stray', parent: 1 },
    ]);
    assert.equal(host.world.get(10, 1, 0), 'air', '孤立格默认被清理');
  });

  it('cleanup:none 保留孤立格并如实计数；isolated 默认删除', () => {
    const document = makeDocument([
      { id: 'base', size: [2, 1, 1] },
      { id: 'stray', size: [1, 1, 1], translate: [10, 0, 0] },
    ]);
    const isolated = makeWorld(document);
    const report = isolated.world.massingImport('a');
    assert.equal(report.counts.cells, 2);
    assert.equal(report.counts.isolatedCells, 1);
    assert.equal(report.counts.isolatedRemoved, 1);
    assert.equal(isolated.world.get(0, 1, 0), 'stone');
    assert.equal(isolated.world.get(10, 1, 0), 'air', '孤立格默认被清理');
    const kept = makeWorld(document);
    const keptReport = kept.world.massingImport('a', { cleanup: 'none' });
    assert.equal(keptReport.counts.cells, 3);
    assert.equal(keptReport.counts.isolatedCells, 1);
    assert.equal(keptReport.counts.isolatedRemoved, 0);
    assert.equal(kept.world.get(10, 1, 0), 'stone');
  });

  it('同一 id 重复导入允许，部件同名并存、各自一次调用', () => {
    const host = makeWorld(makeDocument([{ id: 'box', size: [2, 1, 1] }]));
    host.world.massingImport('a');
    host.world.massingImport('a', { at: [5, 1, 0] });
    const { grid } = host.compose();
    assert.deepEqual(
      grid.parts().map((p) => p.name),
      ['部件 box', '部件 box'],
    );
    assert.equal(grid.calls().length, 2);
    assert.equal(host.world.get(0, 1, 0), 'stone');
    assert.equal(host.world.get(5, 1, 0), 'stone');
  });

  it('同输入同结果：网格 hash 与句柄 JSON 逐字相同', () => {
    const build = (): { readonly host: WorldHost; readonly text: string } => {
      const host = makeWorld(
        makeDocument([
          { id: 'box', size: [4, 3, 4] },
          { id: 'roof', role: 'roof', size: [2, 1, 2], translate: [0, 3, 0] },
        ]),
      );
      const handle = host.world.massingImport('a', { rotate: 180 });
      return { host, text: JSON.stringify(handle) };
    };
    const first = build();
    const second = build();
    assert.equal(hashGrid(first.host.compose().grid), hashGrid(second.host.compose().grid));
    assert.equal(first.text, second.text);
  });

  it('句柄数值：solid 盒 4×3×4 共 48 格，包围盒与 counts 逐项一致', () => {
    const host = makeWorld(makeDocument([{ id: 'box', role: 'volume', size: [4, 3, 4] }]));
    const handle = host.world.massingImport('a');
    assert.deepEqual(handle.bounds, { min: [0, 1, 0], max: [3, 3, 3] });
    assert.equal(handle.counts.cells, 48);
    assert.equal(handle.counts.triangles, 12);
    assert.equal(handle.counts.solidParts, 1);
    const first = handle.parts[0];
    assert.ok(first !== undefined);
    assert.equal(first.cellCount, 48);
    assert.deepEqual(first.bounds, { min: [0, 1, 0], max: [3, 3, 3] });
  });
});

describe('massingImport 注入二次校验', () => {
  it('部件 material 为空串：注入时 document-invalid，不静默跳过', () => {
    const valid = makeDocument([{ id: 'box', size: [1, 1, 1] }]);
    const part = valid.parts[0];
    assert.ok(part !== undefined);
    const bad: ModelDocument = { version: 2, parts: [{ ...part, material: '' }] };
    expectMassingError(
      () => createWorld(table, { massing: makeAssets(bad, DEFAULT_CANDIDATES, 'bad') }),
      'document-invalid',
      /bad.*material|material.*bad/,
    );
  });

  it('注入 id 重复：document-invalid', () => {
    const document = makeDocument([{ id: 'box', size: [1, 1, 1] }]);
    const assets: MassingAssets = {
      documents: [
        { id: 'dup', document },
        { id: 'dup', document },
      ],
      colorCandidates: DEFAULT_CANDIDATES,
    };
    expectMassingError(() => createWorld(table, { massing: assets }), 'document-invalid', /重复/);
  });

  it('version 1 文档（无 material）可直接导入', () => {
    const v2 = makeDocument([{ id: 'box', size: [2, 1, 1] }]);
    const v1: ModelDocument = { version: 1, parts: v2.parts };
    const host = makeWorld(v1);
    host.world.massingImport('a', { mode: 'solid' });
    assert.equal(host.world.get(0, 1, 0), 'stone');
  });
});

describe('massingImport 与既有构件的冲突（两种调用顺序）', () => {
  const stairMaterial = 'stone_brick_stairs';

  it('stair：导入先与楼梯先都报 stair-structure，且失败原子', () => {
    const document = makeDocument([{ id: 'box', size: [2, 2, 2] }]);
    const first = makeWorld(document);
    const w1 = first.world;
    const hall1 = w1.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    const lower1 = w1.floorPlate({ in: hall1.inner, material: 'stone' });
    w1.massingImport('a', { at: [-3, 1, -2] });
    const before = snapshot(first);
    assert.throws(
      () => w1.stair({ from: lower1, to: hall1.top, kind: 'spiral', at: [0, 0], radius: 2, material: stairMaterial }),
      /stair 的踏面.*撞上 massingImport#\d+/,
    );
    assert.equal(snapshot(first), before);

    const reverse = makeWorld(document);
    const w2 = reverse.world;
    const hall2 = w2.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    const lower2 = w2.floorPlate({ in: hall2.inner, material: 'stone' });
    w2.stair({ from: lower2, to: hall2.top, kind: 'spiral', at: [0, 0], radius: 2, material: stairMaterial });
    const reverseBefore = snapshot(reverse);
    assert.throws(() => w2.massingImport('a', { at: [-3, 1, -2] }), /massingImport 盖到了此前 stair#\d+ 的踏面/);
    assert.equal(snapshot(reverse), reverseBefore);
  });

  it('steps：导入先与踏步先都报 steps-structure', () => {
    const document = makeDocument([{ id: 'box', size: [3, 1, 3] }]);
    const first = makeWorld(document);
    const w1 = first.world;
    const hall1 = w1.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    const door1 = w1.opening({ in: hall1.facade('south'), kind: 'door', width: 3, height: 2, sill: 1 });
    w1.massingImport('a', { at: [-1, 1, 5] });
    assert.throws(() => w1.steps({ to: door1, width: 3, material: stairMaterial }), /massingImport#\d+/);

    const reverse = makeWorld(document);
    const w2 = reverse.world;
    const hall2 = w2.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    const door2 = w2.opening({ in: hall2.facade('south'), kind: 'door', width: 3, height: 2, sill: 1 });
    w2.steps({ to: door2, width: 3, material: stairMaterial });
    assert.throws(() => w2.massingImport('a', { at: [-1, 1, 5] }), /steps#\d+ 的踏面/);
  });

  it('opening 的 hole：导入先与开洞先都报 opening-hole-body', () => {
    const document = makeDocument([{ id: 'box', size: [2, 2, 2] }]);
    const first = makeWorld(document);
    const w1 = first.world;
    const hall1 = w1.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    w1.massingImport('a', { at: [0, 1, 3] });
    assert.throws(
      () => w1.opening({ in: hall1.facade('south'), kind: 'door', width: 3, height: 2 }),
      /opening 的洞.*落进 massingImport#\d+/,
    );

    const reverse = makeWorld(document);
    const w2 = reverse.world;
    const hall2 = w2.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    w2.opening({ in: hall2.facade('south'), kind: 'door', width: 3, height: 2 });
    assert.throws(() => w2.massingImport('a', { at: [0, 1, 3] }), /massingImport 盖到了此前 opening#\d+ 的洞/);
  });
});

describe('massingImport 后的测量无需特判', () => {
  it('落地的导入件悬空为 0，且可被可达测量走上顶面', () => {
    const host = makeWorld(makeDocument([{ id: 'box', size: [3, 1, 3] }]));
    host.world.massingImport('a');
    const grid = host.compose().grid;
    assert.equal(measureFloating(grid).cells, 0);
    const report = measureReach(grid, loaded, { targets: [{ x: 0, y: 2, z: 0 }] });
    assert.equal(report.targets[0]?.reached, true);
  });

  it('悬空的导入件如实报出，不做特判', () => {
    const host = makeWorld(makeDocument([{ id: 'box', size: [2, 2, 2] }]));
    host.world.massingImport('a', { at: [0, 5, 0] });
    assert.equal(measureFloating(host.compose().grid).cells, 8);
  });
});
