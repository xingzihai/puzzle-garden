/** 屋面剖面、陡坡连接、关系与拒绝样本；用超出连接所需的格数判断叠层，不把顶饰与连接格算成叠层。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { measureRoofProfile } from '@pg/analysis/roof-profile';
import { measureReach } from '@pg/analysis/reach';
import { createWorld, rect } from './index.ts';

const registry = loadRegistry();
test('五种屋面默认薄壳，每列恰好一格；厚度与峰高显式可调', () => {
  for (const kind of ['gable', 'hip', 'pyramid', 'shed', 'flat'] as const) {
    const h = createWorld(registry.table);
    const roof = h.world.roof({ footprint: rect(-5, -4, 5, 4), y: 8, kind, material: 'deepslate_tiles' });
    const profile = measureRoofProfile(h.compose().grid, () => true);
    assert.equal(profile.thickness[2], 0);
    assert.equal(profile.thickness['3+'], 0);
    assert.equal(profile.cells, 13 * 11);
    assert.equal(roof.eaveLine.y, 8);
    if (kind === 'flat') assert.equal(roof.top?.y, 9);
    else {
      assert(roof.peak[1] > 8);
      assert.equal(roof.top, undefined);
    }
  }
  const h = createWorld(registry.table);
  h.world.roof({
    footprint: rect(-4, -4, 4, 4),
    y: 8,
    kind: 'gable',
    ridge: 'z',
    peakY: 11,
    thickness: 2,
    material: 'stone',
  });
  const profile = measureRoofProfile(h.compose().grid, () => true);
  assert.equal(profile.thickness[1], 0);
  assert.equal(profile.thickness[2], 121);
  assert.equal(profile.layers.at(-1)?.y, 11);
  // 显式 thickness=2：测量不知道调用参数，照实报出每列多 1 格；判断是否叠层要结合调用参数看。
  assert.deepEqual(profile.excess, { columns: 121, cells: 121 });
});

/**
 * 侧面缝：对每列，它的最低格与较低邻列的列顶之差。1 表示两级靠棱相接、侧面不透光（薄壳的正常形态）；
 * ≥ 2 表示中间露出空气缝。返回所有相邻列对里的最大值（只有一列时为 1）。
 */
function maxSideGap(cells: readonly { x: number; y: number; z: number }[]): number {
  const cols = new Map<string, { lo: number; hi: number }>();
  for (const c of cells) {
    const k = `${String(c.x)},${String(c.z)}`;
    const e = cols.get(k);
    cols.set(k, e === undefined ? { lo: c.y, hi: c.y } : { lo: Math.min(e.lo, c.y), hi: Math.max(e.hi, c.y) });
  }
  let gap = 1;
  for (const [k, e] of cols) {
    const [x, z] = k.split(',').map(Number) as [number, number];
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const n = cols.get(`${String(x + dx)},${String(z + dz)}`);
      if (n !== undefined && n.hi < e.lo) gap = Math.max(gap, e.lo - n.hi);
    }
  }
  return gap;
}

test('陡坡：peakY 精确落在尖端，侧面补竖向连接后没有缝，超出连接所需为 0', () => {
  for (const kind of ['gable', 'hip', 'pyramid', 'shed'] as const) {
    const h = createWorld(registry.table);
    const roof = h.world.roof({
      footprint: rect(-7, -7, 7, 7),
      y: 42,
      kind,
      peakY: 54,
      overhang: 0,
      material: 'stone',
    });
    const grid = h.compose().grid;
    const cells = [...grid.cells()];
    assert.equal(roof.peak[1], 54, kind);
    assert.equal(Math.max(...cells.map((c) => c.y)), 54, kind);
    assert.equal(maxSideGap(cells), 1, `${kind} 陡坡侧面有缝`);
    const profile = measureRoofProfile(grid, () => true);
    assert.deepEqual(profile.excess, { columns: 0, cells: 0 }, kind);
    // 双坡、四坡、攒尖坡度 12/7：相邻列高差 1 或 2，高差 2 处补 1 格，旧的竖向列厚统计把这些列报成厚 2。
    // 单坡进深 14、坡度 12/14 < 1，不需要补，作为对照。
    if (kind === 'shed') assert.equal(profile.thickness[2], 0);
    else assert(profile.thickness[2] > 0, `${kind} 陡坡的连接列应当在旧统计里显示为列厚 2`);
  }
});

