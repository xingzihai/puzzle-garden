/**
 * 建模包的唯一数据 schema 与推导类型（docs/MODELING-SPEC.md §3）。
 *
 * 负责：公共选项 / 变换、Part 与 ModelDocument、source 可辨识联合（box / revolve / extrude / surface）的严格
 * 只读结构；有限浮点范围与 -0 规范化；轮廓的简单性（重复 / 共线 / 自交 / 退化为零面积）校验；旋转母线的半径与高度
 * 单调性；网格顶点数 / 索引范围 / 非退化三角 / 包围盒一致性；部件 id 唯一与全包顶点 / 三角上限。
 * 不负责：网格生成（box.ts / revolve.ts / extrude.ts / surface.ts）、变换求值（transform.ts）、模型对象与调用
 * 参数的运行期校验（model.ts）。
 *
 * 数值约定：坐标 / 顶点 / 变换允许有限浮点，绝对值 ≤ ABS_MAX（适配连续函数）；-0 规范成 0；
 * 拒绝 NaN / Infinity。色值为小写 `#rrggbb`。
 */
import { z } from 'zod';

import { MAX_OUTLINE_POINTS, checkOutline } from './polygon.ts';

/** 建模坐标 / 变换允许的绝对值上限（MODELING-SPEC §2）。 */
export const ABS_MAX = 100000;
/**
 * ModelDocument 当前版本号（决策 #113）：v2 起部件可带可选 `material`；读取兼容 version 1 的旧文档。
 * 旧 v1 文档带 `material` 一律拒绝（version 1 不支持 material，请升级为 2）。
 */
export const MODEL_VERSION = 2;
/** 轮廓 / 旋转采样的段数范围。 */
export const MIN_SEGMENTS = 4;
export const MAX_SEGMENTS = 128;
/** 部件数、总顶点数、总三角数上限（MODELING-SPEC §3）。 */
export const MAX_PARTS = 128;
export const MAX_VERTICES = 200000;
export const MAX_TRIANGLES = 400000;
/** 字符串上限。 */
export const ID_MAX = 64;
export const NAME_MAX = 128;
/** 部件可选材质上限：方块名或 `name[props]` 写法（决策 #113）。 */
export const MATERIAL_MAX = 200;
/** 包围盒与顶点一致性的容差（外部 JSON 往返仍逐位精确，这里留一点余量）。 */
export const BOUNDS_TOLERANCE = 1e-6;
/** 色值只接受小写 6 位十六进制。 */
export const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** 有限浮点，绝对值 ≤ ABS_MAX，-0 规范成 0。 */
const boundedNumber = z
  .number()
  .refine((value) => Number.isFinite(value) && Math.abs(value) <= ABS_MAX, {
    message: `必须是绝对值 ≤ ${String(ABS_MAX)} 的有限数`,
  })
  .transform((value) => (value === 0 ? 0 : value));

/** 有限浮点，位于 (0, ABS_MAX]；用于尺寸与缩放分量。 */
const positiveNumber = z.number().refine((value) => Number.isFinite(value) && value > 0 && value <= ABS_MAX, {
  message: `必须是 (0, ${String(ABS_MAX)}] 内的有限数`,
});

const segmentCount = z.int().min(MIN_SEGMENTS).max(MAX_SEGMENTS);

/** 只读三元组 [x, y, z]。 */
export const Vec3 = z.tuple([boundedNumber, boundedNumber, boundedNumber]).readonly();
export type Vec3 = z.infer<typeof Vec3>;

/** 只读二元组 [a, b]；在 outline 里表示 (x, z)，在旋转母线里表示 [radius, height]。 */
export const Point2 = z.tuple([boundedNumber, boundedNumber]).readonly();
export type Point2 = z.infer<typeof Point2>;

/** 部件角色。 */
export const Role = z.enum(['volume', 'roof', 'floor', 'connection']);
export type Role = z.infer<typeof Role>;

/** 色值：严格小写 `#rrggbb`。 */
export const Color = z.string().regex(COLOR_PATTERN, '颜色必须是小写 #rrggbb（6 位十六进制）');

/** 调用方传入的变换：Euler XYZ 弧度，缩放各轴 > 0，缺省单位变换。 */
export const Transform = z
  .strictObject({
    translate: Vec3.optional(),
    rotate: Vec3.optional(),
    scale: z.tuple([positiveNumber, positiveNumber, positiveNumber]).readonly().optional(),
  })
  .readonly();
