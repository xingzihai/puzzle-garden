/**
 * 体素化内核的格集容器与填充 / 清理工具（MASSING-CONVERSION-SPEC §3.2、§8）。
 *
 * 负责：格坐标到安全整数键的混合基打包、CellStore（键 → 扁平坐标数组）、去重加入与单次导入上限拦阻、
 * 6 邻接膨胀、solid 的 6 邻接洪水填内部（含 leaky 判定）、文档并集上的单趟孤立格识别。
 * 不负责：三角求交与共面特判（voxelize.ts）、选项与输出结构（voxelize.ts）、I/O。
 */
import { ABS_MAX } from './schema.ts';
import { VoxelizeError } from './voxelize-error.ts';

/** 单次导入格数上限（§8）：v0.2 最大交付约 44.9 万格，50 万作安全阀。 */
export const MAX_IMPORT_CELLS = 500000;

/** 混合基打包的偏移与基数：两侧各留 16 格余量给膨胀 / 洪水外扩 / 边界外扩，避免低位借位串到邻近轴。 */
const CELL_OFFSET = ABS_MAX + 16;
const CELL_BASE = 2 * CELL_OFFSET + 1;
const CELL_BASE2 = CELL_BASE * CELL_BASE;
const DELTA_X = CELL_BASE2;
const DELTA_Y = CELL_BASE;
/** 6 邻接的键增量（±x / ±y / ±z）。 */
const NEIGHBOR_DELTAS: readonly number[] = [DELTA_X, -DELTA_X, DELTA_Y, -DELTA_Y, 1, -1];

/** 格坐标 → 安全整数键。 */
function packCell(x: number, y: number, z: number): number {
  return (x + CELL_OFFSET) * CELL_BASE2 + (y + CELL_OFFSET) * CELL_BASE + (z + CELL_OFFSET);
}

/** 把 -0 规范成 0；输出格与包围盒都过它。 */
function clean(value: number): number {
  return value === 0 ? 0 : value;
}

/** 一个部件的格集：`index` 键 → `coords` 三元组扁平数组的下标。 */
export interface CellStore {
  readonly index: Map<number, number>;
  readonly coords: number[];
}

/** 空格集。 */
export function createCellStore(): CellStore {
  return { index: new Map<number, number>(), coords: [] };
}

/** 取格坐标三元组；键必须已在格集里。 */
export function coordsOf(store: CellStore, key: number): readonly [number, number, number] {
  const offset = store.index.get(key);
  if (offset === undefined) throw new Error('voxelize：内部不变量失败，键不在格集里');
  return [store.coords[offset] ?? 0, store.coords[offset + 1] ?? 0, store.coords[offset + 2] ?? 0];
}

/** 加入一个格；重复忽略，超上限抛 limit-exceeded（§8，边算边拦避免病态输入拖死）。 */
export function addCell(store: CellStore, x: number, y: number, z: number): void {
  const key = packCell(x, y, z);
  if (store.index.has(key)) return;
  const cx = clean(x);
  const cy = clean(y);
  const cz = clean(z);
  if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cy) || !Number.isSafeInteger(cz)) {
    throw new Error('voxelize：内部不变量失败，格坐标不是安全整数');
  }
  store.index.set(key, store.coords.length);
  store.coords.push(cx, cy, cz);
  if (store.index.size > MAX_IMPORT_CELLS) {
    throw new VoxelizeError(
      'limit-exceeded',
      `导入 ${String(store.index.size)} 格超过单次上限 ${String(MAX_IMPORT_CELLS)}；请减少采样段数、拆分部件或分次导入`,
    );
  }
}

/** 从 positions / indices 里安全取数；越界是内部不变量错误（schema 已校验）。 */
export function numberAt(values: readonly number[], index: number, what: string): number {
  const value = values[index];
  if (value === undefined) throw new Error(`voxelize：内部不变量失败，${what} 缺少下标 ${String(index)}`);
  return value;
}

