/** mesh.ts：剔除、盒子、AO、亮度、顶点色与确定性（RENDER-SPEC §6.2、§7、§12 第 3 条）。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import fc from 'fast-check';
import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';

import { countFaces, meshScene, parseScene, PAINT } from './mesh.ts';
import type { MeshResult, PaletteEntry, ParsedScene, SceneCell } from './mesh.ts';
import { buildScene } from './scene-buffer.ts';

interface Spec {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly paint: number;
  readonly params?: readonly [number, number, number] | readonly [number, number, number, number];
  readonly rgb?: readonly [number, number, number];
}

function scene(specs: readonly Spec[]): ParsedScene {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const s of specs) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    minZ = Math.min(minZ, s.z);
    maxX = Math.max(maxX, s.x);
    maxY = Math.max(maxY, s.y);
    maxZ = Math.max(maxZ, s.z);
  }
  const palette: PaletteEntry[] = [];
  const indexByKey = new Map<string, number>();
  const cells: SceneCell[] = [];
  for (const s of specs) {
    const raw = s.params ?? [0, 0, 0, 0];
    const params: [number, number, number, number] = [raw[0], raw[1], raw[2], raw[3] ?? 0];
    const rgb = s.rgb ?? [255, 255, 255];
    const key = `${String(s.paint)},${params.join(',')},${rgb.join(',')}`;
    let index = indexByKey.get(key);
    if (index === undefined) {
      index = palette.length;
      indexByKey.set(key, index);
      palette.push({ paint: s.paint, params, rgb, model: 0 });
    }
    cells.push({ dx: s.x - minX, dy: s.y - minY, dz: s.z - minZ, palette: index });
  }
  cells.sort((a, b) => a.dy - b.dy || a.dz - b.dz || a.dx - b.dx);
  return {
    origin: [minX, minY, minZ],
    size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1],
    palette,
    cells,
    cellCount: cells.length,
    paletteCount: palette.length,
    version: 1,
  };
}

function cube(x: number, y: number, z: number, rgb?: readonly [number, number, number]): Spec {
  return rgb === undefined ? { x, y, z, paint: PAINT.cube } : { x, y, z, paint: PAINT.cube, rgb };
}

test('mesh.ts 只 import mesh-parts（无 Node / 包依赖），mesh-parts 零 import（RENDER-SPEC §12 第 1 条）', () => {
  const source = readFileSync(new URL('./mesh.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['./mesh-parts.ts']);
  const parts = readFileSync(new URL('./mesh-parts.ts', import.meta.url), 'utf8');
  assert.equal(/^\s*import\s/m.test(parts), false, 'mesh-parts.ts 不应有任何 import');
  assert.equal(/^\s*export\s[^;]*\sfrom\s/m.test(parts), false, 'mesh-parts.ts 不应有 re-export from');
});

test('单格 cube：y ≥ 2 六面；y = 1 底面因地面剔除为 5 面', () => {
  assert.equal(meshScene(scene([cube(0, 5, 0)])).faces, 6);
  assert.equal(meshScene(scene([cube(0, 1, 0)])).faces, 5);
});

test('两格相邻 10 面；3×3×3 实心悬空 54 面', () => {
  assert.equal(meshScene(scene([cube(0, 5, 0), cube(1, 5, 0)])).faces, 10);
  const solid: Spec[] = [];
  for (let x = 0; x < 3; x += 1)
    for (let y = 2; y < 5; y += 1) for (let z = 0; z < 3; z += 1) solid.push(cube(x, y, z));
  assert.equal(meshScene(scene(solid)).faces, 54);
});

test('玻璃夹在两个 cube 间：玻璃朝 cube 的面剔除，cube 朝玻璃的面保留', () => {
  const s = scene([cube(-1, 5, 0), { x: 0, y: 5, z: 0, paint: PAINT.glass }, cube(1, 5, 0)]);
  // 玻璃只剩 4 面；两个 cube 各 6 面（朝玻璃的面保留）→ 16。
  assert.equal(meshScene(s).faces, 16);
});

test('红蓝两块染色玻璃相邻时互相剔除；水挨水剔除', () => {
  assert.equal(
    meshScene(
      scene([
        { x: 0, y: 5, z: 0, paint: PAINT.glass, rgb: [255, 0, 0] },
        { x: 1, y: 5, z: 0, paint: PAINT.glass, rgb: [0, 0, 255] },
      ]),
    ).faces,
    10,
  );
  assert.equal(
    meshScene(
      scene([
        { x: 0, y: 5, z: 0, paint: PAINT.fluid },
        { x: 1, y: 5, z: 0, paint: PAINT.fluid },
      ]),
    ).faces,
    10,
  );
});

test('台阶相邻 cube：只剔除台阶落在格边界上的那个面', () => {
  const stairs = (): Spec => ({ x: 0, y: 5, z: 0, paint: PAINT.stairs, params: [0, 0, 0] });
  assert.equal(meshScene(scene([stairs()])).faces, 12);
  // 南侧 cube：台阶底板 +z 那面被剔除，台阶 12 → 11，加 cube 6 → 17。
  assert.equal(meshScene(scene([stairs(), cube(0, 5, 1)])).faces, 17);
});

/** 顶点 (x,y,z) 是否落在给定小盒里。 */
function hasVertex(mesh: MeshResult, box: readonly [number, number, number, number, number, number]): boolean {
  const p = mesh.opaque.positions;
  for (let i = 0; i < p.length; i += 3) {
    if (
      (p[i] ?? 0) >= box[0] &&
      (p[i] ?? 0) <= box[3] &&
      (p[i + 1] ?? 0) >= box[1] &&
      (p[i + 1] ?? 0) <= box[4] &&
      (p[i + 2] ?? 0) >= box[2] &&
      (p[i + 2] ?? 0) <= box[5]
    ) {
      return true;
    }
  }
  return false;
}