export type Transform = z.infer<typeof Transform>;
export type TransformInput = z.infer<typeof Transform>;

/** 记录进 source 的已解析变换：三个分量都齐全，保证可序列化且复现。 */
export const TransformDocument = z
  .strictObject({
    translate: Vec3,
    rotate: Vec3,
    scale: z.tuple([positiveNumber, positiveNumber, positiveNumber]).readonly(),
  })
  .readonly();
export type TransformDocument = z.infer<typeof TransformDocument>;

/**
 * 轴对齐包围盒：每轴 max ≥ min（网格是平面时某轴允许相等）。
 * 这里只校验 min / max 自身的次序；与实际顶点的容差比对在 meshProblems 里单独做，两者互不替代。
 */
export const Bounds = z
  .strictObject({ min: Vec3, max: Vec3 })
  .superRefine((bounds, ctx) => {
    const axes = [0, 1, 2] as const;
    for (const axis of axes) {
      if (bounds.max[axis] < bounds.min[axis]) {
        ctx.addIssue({
          code: 'custom',
          path: ['max', axis],
          message: `bounds 每轴必须 max ≥ min：第 ${String(axis)} 轴 min=${String(bounds.min[axis])} > max=${String(bounds.max[axis])}`,
        });
      }
    }
  })
  .readonly();
export type Bounds = z.infer<typeof Bounds>;

/** 旋转母线的一个采样：[radius, height]。 */
export const RevolveSample = z.tuple([boundedNumber, boundedNumber]).readonly();
export type RevolveSample = z.infer<typeof RevolveSample>;

/**
 * 旋转母线采样的额外规则（MODELING-SPEC §3）：
 * 半径 ≥ 0；高度沿采样严格递增；只有首尾采样允许半径为 0（尖端），中间不得为 0。
 * 返回中文问题描述，合法时返回 null；schema 的 refine 与调用期校验共用。
 */
export function sampledProfileProblem(samples: readonly (readonly [number, number])[]): string | null {
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    if (sample === undefined) return `缺少第 ${String(i)} 个采样`;
    if (sample[0] < 0) return `第 ${String(i)} 个采样半径 ${String(sample[0])} < 0，半径必须 ≥ 0`;
    if (i > 0) {
      const previous = samples[i - 1];
      if (previous !== undefined && !(sample[1] > previous[1])) {
        return `高度必须沿采样严格递增：第 ${String(i)} 个高度 ${String(sample[1])} 未大于第 ${String(i - 1)} 个 ${String(previous[1])}`;
      }
    }
  }
  for (let i = 1; i < samples.length - 1; i += 1) {
    const sample = samples[i];
    if (sample?.[0] === 0) {
      return `中间采样不得半径为 0（第 ${String(i)} 个）；尖端只能出现在首尾采样`;
    }
  }
  return null;
}

/** 旋转母线采样数组：至少 MIN_SEGMENTS+1 个、至多 MAX_SEGMENTS+1 个且满足半径 / 单调性规则。 */
export const SampledProfile = z
  .array(RevolveSample)
  .min(MIN_SEGMENTS + 1)
  .max(MAX_SEGMENTS + 1)
  .superRefine((samples, ctx) => {
    const problem = sampledProfileProblem(samples);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
  })
  .readonly();
export type SampledProfile = z.infer<typeof SampledProfile>;

/**
 * 简单轮廓：至少 3 点、面积非零、相邻顶点不共线退化、非相邻边不自交；凸或凹都接受（凹形由
 * ear clipping 三角化）。source 只存规范形，不允许再带重复闭合点（调用期由 model.ts 先规范化）。
 */
export const SimpleOutline = z
  .array(Point2)
  .min(3)
  .max(MAX_OUTLINE_POINTS)
  .superRefine((outline, ctx) => {
    const result = checkOutline(outline);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.error });
      return;
    }
    if (result.outline.length !== outline.length) {
      ctx.addIssue({ code: 'custom', message: '轮廓不应包含重复的闭合点（source 只存规范形）' });
    }
  })
  .readonly();

