/**
 * 网格通用工具：位置数组与索引数组的组装辅助、包围盒计算、-0 规范化。
 *
 * 负责：把顶点三元组写进数组、由顶点算出实际包围盒（供 source / Part 校验使用）、把 -0 统一成 0。
 * 不负责：具体形体生成（box.ts / revolve.ts / extrude.ts）、合法性校验（schema.ts）。
 */
import type { Bounds, Vec3 } from './schema.ts';

/** 一个部件的原始网格：平坦 xyz 数组 + 三角索引。 */
export interface MeshData {
  readonly positions: number[];
  readonly indices: number[];
}

/** 把 -0 规范成 0（其余值原样）；所有写进 positions / bounds 的浮点都先过它。 */
export function clean(value: number): number {
  return value === 0 ? 0 : value;
}

/** 由平坦 xyz 数组算实际包围盒；空数组抛错（生成器不应产出空网格）。 */
export function computeBounds(positions: readonly number[]): Bounds {
  if (positions.length === 0) throw new Error('computeBounds：顶点数组为空');
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x === undefined || y === undefined || z === undefined)
      throw new Error('computeBounds：顶点数组长度不是 3 的倍数');
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const min: Vec3 = [clean(minX), clean(minY), clean(minZ)];
  const max: Vec3 = [clean(maxX), clean(maxY), clean(maxZ)];
  return { min, max };
}
