/**
 * 方案数据的唯一 schema 与推导类型（MASSING-SPEC §2）。
 *
 * 负责：定义 Vec3 / Bounds / Element / Space / Level / Clearance / Blueprint 的严格只读结构，
 * 校验字段取值范围、严格对象、id 唯一性与跨集合引用完整性。
 * 不负责：几何求交（见 checks.ts）、版本差异（见 diff.ts）、生成样例（见 example.ts）；
 * 也不执行任何外部代码，只做纯数据解析。
 *
 * 约定：x 东、y 上、z 南，坐标全为整数；单位与蓝图一致。色值统一小写 `#rrggbb`。
 */
import { z } from 'zod';

/** 各字段上限（docs/STANDARDS.md §3：字符串非空有合理上限、数组有上限）。 */
const ID_MAX = 64;
const NAME_MAX = 128;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const NOTE_MAX = 1000;
const LEVELS_MAX = 64;
const SPACES_MAX = 500;
const ELEMENTS_MAX = 5000;
const CLEARANCES_MAX = 200;
const NOTES_MAX = 100;

/** 色值只接受 6 位十六进制；不做大小写归一，调用方按原样保存。 */
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

const idSchema = z.string().min(1).max(ID_MAX);
const nameSchema = z.string().min(1).max(NAME_MAX);
/** z.int() 会拒绝浮点、NaN、±Infinity 以及超出安全整数范围的值。 */
const coordinate = z.int();

/** 只读三元组 [x, y, z]，坐标全为整数。 */
export const Vec3 = z.tuple([coordinate, coordinate, coordinate]).readonly();
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

/** 元素类别；marker 是标注点，不是实体，不参与净空侵入判定（见 checks.ts 文件头）。 */
export const ElementKind = z.enum(['wall', 'slab', 'stair', 'furnishing', 'glazing', 'landscape', 'marker']);
export type ElementKind = z.infer<typeof ElementKind>;

/** 形体：box 为轴对齐盒；wedge-x / wedge-z 为沿 x / z 的斜顶楔体；lathe 为绕 y 轴的旋转薄壳。 */
export const ElementShape = z.enum(['box', 'wedge-x', 'wedge-z', 'lathe']);
export type ElementShape = z.infer<typeof ElementShape>;

/** 楔体高端方向：1 表示正方向高端，−1 表示负方向高端。box 也需给值但语义被忽略。 */
export const Direction = z.union([z.literal(1), z.literal(-1)]);
export type Direction = z.infer<typeof Direction>;

/**
 * 旋转薄壳参数（仅 shape=lathe 使用）。只记整数参数，不在 schema 里采样浮点几何：
 * - kind：linear 直线母线（锥 / 台）；reciprocal 反比例母线（凹曲面）。
 * - curvature：反比例系数 k。linear 必须为 0；reciprocal 必须 ≥ 1（k=0 会退化成线性）。
 * - heightSegments / radialSegments：渲染沿高、绕轴的采样段数（整数）。
 * 半径由消费方按 kind 求值：linear r(t)=R·(1−t)；reciprocal r(t)=R·(1−t)/(1+k·t)，t∈[0,1]，
 * 底半径 R（t=0）、顶半径 0（t=1）；等价写法 R·(1+k)/(k·(1+k·t))−R/k。浮点几何交给渲染层。
 */
export const LatheProfile = z
  .strictObject({
    kind: z.enum(['linear', 'reciprocal']),
    curvature: z.int().min(0).max(20),
    heightSegments: z.int().min(4).max(128),
    radialSegments: z.int().min(8).max(128),
  })
  .superRefine((profile, ctx) => {
    if (profile.kind === 'linear' && profile.curvature !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['curvature'],
        message: `linear 的 curvature 必须为 0（直线母线），实际 ${String(profile.curvature)}`,
      });
    }
    if (profile.kind === 'reciprocal' && profile.curvature < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['curvature'],
        message: `reciprocal 的 curvature 必须 ≥ 1，实际 ${String(profile.curvature)}`,
      });
    }
  })
  .readonly();
export type LatheProfile = z.infer<typeof LatheProfile>;

/**
 * 实体元素。`level` 引用 Level.id，`spaceId` 可选引用 Space.id；
 * 这些引用在 Blueprint 层统一校验（单个元素无法自证引用是否存在于同一份方案）。
 * shape=lathe 必须带 profile，且 bounds 的 x/z 跨度相等偶数（轴在整数中心）、direction=1（轴沿 y 正向）；
 * 其他 shape 禁止 profile。lathe 只给整数参数与包围盒，不存实际曲面顶点。
 */
export const Element = z
  .strictObject({
    id: idSchema,
    name: nameSchema,
    level: idSchema,
    kind: ElementKind,
    bounds: Bounds,
    color: z.string().regex(COLOR_PATTERN, '颜色必须是 #rrggbb（6 位十六进制）'),
    shape: ElementShape,
    direction: Direction,
    spaceId: idSchema.optional(),
    profile: LatheProfile.optional(),
  })
  .superRefine((element, ctx) => {
    if (element.shape === 'lathe') {
      if (element.profile === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['profile'],
          message: 'shape=lathe 必须给出 profile（kind / curvature / heightSegments / radialSegments）',
        });
      }
      const spanX = element.bounds.max[0] - element.bounds.min[0];
      const spanZ = element.bounds.max[2] - element.bounds.min[2];
      if (spanX !== spanZ) {
        ctx.addIssue({
          code: 'custom',
          path: ['bounds'],
          message: `lathe 的 x、z 跨度必须相等（轴在水平中心），实际 x=${String(spanX)}、z=${String(spanZ)}`,
        });
      } else if (spanX % 2 !== 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['bounds'],
          message: `lathe 的 x、z 跨度必须为偶数（轴在整数中心），实际 ${String(spanX)}`,
        });
      }
      if (element.direction !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['direction'],
          message: `lathe 的轴沿 y 正向，direction 必须为 1，实际 ${String(element.direction)}`,
        });
      }
      return;
    }
    if (element.profile !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['profile'],
        message: `只有 shape=lathe 允许 profile，当前 shape=${element.shape}`,
      });
    }
  })
  .readonly();