const idField = z.string().min(1).max(ID_MAX);
const nameField = z.string().min(1).max(NAME_MAX);
/**
 * 部件可选材质（决策 #113）：方块名（如 `deepslate_tiles`）或带状态写法（如 `oak_stairs[facing=north]`）。
 * 本层只查格式（非空、长度上限），不查方块注册表；注册表校验在建模运行反馈与体素导入两处。
 */
const materialField = z.string().min(1).max(MATERIAL_MAX);
const commonFields = {
  id: idField,
  name: nameField,
  role: Role,
  color: Color,
  material: materialField.optional(),
  transform: Transform.optional(),
};

/** box 调用参数（size 每轴为正）。 */
export const BoxOptionsSchema = z
  .strictObject({ ...commonFields, size: z.tuple([positiveNumber, positiveNumber, positiveNumber]).readonly() })
  .readonly();
export type BoxOptionsInput = z.infer<typeof BoxOptionsSchema>;

/** revolve 调用参数；profile 是函数，运行期只判 typeof（见 model.ts），schema 里记为 unknown。 */
export const RevolveOptionsSchema = z
  .strictObject({
    ...commonFields,
    profile: z.unknown(),
    profileSegments: segmentCount.optional(),
    radialSegments: segmentCount.optional(),
  })
  .readonly();
export type RevolveOptionsInput = z.infer<typeof RevolveOptionsSchema>;

/** extrude 调用参数；轮廓的简单性（重复点 / 共线 / 自交）由 checkOutline 在调用期报错。 */
export const ExtrudeOptionsSchema = z
  .strictObject({
    ...commonFields,
    outline: z
      .array(Point2)
      .min(3)
      .max(MAX_OUTLINE_POINTS + 1)
      .readonly(),
    height: positiveNumber,
  })
  .readonly();
export type ExtrudeOptionsInput = z.infer<typeof ExtrudeOptionsSchema>;

/** surface 调用参数；position 是函数，运行期只判 typeof（见 model.ts），schema 里记为 unknown。 */
export const SurfaceOptionsSchema = z
  .strictObject({
    ...commonFields,
    uSegments: segmentCount,
    vSegments: segmentCount,
    closedU: z.boolean().optional(),
    position: z.unknown(),
  })
  .readonly();
export type SurfaceOptionsInput = z.infer<typeof SurfaceOptionsSchema>;

/** 贝塞尔的 4 个控制点与采样参数 t。 */
export const BezierPointsSchema = z.tuple([Point2, Point2, Point2, Point2]).readonly();
export type BezierPoints = z.infer<typeof BezierPointsSchema>;
export const BezierT = boundedNumber;

/** box 的可序列化 source 参数。 */
export const boxParametersSchema = z
  .strictObject({
    size: z.tuple([positiveNumber, positiveNumber, positiveNumber]).readonly(),
    transform: TransformDocument,
  })
  .readonly();

/** revolve 的可序列化 source 参数：采样段数 + 实际采样轮廓 + 已解析变换。 */
export const revolveParametersSchema = z
  .strictObject({
    profileSegments: segmentCount,
    radialSegments: segmentCount,
    sampledProfile: SampledProfile,
    transform: TransformDocument,
  })
  .superRefine((parameters, ctx) => {
    if (parameters.sampledProfile.length !== parameters.profileSegments + 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['sampledProfile'],
        message: `采样点数必须为 profileSegments + 1 = ${String(parameters.profileSegments + 1)}，实际 ${String(parameters.sampledProfile.length)}`,
      });
    }
  })
  .readonly();

/** extrude 的可序列化 source 参数。 */
export const extrudeParametersSchema = z
  .strictObject({ outline: SimpleOutline, height: positiveNumber, transform: TransformDocument })
  .readonly();

/** surface 的可序列化 source 参数：采样网格已在 Part.positions，这里只记段数与是否闭合。 */
export const surfaceParametersSchema = z
  .strictObject({
    uSegments: segmentCount,
    vSegments: segmentCount,
    closedU: z.boolean(),
    transform: TransformDocument,
  })
  .readonly();

/** source 的可辨识联合：operation 为判别字段。 */
export const PartSource = z
  .discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('box'), parameters: boxParametersSchema }).readonly(),
    z.strictObject({ operation: z.literal('revolve'), parameters: revolveParametersSchema }).readonly(),
    z.strictObject({ operation: z.literal('extrude'), parameters: extrudeParametersSchema }).readonly(),
    z.strictObject({ operation: z.literal('surface'), parameters: surfaceParametersSchema }).readonly(),
  ])
  .readonly();