test('坡度 ≤ 1 不补连接：与每列一格的薄壳完全相同', () => {
  for (const pitch of [0.4, 0.75, 1]) {
    const h = createWorld(registry.table);
    h.world.roof({ footprint: rect(-6, -5, 6, 5), y: 8, kind: 'hip', pitch, material: 'stone' });
    const cells = [...h.compose().grid.cells()];
    const profile = measureRoofProfile(h.compose().grid, () => true);
    assert.equal(profile.thickness[2] + profile.thickness['3+'], 0, String(pitch));
    assert(maxSideGap(cells) <= 1, String(pitch));
  }
});

test('坏样本：不补连接的陡坡侧面有缝，检查函数能报出', () => {
  // 手写一排列顶 10 / 12 / 14、每列一格的陡坡：缝 2
  assert.equal(
    maxSideGap([
      { x: 0, y: 10, z: 0 },
      { x: 1, y: 12, z: 0 },
      { x: 2, y: 14, z: 0 },
    ]),
    2,
  );
});

test('坏样本：陡坡上再叠一层实心板，超出连接所需必须报出', () => {
  const h = createWorld(registry.table);
  const roof = h.world.roof({
    footprint: rect(-4, -4, 4, 4),
    y: 10,
    kind: 'pyramid',
    pitch: 2,
    overhang: 0,
    material: 'stone',
  });
  // 在整个屋面下方紧贴再铺一层（v0.2 式叠层），尖端除外
  for (const c of [...h.compose().grid.cells()]) {
    if (c.y > 10 && c.y < roof.peak[1]) h.world.set(c.x, c.y - 1, c.z, 'stone');
  }
  const profile = measureRoofProfile(h.compose().grid, () => true);
  assert(profile.excess.columns > 0);
  assert(profile.excessSamples.length > 0);
});

test('平屋面承托上方外墙，女儿墙与顶饰位置可追溯', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const hall = w.walls({ footprint: rect(-6, -6, 6, 6), y: 1, height: 6, material: 'stone' });
  const roof = w.roof({ on: hall, kind: 'flat', material: 'stone', parapet: { height: 2, material: 'stone_bricks' } });
  assert(roof.top !== undefined);
  assert.equal(w.get(-7, 8, 0), 'stone_bricks');
  w.walls({ on: roof.top, height: 3, material: 'oak_planks' });
  assert.equal(w.get(-6, 8, 0), 'oak_planks');
  const peak = w.roof({
    footprint: rect(-3, -3, 3, 3),
    y: 15,
    kind: 'pyramid',
    pitch: 1,
    material: 'stone',
    finial: { height: 2, material: 'gold_block' },
  });
  assert.equal(w.get(peak.peak[0], peak.peak[1] + 1, peak.peak[2]), 'gold_block');
  assert.equal(w.get(peak.peak[0], peak.peak[1] + 2, peak.peak[2]), 'gold_block');
});

test('楼梯出口穿过后铺的平屋面，平台可达', () => {
  const h = createWorld(registry.table);
  const w = h.world;
  const hall = w.walls({ footprint: rect(-8, -8, 8, 8), y: 1, height: 7, material: 'stone' });
  const bottom = w.floorPlate({ in: hall.inner, material: 'stone' });
  const roof = w.roof({ on: hall, kind: 'flat', material: 'stone', overhang: 0 });
  assert(roof.top !== undefined);
  const door = w.opening({ in: hall.facade('south'), kind: 'door', sill: 1, width: 3, height: 4 });
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
  w.stair({ from: bottom, to: roof.top, kind: 'spiral', at: [0, 0], radius: 2, material: 'stone_brick_stairs' });
  w.roof({ on: hall, kind: 'flat', material: 'stone', overhang: 0 });
  assert.equal(measureReach(h.compose().grid, registry, { targets: [{ x: 6, y: 9, z: 6 }] }).targets[0]?.reached, true);
});

/**
 * 室内空气能不能从墙顶以上漏到室外：从室内一格出发，在墙顶高度以上的空气里面邻接扩散，
 * 走出外墙包围盒就算漏。只看墙顶以上（门窗洞在墙身里，不在这里测）。
 */
function leaksAboveWalls(
  get: (x: number, y: number, z: number) => string,
  box: { minX: number; maxX: number; minZ: number; maxZ: number },
  wallTop: number,
  start: readonly [number, number, number],
): boolean {
  const seen = new Set<string>();
  const stack = [start];
  const ceiling = wallTop + 40;
  for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
    const [x, y, z] = c;
    if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) return true;
    const k = `${String(x)},${String(y)},${String(z)}`;
    if (seen.has(k) || y < wallTop || y > ceiling || get(x, y, z) !== 'air') continue;
    seen.add(k);
    for (const [dx, dy, dz] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const)
      stack.push([x + dx, y + dy, z + dz]);
  }
  return false;
}

