/**
 * 轴对齐盒网格：以局部原点为最小角，向 +x / +y / +z 拉伸给定正尺寸。
 *
 * 负责：8 个共享顶点 + 12 个外向三角（面法线朝外，浏览器自行算法线）。
 * 不负责：变换（transform.ts）、schema 校验（schema.ts）。
 */
import type { MeshData } from './mesh.ts';
import { clean } from './mesh.ts';
import type { Vec3 } from './schema.ts';

/** 生成尺寸为 size 的盒网格。size 已由调用方保证每轴为正。 */
export function boxMesh(size: Vec3): MeshData {
  const [sx, sy, sz] = size;
  const positions: number[] = [0, 0, 0, sx, 0, 0, sx, 0, sz, 0, 0, sz, 0, sy, 0, sx, sy, 0, sx, sy, sz, 0, sy, sz].map(
    clean,
  );
  // 每面两个三角，按从外部看逆时针排列；下方注释给面法线方向。
  const indices: number[] = [
    0,
    1,
    2,
    0,
    2,
    3, // y=0，法线 -y
    4,
    7,
    6,
    4,
    6,
    5, // y=sy，法线 +y
    0,
    4,
    5,
    0,
    5,
    1, // z=0，法线 -z
    3,
    2,
    6,
    3,
    6,
    7, // z=sz，法线 +z
    0,
    3,
    7,
    0,
    7,
    4, // x=0，法线 -x
    1,
    5,
    6,
    1,
    6,
    2, // x=sx，法线 +x
  ];
  return { positions, indices };
}