export type PartSource = z.infer<typeof PartSource>;

/** 三角 (a,b,c) 的叉积是否为零向量，即三点共线或重合。 */
function zeroCross(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): boolean {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  return uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0;
}

/** 数值友好显示：整数原样，非整数保留三位小数（与渲染层 mesh-scene 的显示口径一致）。 */
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/**
 * 网格问题：顶点 / 索引计数、索引范围、非退化三角、包围盒一致性，以及渲染精度（float32）镜像检查。
 * 返回中文问题列表。
 */
function meshProblems(part: {
  readonly id: string;
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly bounds: Bounds;
}): string[] {
  const problems: string[] = [];
  const { positions, indices, bounds } = part;
  if (positions.length % 3 !== 0) problems.push(`顶点数组长度必须是 3 的倍数，实际 ${String(positions.length)}`);
  if (indices.length % 3 !== 0) problems.push(`索引数组长度必须是 3 的倍数，实际 ${String(indices.length)}`);
  if (positions.length % 3 !== 0 || indices.length % 3 !== 0) return problems;

  const vertexCount = positions.length / 3;

  let outOfRange = -1;
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
      outOfRange = index;
      break;
    }
  }
  if (outOfRange >= 0) problems.push(`索引越界：${String(outOfRange)}（顶点数 ${String(vertexCount)}）`);

  if (vertexCount > 0) {
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
      if (x === undefined || y === undefined || z === undefined) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const pairs: readonly (readonly [number, number, string])[] = [
      [minX, bounds.min[0], 'min.x'],
      [minY, bounds.min[1], 'min.y'],
      [minZ, bounds.min[2], 'min.z'],
      [maxX, bounds.max[0], 'max.x'],
      [maxY, bounds.max[1], 'max.y'],
      [maxZ, bounds.max[2], 'max.z'],
    ];
    for (const [actual, declared, label] of pairs) {
      if (Math.abs(actual - declared) > BOUNDS_TOLERANCE) {
        problems.push(`bounds.${label} 与实际顶点不一致：声明 ${String(declared)}，实际 ${String(actual)}`);
        break;
      }
    }

    if (outOfRange < 0) {
      // 1) source 级（f64）退化：三点在建模精度下就共线或重合。
      let sourceDegenerate = -1;
      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t];
        const i1 = indices[t + 1];
        const i2 = indices[t + 2];
        if (i0 === undefined || i1 === undefined || i2 === undefined) break;
        const ax = positions[i0 * 3];
        const ay = positions[i0 * 3 + 1];
        const az = positions[i0 * 3 + 2];
        const bx = positions[i1 * 3];
        const by = positions[i1 * 3 + 1];
        const bz = positions[i1 * 3 + 2];
        const cx = positions[i2 * 3];
        const cy = positions[i2 * 3 + 1];
        const cz = positions[i2 * 3 + 2];
        if (ax === undefined || ay === undefined || az === undefined) break;
        if (bx === undefined || by === undefined || bz === undefined) break;
        if (cx === undefined || cy === undefined || cz === undefined) break;
        if (zeroCross(ax, ay, az, bx, by, bz, cx, cy, cz)) {
          sourceDegenerate = t / 3;
          break;
        }
      }
      if (sourceDegenerate >= 0) {
        problems.push(`第 ${String(sourceDegenerate)} 个三角退化（三点共线或重合）`);
      } else {
        // 2) 镜像渲染层（packages/web/src/page/mesh-scene.ts 的 assertQuantizedNonDegenerate）口径：
        //    顶点先减部件 bounds.min，再 Math.fround 到 float32，逐三角看叉积是否全 0。
        //    这样建模 finish 就能拦住“f64 合法、转 float32 后塌成零面积”的交付物；
        //    绝不静默删除退化三角，只报可行动的错误。
        const ox = bounds.min[0];
        const oy = bounds.min[1];
        const oz = bounds.min[2];
        let quantizedDegenerate = -1;
        for (let t = 0; t < indices.length; t += 3) {
          const i0 = indices[t];
          const i1 = indices[t + 1];
          const i2 = indices[t + 2];
          if (i0 === undefined || i1 === undefined || i2 === undefined) break;
          const ax = Math.fround((positions[i0 * 3] ?? 0) - ox);
          const ay = Math.fround((positions[i0 * 3 + 1] ?? 0) - oy);
          const az = Math.fround((positions[i0 * 3 + 2] ?? 0) - oz);
          const bx = Math.fround((positions[i1 * 3] ?? 0) - ox);
          const by = Math.fround((positions[i1 * 3 + 1] ?? 0) - oy);
          const bz = Math.fround((positions[i1 * 3 + 2] ?? 0) - oz);
          const cx = Math.fround((positions[i2 * 3] ?? 0) - ox);
          const cy = Math.fround((positions[i2 * 3 + 1] ?? 0) - oy);
          const cz = Math.fround((positions[i2 * 3 + 2] ?? 0) - oz);
          if (zeroCross(ax, ay, az, bx, by, bz, cx, cy, cz)) {
            quantizedDegenerate = t / 3;
            break;
          }
        }
        if (quantizedDegenerate >= 0) {
          const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
          problems.push(
            `部件 ${part.id} 的第 ${String(quantizedDegenerate)} 个三角在渲染精度（float32）下退化：` +
              `顶点减 bounds.min 并转 float32 后三点塌成零面积（部件跨度约 ${formatNumber(span)}）。` +
              `请把端部半径精确收到 0、增大端部半径，或减小该部件跨度（拆分部件 / 缩小尺寸）；不要删除该三角。`,
          );
        }
      }
    }
  }
  return problems;
}