test('双坡、单坡屋面自动封山墙：墙顶以上没有漏到室外的开口（审查 B1、决策 #63）', () => {
  for (const kind of ['gable', 'shed'] as const) {
    for (const ridge of ['x', 'z'] as const) {
      for (const pitch of [0.5, 1, 2]) {
        const h = createWorld(registry.table);
        const hall = h.world.walls({ footprint: rect(-6, -4, 6, 4), y: 1, height: 4, material: 'oak_planks' });
        h.world.roof({ on: hall, kind, ridge, pitch, overhang: 1, material: 'deepslate_tiles' });
        const label = `${kind} ${ridge} ${String(pitch)}`;
        assert(
          !leaksAboveWalls(h.world.get, { minX: -6, maxX: 6, minZ: -4, maxZ: 4 }, 5, [0, 5, 0]),
          `${label} 山墙有开口`,
        );
        // 山墙用外墙材质
        const end = ridge === 'x' ? [-6, 6, 0] : [0, 6, -4];
        if (kind === 'gable' || ridge === 'x') {
          assert.equal(h.world.get(end[0]!, end[1]!, end[2]!), 'oak_planks', `${label} 山墙材质`);
        }
      }
    }
  }
});

test('山墙：gableMaterial 可换材质，false 不封；柱廊上的屋面不自动封', () => {
  const h = createWorld(registry.table);
  const hall = h.world.walls({ footprint: rect(-6, -4, 6, 4), y: 1, height: 4, material: 'oak_planks' });
  h.world.roof({ on: hall, kind: 'gable', ridge: 'x', pitch: 1, material: 'deepslate_tiles', gableMaterial: 'stone' });
  assert.equal(h.world.get(-6, 6, 0), 'stone');
  const open = createWorld(registry.table);
  const hall2 = open.world.walls({ footprint: rect(-6, -4, 6, 4), y: 1, height: 4, material: 'oak_planks' });
  open.world.roof({
    on: hall2,
    kind: 'gable',
    ridge: 'x',
    pitch: 1,
    material: 'deepslate_tiles',
    gableMaterial: false,
  });
  assert(leaksAboveWalls(open.world.get, { minX: -6, maxX: 6, minZ: -4, maxZ: 4 }, 5, [0, 5, 0]));
  // 亭子：柱廊上的双坡顶两端本来就是敞开的
  const pav = createWorld(registry.table);
  const columns = pav.world.colonnade({
    footprint: rect(-4, -3, 4, 3),
    y: 1,
    count: 4,
    height: 3,
    column: { material: 'oak_log' },
  });
  pav.world.roof({ on: columns, kind: 'gable', ridge: 'x', pitch: 1, material: 'deepslate_tiles' });
  assert.equal(pav.world.get(-4, 6, 0), 'air');
});

test('后殿屋面贴住曲墙墙顶：任何坡度下墙顶上方都没有空气缝（审查 A1）', () => {
  for (const pitch of [0.4, 0.7, 1, 2]) {
    for (const overhang of [0, 1, 2]) {
      const h = createWorld(registry.table);
      const apse = h.world.walls({
        footprint: rect(-6, -20, 6, -10),
        y: 1,
        height: 6,
        outline: 'apse',
        material: 'stone',
      });
      h.world.roof({ on: apse, kind: 'hip', pitch, overhang, material: 'deepslate_tiles' });
      const grid = h.compose().grid;
      for (const c of grid.cells()) {
        if (c.state.name !== 'stone' || c.y !== 6) continue;
        assert.equal(
          grid.get(c.x, 7, c.z)?.state.name,
          'deepslate_tiles',
          `墙顶 (${String(c.x)}, ${String(c.z)}) 上方不是屋面：pitch ${String(pitch)} overhang ${String(overhang)}`,
        );
      }
    }
  }
  const h = createWorld(registry.table);
  const apse = h.world.walls({ footprint: rect(-6, -20, 6, -10), y: 1, height: 6, outline: 'apse', material: 'stone' });
  assert.throws(() => h.world.roof({ on: apse, kind: 'gable', material: 'stone' }), /后殿.*hip、pyramid、flat/);
});