test('栅栏旁有 cube 画臂、空气不画、四个方向臂坐标按 §6.2 变换', () => {
  const fence: Spec = { x: 0, y: 5, z: 0, paint: PAINT.fence };
  const alone = meshScene(scene([fence]));
  assert.equal(hasVertex(alone, [6 / 16, 5, 0, 10 / 16, 6, 0]), false); // 没臂
  assert.equal(hasVertex(alone, [6 / 16, 5, 6 / 16, 10 / 16, 6, 10 / 16]), true); // 柱子在
  // 北臂横杆 [7,6,0,9,9,6]，世界 y = 5 + 6/16 … 5 + 9/16。
  const rail = (
    x0: number,
    x1: number,
    z0: number,
    z1: number,
  ): readonly [number, number, number, number, number, number] => [x0, 5 + 6 / 16, z0, x1, 5 + 9 / 16, z1];
  assert.equal(hasVertex(meshScene(scene([fence, cube(0, 5, -1)])), rail(7 / 16, 9 / 16, 0, 0)), true);
  assert.equal(hasVertex(meshScene(scene([fence, cube(0, 5, 1)])), rail(7 / 16, 9 / 16, 1, 1)), true);
  assert.equal(hasVertex(meshScene(scene([fence, cube(-1, 5, 0)])), rail(0, 0, 7 / 16, 9 / 16)), true);
  assert.equal(hasVertex(meshScene(scene([fence, cube(1, 5, 0)])), rail(1, 1, 7 / 16, 9 / 16)), true);
  // slab 不在连接集合里，不画臂。
  assert.equal(
    hasVertex(meshScene(scene([fence, { x: 0, y: 5, z: -1, paint: PAINT.slab }])), rail(7 / 16, 9 / 16, 0, 0)),
    false,
  );
});

/** 顶面（+y）四个顶点的 AO 颜色：a00、a10、a11、a01，顶点下标 8–11。 */
function topFaceColors(specs: readonly Spec[]): number[] {
  const colors = meshScene(scene(specs)).opaque.colors;
  return [0, 1, 2, 3].map((k) => colors[(8 + k) * 3] ?? -1);
}

test('AO 四级各一例，含 s1、s2 都遮挡而 c 不遮挡 → 3 级', () => {
  const base = cube(0, 5, 0);
  assert.deepEqual(topFaceColors([base]), [255, 255, 255, 255]); // 0 级
  assert.deepEqual(topFaceColors([base, cube(-1, 6, 0)]), [217, 255, 255, 217]); // 1 级
  assert.deepEqual(topFaceColors([base, cube(-1, 6, 0), cube(-1, 6, -1)]), [179, 255, 255, 217]); // 2 级（s1+c）
  assert.deepEqual(topFaceColors([base, cube(-1, 6, 0), cube(0, 6, -1)]), [140, 217, 255, 217]); // 3 级（s1&s2，c=0）
});

test('a00 + a11 < a01 + a10 时换对角线', () => {
  const base = cube(0, 5, 0);
  const flat = meshScene(scene([base]));
  assert.deepEqual(Array.from(flat.opaque.indices.slice(12, 18)), [8, 9, 10, 8, 10, 11]);
  // NE 与 SW 遮挡：a00=0、a11=0、a10=1、a01=1 → 换 (00,10,01)、(10,11,01)。
  const swapped = meshScene(scene([base, cube(1, 6, -1), cube(-1, 6, 1)]));
  assert.deepEqual(Array.from(swapped.opaque.indices.slice(12, 18)), [8, 9, 11, 9, 10, 11]);
});