export type Element = z.infer<typeof Element>;

/** 空间用途：room 房间、circulation 交通、void 挑空。 */
export const SpaceRole = z.enum(['room', 'circulation', 'void']);
export type SpaceRole = z.infer<typeof SpaceRole>;

/** 空间：可选显示的范围，不自动当实体（是否参与净空判定由具体元素决定，空间本身不参与）。 */
export const Space = z
  .strictObject({
    id: idSchema,
    name: nameSchema,
    level: idSchema,
    bounds: Bounds,
    role: SpaceRole,
    color: z.string().regex(COLOR_PATTERN, '颜色必须是 #rrggbb（6 位十六进制）'),
  })
  .readonly();
export type Space = z.infer<typeof Space>;

/** 楼层：elevation 为整数楼面标高（地下为负）。 */
export const Level = z.strictObject({ id: idSchema, name: nameSchema, elevation: z.int() }).readonly();
export type Level = z.infer<typeof Level>;

/**
 * 显式不得侵入的轴对齐净空区。`ignoreElementIds` 中的元素不参与本净空区的判定，
 * 引用必须指向同一份 Blueprint 里存在的元素（在 Blueprint 层校验）。
 */
export const Clearance = z
  .strictObject({
    id: idSchema,
    name: nameSchema,
    bounds: Bounds,
    ignoreElementIds: z.array(idSchema).max(ELEMENTS_MAX).readonly(),
  })
  .readonly();
export type Clearance = z.infer<typeof Clearance>;

/**
 * 完整方案。四个集合内的 id 各自唯一；元素 / 空间的 level、元素的 spaceId、
 * 净空的 ignoreElementIds 必须能解析到本方案内的对应 id，否则解析失败并逐条报出。
 */
export const Blueprint = z
  .strictObject({
    id: idSchema,
    revision: z.int().nonnegative(),
    title: z.string().min(1).max(TITLE_MAX),
    description: z.string().min(1).max(DESCRIPTION_MAX),
    levels: z.array(Level).min(1).max(LEVELS_MAX).readonly(),
    spaces: z.array(Space).max(SPACES_MAX).readonly(),
    elements: z.array(Element).max(ELEMENTS_MAX).readonly(),
    clearances: z.array(Clearance).max(CLEARANCES_MAX).readonly(),
    notes: z.array(z.string().min(1).max(NOTE_MAX)).max(NOTES_MAX).readonly(),
  })
  .superRefine((blueprint, ctx) => {
    const levelIds = new Set<string>();
    blueprint.levels.forEach((level, index) => {
      if (levelIds.has(level.id)) {
        ctx.addIssue({ code: 'custom', path: ['levels', index, 'id'], message: `楼层 id 重复：${level.id}` });
      }
      levelIds.add(level.id);
    });

    const spaceIds = new Set<string>();
    blueprint.spaces.forEach((space, index) => {
      if (spaceIds.has(space.id)) {
        ctx.addIssue({ code: 'custom', path: ['spaces', index, 'id'], message: `空间 id 重复：${space.id}` });
      }
      spaceIds.add(space.id);
      if (!levelIds.has(space.level)) {
        ctx.addIssue({
          code: 'custom',
          path: ['spaces', index, 'level'],
          message: `空间 ${space.id} 引用了不存在的楼层 ${space.level}`,
        });
      }
    });

    const elementIds = new Set<string>();
    blueprint.elements.forEach((element, index) => {
      if (elementIds.has(element.id)) {
        ctx.addIssue({ code: 'custom', path: ['elements', index, 'id'], message: `元素 id 重复：${element.id}` });
      }
      elementIds.add(element.id);
      if (!levelIds.has(element.level)) {
        ctx.addIssue({
          code: 'custom',
          path: ['elements', index, 'level'],
          message: `元素 ${element.id} 引用了不存在的楼层 ${element.level}`,
        });
      }
      if (element.spaceId !== undefined && !spaceIds.has(element.spaceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['elements', index, 'spaceId'],
          message: `元素 ${element.id} 引用了不存在的空间 ${element.spaceId}`,
        });
      }
    });

    const clearanceIds = new Set<string>();
    blueprint.clearances.forEach((clearance, index) => {
      if (clearanceIds.has(clearance.id)) {
        ctx.addIssue({ code: 'custom', path: ['clearances', index, 'id'], message: `净空 id 重复：${clearance.id}` });
      }
      clearanceIds.add(clearance.id);
      clearance.ignoreElementIds.forEach((reference, refIndex) => {
        if (!elementIds.has(reference)) {
          ctx.addIssue({
            code: 'custom',
            path: ['clearances', index, 'ignoreElementIds', refIndex],
            message: `净空 ${clearance.id} 忽略了不存在的元素 ${reference}`,
          });
        }
      });
    });
  })
  .readonly();
export type Blueprint = z.infer<typeof Blueprint>;
