/**
 * 交互层的共享标量：id / 文本 / 坐标 / 半开包围盒 / 面积。
 *
 * 负责：给 RequirementGraph、DesignScheme、BuildSpec、ReviewReport 提供同一套取值范围；
 * 坐标直接复用 @pg/core 的世界范围，避免设计层与构建层各写一套上下限。
 * 不负责：几何求交、方案校验或任何 I/O。
 *
 * 单位：线性坐标以格为单位（设计尺度默认一格约一米）；面积以 m² 记录，
 * 由 bounds 的地面投影派生时会在报告 / bug 简报里明确标注“外包面积、未扣墙厚”。
 */
import { XZ_MAX, XZ_MIN, Y_MAX, Y_MIN } from '@pg/core/coord';
import { z } from 'zod';

export const ID_MAX = 64;
export const LABEL_MAX = 128;
export const TEXT_MAX = 4000;
export const NOTE_MAX = 1000;
export const TITLE_MAX = 200;

const xz = z.int().min(XZ_MIN).max(XZ_MAX);
const y = z.int().min(Y_MIN).max(Y_MAX);

/** 非空 id；不限制大小写与连字符，便于模型直接使用稳定 slug。 */
export const Identifier = z.string().min(1).max(ID_MAX);
export type Identifier = z.infer<typeof Identifier>;

/** 名称、标签、短句。 */
export const Label = z.string().min(1).max(LABEL_MAX);
export type Label = z.infer<typeof Label>;

/** 需求、描述、理由等长文本。 */
export const Text = z.string().min(1).max(TEXT_MAX);
export type Text = z.infer<typeof Text>;

/** 可选备注：缺失时必须显式写 null，避免结构化输出里出现“有时缺字段”。 */
export const Note = z.string().min(1).max(NOTE_MAX).nullable();
export type Note = z.infer<typeof Note>;

/** 色值只接受 6 位十六进制；大小写都保留原样。 */
export const ColorHex = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, '颜色必须是 #rrggbb（6 位十六进制）')
  .nullable();
export type ColorHex = z.infer<typeof ColorHex>;

/** 只读三元组 [x, y, z]；x 向东、y 向上、z 向南，全部为整数。 */
export const Vec3 = z.tuple([xz, y, xz]).readonly();
export type Vec3 = z.infer<typeof Vec3>;

/** 轴对齐半开区间 [min, max)：每轴 max 必须严格大于 min。 */
export const Bounds = z
  .strictObject({ min: Vec3, max: Vec3 })
  .refine(
    (bounds) => bounds.max[0] > bounds.min[0] && bounds.max[1] > bounds.min[1] && bounds.max[2] > bounds.min[2],
    '边界每轴必须 max 严格大于 min（半开区间 [min, max)）',
  )
  .readonly();
export type Bounds = z.infer<typeof Bounds>;

/** 半开包围盒在三轴上的尺寸（格）。 */
export function boundsSize(bounds: Bounds): readonly [number, number, number] {
  return [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
}

/** 地面投影面积（格²；设计尺度默认按 m² 读）。不做墙厚扣除。 */
export function areaOfBounds(bounds: Bounds): number {
  return (bounds.max[0] - bounds.min[0]) * (bounds.max[2] - bounds.min[2]);
}

/** 两个半开包围盒是否在三维空间有重叠；只接触边 / 面不算重叠。 */
export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.min[0] < b.max[0] &&
    b.min[0] < a.max[0] &&
    a.min[1] < b.max[1] &&
    b.min[1] < a.max[1] &&
    a.min[2] < b.max[2] &&
    b.min[2] < a.max[2]
  );
}

/** bounds 是否完整落在 outer 内（半开区间端点允许相等）。 */
export function boundsWithin(bounds: Bounds, outer: Bounds): boolean {
  return (
    bounds.min[0] >= outer.min[0] &&
    bounds.min[1] >= outer.min[1] &&
    bounds.min[2] >= outer.min[2] &&
    bounds.max[0] <= outer.max[0] &&
    bounds.max[1] <= outer.max[1] &&
    bounds.max[2] <= outer.max[2]
  );
}