test('顶点色 = round(rgb × 面亮度 × AO) 的具体数值', () => {
  const mesh = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.cube, rgb: [200, 100, 50] }]));
  const face = (index: number): number[] => Array.from(mesh.opaque.colors.slice(index * 12, index * 12 + 3));
  assert.deepEqual(face(0), [160, 80, 40]); // +x 0.80
  assert.deepEqual(face(2), [200, 100, 50]); // +y 1.00
  assert.deepEqual(face(3), [100, 50, 25]); // −y 0.50
  assert.deepEqual(face(4), [130, 65, 33]); // +z 0.65（32.5 → 33）
});

test('countFaces 等于生成缓冲的面数；同输入两次缓冲 sha256 相同', () => {
  const registry = loadRegistry();
  const table = registry.table;
  const grid = createGrid(table);
  for (let x = 0; x < 4; x += 1)
    for (let y = 1; y < 4; y += 1)
      for (let z = 0; z < 3; z += 1) {
        grid.set(x, y, z, parseState(table, z === 1 ? 'glass' : 'stone'), 0, 0);
      }
  const built = buildScene(grid, registry, 1_000_000);
  assert.equal(built.kind, 'ok');
  const parsed = parseScene(built.buffer);
  const mesh = meshScene(parsed);
  assert.equal(countFaces(built.buffer), mesh.faces);
  const second = buildScene(grid, registry, 1_000_000);
  assert.equal(second.kind, 'ok');
  const hash = (b: Uint8Array): string => createHash('sha256').update(Buffer.from(b)).digest('hex');
  assert.equal(hash(built.buffer), hash(second.buffer));
});

/** 不透明面所有顶点的包围盒（用于检查薄板厚度 / 家具尺寸）。 */
function extents(mesh: MeshResult): readonly [number, number, number, number, number, number] {
  const p = mesh.opaque.positions;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i] ?? 0);
    minY = Math.min(minY, p[i + 1] ?? 0);
    minZ = Math.min(minZ, p[i + 2] ?? 0);
    maxX = Math.max(maxX, p[i] ?? 0);
    maxY = Math.max(maxY, p[i + 1] ?? 0);
    maxZ = Math.max(maxZ, p[i + 2] ?? 0);
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

function faceRedColors(mesh: MeshResult): readonly number[] {
  return [0, 1, 2, 3, 4, 5].map((face) => mesh.opaque.colors[face * 12] ?? -1);
}

test('门：关闭贴 facing 边；打开按 hinge 转到相邻边；上半与下半共享连续门板', () => {
  const north = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.door, params: [0, 0, 0, 0] }]));
  assert.equal(north.faces, 6);
  assert.deepEqual(extents(north), [0, 5, 0, 1, 6, 3 / 16]);
  const south = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.door, params: [2, 1, 0, 0] }]));
  assert.deepEqual(extents(south), [0, 5, 13 / 16, 1, 6, 1]);
  // 北门 hinge=left：门板转到东侧；hinge=right：转到西侧。
  const left = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.door, params: [0, 0, 0, 1] }]));
  assert.deepEqual(extents(left), [13 / 16, 5, 0, 1, 6, 1]);
  const right = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.door, params: [0, 0, 1, 1] }]));
  assert.deepEqual(extents(right), [0, 5, 0, 3 / 16, 6, 1]);
  // 东门左侧为南，西门左侧为北。
  const eastLeft = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.door, params: [1, 0, 0, 1] }]));
  assert.deepEqual(extents(eastLeft), [0, 5, 13 / 16, 1, 6, 1]);
  const westLeft = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.door, params: [3, 0, 0, 1] }]));
  assert.deepEqual(extents(westLeft), [0, 5, 0, 1, 6, 3 / 16]);
});

test('活板门：关闭时 3/16 水平板（上/下半），打开时贴 facing 边', () => {
  const bottom = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.trapdoor, params: [0, 0, 0, 0] }]));
  assert.deepEqual(extents(bottom), [0, 5, 0, 1, 5 + 3 / 16, 1]);
  const top = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.trapdoor, params: [0, 1, 0, 0] }]));
  assert.deepEqual(extents(top), [0, 5 + 13 / 16, 0, 1, 6, 1]);
  const open = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.trapdoor, params: [2, 0, 0, 1] }]));
  assert.deepEqual(extents(open), [0, 5, 13 / 16, 1, 6, 1]);
});

