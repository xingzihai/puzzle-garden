/**
 * 参数曲面网格：把 (u, v) 采样网格按拓扑连成三角。
 *
 * 负责：由已按 u/v 采样的顶点按「增 u 方向 × 增 v 方向」的绕序生成三角；closedU=true 时 u 方向
 * 首尾相接（第 uSegments−1 列跨接到第 0 列，不复制缝合列），closedU=false 时 u=0 与 u=1 是两条独立列；
 * v=0 行或 v=vSegments 行若整行采样互相重合（容差与 revolve 端部吸附同量级，见 surfaceRowSnapThreshold），
 * 则把该行塌缩成单个尖点、改用扇面连接相邻行（与 revolve 的收尖处理同精神），两端都塌缩的纺锤形同样成立。
 * 不负责：position 函数采样与数值校验（model.ts）、轮廓 / 变换（transform.ts）。
 *
 * 顶点布局：i 为列（0..columns−1）、j 为行（0..vSegments）；未塌缩行的下标 = i·(vSegments+1)+j。
 * columns = closedU ? uSegments : uSegments + 1，普通顶点数 = columns·(vSegments+1)；每塌缩一个端行少
 * columns−1 个顶点。每个网格单元 (i,j)-(i+1,j)-(i+1,j+1)-(i,j+1) 普通情况拆成 (a,b,c) 与 (a,c,d) 两个
 * 三角；底行塌缩取 (a,c,d)、顶行塌缩取 (a,b,c)，法线方向仍为 du×dv。
 */
import type { MeshData } from './mesh.ts';
import { clean } from './mesh.ts';

type Sample = readonly [number, number, number];

/**
 * v 端整行吸附阈值：`max(1e-9, 跨度 × 1e-9)`（跨度取所有采样三轴包围盒的最大边长）。
 *
 * 与 revolve 的端部半径吸附（revolve.ts 的 revolveEndSnapThreshold）同量级：整行是否构成“真实尖点”
 * 应与部件尺度挂钩，故用相对阈值；绝对下限 1e-9 兜住极细部件里纯粹的舍入噪声。
 */
function surfaceRowSnapThreshold(samples: readonly Sample[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const sample of samples) {
    if (sample[0] < minX) minX = sample[0];
    if (sample[1] < minY) minY = sample[1];
    if (sample[2] < minZ) minZ = sample[2];
    if (sample[0] > maxX) maxX = sample[0];
    if (sample[1] > maxY) maxY = sample[1];
    if (sample[2] > maxZ) maxZ = sample[2];
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  return Math.max(1e-9, span * 1e-9);
}

/** 第 j 行（j=rowStart）的各列采样是否互相重合：三轴各自极差都 ≤ threshold 即视为同一点。 */
function rowCoincides(
  samples: readonly Sample[],
  rowStart: number,
  rows: number,
  columns: number,
  threshold: number,
): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < columns; i += 1) {
    const sample = samples[i * rows + rowStart];
    if (sample === undefined) return false;
    if (sample[0] < minX) minX = sample[0];
    if (sample[1] < minY) minY = sample[1];
    if (sample[2] < minZ) minZ = sample[2];
    if (sample[0] > maxX) maxX = sample[0];
    if (sample[1] > maxY) maxY = sample[1];
    if (sample[2] > maxZ) maxZ = sample[2];
  }
  return maxX - minX <= threshold && maxY - minY <= threshold && maxZ - minZ <= threshold;
}

/** 读出列 i、行 j 的顶点下标；越界即内部布局错误。 */
function indexAt(vertexIndex: readonly (readonly number[])[], i: number, j: number): number {
  const value = vertexIndex[i]?.[j];
  if (value === undefined) throw new Error(`surfaceMesh：缺少顶点索引 (i=${String(i)}, j=${String(j)})`);
  return value;
}

/** 生成参数曲面网格。samples 已由调用方按列优先（i 外层、j 内层）采样并校验。 */
export function surfaceMesh(
  samples: readonly Sample[],
  uSegments: number,
  vSegments: number,
  closedU: boolean,
): MeshData {
  const columns = closedU ? uSegments : uSegments + 1;
  const rows = vSegments + 1;
  if (samples.length !== columns * rows) {
    throw new Error(`surfaceMesh：顶点数 ${String(samples.length)} 与网格 ${String(columns)}×${String(rows)} 不符`);
  }
  const threshold = surfaceRowSnapThreshold(samples);
  const rowCollapsed: boolean[] = new Array<boolean>(rows).fill(false);
  rowCollapsed[0] = rowCoincides(samples, 0, rows, columns, threshold);
  rowCollapsed[vSegments] = rowCoincides(samples, vSegments, rows, columns, threshold);

  const positions: number[] = [];
  const vertexIndex: number[][] = [];
  // 塌缩端行只建一个顶点：该行首个遇到的采样作为尖点位置，其余列复用它。
  const collapsedApex = new Map<number, number>();
  for (let i = 0; i < columns; i += 1) {
    const column: number[] = [];
    for (let j = 0; j < rows; j += 1) {
      if (rowCollapsed[j] === true) {
        let apex = collapsedApex.get(j);
        if (apex === undefined) {
          const sample = samples[i * rows + j];
          if (sample === undefined) throw new Error(`surfaceMesh：缺少采样 (i=${String(i)}, j=${String(j)})`);
          apex = positions.length / 3;
          positions.push(clean(sample[0]), clean(sample[1]), clean(sample[2]));
          collapsedApex.set(j, apex);
        }
        column[j] = apex;
        continue;
      }
      const sample = samples[i * rows + j];
      if (sample === undefined) throw new Error(`surfaceMesh：缺少采样 (i=${String(i)}, j=${String(j)})`);
      column[j] = positions.length / 3;
      positions.push(clean(sample[0]), clean(sample[1]), clean(sample[2]));
    }
    vertexIndex.push(column);
  }

  const indices: number[] = [];
  for (let i = 0; i < uSegments; i += 1) {
    const next = closedU ? (i + 1) % uSegments : i + 1;
    for (let j = 0; j < vSegments; j += 1) {
      const a = indexAt(vertexIndex, i, j);
      const b = indexAt(vertexIndex, next, j);
      const c = indexAt(vertexIndex, next, j + 1);
      const d = indexAt(vertexIndex, i, j + 1);
      const bottomCollapsed = rowCollapsed[j] === true;
      const topCollapsed = rowCollapsed[j + 1] === true;
      if (!bottomCollapsed && !topCollapsed) {
        indices.push(a, b, c, a, c, d);
      } else if (bottomCollapsed && !topCollapsed) {
        // 底行塌缩：a === b，取四边形中唯一非退化的 (a, c, d) 扇面。
        indices.push(a, c, d);
      } else if (!bottomCollapsed && topCollapsed) {
        // 顶行塌缩：c === d，取四边形中唯一非退化的 (a, b, c) 扇面。
        indices.push(a, b, c);
      }
      // 同一带两端都塌缩只可能出现在 vSegments=1（本包不允许），此时无有效三角，跳过。
    }
  }
  return { positions, indices };
}
