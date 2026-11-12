/**
 * fixture 几何自检：只验证 fixture 自己声明的几何，不依赖 design-conformance 的检查逻辑。
 *
 * 自检失败抛 FixtureError；矩阵把它归类为 unexpected（fixture bug / harness 错误），
 * 不能计入 prototype-gap。故意做错的样本由调用方跳过对应项目。
 */

import type { Grid } from '@pg/core/grid';
import type { Bounds, BuildSpec } from '@pg/interaction/schema';

export type SelfCheckSide = 'north' | 'east' | 'south' | 'west';

export interface SelfCheckRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface SelfCheckBlocks {
  readonly wall: string;
  readonly floor: string;
  readonly glass: string;
  readonly trim: string;
  readonly roof: string;
  readonly ground: string;
}

export interface SelfCheckOpening {
  readonly id: string;
  readonly kind: 'door' | 'window';
  readonly side: SelfCheckSide;
  readonly bounds: Bounds;
  /** 实际挖空体；good 样本等于 bounds，H3 wrong 故意多一格洞顶。 */
  readonly hole: Bounds;
  readonly sillHeight: number;
}

export interface SelfCheckInput {
  readonly house: string;
  readonly variant: string;
  readonly elevation: number;
  readonly rects: readonly SelfCheckRect[];
  readonly blocks: SelfCheckBlocks;
  readonly openings: readonly SelfCheckOpening[];
  /** H1/H2 wrong 故意做错屋面，跳过 eave/ridge / profile 反查。 */
  readonly roofMatchesSpec: boolean;
  /** H4 wrong 故意在窗外 1 格壳加遮挡；false 时跳过壳检查。 */
  readonly windowShellIntact?: boolean;
  /** H3 wrong 故意把门洞顶加高 1 格；false 时跳过 hole === bounds 检查。 */
  readonly doorHoleIntact?: boolean;
  /** fixture 期望的屋面顶面 y；用于逐列校验 profile。 */
  readonly roofTop: (x: number, z: number) => number;
}

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureError';
  }
}

function fixtureFail(message: string): never {
  throw new FixtureError(message);
}

function box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Bounds {
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function forEachCell(bounds: Bounds, visit: (x: number, y: number, z: number) => void): void {
  for (let x = bounds.min[0]; x < bounds.max[0]; x += 1) {
    for (let y = bounds.min[1]; y < bounds.max[1]; y += 1) {
      for (let z = bounds.min[2]; z < bounds.max[2]; z += 1) visit(x, y, z);
    }
  }
}

/** 窗外侧正好 1 格壳。 */
function shellOf(bounds: Bounds, side: SelfCheckSide): Bounds {
  switch (side) {
    case 'north':
      return box(bounds.min[0], bounds.min[1], bounds.min[2] - 1, bounds.max[0], bounds.max[1], bounds.min[2]);
    case 'south':
      return box(bounds.min[0], bounds.min[1], bounds.max[2], bounds.max[0], bounds.max[1], bounds.max[2] + 1);
    case 'west':
      return box(bounds.min[0] - 1, bounds.min[1], bounds.min[2], bounds.min[0], bounds.max[1], bounds.max[2]);
    case 'east':
      return box(bounds.max[0], bounds.min[1], bounds.min[2], bounds.max[0] + 1, bounds.max[1], bounds.max[2]);
  }
}

/** 门外侧 1 格 pad：与室内楼面同层，范围 [elevation-1, elevation)。 */
export function padBounds(opening: SelfCheckOpening, elevation: number): Bounds {
  const bounds = opening.bounds;
  switch (opening.side) {
    case 'north':
      return box(bounds.min[0], elevation - 1, bounds.min[2] - 1, bounds.max[0], elevation, bounds.min[2]);
    case 'south':
      return box(bounds.min[0], elevation - 1, bounds.max[2], bounds.max[0], elevation, bounds.max[2] + 1);
    case 'east':
      return box(bounds.max[0], elevation - 1, bounds.min[2], bounds.max[0] + 1, elevation, bounds.max[2]);
    case 'west':
      return box(bounds.min[0] - 1, elevation - 1, bounds.min[2], bounds.min[0], elevation, bounds.max[2]);
  }
}

function sameBounds(a: Bounds, b: Bounds): boolean {
  return (
    a.min[0] === b.min[0] &&
    a.min[1] === b.min[1] &&
    a.min[2] === b.min[2] &&
    a.max[0] === b.max[0] &&
    a.max[1] === b.max[1] &&
    a.max[2] === b.max[2]
  );
}

function boundsInside(inner: Bounds, outer: Bounds): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if ((inner.min[axis] ?? 0) < (outer.min[axis] ?? 0) || (inner.max[axis] ?? 0) > (outer.max[axis] ?? 0)) {
      return false;
    }
  }
  return true;
}