test('栅栏门：关闭时横跨 facing 轴，打开时转 90°，都有竖柱', () => {
  const closed = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.fence_gate, params: [0, 0, 0, 0] }]));
  assert.equal(closed.faces, 24);
  assert.equal(hasVertex(closed, [0, 5, 6 / 16, 3 / 16, 6, 10 / 16]), true);
  assert.equal(hasVertex(closed, [6 / 16, 5, 0, 10 / 16, 6, 3 / 16]), false);
  const open = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.fence_gate, params: [0, 0, 0, 1] }]));
  assert.equal(open.faces, 24);
  assert.equal(hasVertex(open, [6 / 16, 5, 0, 10 / 16, 6, 3 / 16]), true);
  assert.equal(hasVertex(open, [0, 5, 6 / 16, 3 / 16, 6, 10 / 16]), false);
});

test('地毯 / 压力板：约 1/16 高的薄板', () => {
  const carpet = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.carpet }]));
  assert.equal(carpet.faces, 6);
  assert.deepEqual(extents(carpet), [0, 5, 0, 1, 5 + 1 / 16, 1]);
  const plate = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.pressure_plate }]));
  assert.equal(plate.faces, 6);
  assert.deepEqual(extents(plate), [1 / 16, 5, 1 / 16, 15 / 16, 5 + 1 / 16, 15 / 16]);
});

test('按钮：floor / ceiling 是 2/16 小块，wall 贴 facing 边', () => {
  const wall = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.button, params: [1, 0, 0, 0] }]));
  assert.deepEqual(extents(wall), [5 / 16, 5 + 5 / 16, 0, 11 / 16, 5 + 11 / 16, 3 / 16]);
  const floor = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.button, params: [0, 0, 0, 0] }]));
  assert.deepEqual(extents(floor), [6 / 16, 5, 5 / 16, 10 / 16, 5 + 2 / 16, 11 / 16]);
  const floorEast = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.button, params: [0, 1, 0, 0] }]));
  assert.deepEqual(extents(floorEast), [5 / 16, 5, 6 / 16, 11 / 16, 5 + 2 / 16, 10 / 16]);
  const ceiling = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.button, params: [2, 0, 0, 0] }]));
  assert.deepEqual(extents(ceiling), [6 / 16, 5 + 14 / 16, 5 / 16, 10 / 16, 6, 11 / 16]);
});

test('植物：两张交叉薄板，不再是小方块', () => {
  const plant = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.plant, params: [0, 12, 0, 0] }]));
  assert.equal(plant.faces, 12);
  assert.deepEqual(extents(plant), [0, 5, 0, 1, 5 + 12 / 16, 1]);
  assert.equal(hasVertex(plant, [7 / 16, 5, 0, 9 / 16, 5 + 12 / 16, 0]), true);
  assert.equal(hasVertex(plant, [0, 5, 7 / 16, 0, 5 + 12 / 16, 9 / 16]), true);
});

test('告示牌：站立有立柱和薄板，贴墙只留贴边薄板', () => {
  const standing = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.sign, params: [0, 0, 0, 0] }]));
  assert.equal(standing.faces, 18);
  assert.deepEqual(extents(standing), [1 / 16, 5, 7 / 16, 15 / 16, 5 + 14 / 16, 9 / 16]);
  const rotated = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.sign, params: [0, 1, 0, 0] }]));
  assert.deepEqual(extents(rotated), [7 / 16, 5, 1 / 16, 9 / 16, 5 + 14 / 16, 15 / 16]);
  const wall = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.sign, params: [1, 0, 0, 0] }]));
  assert.equal(wall.faces, 6);
  assert.deepEqual(extents(wall), [1 / 16, 5 + 6 / 16, 0, 15 / 16, 5 + 14 / 16, 2 / 16]);
});

test('箱子：14×14×14 近似盒 + 朝向锁扣', () => {
  const north = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.chest, params: [0, 0, 0, 0] }]));
  assert.equal(north.faces, 12);
  assert.deepEqual(extents(north), [1 / 16, 5, 0, 15 / 16, 5 + 14 / 16, 15 / 16]);
  assert.equal(hasVertex(north, [7 / 16, 5 + 7 / 16, 0, 9 / 16, 5 + 9 / 16, 1 / 16]), true);
  const south = meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.chest, params: [2, 0, 0, 0] }]));
  assert.deepEqual(extents(south), [1 / 16, 5, 1 / 16, 15 / 16, 5 + 14 / 16, 1]);
});

