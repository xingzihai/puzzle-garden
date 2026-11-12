/** voxelize 的单元测试：MASSING-CONVERSION-SPEC §9 的好 / 坏样本、金标指纹、性质与确定性。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { createModel } from './model.ts';
import type { ModelDocument, Role } from './schema.ts';
import { MAX_IMPORT_CELLS, VoxelizeError, voxelize } from './voxelize.ts';
import type { VoxelizeOptions, VoxelMode } from './voxelize.ts';

type Cell = readonly [number, number, number];

function base(id: string) {
  return { id, name: `部件${id}`, role: 'volume' as const, color: '#123456' };
}

function boxDoc(size: readonly [number, number, number], role: Role = 'volume'): ModelDocument {
  const model = createModel();
  model.box({ ...base('box'), role, size: [size[0], size[1], size[2]] });
  return model.finish();
}

const HEX_OUTLINE: readonly [number, number][] = [
  [4, 0],
  [2, 3],
  [-2, 3],
  [-4, 0],
  [-2, -3],
  [2, -3],
];

function hexDoc(): ModelDocument {
  const model = createModel();
  model.extrude({ ...base('hex'), role: 'roof', outline: HEX_OUTLINE, height: 2 });
  return model.finish();
}

function coneDoc(): ModelDocument {
  const model = createModel();
  model.revolve({
    ...base('cone'),
    role: 'roof',
    profile: (t) => [4 * t, 4 * t],
    profileSegments: 8,
    radialSegments: 16,
  });
  return model.finish();
}

function tubeDoc(): ModelDocument {
  const model = createModel();
  model.revolve({ ...base('tube'), profile: (t) => [3, t * 4], profileSegments: 8, radialSegments: 16 });
  return model.finish();
}

/** 断言抛出 VoxelizeError，且 code 与中文关键词都对上，不只断言“报错”。 */
function expectCode(run: () => unknown, code: VoxelizeError['code'], keyword: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof VoxelizeError, `期望 VoxelizeError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    assert.match(error.message, keyword);
    return true;
  });
}

function compareCells(a: Cell, b: Cell): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function sortCells(cells: readonly Cell[]): Cell[] {
  return cells.map((c): Cell => [c[0], c[1], c[2]]).sort(compareCells);
}

/** §6 的绕 y 90° 格索引映射；连转四次应为恒等。 */
function rotate90(cells: readonly Cell[]): Cell[] {
  return cells.map((c): Cell => [-c[2] - 1, c[1], c[0]]);
}

function fingerprintOf(result: unknown): string {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

describe('voxelize 好样本', () => {
  it('整数对齐盒 [4,3,4]：solid 恰好 48 格、shell 44 格、包围盒正确（§9.1）', () => {
    const solid = voxelize(boxDoc([4, 3, 4]), { mode: 'solid' });
    const solidPart = solid.parts[0];
    assert.ok(solidPart);
    assert.equal(solidPart.cellCount, 48);
    assert.deepEqual(solidPart.bounds, { min: [0, 0, 0], max: [3, 2, 3] });
    assert.equal(solidPart.leaky, false);
    const shell = voxelize(boxDoc([4, 3, 4]), { mode: 'shell' });
    assert.equal(shell.parts[0]?.cellCount, 44);
  });

  it('旋转圆锥壳：shell 1 格厚、保留尖端、无孤立格（§9.2）', () => {
    const result = voxelize(coneDoc());
    const part = result.parts[0];
    assert.ok(part);
    assert.equal(part.mode, 'shell');
    assert.equal(part.isolatedCells, 0);
    assert.ok(part.bounds);
    const tipY = part.bounds.min[1];
    assert.ok(part.cells.some((cell) => cell[1] === tipY && cell[0] === 0 && cell[2] === 0));
  });

  it('六角屋面：俯视格集覆盖六边形范围（§9.3，金标见下一组）', () => {
    const result = voxelize(hexDoc());
    const part = result.parts[0];
    assert.ok(part);
    assert.ok(part.cellCount > 0);
    assert.deepEqual(part.bounds, { min: [-4, 0, -3], max: [4, 2, 3] });
  });

  it('非闭合薄壳：solid 标 leaky 且不填内部（§9.4）', () => {
    const shell = voxelize(tubeDoc(), { mode: 'shell' });
    const solid = voxelize(tubeDoc(), { mode: 'solid' });
    const part = solid.parts[0];
    assert.ok(part);
    assert.equal(part.leaky, true);
    assert.equal(part.cellCount, shell.parts[0]?.cellCount);
  });

  it('空文档：返回空结果（§9.5）', () => {
    const result = voxelize(createModel().finish());
    assert.deepEqual(result.parts, []);
    assert.equal(result.bounds, null);
    assert.deepEqual(result.counts, {
      parts: 0,
      cells: 0,
      triangles: 0,
      shellParts: 0,
      solidParts: 0,
      emptyParts: 0,
      leakyParts: 0,
      isolatedCells: 0,
      isolatedRemoved: 0,
    });
  });

  it('单格噪声：默认清理删 1 格；cleanup:none 保留并计数（§9.6）', () => {
    const model = createModel();
    model.box({ ...base('body'), size: [2, 2, 2] });
    model.box({ ...base('noise'), size: [0.5, 0.5, 0.5], transform: { translate: [50, 0, 0] } });
    const doc = model.finish();
    const cleaned = voxelize(doc);
    const noise = cleaned.parts[1];
    assert.ok(noise);
    assert.equal(noise.isolatedCells, 1);
    assert.equal(noise.isolatedRemoved, 1);
    assert.equal(noise.cellCount, 0);
    assert.equal(cleaned.counts.isolatedRemoved, 1);
    const kept = voxelize(doc, { cleanup: 'none' });
    const keptNoise = kept.parts[1];
    assert.ok(keptNoise);
    assert.equal(keptNoise.cellCount, 1);
    assert.equal(keptNoise.isolatedCells, 1);
    assert.equal(keptNoise.isolatedRemoved, 0);
  });

  it('overrides 逐部件覆盖模式与厚度', () => {
    const model = createModel();
    model.box({ ...base('roof'), role: 'roof', size: [4, 3, 4] });
    const doc = model.finish();
    assert.equal(voxelize(doc).parts[0]?.cellCount, 44);
    const solid = voxelize(doc, { overrides: { roof: { mode: 'solid' } } });
    const solidPart = solid.parts[0];
    assert.ok(solidPart);
    assert.equal(solidPart.mode, 'solid');
    assert.equal(solidPart.cellCount, 48);
    const thick = voxelize(doc, { overrides: { roof: { thickness: 2 } } });
    const thickPart = thick.parts[0];
    assert.ok(thickPart);
    assert.ok(thickPart.cellCount > 44);
  });

  it('部件 material 原样透传，未设时属性不存在（§9.7）', () => {
    const model = createModel();
    model.box({ ...base('a'), size: [1, 1, 1], material: 'deepslate_tiles' });
    model.box({ ...base('b'), size: [1, 1, 1], transform: { translate: [3, 0, 0] } });
    const result = voxelize(model.finish());
    assert.equal(result.parts[0]?.material, 'deepslate_tiles');
    const second = result.parts[1];
    assert.ok(second);
    assert.equal('material' in second, false);
  });
});

describe('voxelize 金标指纹', () => {
  // 常量来源：MASSING-CONVERSION-SPEC §3 首次实现（2026-10-13）固化；规范序列化 = JSON.stringify(VoxelResult)，
  // 格已升序、JSON 无空白。改动算法或输出结构必须重算并注明原因。
  const goldens: readonly {
    readonly name: string;
    readonly build: () => ModelDocument;
    readonly options: VoxelizeOptions;
    readonly sha256: string;
  }[] = [
    {
      name: '整数对齐盒 solid',
      build: () => boxDoc([4, 3, 4]),
      options: { mode: 'solid' },
      sha256: 'bad5f99d7727954764b62e5006b190c9c32182425ecf556c1c97f22f6971346a',
    },
    {
      name: '整数对齐盒 shell',
      build: () => boxDoc([4, 3, 4]),
      options: { mode: 'shell' },
      sha256: '9df417cf676f4057ba49ebc294be51268bb6662f24a46ad1e60b066cb709541f',
    },
    {
      name: '六角屋面 shell',
      build: hexDoc,
      options: { mode: 'shell' },
      sha256: 'cb80ed9c0e9beac8f4844d6e60efe4f47146036c8d8a14d1c0c0fbf95504863f',
    },
  ];
  for (const golden of goldens) {
    it(`${golden.name}：指纹稳定且两次调用一致`, () => {
      const first = fingerprintOf(voxelize(golden.build(), golden.options));
      const second = fingerprintOf(voxelize(golden.build(), golden.options));
      assert.equal(first, golden.sha256);
      assert.equal(second, golden.sha256);
    });
  }
});

describe('voxelize 坏样本', () => {
  it('NaN / Infinity 顶点：document-invalid', () => {
    const doc = boxDoc([2, 2, 2]);
    const part = doc.parts[0];
    assert.ok(part);
    const nan = { ...doc, parts: [{ ...part, positions: [NaN, ...part.positions.slice(1)] }] };
    expectCode(() => voxelize(nan), 'document-invalid', /草模文档不合/);
    const infinity = { ...doc, parts: [{ ...part, positions: [Infinity, ...part.positions.slice(1)] }] };
    expectCode(() => voxelize(infinity), 'document-invalid', /草模文档不合/);
  });

  it('重复部件 id：document-invalid', () => {
    const doc = boxDoc([2, 2, 2]);
    const part = doc.parts[0];
    assert.ok(part);
    expectCode(() => voxelize({ ...doc, parts: [part, part] }), 'document-invalid', /id 重复/);
  });

  it('部件 material 为空串：document-invalid', () => {
    const doc = boxDoc([2, 2, 2]);
    const part = doc.parts[0];
    assert.ok(part);
    expectCode(() => voxelize({ ...doc, parts: [{ ...part, material: '' }] }), 'document-invalid', /草模文档不合/);
  });

  it('总三角数超过上限：document-invalid', () => {
    const many = (id: string, count: number): unknown => ({
      id,
      name: id,
      role: 'volume',
      color: '#000000',
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: Array.from({ length: count * 3 }, (_, index) => index % 3),
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      source: {
        operation: 'box',
        parameters: { size: [1, 1, 1], transform: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] } },
      },
    });
    const doc = { version: 2, parts: [many('a', 200001), many('b', 200000)] };
    expectCode(() => voxelize(doc), 'document-invalid', /三角数超过上限/);
  });

  it('thickness 非 1–4：options-invalid', () => {
    expectCode(() => voxelize(boxDoc([2, 2, 2]), { thickness: 0 }), 'options-invalid', /thickness/);
    expectCode(() => voxelize(boxDoc([2, 2, 2]), { thickness: 5 }), 'options-invalid', /thickness/);
  });

  it('thickness 与 solid 同传：options-invalid', () => {
    expectCode(() => voxelize(boxDoc([2, 2, 2]), { mode: 'solid', thickness: 2 }), 'options-invalid', /只能用于 shell/);
  });

  it('overrides 指向不存在的部件：options-invalid', () => {
    expectCode(
      () => voxelize(boxDoc([2, 2, 2]), { overrides: { nope: { mode: 'shell' } } }),
      'options-invalid',
      /overrides 含不存在/,
    );
  });

  it('world 层选项（rotate 等）不属于内核：严格拒绝未知键', () => {
    const worldOnly = { rotate: 45 } as unknown as VoxelizeOptions;
    expectCode(() => voxelize(boxDoc([2, 2, 2]), worldOnly), 'options-invalid', /选项不合法/);
  });

  it(`超过单次导入上限 ${String(MAX_IMPORT_CELLS)} 格：limit-exceeded`, () => {
    const model = createModel();
    model.box({ ...base('big'), role: 'roof', size: [501, 1, 1000] });
    expectCode(() => voxelize(model.finish(), { mode: 'shell' }), 'limit-exceeded', /超过单次上限 500000/);
  });

  it('多个部件各自不超、合计超过单次导入上限：limit-exceeded', () => {
    const model = createModel();
    model.box({ ...base('a'), size: [100, 50, 52] });
    model.box({ ...base('b'), size: [100, 50, 52], transform: { translate: [200, 0, 0] } });
    expectCode(() => voxelize(model.finish(), { mode: 'solid' }), 'limit-exceeded', /超过单次上限 500000/);
  });
});

const roleArb = fc.constantFrom<Role>('volume', 'roof', 'floor', 'connection');
const docArb: fc.Arbitrary<ModelDocument> = fc
  .array(
    fc.record({
      sx: fc.integer({ min: 1, max: 5 }),
      sy: fc.integer({ min: 1, max: 5 }),
      sz: fc.integer({ min: 1, max: 5 }),
      role: roleArb,
    }),
    { minLength: 1, maxLength: 4 },
  )
  .map((parts) => {
    const model = createModel();
    parts.forEach((part, index) => {
      model.box({
        id: `p${String(index)}`,
        name: `部件${String(index)}`,
        role: part.role,
        color: '#123456',
        size: [part.sx, part.sy, part.sz],
      });
    });
    return model.finish();
  });

describe('voxelize 性质测试（fast-check）', () => {
  it('同输入同选项两次调用逐格相同', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        assert.deepEqual(voxelize(doc), voxelize(doc));
      }),
    );
  });

  it('每格在每轴 floor(min)−1 .. floor(max) 闭区间内', () => {
    fc.assert(
      fc.property(docArb, fc.constantFrom<VoxelMode>('shell', 'solid'), (doc, mode) => {
        const result = voxelize(doc, { mode });
        result.parts.forEach((part, index) => {
          const source = doc.parts[index];
          assert.ok(source);
          for (const cell of part.cells) {
            for (const axis of [0, 1, 2] as const) {
              const low = Math.floor(source.bounds.min[axis]) - 1;
              const high = Math.floor(source.bounds.max[axis]);
              assert.ok(cell[axis] >= low && cell[axis] <= high);
            }
          }
        });
      }),
    );
  });

  it('部件内无重复格且严格升序', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        for (const part of voxelize(doc).parts) {
          for (let i = 1; i < part.cells.length; i += 1) {
            const previous = part.cells[i - 1];
            const current = part.cells[i];
            assert.ok(previous && current);
            assert.ok(compareCells(previous, current) < 0);
          }
        }
      }),
    );
  });

  it('counts 与各数组长度一致', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const result = voxelize(doc);
        const cells = result.parts.reduce((sum, part) => sum + part.cellCount, 0);
        assert.equal(result.counts.cells, cells);
        assert.equal(result.counts.parts, result.parts.length);
        assert.equal(result.counts.shellParts + result.counts.solidParts, result.parts.length);
        assert.equal(result.counts.emptyParts, result.parts.filter((part) => part.cellCount === 0).length);
        assert.equal(result.counts.leakyParts, result.parts.filter((part) => part.leaky).length);
      }),
    );
  });

  it('thickness=t 的壳包含 t−1 的壳', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const thinner = voxelize(doc, { mode: 'shell', thickness: 1 });
        const thicker = voxelize(doc, { mode: 'shell', thickness: 2 });
        const keys = new Set(thicker.parts.flatMap((part) => part.cells.map((cell) => cell.join(','))));
        for (const part of thinner.parts) {
          for (const cell of part.cells) assert.ok(keys.has(cell.join(',')));
        }
      }),
    );
  });

  it('绕 y 连转四次 90° 回到原格集', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        for (const part of voxelize(doc).parts) {
          let rotated: readonly Cell[] = part.cells;
          for (let turn = 0; turn < 4; turn += 1) rotated = rotate90(rotated);
          assert.deepEqual(sortCells(rotated), sortCells(part.cells));
        }
      }),
    );
  });

  it('输出格全为安全整数、无 -0', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        for (const part of voxelize(doc).parts) {
          for (const cell of part.cells) {
            for (const axis of [0, 1, 2] as const) {
              assert.ok(Number.isSafeInteger(cell[axis]));
              assert.equal(Object.is(cell[axis], -0), false);
            }
          }
        }
      }),
    );
  });
});
