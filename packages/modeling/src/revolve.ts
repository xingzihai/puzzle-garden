/**
 * 旋转网格：把 [radius, height] 采样母线绕局部 +y 轴旋转。
 *
 * 负责：生成侧表面三角形；半径为 0 的首 / 尾采样收成单个尖点，不生成退化三角形；
 * 端部半径为 0 以外的开口不封底、不封顶；外向绕序（浏览器自行算法线）；
 * 把首 / 尾采样的近零半径吸附成精确 0（见 snapRevolveEnds），避免 f64 下非零的极小半径
 * 在渲染层转 float32 后塌成零面积三角。
 * 不负责：母线合法性（schema.ts 的 sampledProfileProblem）、变换（transform.ts）。
 *
 * 绕序推导（世界系 x 东、y 上、z 南）：θ=0 处圆柱面外法线为 +x，故四边形取
 * (i,j)→(i+1,j)→(i+1,j+1) 与 (i,j)→(i+1,j+1)→(i,j+1)；底尖扇面与顶尖扇面各自镜像。
 */
import type { MeshData } from './mesh.ts';
import { clean } from './mesh.ts';
import type { RevolveSample } from './schema.ts';

function sampleAt(samples: readonly RevolveSample[], index: number): RevolveSample {
  const sample = samples[index];
  if (sample === undefined) throw new Error(`revolveMesh：缺少第 ${String(index)} 个母线采样`);
  return sample;
}

/**
 * 端部半径吸附阈值：`max(1e-9, 跨度 × 1e-9)`。
 *
 * 跨度取 revolve 自身包围盒水平（2 × 最大半径）与竖向（高度差）的较大者：渲染层
 * （packages/web/src/page/mesh-scene.ts 的 assertQuantizedNonDegenerate）按部件跨度判断
 * float32 是否抹掉内部细特征，端部是否为“真实尖点”应与部件尺度挂钩，故用同量级的跨度
 * 换算成相对阈值；绝对下限 1e-9 兜住极细部件里纯粹的舍入噪声。仅用于首 / 尾采样。
 */
export function revolveEndSnapThreshold(sampledProfile: readonly RevolveSample[]): number {
  let maxRadius = 0;
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (const sample of sampledProfile) {
    if (sample[0] > maxRadius) maxRadius = sample[0];
    if (sample[1] < minHeight) minHeight = sample[1];
    if (sample[1] > maxHeight) maxHeight = sample[1];
  }
  const horizontal = 2 * maxRadius;
  const vertical = maxHeight > minHeight ? maxHeight - minHeight : 0;
  return Math.max(1e-9, Math.max(horizontal, vertical) * 1e-9);
}

/**
 * 把首 / 尾采样的近零半径吸附到精确 0，让 revolveMesh 走既有单尖点路径。
 *
 * 起因：分段贝塞尔末段控制点半径为 0 时，t=1 处可能算出 ~1e-16 而非精确 0；该半径在 f64 下
 * 非零，会生成一圈极小半径，交付物转 float32 后该圈三角塌成零面积、自家渲染器打不开。
 * 只吸附首 / 尾；中间采样不吸附（sampledProfileProblem 已保证中间半径 > 0，保持现状报错）。
 * 返回新数组，不改动传入的采样。
 */
export function snapRevolveEnds(sampledProfile: readonly RevolveSample[]): RevolveSample[] {
  const snapped: RevolveSample[] = sampledProfile.map((sample): RevolveSample => [sample[0], sample[1]]);
  if (snapped.length === 0) return snapped;
  const threshold = revolveEndSnapThreshold(snapped);
  const first = snapped[0];
  if (first !== undefined && first[0] < threshold) snapped[0] = [0, first[1]];
  const lastIndex = snapped.length - 1;
  const last = snapped[lastIndex];
  if (last !== undefined && last[0] < threshold) snapped[lastIndex] = [0, last[1]];
  return snapped;
}

function indexAt(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`revolveMesh：缺少第 ${String(index)} 个顶点索引`);
  return value;
}

/** 生成旋转网格。sampledProfile 已保证长度 ≥ 2、半径 ≥ 0 且高度严格递增。 */
export function revolveMesh(rawSampledProfile: readonly RevolveSample[], radialSegments: number): MeshData {
  // 先吸附端部近零半径，使 t=1 处被浮点算成 ~1e-16 的端点也走单尖点路径。
  const sampledProfile = snapRevolveEnds(rawSampledProfile);
  const sampleCount = sampledProfile.length;
  const positions: number[] = [];
  const indices: number[] = [];
  /** 每个采样对应的环起始顶点下标；半径为 0 的端点为 -1。 */
  const ringStart = new Array<number>(sampleCount).fill(-1);
  /** 每个采样对应的尖点顶点下标；非尖点为 -1。 */
  const apexIndex = new Array<number>(sampleCount).fill(-1);

  for (let i = 0; i < sampleCount; i += 1) {
    const sample = sampleAt(sampledProfile, i);
    const radius = sample[0];
    const height = sample[1];
    if (radius === 0) {
      apexIndex[i] = positions.length / 3;
      positions.push(0, clean(height), 0);
      continue;
    }
    ringStart[i] = positions.length / 3;
    for (let j = 0; j < radialSegments; j += 1) {
      const angle = (2 * Math.PI * j) / radialSegments;
      positions.push(clean(radius * Math.cos(angle)), clean(height), clean(radius * Math.sin(angle)));
    }
  }

  const ring = (i: number, j: number): number => indexAt(ringStart, i) + (j % radialSegments);

  // 底尖（首个采样半径为 0）：单尖点扇面。
  if (indexAt(apexIndex, 0) >= 0) {
    const apex = indexAt(apexIndex, 0);
    for (let j = 0; j < radialSegments; j += 1) indices.push(apex, ring(1, j), ring(1, j + 1));
  }
  // 顶尖（末个采样半径为 0）：镜像绕序。
  if (indexAt(apexIndex, sampleCount - 1) >= 0) {
    const apex = indexAt(apexIndex, sampleCount - 1);
    for (let j = 0; j < radialSegments; j += 1)
      indices.push(apex, ring(sampleCount - 2, j + 1), ring(sampleCount - 2, j));
  }
  // 相邻两环之间的侧表面；任一端为尖点时该段由扇面覆盖。
  for (let i = 0; i < sampleCount - 1; i += 1) {
    if (indexAt(ringStart, i) < 0 || indexAt(ringStart, i + 1) < 0) continue;
    for (let j = 0; j < radialSegments; j += 1) {
      const a = ring(i, j);
      const b = ring(i + 1, j);
      const c = ring(i + 1, j + 1);
      const d = ring(i, j + 1);
      indices.push(a, b, c, a, c, d);
    }
  }
  return { positions, indices };
}