test('错误坡度、过窄轮廓、无效参数组合、材质与越界原子拒绝', () => {
  const h = createWorld(registry.table);
  const base = { footprint: rect(-3, -3, 3, 3), y: 5, kind: 'gable' as const, material: 'stone' };
  for (const bad of [
    { ...base, pitch: 9 },
    { ...base, pitch: 0 },
    { ...base, peakY: 5 },
    { ...base, peakY: 4 },
    { ...base, peakY: 100 },
    { ...base, pitch: 0.01 },
    { ...base, peakY: 7, pitch: 0.5 },
    { ...base, footprint: rect(0, 0, 0, 0), overhang: 0 },
    { ...base, kind: 'flat' as const, pitch: 1 },
    { ...base, kind: 'hip' as const, ridge: 'x' as const },
    { ...base, parapet: { height: 1, material: 'stone' } },
    { ...base, material: 'air' },
    { ...base, y: 2047 },
  ]) {
    assert.throws(() => h.world.roof(bad));
    assert.equal(h.compose().grid.calls().length, 0);
  }
  // 已去掉的 eave（决策 #61）：模型照旧写也必须报错，不能静默忽略。走 JSON 解析，模拟未经类型检查的代码。
  const stale: unknown = JSON.parse(
    '{"footprint":{"minX":-3,"minZ":-3,"maxX":3,"maxZ":3},"y":5,"kind":"gable","material":"stone","eave":1}',
  );
  assert.throws(() => h.world.roof(stale as Parameters<typeof h.world.roof>[0]), /eave/);
  assert.equal(h.compose().grid.calls().length, 0);
  h.world.roof({ ...base, ridge: 'z', kind: 'shed', pitch: 1, overhang: 0 });
  assert.equal(h.compose().grid.calls().length, 1);
});

test('单坡 roof.high：四向峰位、高侧不出檐、低侧出檐', () => {
  const cases = [
    { high: 'west', peak: [0, 9, 2], eave: { minX: 0, minZ: -1, maxX: 5, maxZ: 5 }, low: [5, 5, 2] },
    { high: 'east', peak: [4, 9, 2], eave: { minX: -1, minZ: -1, maxX: 4, maxZ: 5 }, low: [-1, 5, 2] },
    { high: 'north', peak: [2, 9, 0], eave: { minX: -1, minZ: 0, maxX: 5, maxZ: 5 }, low: [2, 5, 5] },
    { high: 'south', peak: [2, 9, 4], eave: { minX: -1, minZ: -1, maxX: 5, maxZ: 4 }, low: [2, 5, -1] },
  ] as const;
  for (const c of cases) {
    const h = createWorld(registry.table);
    const roof = h.world.roof({
      footprint: rect(0, 0, 4, 4),
      y: 5,
      kind: 'shed',
      high: c.high,
      pitch: 1,
      overhang: 1,
      material: 'deepslate_tiles',
    });
    assert.deepEqual(roof.peak, c.peak, `${c.high} 峰位`);
    assert.deepEqual(roof.eaveLine.footprint, { ...c.eave }, `${c.high} 檐线`);
    assert.equal(h.world.get(c.low[0], c.low[1], c.low[2]), 'deepslate_tiles', `${c.high} 低侧出檐`);
  }
});

test('单坡 roof.high 的山墙在高侧加两端，低侧不封', () => {
  const h = createWorld(registry.table);
  h.world.roof({
    footprint: rect(0, 0, 4, 4),
    y: 5,
    kind: 'shed',
    high: 'west',
    pitch: 1,
    overhang: 1,
    material: 'deepslate_tiles',
    gableMaterial: 'stone',
  });
  assert.equal(h.world.get(0, 6, 2), 'stone', '高侧山墙');
  assert.equal(h.world.get(2, 6, 0), 'stone', '两端山墙');
  assert.equal(h.world.get(4, 6, 2), 'air', '低侧不封山墙');
});

test('单坡 roof.high 坏样本：非 shed、与 ridge 同传，整次失败不留调用', () => {
  const h = createWorld(registry.table);
  const base = { footprint: rect(-3, -3, 3, 3), y: 5, material: 'stone' } as const;
  assert.throws(() => h.world.roof({ ...base, kind: 'gable', high: 'west' }), /roof\.high 只用于 kind:'shed'/);
  assert.throws(() => h.world.roof({ ...base, kind: 'hip', high: 'north' }), /只用于 kind:'shed'/);
  assert.throws(() => h.world.roof({ ...base, kind: 'shed', high: 'west', ridge: 'z' }), /二选一/);
  assert.equal(h.compose().grid.calls().length, 0);
});
