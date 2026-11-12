/**
 * probe 的单元测试（OPTIMIZATION-ROADMAP Phase 3C；R4 §2.2 / Leak 3）：
 * 覆盖点查询（空气 / 方块 / 来源 / 顺序）、盒汇总与截断、剖面两个轴与图例、上限与存档错误。
 * 纯函数测试：不发请求、不渲染、不读文件（registry 只提供方块表）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { parseState } from '@pg/core/block-state';
import type { BlockTable } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Grid } from '@pg/core/grid';

import { probeBuilding } from './probe.ts';
import type { ProbeInput } from './probe.ts';

const registry = loadRegistry();

function archiveOf(build: (grid: Grid, table: BlockTable) => void): Uint8Array {
  const grid = createGrid(registry.table);
  build(grid, registry.table);
  return writeArchive(grid, 7);
}

function input(archive: Uint8Array, rest: Omit<ProbeInput, 'archive'>): ProbeInput {
  return { archive, ...rest };
}

/** 3×3×3 的小屋角：三种方块、三个调用，x/z 两个方向都有内容。 */
function cornerArchive(): Uint8Array {
  return archiveOf((grid, table) => {
    const walls = grid.defineCall('walls', 3, {});
    const floorPlate = grid.defineCall('floorPlate', 5, {});
    const box = grid.defineCall('box', 8, {});
    const set = (x: number, y: number, z: number, name: string, call: number): void => {
      grid.set(x, y, z, parseState(table, name), 0, call);
    };
    set(0, 0, 0, 'stone', walls);
    set(1, 0, 0, 'stone', walls);
    set(2, 0, 0, 'stone', walls);
    set(0, 0, 1, 'stone', walls);
    set(0, 0, 2, 'glass', box);
    set(0, 1, 0, 'oak_planks', floorPlate);
    set(0, 2, 0, 'glass', box);
  });
}

describe('probeBuilding points', () => {
  it('空气 / 方块 / 来源调用，且保持输入顺序', () => {
    const archive = cornerArchive();
    const result = probeBuilding(
      input(archive, {
        archiveVersion: 7,
        draftVersion: 9,
        points: [
          [5, 2, 9],
          [0, 2, 0],
          [0, 0, 0],
        ],
      }),
      { registry },
    );
    assert.equal(result.status, 'ok');
    assert.match(result.text, /^存档 v7 · 当前稿 v9\n/);
    assert.ok(result.text.includes('(5,2,9) air ← 无'));
    assert.ok(result.text.includes('(0,0,0) stone ← walls#1'));
    assert.ok(result.text.includes('(0,2,0) glass ← box#3'));
    assert.ok(result.text.indexOf('(5,2,9)') < result.text.indexOf('(0,0,0)'));
  });

  it('当前稿为 0 时头部写“无”', () => {
    const result = probeBuilding(
      input(cornerArchive(), { archiveVersion: 3, draftVersion: null, points: [[0, 0, 0]] }),
      { registry },
    );
    assert.equal(result.status, 'ok');
    assert.match(result.text, /^存档 v3 · 当前稿 无\n/);
  });
});