test('轴向方块：端面比侧面亮/暗，轴方向由 params[0] 决定；与 cube 互相剔除', () => {
  const yAxis = meshScene(
    scene([{ x: 0, y: 5, z: 0, paint: PAINT.axis_cube, params: [0, 0, 0, 0], rgb: [100, 100, 100] }]),
  );
  const yColors = faceRedColors(yAxis);
  assert.equal(yColors[2], 118); // +y 端面
  assert.equal(yColors[0], 80); // +x 侧面
  assert.equal(yColors[3], 41); // −y 端面
  const xAxis = meshScene(
    scene([{ x: 0, y: 5, z: 0, paint: PAINT.axis_cube, params: [1, 0, 0, 0], rgb: [100, 100, 100] }]),
  );
  const xColors = faceRedColors(xAxis);
  assert.equal(xColors[0], 94); // +x 端面
  assert.equal(xColors[2], 100); // +y 侧面
  assert.equal(xColors[1], 66); // −x 端面
  const zAxis = meshScene(
    scene([{ x: 0, y: 5, z: 0, paint: PAINT.axis_cube, params: [2, 0, 0, 0], rgb: [100, 100, 100] }]),
  );
  const zColors = faceRedColors(zAxis);
  assert.equal(zColors[4], 77); // +z 端面
  assert.equal(zColors[2], 100); // +y 侧面
  assert.equal(zColors[5], 53); // −z 端面
  assert.equal(meshScene(scene([{ x: 0, y: 5, z: 0, paint: PAINT.axis_cube }, cube(1, 5, 0)])).faces, 10);
});

test('楼梯转角：straight / outer 为两个盒子，inner 为三个盒子（近似 L 形）', () => {
  const stairs = (shape: number): Spec => ({ x: 0, y: 5, z: 0, paint: PAINT.stairs, params: [0, 0, shape, 0] });
  assert.equal(meshScene(scene([stairs(0)])).faces, 12);
  assert.equal(meshScene(scene([stairs(1)])).faces, 12);
  assert.equal(meshScene(scene([stairs(2)])).faces, 12);
  assert.equal(meshScene(scene([stairs(3)])).faces, 18);
  assert.equal(meshScene(scene([stairs(4)])).faces, 18);
  // 北向 outer_left 的 1/4 上层在西北角；inner_left 是 3/4，缺东北角。
  const outerLeft = meshScene(scene([stairs(1)]));
  assert.equal(hasVertex(outerLeft, [0, 6, 0, 7 / 16, 6, 7 / 16]), true);
  assert.equal(hasVertex(outerLeft, [9 / 16, 6, 0, 1, 6, 7 / 16]), false);
  assert.equal(hasVertex(outerLeft, [0, 6, 9 / 16, 1, 6, 1]), false);
  const innerLeft = meshScene(scene([stairs(3)]));
  assert.equal(hasVertex(innerLeft, [0, 6, 0, 7 / 16, 6, 7 / 16]), true);
  assert.equal(hasVertex(innerLeft, [9 / 16, 6, 0, 1, 6, 7 / 16]), false);
  assert.equal(hasVertex(innerLeft, [0, 6, 9 / 16, 1, 6, 1]), true);
  const innerRight = meshScene(scene([stairs(4)]));
  assert.equal(hasVertex(innerRight, [0, 6, 0, 7 / 16, 6, 7 / 16]), false);
  assert.equal(hasVertex(innerRight, [9 / 16, 6, 0, 1, 6, 7 / 16]), true);
});

test('fast-check：只含 cube、全部 y ≥ 2 的随机格集合，面数 = 6n − 2×相邻对数', () => {
  const coord = fc.tuple(
    fc.integer({ min: -4, max: 4 }),
    fc.integer({ min: 2, max: 6 }),
    fc.integer({ min: -4, max: 4 }),
  );
  const coords = fc.uniqueArray(coord, {
    maxLength: 24,
    selector: (p) => `${String(p[0])},${String(p[1])},${String(p[2])}`,
  });
  fc.assert(
    fc.property(coords, (points) => {
      if (points.length === 0) return;
      let adjacent = 0;
      for (let i = 0; i < points.length; i += 1) {
        for (let j = i + 1; j < points.length; j += 1) {
          const a = points[i];
          const b = points[j];
          if (a === undefined || b === undefined) continue;
          if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) === 1) adjacent += 1;
        }
      }
      const specs = points.map((p) => cube(p[0], p[1], p[2]));
      assert.equal(meshScene(scene(specs)).faces, 6 * points.length - 2 * adjacent);
    }),
  );
});
