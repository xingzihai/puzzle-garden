/**
 * @pg/modeling 体素化内核基准（MASSING-CONVERSION-SPEC §8）：内存合成夹具，不读文件。
 *
 * 覆盖：整数对齐盒 50 万格（solid 洪水 + 内部填充）、旋转圆锥壳（非共面 SAT）、六角屋面（共面 2D 判据），
 * 以及 40 万三角 + 约 50 万格的混合文档（12 个 128² 曲面片 + 一个 solid 体量），对齐 §8 的参考口径。
 */
import { createModel } from './model.ts';
import { voxelize } from './voxelize.ts';
import type { VoxelResult } from './voxelize.ts';

function base(id: string) {
  return { id, name: id, role: 'volume' as const, color: '#123456' };
}

/** 100×50×100 = 50 万格，恰在 MAX_IMPORT_CELLS 上。 */
function limitBoxDocument() {
  const model = createModel();
  model.box({ ...base('hall'), size: [100, 50, 100] });
  return model.finish();
}

function coneDocument() {
  const model = createModel();
  model.revolve({
    ...base('cone'),
    role: 'roof',
    profile: (t) => [20 * t, 20 * t],
    profileSegments: 128,
    radialSegments: 128,
  });
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

function hexDocument() {
  const model = createModel();
  model.extrude({ ...base('hex'), role: 'roof', outline: HEX_OUTLINE, height: 2 });
  return model.finish();
}

/** 12 个 128×128 曲面片（共 393,216 三角）+ 300,000 格 solid 体量，总格数 ~49.7 万（≤ 上限）。 */
function mixedDocument() {
  const model = createModel();
  model.box({ ...base('body'), size: [100, 50, 60] });
  for (let index = 0; index < 12; index += 1) {
    const x0 = 200 + index * 130;
    model.surface({
      ...base(`roof${String(index)}`),
      role: 'roof',
      uSegments: 128,
      vSegments: 128,
      position: (u, v) => [x0 + u * 128, 100, v * 128],
    });
  }
  return model.finish();
}

const limitBox = limitBoxDocument();
const cone = coneDocument();
const hex = hexDocument();
const mixed = mixedDocument();

export default [
  {
    name: 'voxelize/整数对齐盒 50 万格 (solid)',
    run: (): VoxelResult => voxelize(limitBox, { mode: 'solid' }),
    warmup: 1,
    iterations: 3,
  },
  { name: 'voxelize/旋转圆锥壳 128×128 (shell)', run: (): VoxelResult => voxelize(cone), warmup: 1, iterations: 5 },
  { name: 'voxelize/六角屋面 (shell)', run: (): VoxelResult => voxelize(hex), warmup: 1, iterations: 5 },
  {
    name: 'voxelize/混合 40 万三角 + 50 万格 (shell+solid)',
    run: (): VoxelResult => voxelize(mixed),
    warmup: 1,
    iterations: 3,
  },
];
