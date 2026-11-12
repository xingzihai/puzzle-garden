/**
 * 参数化网格采样（M3 参数化壳构件）：把 surface / revolve 的函数定义采样成网格与可序列化 source 参数。
 *
 * 负责：position / profile 的 typeof 检查、按段数采样、采样值校验（有限数 / 半径与单调性 / -0 规范化）、
 * 端部近零半径吸附、网格生成与变换、source 参数二次校验；报错文案与 MODELING-SPEC §3 一致。
 * 不负责：部件的公共选项（id / name / role / color / material）与登记（model.ts、geometry 的壳构件）、
 * 体素化（voxelize.ts）、世界放置（geometry 的 voxel-place.ts）。
 */
import type { z } from 'zod';

import { ModelError, formatIssues } from './errors.ts';
import { clean, computeBounds } from './mesh.ts';
import { revolveMesh, snapRevolveEnds } from './revolve.ts';
import {
  ABS_MAX,
  Point2,
  Vec3,
  revolveParametersSchema,
  sampledProfileProblem,
  surfaceParametersSchema,
} from './schema.ts';
import type { Bounds, TransformInput } from './schema.ts';
import { surfaceMesh } from './surface.ts';
import { applyTransform, resolveTransform } from './transform.ts';

/** revolve 缺省采样段数（与 MODELING-SPEC §3 一致）。 */
export const DEFAULT_PROFILE_SEGMENTS = 32;
export const DEFAULT_RADIAL_SEGMENTS = 48;

/** surface 采样输入；position 是未知值，运行期做 typeof 检查（函数不序列化）。 */
export interface SurfaceSampleOptions {
  readonly position: unknown;
  readonly uSegments: number;
  readonly vSegments: number;
  readonly closedU?: boolean;
  readonly transform?: TransformInput;
}
export interface SurfaceSample {
  readonly positions: number[];
  readonly indices: number[];
  readonly bounds: Bounds;
  readonly parameters: z.output<typeof surfaceParametersSchema>;
}

/** revolve 采样输入；profile 是未知值，运行期做 typeof 检查（函数不序列化）。 */
export interface RevolveSampleOptions {
  readonly profile: unknown;
  readonly profileSegments?: number;
  readonly radialSegments?: number;
  readonly transform?: TransformInput;
}
export interface RevolveSample {
  readonly positions: number[];
  readonly indices: number[];
  readonly bounds: Bounds;
  readonly parameters: z.output<typeof revolveParametersSchema>;
}

/** profile 字段只做 typeof 检查（函数不序列化、不进 schema）。 */
function isProfile(value: unknown): value is (t: number) => unknown {
  return typeof value === 'function';
}

/** surface 的 position 字段只做 typeof 检查（同上）。 */
function isPosition(value: unknown): value is (u: number, v: number) => unknown {
  return typeof value === 'function';
}

/** 出错消息里安全预览函数返回值（不展开大对象、不调用未知 getter）。 */
function preview(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return Array.isArray(value) ? '一个数组' : '一个对象';
  if (typeof value === 'function') return '一个函数';
  if (typeof value === 'symbol') return '一个 symbol';
  if (typeof value === 'string') return `字符串 ${value}`;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return 'undefined';
}

/** 采样并生成参数曲面网格；closedU 时 u 方向首尾相接，v 端整行重合由 surfaceMesh 收成尖点。 */
export function sampleSurface(options: SurfaceSampleOptions): SurfaceSample {
  const { position } = options;
  if (!isPosition(position)) {
    throw new ModelError(`surface 的 position 必须是 (u, v) => [x, y, z] 函数，实际是 ${typeof position}`);
  }
  const { uSegments, vSegments } = options;
  const closedU = options.closedU ?? false;
  // closedU=true 时 u 方向首尾相接：只采样 uSegments 列（不复制 u=1 的缝合列）。
  const columns = closedU ? uSegments : uSegments + 1;
  const samples: (readonly [number, number, number])[] = [];
  for (let i = 0; i < columns; i += 1) {
    const u = i / uSegments;
    for (let j = 0; j <= vSegments; j += 1) {
      const v = j / vSegments;
      const where = `采样 (i=${String(i)}, u=${String(u)}, j=${String(j)}, v=${String(v)})`;
      let value: unknown;
      try {
        value = position(u, v);
      } catch (error) {
        throw new ModelError(
          `surface 的 position 在 ${where} 抛错：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const sample = Vec3.safeParse(value);
      if (!sample.success) {
        throw new ModelError(
          `surface 的 position 必须返回 [x, y, z] 三个绝对值 ≤ ${String(ABS_MAX)} 的有限数，${where} 返回了 ${preview(value)}`,
        );
      }
      samples.push(sample.data);
    }
  }
  const transform = resolveTransform(options.transform);
  const mesh = applyTransform(surfaceMesh(samples, uSegments, vSegments, closedU), transform);
  const parameters = surfaceParametersSchema.safeParse({ uSegments, vSegments, closedU, transform });
  if (!parameters.success) {
    throw new ModelError(`surface 采样参数非法：${formatIssues(parameters.error.issues)}`);
  }
  return {
    positions: mesh.positions,
    indices: mesh.indices,
    bounds: computeBounds(mesh.positions),
    parameters: parameters.data,
  };
}

/** 采样并生成旋转网格；端部近零半径吸附成精确 0，中间采样遵守半径与高度规则。 */
export function sampleRevolve(options: RevolveSampleOptions): RevolveSample {
  const { profile } = options;
  if (!isProfile(profile)) {
    throw new ModelError(`revolve 的 profile 必须是 (t: number) => [radius, height] 函数，实际是 ${typeof profile}`);
  }
  const profileSegments = options.profileSegments ?? DEFAULT_PROFILE_SEGMENTS;
  const radialSegments = options.radialSegments ?? DEFAULT_RADIAL_SEGMENTS;
  const samples: [number, number][] = [];
  for (let i = 0; i <= profileSegments; i += 1) {
    const t = i / profileSegments;
    let value: unknown;
    try {
      value = profile(t);
    } catch (error) {
      throw new ModelError(
        `revolve 的 profile 在第 ${String(i)} 个采样 t=${String(t)} 抛错：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const sample = Point2.safeParse(value);
    if (!sample.success) {
      throw new ModelError(
        `revolve 的 profile 必须返回 [radius, height] 两个有限数字，第 ${String(i)} 个采样 t=${String(t)} 返回了 ${preview(value)}`,
      );
    }
    samples.push([clean(sample.data[0]), clean(sample.data[1])]);
  }
  const problem = sampledProfileProblem(samples);
  if (problem !== null) throw new ModelError(`revolve 采样轮廓非法：${problem}`);
  // 吸附首 / 尾近零半径（分段贝塞尔 t=1 处可能算出 ~1e-16），并让 source 记录吸附后的采样，
  // 保证交付件里的 sampledProfile 与生成的网格一致、重放不会再次生成 float32 退化三角。
  const snapped = snapRevolveEnds(samples);
  const transform = resolveTransform(options.transform);
  const mesh = applyTransform(revolveMesh(snapped, radialSegments), transform);
  const parameters = revolveParametersSchema.safeParse({
    profileSegments,
    radialSegments,
    sampledProfile: snapped,
    transform,
  });
  if (!parameters.success) {
    throw new ModelError(`revolve 采样参数非法：${formatIssues(parameters.error.issues)}`);
  }
  return {
    positions: mesh.positions,
    indices: mesh.indices,
    bounds: computeBounds(mesh.positions),
    parameters: parameters.data,
  };
}
