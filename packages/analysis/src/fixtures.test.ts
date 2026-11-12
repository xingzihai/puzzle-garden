/**
 * 测试共用：手工构造小网格。
 * 以 `.test.ts` 结尾是为了让它按测试文件处理（可以读 assets/、不计入覆盖率、不要求配对测试）；
 * 本身不含测试用例，node --test 执行它时什么也不做。
 */

import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Grid } from '@pg/core/grid';

export const registry = loadRegistry();

/** 按 [x, y, z, 方块] 列表建网格；方块为 'air' 时挖空。 */
export function gridOf(cells: readonly (readonly [number, number, number, string])[]): Grid {
  const g = createGrid(registry.table);
  for (const [x, y, z, s] of cells) g.set(x, y, z, parseState(registry.table, s), 0, 0);
  return g;
}

/** 闭区间长方体的全部格。 */
export function box(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  block: string,
): [number, number, number, string][] {
  const out: [number, number, number, string][] = [];
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) for (let z = z0; z <= z1; z += 1) out.push([x, y, z, block]);
  }
  return out;
}

/** 地面：y = 0 的一片草地。 */
export function ground(r: number): [number, number, number, string][] {
  return box(-r, 0, -r, r, 0, r, 'grass_block');
}