/** 单个部件：id 唯一性在 ModelDocument 层校验；material 为可选材质（v2 起）。 */
export const Part = z
  .strictObject({
    id: idField,
    name: nameField,
    role: Role,
    color: Color,
    material: materialField.optional(),
    positions: z
      .array(boundedNumber)
      .min(9)
      .max(MAX_VERTICES * 3)
      .readonly(),
    indices: z
      .array(z.int().min(0))
      .min(3)
      .max(MAX_TRIANGLES * 3)
      .readonly(),
    bounds: Bounds,
    source: PartSource,
  })
  .superRefine((part, ctx) => {
    for (const problem of meshProblems(part)) ctx.addIssue({ code: 'custom', message: problem });
  })
  .readonly();
export type Part = z.infer<typeof Part>;

/**
 * 完整交付文档：version + parts；id 唯一，总顶点 / 总三角不超上限。
 *
 * 版本（决策 #113）：接受 v1 与 v2 两种文档（读取兼容旧文档）。v2 起部件可带 `material`；
 * v1 文档带 `material` 一律拒绝，提示升级为 2。
 *
 * `parts` 允许为空：运行期把"没有画出任何部件"当作合法文档，便于宿主统一处理失败与空稿；
 * 是否允许交付由上层提交闸门另行判定（agent 提交空稿应拒绝），不在这个数据 schema 里做。
 * 同理，单部件要求 positions ≥ 3 个顶点、indices ≥ 3 个且是 3 的倍数，空三角面片被拒绝。
 */
export const ModelDocument = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    parts: z.array(Part).max(MAX_PARTS).readonly(),
  })
  .superRefine((document, ctx) => {
    if (document.version === 1) {
      document.parts.forEach((part, index) => {
        if (part.material !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['parts', index, 'material'],
            message: 'version 1 不支持 material，请升级为 2',
          });
        }
      });
    }
    const ids = new Set<string>();
    document.parts.forEach((part, index) => {
      if (ids.has(part.id)) {
        ctx.addIssue({ code: 'custom', path: ['parts', index, 'id'], message: `部件 id 重复：${part.id}` });
      }
      ids.add(part.id);
    });
    let vertices = 0;
    let triangles = 0;
    for (const part of document.parts) {
      vertices += part.positions.length / 3;
      triangles += part.indices.length / 3;
    }
    if (vertices > MAX_VERTICES) {
      ctx.addIssue({ code: 'custom', message: `总顶点数超过上限 ${String(MAX_VERTICES)}：${String(vertices)}` });
    }
    if (triangles > MAX_TRIANGLES) {
      ctx.addIssue({ code: 'custom', message: `总三角数超过上限 ${String(MAX_TRIANGLES)}：${String(triangles)}` });
    }
  })
  .readonly();
export type ModelDocument = z.infer<typeof ModelDocument>;