function footprintColumns(rects: readonly SelfCheckRect[]): Set<string> {
  const columns = new Set<string>();
  for (const item of rects) {
    for (let x = item.minX; x <= item.maxX; x += 1) {
      for (let z = item.minZ; z <= item.maxZ; z += 1) columns.add(`${String(x)},${String(z)}`);
    }
  }
  return columns;
}

export function assertFixtureGeometry(spec: BuildSpec, grid: Grid, input: SelfCheckInput): void {
  const label = `${input.house}/${input.variant}`;
  const actualBounds = grid.bounds();
  if (actualBounds === undefined) fixtureFail(`${label}: grid 为空`);
  for (let axis = 0; axis < 3; axis += 1) {
    const min = actualBounds.min[axis] ?? 0;
    const max = actualBounds.max[axis] ?? 0;
    if (min < (spec.siteBounds.min[axis] ?? 0) || max > (spec.siteBounds.max[axis] ?? 0) - 1) {
      fixtureFail(
        `${label}: grid bounds ${JSON.stringify(actualBounds)} 超出 siteBounds ${JSON.stringify(spec.siteBounds)}`,
      );
    }
  }
  // 当前矩阵 overhang=0：楼板 / 墙体 / 屋面不得超出 spec.bounds 的 x/z 范围。
  // 注意 spec.bounds 的 y 只到墙顶，楼板 y0 与屋面 y5..7 本来就在 y 范围外，因此只查水平 footprint；
  // 室外 pad 在 building 外侧，不属于这三类，不能用整张 grid.bounds 去卡。
  const structural = new Set([input.blocks.floor, input.blocks.wall, input.blocks.roof]);
  for (const cell of grid.cells()) {
    if (!structural.has(cell.state.name)) continue;
    if (
      cell.x < spec.bounds.min[0] ||
      cell.x > spec.bounds.max[0] - 1 ||
      cell.z < spec.bounds.min[2] ||
      cell.z > spec.bounds.max[2] - 1
    ) {
      fixtureFail(
        `${label}: ${cell.state.name} (${String(cell.x)},${String(cell.y)},${String(cell.z)}) 超出 spec.bounds ${JSON.stringify(spec.bounds)}（overhang 仅允许 0）`,
      );
    }
  }

  for (const item of input.rects) {
    for (let x = item.minX; x <= item.maxX; x += 1) {
      for (let z = item.minZ; z <= item.maxZ; z += 1) {
        const name = grid.get(x, input.elevation - 1, z)?.state.name;
        if (name !== input.blocks.floor) {
          fixtureFail(
            `${label}: 楼板 (${String(x)},${String(input.elevation - 1)},${String(z)}) 是 ${name ?? 'air'}，不是 ${input.blocks.floor}`,
          );
        }
      }
    }
  }

  for (const opening of input.openings) {
    if (opening.kind === 'door') {
      if (opening.sillHeight !== 0 || opening.bounds.min[1] !== input.elevation) {
        fixtureFail(
          `${label}: 门 ${opening.id} 洞底 ${String(opening.bounds.min[1])} / sillHeight ${String(opening.sillHeight)} 不符合 elevation ${String(input.elevation)}`,
        );
      }
      if (input.doorHoleIntact !== false && !sameBounds(opening.hole, opening.bounds)) {
        fixtureFail(
          `${label}: 门 ${opening.id} 实际挖空 ${JSON.stringify(opening.hole)} ≠ BuildSpec.bounds ${JSON.stringify(opening.bounds)}`,
        );
      }
      forEachCell(opening.hole, (x, y, z) => {
        const name = grid.get(x, y, z)?.state.name;
        if (name !== undefined) {
          fixtureFail(`${label}: 门 ${opening.id} 洞内 (${String(x)},${String(y)},${String(z)}) 不是 air：${name}`);
        }
      });
      const pad = padBounds(opening, input.elevation);
      if (!boundsInside(pad, spec.siteBounds)) {
        fixtureFail(`${label}: 门 ${opening.id} 室外 pad ${JSON.stringify(pad)} 超出 siteBounds`);
      }
      const scanTop = spec.siteBounds.max[1] - 1;
      const scanBottom = spec.siteBounds.min[1];
      for (let x = pad.min[0]; x < pad.max[0]; x += 1) {
        for (let z = pad.min[2]; z < pad.max[2]; z += 1) {
          let top: number | null = null;
          for (let y = scanTop; y >= scanBottom; y -= 1) {
            if (grid.get(x, y, z) !== undefined) {
              top = y;
              break;
            }
          }
          if (top !== input.elevation - 1) {
            fixtureFail(
              `${label}: 门 ${opening.id} 室外 pad (${String(x)},${String(z)}) 顶面 y=${String(top ?? '无')} ≠ 室内楼面 y=${String(input.elevation - 1)}`,
            );
          }
          if (grid.get(x, top, z)?.state.name !== input.blocks.ground) {
            fixtureFail(`${label}: 门 ${opening.id} 室外 pad (${String(x)},${String(z)}) 不是 ${input.blocks.ground}`);
          }
        }
      }
      continue;
    }
    forEachCell(opening.bounds, (x, y, z) => {
      const name = grid.get(x, y, z)?.state.name;
      if (name !== input.blocks.glass) {
        fixtureFail(
          `${label}: 窗 ${opening.id} bounds 内 (${String(x)},${String(y)},${String(z)}) 是 ${name ?? 'air'}，不是玻璃 ${input.blocks.glass}`,
        );
      }
    });
    // H4 wrong 故意在窗外 1 格壳加遮挡：该样本跳过壳检查，让 conformance 自己判遮挡。
    if (input.windowShellIntact === false) continue;
    forEachCell(shellOf(opening.bounds, opening.side), (x, y, z) => {
      const name = grid.get(x, y, z)?.state.name;
      if (name !== undefined && name !== input.blocks.glass && name !== input.blocks.trim) {
        fixtureFail(`${label}: 窗 ${opening.id} 外侧 1 格壳 (${String(x)},${String(y)},${String(z)}) 被 ${name} 遮挡`);
      }
    });
  }

  if (!input.roofMatchesSpec) return;
  const footprint = footprintColumns(input.rects);
  const tops = new Map<string, number>();
  for (const cell of grid.cells()) {
    if (cell.state.name !== input.blocks.roof) continue;
    const key = `${String(cell.x)},${String(cell.z)}`;
    tops.set(key, Math.max(tops.get(key) ?? -Infinity, cell.y));
  }
  if (tops.size === 0) fixtureFail(`${label}: 找不到屋面块 ${input.blocks.roof}`);
  for (const key of footprint) {
    if (!tops.has(key)) fixtureFail(`${label}: footprint 列 ${key} 缺屋面块`);
  }
  for (const key of tops.keys()) {
    if (!footprint.has(key)) fixtureFail(`${label}: 屋面块出现在 footprint 外的列 ${key}`);
  }
  for (const key of footprint) {
    const [xText, zText] = key.split(',');
    const expected = input.roofTop(Number(xText), Number(zText));
    const actual = tops.get(key);
    if (actual !== expected) {
      fixtureFail(`${label}: footprint 列 ${key} 屋面顶面 y=${String(actual ?? '无')} ≠ 预期 y=${String(expected)}`);
    }
  }
  const heights = [...tops.values()];
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  if (min !== spec.roof.eaveHeight || max !== spec.roof.ridgeHeight) {
    fixtureFail(
      `${label}: 屋面顶面 y${String(min)}..${String(max)} ≠ spec eave/ridge ${String(spec.roof.eaveHeight)}/${String(spec.roof.ridgeHeight)}`,
    );
  }
}