describe('probeBuilding box', () => {
  it('半开盒：汇总总数 / 非空气数，按 y 降序、z 升序、x 升序', () => {
    const result = probeBuilding(
      input(cornerArchive(), {
        archiveVersion: 1,
        draftVersion: 1,
        box: { min: [0, 0, 0], max: [3, 1, 3] },
      }),
      { registry },
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.text.includes('box x[0,3) y[0,1) z[0,3)：共 9 格，非空气 5 格。'));
    const coords = [...result.text.matchAll(/^\((\d+),(\d+),(\d+)\)/gm)].map((m) => [m[1], m[2], m[3]].join(','));
    assert.deepEqual(coords, ['0,0,0', '1,0,0', '2,0,0', '0,0,1', '0,0,2']);
  });

  it('最多列出 40 格，并注明剩余数量', () => {
    const archive = archiveOf((grid, table) => {
      const call = grid.defineCall('box', 1, {});
      for (let x = 0; x < 50; x += 1) grid.set(x, 0, 0, parseState(table, 'stone'), 0, call);
    });
    const result = probeBuilding(
      input(archive, { archiveVersion: 1, draftVersion: 1, box: { min: [0, 0, 0], max: [50, 1, 1] } }),
      { registry },
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.text.includes('共 50 格，非空气 50 格。'));
    assert.equal(result.text.match(/^\(\d+/gm)?.length, 40);
    assert.ok(result.text.includes('…另有 10 格未列出'));
  });

  it('按方块 / 来源聚合：格数降序、前 12 项、总数与截断都写明', () => {
    const materials = ['stone', 'glass', 'oak_planks'] as const;
    const archive = archiveOf((grid, table) => {
      for (let i = 0; i < 15; i += 1) {
        const call = grid.defineCall('box', i + 1, {});
        const cells = 15 - i;
        for (let n = 0; n < cells; n += 1) {
          grid.set(n, 0, i, parseState(table, materials[i % materials.length] ?? 'stone'), 0, call);
        }
      }
    });
    const result = probeBuilding(
      input(archive, {
        archiveVersion: 1,
        draftVersion: 1,
        box: { min: [0, 0, 0], max: [15, 1, 15] },
      }),
      { registry },
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.text.includes('聚合（按方块 / 来源，前 12 项）：共 120 格 / 已列出 114 格（12 项）。'));
    assert.match(result.text, /^ {2}stone ← box#1：15 格（12\.5%）$/m);
    assert.match(result.text, /^ {2}glass ← box#2：14 格（11\.7%）$/m);
    assert.equal(result.text.match(/^ {2}\S+ ← box#\d+：/gm)?.length, 12);
    assert.doesNotMatch(result.text, /^ {2}\S+ ← box#13：/m);
    assert.ok(result.text.includes('…另有 3 项 / 6 格未列出'));
    assert.ok(result.text.includes('明细（y 降序，已列出 40 / 非空气 120 格）：'));
    assert.ok(result.text.includes('…另有 80 格未列出'));
  });

  it('counts:false 时关闭聚合，只保留原有逐格明细', () => {
    const result = probeBuilding(
      input(cornerArchive(), {
        archiveVersion: 1,
        draftVersion: 1,
        box: { min: [0, 0, 0], max: [3, 1, 3], counts: false },
      }),
      { registry },
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.text.includes('共 9 格，非空气 5 格。'));
    assert.ok(!result.text.includes('聚合（按方块 / 来源'));
    assert.ok(result.text.includes('明细（y 降序，已列出 5 / 非空气 5 格）：'));
  });

  it('体积超过 4096 格时返回 box-too-large，不逐格扫描', () => {
    const result = probeBuilding(
      input(cornerArchive(), {
        archiveVersion: 1,
        draftVersion: 1,
        box: { min: [0, 0, 0], max: [100, 100, 1] },
      }),
      { registry },
    );
    assert.equal(result.status, 'box-too-large');
    assert.ok(result.text.includes('超过上限 4096'));
    assert.ok(result.text.includes('缩小盒范围'));
    assert.ok(result.text.includes('points'));
  });
});

describe('probeBuilding section', () => {
  it('axis=x 扫 z：行按 y 降序、固定宽度、图例含方块与首次来源', () => {
    const result = probeBuilding(
      input(cornerArchive(), { archiveVersion: 7, draftVersion: 7, section: { axis: 'x', at: 0 } }),
      { registry },
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.text.includes('横向 z 0–2（左→右）'));
    assert.ok(result.text.includes('y=2 |#..|'));
    assert.ok(result.text.includes('y=1 |=..|'));
    assert.ok(result.text.includes('y=0 |++#|'));
    assert.ok(result.text.indexOf('y=2 |') < result.text.indexOf('y=1 |'));
    assert.ok(result.text.indexOf('y=1 |') < result.text.indexOf('y=0 |'));
    assert.ok(result.text.includes('# glass ← box#3'));
    assert.ok(result.text.includes('= oak_planks ← floorPlate#2'));
    assert.ok(result.text.includes('+ stone ← walls#1'));
    assert.ok(result.text.includes('. 空气'));
  });

  it('axis=z 扫 x，并支持 y 闭区间裁剪', () => {
    const result = probeBuilding(
      input(cornerArchive(), {
        archiveVersion: 7,
        draftVersion: 7,
        section: { axis: 'z', at: 0, y: [0, 0] },
      }),
      { registry },
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.text.includes('横向 x 0–2（左→右）'));
    assert.ok(result.text.includes('y 0–0'));
    assert.ok(result.text.includes('y=0 |###|'));
    assert.ok(result.text.includes('# stone ← walls#1'));
    assert.ok(!result.text.includes('y=1 |'));
    assert.ok(!result.text.includes('y=2 |'));
  });

  it('同一存档连续调用输出逐字节相同', () => {
    const archive = cornerArchive();
    const query = (): string =>
      probeBuilding(input(archive, { archiveVersion: 7, draftVersion: 7, section: { axis: 'x', at: 0 } }), {
        registry,
      }).text;
    assert.equal(query(), query());
  });

  it('宽度 × 高度超过 1200 时返回 section-too-large', () => {
    const archive = archiveOf((grid, table) => {
      const call = grid.defineCall('box', 1, {});
      grid.set(0, 0, 0, parseState(table, 'stone'), 0, call);
      grid.set(39, 39, 39, parseState(table, 'stone'), 0, call);
    });
    const result = probeBuilding(
      input(archive, { archiveVersion: 1, draftVersion: 1, section: { axis: 'x', at: 0 } }),
      { registry },
    );
    assert.equal(result.status, 'section-too-large');
    assert.ok(result.text.includes('40×40 = 1600'));
    assert.ok(result.text.includes('超过上限 1200'));
    assert.ok(result.text.includes('缩小 y 范围'));
  });
});

describe('probeBuilding 空 / 坏输入', () => {
  it('没有实体格时 section 为空但不报错', () => {
    const archive = writeArchive(createGrid(registry.table), 7);
    const result = probeBuilding(
      input(archive, { archiveVersion: 1, draftVersion: 1, section: { axis: 'x', at: 0 } }),
      { registry },
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.text.includes('存档没有实体格'));
  });

  it('坏存档返回 invalid-archive；缺选择器返回 invalid-input；点数超限返回 invalid-input', () => {
    const bad = probeBuilding(input(Uint8Array.from([1, 2, 3]), { archiveVersion: 1, draftVersion: 1 }), {
      registry,
    });
    assert.equal(bad.status, 'invalid-archive');

    const none = probeBuilding(input(cornerArchive(), { archiveVersion: 1, draftVersion: 1 }), { registry });
    assert.equal(none.status, 'invalid-input');

    const tooMany = probeBuilding(
      input(cornerArchive(), {
        archiveVersion: 1,
        draftVersion: 1,
        points: Array.from({ length: 33 }, () => [0, 0, 0] as const),
      }),
      { registry },
    );
    assert.equal(tooMany.status, 'invalid-input');
  });
});