/** 6 邻接膨胀 `rounds` 圈（shell 的 thickness−1）。 */
export function dilate(store: CellStore, rounds: number): CellStore {
  let current = store;
  for (let round = 0; round < rounds; round += 1) {
    const next: CellStore = { index: new Map(current.index), coords: [...current.coords] };
    for (const key of current.index.keys()) {
      const [x, y, z] = coordsOf(current, key);
      addCell(next, x + 1, y, z);
      addCell(next, x - 1, y, z);
      addCell(next, x, y + 1, z);
      addCell(next, x, y - 1, z);
      addCell(next, x, y, z + 1);
      addCell(next, x, y, z - 1);
    }
    current = next;
  }
  return current;
}

interface PartBounds {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/** 由格集 coords 求闭区间包围盒；空格返回 null。 */
function storeBounds(store: CellStore): PartBounds | null {
  if (store.coords.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < store.coords.length; i += 3) {
    const x = store.coords[i] ?? 0;
    const y = store.coords[i + 1] ?? 0;
    const z = store.coords[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/**
 * solid 填充：从壳包围盒外扩 1 格的边界格出发、穿过非壳格做 6 邻接洪水。
 * 洪水到达包围盒内空格 → 非闭合壳，标 leaky 且不填；否则包围盒内未到达的空格是内部，与壳合并（§3.2）。
 */
export function fillSolid(shell: CellStore): { readonly store: CellStore; readonly leaky: boolean } {
  const bounds = storeBounds(shell);
  if (bounds === null) return { store: shell, leaky: false };
  const ex0 = bounds.minX - 1;
  const ex1 = bounds.maxX + 1;
  const ey0 = bounds.minY - 1;
  const ey1 = bounds.maxY + 1;
  const ez0 = bounds.minZ - 1;
  const ez1 = bounds.maxZ + 1;
  const inside = (x: number, y: number, z: number): boolean =>
    x >= bounds.minX &&
    x <= bounds.maxX &&
    y >= bounds.minY &&
    y <= bounds.maxY &&
    z >= bounds.minZ &&
    z <= bounds.maxZ;
  const visited = new Set<number>();
  // 队列存扁平 xyz 而不是键：键无法可靠反解回坐标（大整数除法在边界会舍入）。
  const queue: number[] = [];
  const seed = (x: number, y: number, z: number): void => {
    const key = packCell(x, y, z);
    if (shell.index.has(key) || visited.has(key)) return;
    visited.add(key);
    queue.push(x, y, z);
  };
  // 6 个面全部播种；只播种一个角无法覆盖与它不连通的“外部”分量。
  for (let y = ey0; y <= ey1; y += 1) {
    for (let z = ez0; z <= ez1; z += 1) {
      seed(ex0, y, z);
      seed(ex1, y, z);
    }
  }
  for (let x = ex0; x <= ex1; x += 1) {
    for (let z = ez0; z <= ez1; z += 1) {
      seed(x, ey0, z);
      seed(x, ey1, z);
    }
  }
  for (let x = ex0; x <= ex1; x += 1) {
    for (let y = ey0; y <= ey1; y += 1) {
      seed(x, y, ez0);
      seed(x, y, ez1);
    }
  }
  const deltas: readonly (readonly [number, number, number])[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (let head = 0; head < queue.length; head += 3) {
    const x = queue[head] ?? 0;
    const y = queue[head + 1] ?? 0;
    const z = queue[head + 2] ?? 0;
    if (inside(x, y, z)) return { store: shell, leaky: true };
    for (const [dx, dy, dz] of deltas) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (nx < ex0 || nx > ex1 || ny < ey0 || ny > ey1 || nz < ez0 || nz > ez1) continue;
      seed(nx, ny, nz);
    }
  }
  // 无泄漏：包围盒内非壳且未到达的空格是内部。
  const filled: CellStore = { index: new Map(shell.index), coords: [...shell.coords] };
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
        const key = packCell(x, y, z);
        if (shell.index.has(key) || visited.has(key)) continue;
        addCell(filled, x, y, z);
      }
    }
  }
  return { store: filled, leaky: false };
}

/** 在全文档格集并集上找孤立格：6 邻接里没有任何其它保留格。单趟、不级联（§3.2）。 */
export function findIsolated(union: ReadonlySet<number>): ReadonlySet<number> {
  const isolated = new Set<number>();
  for (const key of union) {
    let connected = false;
    for (const delta of NEIGHBOR_DELTAS) {
      if (union.has(key + delta)) {
        connected = true;
        break;
      }
    }
    if (!connected) isolated.add(key);
  }
  return isolated;
}
