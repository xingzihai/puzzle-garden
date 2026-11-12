/** 构件共用数据与基础参数的唯一 schema；不生成几何，也不访问世界状态。 */
import { z } from 'zod';
import { XZ_MIN, XZ_MAX, Y_MIN, Y_MAX } from '@pg/core/coord';
import { MAX_SEGMENTS, MIN_SEGMENTS, Transform } from '@pg/modeling/schema';
import { MAX_THICKNESS } from '@pg/modeling/voxelize';

const horizontal = z.int().min(XZ_MIN).max(XZ_MAX);
const vertical = z.int().min(Y_MIN).max(Y_MAX);
const polygonPointsSchema = z
  .array(z.tuple([horizontal, horizontal]).readonly())
  .min(3)
  .readonly();
export const positive = z.int().positive();
export const sideSchema = z.enum(['north', 'south', 'east', 'west']);
export type Side = z.infer<typeof sideSchema>;
export const pointSchema = z.tuple([horizontal, vertical, horizontal]).readonly();
export type Point = z.infer<typeof pointSchema>;
/**
 * `pgOpaque` 是给 `tools/generate-world.ts` 的元数据：生成模型声明时把这个 schema 折叠成同名的不透明类型，
 * 不展开内部字段（polygon / apse / storeyHeight / corner），模型只能从当前世界的返回值拿到它。
 */
export const footprintSchema = z
  .strictObject({
    minX: horizontal,
    minZ: horizontal,
    maxX: horizontal,
    maxZ: horizontal,
    polygon: polygonPointsSchema.optional(),
    apse: z.literal(true).optional(),
  })
  .refine((r) => r.minX <= r.maxX && r.minZ <= r.maxZ, '占地最小坐标必须不大于最大坐标')
  .readonly()
  .meta({ pgOpaque: 'Footprint' });
export type Footprint = z.infer<typeof footprintSchema>;
export const surfaceSchema = z
  .strictObject({ footprint: footprintSchema, y: vertical })
  .readonly()
  .meta({ pgOpaque: 'Surface' });
export type Surface = z.infer<typeof surfaceSchema>;
export const facadeSchema = z
  .strictObject({
    footprint: footprintSchema,
    y: vertical,
    height: positive,
    thickness: positive,
    side: sideSchema,
    storeyHeight: positive.optional(),
    /** false：这条边两端没有相邻立面的墙（台基边），洞可以开到端点。缺省按外墙处理，两端各 thickness 格是转角。 */
    corner: z.literal(false).optional(),
  })
  .readonly()
  .meta({ pgOpaque: 'Facade' });
export type Facade = z.infer<typeof facadeSchema>;
export const writeLayerSchema = z.enum(['decoration', 'structure', 'opening']);
export type WriteLayer = z.infer<typeof writeLayerSchema>;

export const plinthSchema = z
  .strictObject({
    footprint: z
      .union([footprintSchema, z.strictObject({ points: polygonPointsSchema }).readonly()])
      .describe('承托轮廓（外墙或柱落在其上），不含外挑；手写用 rect 或 { points }')
      .optional(),
    under: surfaceSchema.describe('反推：台基顶面贴在该表面下方；与 footprint / y 互斥').optional(),
    y: vertical.default(1),
    height: positive,
    project: z.int().nonnegative().default(0).describe('向四边外挑的格数'),
    material: z.string(),
  })
  .readonly()
  .refine(
    (p) => (p.footprint === undefined) !== (p.under === undefined),
    '台基位置必须选 footprint 或 under，不能混用或缺项',
  )
  .describe('台基：承托轮廓向四边外挑，顶部可承托外墙。');
const wallFields = {
  thickness: positive.describe('墙厚，向内长；footprint 是外轮廓').default(1),
  material: z.string(),
  outline: z.enum(['rect', 'apse']).default('rect'),
  bands: z
    .array(z.strictObject({ from: z.int().nonnegative(), to: z.int().nonnegative(), material: z.string() }).readonly())
    .readonly()
    .default([])
    .describe('从墙底 0 起算的闭区间换材质，区间互不重叠'),
};
const storeysSchema = z
  .strictObject({ count: positive, height: z.int().min(4) })
  .readonly()
  .describe('楼层：层数 × 层高（层高 ≥ 4，为一格楼板与通行净空留空间）');
const wallHeight = [{ height: positive }, { storeys: storeysSchema }] as const;
/** 外墙的 on 只接表面锚点：墙底落在其上。 */
const wallOn = surfaceSchema.describe('墙底落在该表面上');
export const wallsSchema = z
  .union([
    z.strictObject({ on: wallOn, ...wallFields, ...wallHeight[0] }).readonly(),
    z.strictObject({ on: wallOn, ...wallFields, ...wallHeight[1] }).readonly(),
    z.strictObject({ footprint: footprintSchema, y: vertical, ...wallFields, ...wallHeight[0] }).readonly(),
    z.strictObject({ footprint: footprintSchema, y: vertical, ...wallFields, ...wallHeight[1] }).readonly(),
  ])
  .describe('外墙：只写墙厚，内部留空；返回立面与墙顶。')
  // 生成声明时把另一支的字段写成 `?: never`（参数写法二选一，预检就能拦住同时传）；
  // 运行期解析失败时 pgChoices 用来生成"写法二选一"的中文报错。
  .meta({
    pgExclusive: [['on'], ['footprint', 'y']],
    pgChoices: [
      { label: 'on', keys: ['on'] },
      { label: 'footprint + y', keys: ['footprint', 'y'] },
    ],
  });
export const openingSchema = z
  .strictObject({
    in: facadeSchema,
    kind: z.enum(['door', 'window', 'gate']),
    shape: z.enum(['rect', 'arch', 'pointed', 'round']).default('rect'),
    width: positive.describe('洞的净宽，不含框'),
    height: positive.describe('洞的净高，不含框'),
    sill: z
      .int()
      .nonnegative()
      .default(0)
      .describe('洞底距站立面的格数：普通外墙从墙底算；repeat.storeys 时从该层楼板顶面（楼板厚 1）算'),
    storey: z.int().nonnegative().optional().describe('需 storeys；与 repeat.storeys 互斥'),
    at: z.int().default(0).describe('洞中心相对立面中点的偏移：南北立面 +x、东西立面 +z 为正'),
    fill: z.string().default('air').describe('洞内填充（玻璃、门等）；填了就不能接踏步'),
    repeat: z
      .union([
        z.strictObject({ every: positive }).readonly(),
        z.strictObject({ storeys: z.array(z.int().nonnegative()).min(1).readonly() }).readonly(),
      ])
      .optional(),
    canopy: z
      .strictObject({ depth: positive, material: z.string() })
      .readonly()
      .optional()
      .describe('洞顶外挑的雨棚：depth 为向外伸出的格数，只覆盖本洞宽度'),
    frame: z
      .strictObject({ width: positive.default(1), material: z.string() })
      .readonly()
      .optional()
      .describe('外侧一圈框：默认宽 1，会凸出墙外 1 格'),
    mullion: z
      .strictObject({ every: z.int().min(2).default(2), material: z.string() })
      .readonly()
      .optional()
      .describe('只用于矩形窗；width = k·every + 1'),
  })
  .readonly()
  .describe('开洞：贯穿墙厚，优先于结构，门框不会堵住通道。');

const plateFields = { thickness: positive.default(1), material: z.string() };
export const floorPlateSchema = z
  .union([
    z.strictObject({ in: surfaceSchema, ...plateFields }).readonly(),
    z.strictObject({ footprint: footprintSchema, y: vertical, ...plateFields }).readonly(),
  ])
  .describe('楼板：在内部区域或楼层锚点铺板，梯孔由楼梯自动开通。')
  .meta({
    pgExclusive: [['in'], ['footprint', 'y']],
    pgChoices: [
      { label: 'in', keys: ['in'] },
      { label: 'footprint + y', keys: ['footprint', 'y'] },
    ],
  });
const stairFields = {
  from: surfaceSchema.describe('下站立面（起点）'),
  to: surfaceSchema.describe('上站立面（终点）；去屋顶用平屋面的 roof.top'),
  at: z.tuple([horizontal, horizontal]).readonly().describe('首级格，也是该跑中线'),
  facing: sideSchema
    .default('east')
    .describe('上楼方向，入口在首级反方向一格；switchback 第二跑在南北朝向的 +x 侧、东西朝向的 +z 侧'),
  material: z.string(),
};
export const stairSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ ...stairFields, kind: z.literal('straight'), width: positive.default(1) }).readonly(),
    z.strictObject({ ...stairFields, kind: z.literal('switchback'), width: positive.default(1) }).readonly(),
    z
      .strictObject({ ...stairFields, kind: z.literal('spiral'), radius: positive.describe('方形螺旋半径，at 为中心') })
      .readonly(),
  ])
  .describe('楼梯：连接两个表面，自动设置楼梯朝向并保留踏面与头顶净空。')
  // material 在声明里收窄为楼梯类方块名（运行期 circulation.material 已校验）。
  .meta({
    pgMaterial: 'stair',
    pgChoices: [
      { label: "kind: 'straight'", keys: ['kind'] },
      { label: "kind: 'switchback'", keys: ['kind'] },
      { label: "kind: 'spiral'", keys: ['kind'] },
    ],
  });
export const entranceSchema = z
  .strictObject({
    side: sideSchema,
    bounds: z.strictObject({ min: pointSchema, max: pointSchema }).readonly(),
  })
  .readonly()
  .meta({ pgOpaque: 'Opening' });
export const stepsSchema = z
  .strictObject({
    to: entranceSchema.describe('未填充的门洞或院门，或 plinth.edge(side)'),
    width: positive,
    material: z.string(),
  })
  .readonly()
  .describe('踏步：从地表走到门洞或台基边，自动设置朝向并接齐入口。')
  .meta({ pgMaterial: 'stair' });

const located = { footprint: footprintSchema.optional(), y: vertical.optional() };
function validLocation(p: {
  readonly on?: Surface | undefined;
  readonly footprint?: Footprint | undefined;
  readonly y?: number | undefined;
}): boolean {
  return p.on === undefined
    ? p.footprint !== undefined && p.y !== undefined
    : p.footprint === undefined && p.y === undefined;
}
const ornament = z.strictObject({ height: positive, material: z.string() }).readonly();
export const roofSchema = z
  .strictObject({
    on: surfaceSchema.describe('外墙或柱廊，从其顶面起坡').optional(),
    ...located,
    kind: z.enum(['gable', 'hip', 'pyramid', 'shed', 'flat']),
    ridge: z.enum(['x', 'z']).optional().describe('屋脊方向；shed 高侧在 ridge x 的 +z 侧、ridge z 的 +x 侧'),
    high: sideSchema.optional().describe('单坡高侧所在边；与 ridge 二选一'),
    // 坡度上限 8：再陡就接近竖墙，按塔身而不是屋面写；8 足够容纳 v0.2 人工方案里最陡的尖顶（约 1.7）。
    pitch: z.number().positive().max(8).optional().describe('每内缩一格升高 pitch 格；与 peakY 二选一'),
    peakY: vertical.optional().describe('直接给尖顶 y；与 pitch 二选一'),
    // 出檐圈数：墙外这几圈保持在承托面高度，就是檐口（决策 #61 去掉了与它重复的 eave）。
    overhang: z.int().nonnegative().default(1).describe('出檐圈数，檐口保持承托面高度'),
    thickness: positive.default(1),
    parapet: ornament.optional().describe('仅平屋面；会返回可站立的 top'),
    finial: ornament.optional(),
    // 双坡、单坡的山墙材质。挂在外墙上（on: walls）时缺省用外墙材质；false 不封山墙（决策 #63）。
    gableMaterial: z.union([z.string(), z.literal(false)]).optional(),
    material: z.string(),
  })
  .refine(validLocation, '位置必须用 on 或 footprint + y，不能混用或缺项')
  .superRefine((p, ctx) => {
    if (p.high !== undefined && p.kind !== 'shed')
      ctx.addIssue({ code: 'custom', message: `roof.high 只用于 kind:'shed'，收到 kind=${p.kind}` });
  })
  .refine((p) => p.high === undefined || p.ridge === undefined, 'roof.high 与 ridge 二选一：high 已决定屋脊方向')
  .refine((p) => !(p.pitch !== undefined && p.peakY !== undefined), 'pitch 与 peakY 二选一')
  .refine(
    (p) =>
      p.kind === 'flat'
        ? p.ridge === undefined && p.pitch === undefined && p.peakY === undefined && p.finial === undefined
        : p.parapet === undefined,
    '平屋面不接受 ridge / pitch / peakY / finial；坡屋面不接受 parapet',
  )
  .refine(
    (p) => (p.kind !== 'pyramid' && p.kind !== 'hip') || p.ridge === undefined,
    'hip / pyramid 不接受 ridge，轮廓决定屋脊',
  )
  .readonly()
  .describe('屋面：默认竖向一格薄壳与一圈檐口，平屋面可承托上方体块。')
  // 生成声明时把两个互斥参数做成"至多一个"的联合，预检拦住同时传（运行期 refine 已校验）。
  .meta({ pgAtMostOne: [['pitch', 'peakY']] });
export const colonnadeSchema = z
  .strictObject({
    on: surfaceSchema.describe('外墙或台基，从其顶面起柱').optional(),
    ...located,
    spacing: positive.optional(),
    count: z.int().min(4).optional(),
    height: positive,
    column: z
      .strictObject({
        width: positive.default(1),
        material: z.string(),
        shape: z.enum(['square', 'cross']).default('square').describe('cross：方芯四面各加一格；柱芯间距至少 w+3'),
      })
      .readonly(),
    beam: z
      .union([z.literal(false), z.strictObject({ height: positive.default(1), material: z.string() }).readonly()])
      .optional(),
  })
  .refine(validLocation, '位置必须用 on 或 footprint + y')
  .refine((p) => (p.spacing === undefined) !== (p.count === undefined), 'spacing 与 count 必须选一个')
  .readonly()
  .describe('柱廊：矩形轮廓四角起柱，按间距或总根数布柱，默认带额枋。');
export const railSchema = z
  .strictObject({
    along: surfaceSchema,
    height: positive.default(1),
    material: z.string(),
    gaps: z
      .array(z.strictObject({ side: sideSchema, at: z.int().default(0), width: positive }).readonly())
      .readonly()
      .default([]),
  })
  .readonly()
  .describe('栏杆：沿平台外缘一次围合；门洞与梯道的开洞层自动保留通路。');
export const enclosureSchema = z
  .strictObject({
    outline: footprintSchema,
    y: vertical.default(1),
    height: positive,
    thickness: positive.default(1),
    material: z.string(),
    gate: z
      .strictObject({
        side: sideSchema,
        at: z.int().default(0),
        width: positive,
        height: positive,
        gatehouse: z
          .strictObject({
            depth: positive,
            width: positive,
            height: positive,
            material: z.string(),
            outward: z.int().nonnegative().default(0).describe('伸出院墙外，上限 depth − thickness'),
          })
          .readonly()
          .optional(),
      })
      .readonly(),
  })
  .readonly()
  .describe('院墙：围合院落并贯通门洞，可包含整段挖通的门楼。');
const pavingPathSchema = z
  .strictObject({
    from: entranceSchema,
    to: z.union([positive, entranceSchema]),
    width: positive,
    material: z.string(),
  })
  .readonly();
const pavingRegionSchema = z
  .strictObject({
    region: footprintSchema.describe('整片铺满矩形（y=1）'),
    material: z.string(),
  })
  .readonly();
export const pavingSchema = z
  .union([pavingPathSchema, pavingRegionSchema])
  .describe('铺装：从入口向外铺指定长度、连接另一个入口，或整片铺满矩形，铺在 y=1。')
  .meta({
    pgExclusive: [['from', 'to', 'width'], ['region']],
    pgChoices: [
      { label: 'from + to + width', keys: ['from', 'to', 'width'] },
      { label: 'region', keys: ['region'] },
    ],
  });
/**
 * 草模导入选项（MASSING-CONVERSION-SPEC §5.3、§6、§7）：文档 id 是方法的第一个参数，这里只描述选项。
 * 状态离线通过（API-EVOLUTION §2，决策 #114）：M1c 集成测试经真实沙箱资产通道执行通过后进入模型可见声明。
 */
export const massingImportSchema = z
  .strictObject({
    at: pointSchema.default([0, 1, 0]).describe('草模原点（文档 y=0 平面）落在的世界格；默认 [0, 1, 0]'),
    rotate: z
      .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
      .default(0)
      .describe('绕 y 逆时针旋转的角度；只接受 0 / 90 / 180 / 270'),
    mode: z
      .enum(['shell', 'solid'])
      .optional()
      .describe('整次导入的体素模式；缺省按部件 role（roof 为 shell，其余 solid）'),
    thickness: z.int().min(1).max(4).optional().describe('壳模式厚度 1–4（默认 1）；对 solid 部件传会报错'),
    material: z.string().optional().describe('整次统一的方块材质；优先于部件自带 material'),
    materials: z
      .record(z.string(), z.string())
      .readonly()
      .optional()
      .describe('按部件 id 覆盖材质；优先于 material，键必须是文档里的部件 id'),
    cleanup: z.enum(['isolated', 'none']).optional().describe('孤立格清理；默认 isolated'),
  })
  .readonly()
  .describe(
    '草模导入：把 massing 工具返回的文档 id 体素化并入当前建筑；任一格 y<1 整次拒绝。' +
      'id 来自 massing 工具（先登记再引用，不认识的 id 报 asset-missing）；at 默认 [0, 1, 0]，' +
      'rotate 只接受 0/90/180/270；材质优先级 materials[部件id] > material > 部件自带 material > 按 role+颜色取默认映射。',
  );
/**
 * 参数化壳构件（SURFACE-SHELL-SPEC §2、§3，M3 B 组）：一个构件覆盖参数曲面与旋转壳两种几何。
 * 状态离线通过（决策 #116）：六角亭屋面 / 穹顶夹具（shell-fixtures.test.ts）离线通过后与 API 9 一起进声明。
 */
const shellCommonFields = {
  at: pointSchema.default([0, 1, 0]).describe('局部原点（公式 y=0 平面）落在的世界格；默认 [0, 1, 0]（贴地表）'),
  rotate: z
    .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
    .default(0)
    .describe('绕 y 逆时针旋转的角度；只接受 0 / 90 / 180 / 270'),
  transform: Transform.optional().describe(
    '建模变换（Euler XYZ 弧度、缩放各轴 >0）：体素化前作用于采样网格；与格旋转 rotate 相互独立',
  ),
  thickness: z
    .int()
    .min(1)
    .max(MAX_THICKNESS)
    .optional()
    .describe(`壳厚 1–${String(MAX_THICKNESS)} 格；solid:true 时不能传`),
  solid: z.boolean().default(false).describe('false＝壳（默认）；true＝表壳＋内部填充，开放壳回退为壳并在句柄标 leaky'),
  material: z.string().describe('结构层方块材质（必填）；未知方块与空气报 material-invalid'),
  name: z.string().min(1).max(128).optional().describe('部件名；缺省 surfaceShell'),
  cleanup: z.enum(['isolated', 'none']).optional().describe('孤立格清理；默认 isolated'),
};
const shellSegment = z.int().min(MIN_SEGMENTS).max(MAX_SEGMENTS);
const shellSurfaceSchema = z
  .strictObject({
    kind: z.literal('surface'),
    position: z
      .unknown()
      .describe('参数曲面 (u: number, v: number) => readonly [x, y, z]；u、v ∈ [0, 1]')
      .meta({ pgType: '(u: number, v: number) => readonly [number, number, number]' }),
    uSegments: shellSegment.default(32).describe('u 方向采样段数（4–128）'),
    vSegments: shellSegment.default(32).describe('v 方向采样段数（4–128）'),
    closedU: z.boolean().default(false).describe('true 时 u 方向首尾无缝（不复制缝合列）'),
    ...shellCommonFields,
  })
  .readonly();
const shellRevolveSchema = z
  .strictObject({
    kind: z.literal('revolve'),
    profile: z
      .unknown()
      .describe('旋转母线 (t: number) => readonly [radius, height]；绕局部 +y，t ∈ [0, 1]')
      .meta({ pgType: '(t: number) => readonly [number, number]' }),
    profileSegments: shellSegment.default(32).describe('母线采样段数（4–128）'),
    radialSegments: shellSegment.default(48).describe('环向采样段数（4–128）'),
    ...shellCommonFields,
  })
  .readonly();
export const surfaceShellSchema = z
  .discriminatedUnion('kind', [shellSurfaceSchema, shellRevolveSchema])
  .describe(
    '参数化壳：kind:"surface" 写 position 公式、kind:"revolve" 写 profile 母线；采样后体素化并入建筑，写结构层。' +
      'at 默认 [0, 1, 0]，rotate 只接受 0/90/180/270，任一格 y<1 或越界整次拒绝；' +
      'solid:true 填充内部（开放壳回退为壳并在句柄 leaky 标出）；一次调用一个部件，来源 api=surfaceShell。',
  )
  .meta({
    pgChoices: [
      { label: "kind: 'surface'", keys: ['kind'] },
      { label: "kind: 'revolve'", keys: ['kind'] },
    ],
  });

/**
 * 解析 surfaceShell 选项：先只认 kind，再按分支严格解析。
 *
 * 为什么不用 `parse(surfaceShellSchema, …)`：判别联合把分支内的字段错误（rotate、未知键、缺 material）
 * 包成 invalid_union，`formatParseError` 会输出"写法二选一"的误导文案；按 kind 选分支后
 * 字段级错误可直接可行动。声明与说明仍用联合 schema 生成。
 */
export function parseSurfaceShellOptions(value: unknown): z.output<typeof surfaceShellSchema> {
  const kind = z.object({ kind: z.enum(['surface', 'revolve']) }).safeParse(value);
  if (!kind.success) {
    throw new Error(
      "kind 必须是 'surface' 或 'revolve'（kind:'surface' 需要 position 函数；kind:'revolve' 需要 profile 函数）",
    );
  }
  return kind.data.kind === 'surface' ? parse(shellSurfaceSchema, value) : parse(shellRevolveSchema, value);
}
/** 镜像轴允许整数或半格（.5，如 0.5 表示轴在格 0 与格 1 之间）；反射后坐标仍是整数。 */
const mirrorAt = z
  .number()
  .min(XZ_MIN)
  .max(XZ_MAX)
  .refine((v) => Number.isInteger(v * 2), '镜像轴 at 只能是整数或半格（如 2.5）');
export const mirrorSchema = z.strictObject({ axis: z.enum(['x', 'z']), at: mirrorAt }).readonly();

/** `API-EVOLUTION.md` §2 的状态字面量；只有 `offline-pass` 及之后的状态进入模型可见声明。 */
export type ApiStatus = 'candidate' | 'offline-pass' | 'stable' | 'needs-work' | 'deprecated';
/** 构件状态集中登记；`candidate` 不进入模型可见声明。13 个构件已离线通过（决策 #72；massingImport 见 #114、surfaceShell 见 #116）。 */
export const componentSchemas = Object.freeze({
  plinth: { schema: plinthSchema, status: 'offline-pass' },
  walls: { schema: wallsSchema, status: 'offline-pass' },
  opening: { schema: openingSchema, status: 'offline-pass' },
  floorPlate: { schema: floorPlateSchema, status: 'offline-pass' },
  stair: { schema: stairSchema, status: 'offline-pass' },
  steps: { schema: stepsSchema, status: 'offline-pass' },
  roof: { schema: roofSchema, status: 'offline-pass' },
  colonnade: { schema: colonnadeSchema, status: 'offline-pass' },
  rail: { schema: railSchema, status: 'offline-pass' },
  enclosure: { schema: enclosureSchema, status: 'offline-pass' },
  paving: { schema: pavingSchema, status: 'offline-pass' },
  massingImport: { schema: massingImportSchema, status: 'offline-pass' },
  surfaceShell: { schema: surfaceShellSchema, status: 'offline-pass' },
} satisfies Record<string, { readonly schema: z.ZodType; readonly status: ApiStatus }>);

/** 联合参数"写法二选一"的元数据形状；由各 schema 的 `pgChoices` 登记。 */
const choicesSchema = z.array(z.strictObject({ label: z.string(), keys: z.array(z.string()) }));

/** 对象输入的实际键；非对象返回空数组。 */
function providedKeys(value: unknown): readonly string[] {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

/**
 * 联合解析失败时给"写法二选一"的中文报错（`zod` 默认只说"无效输入"）：
 * 对 `z.union` / `z.discriminatedUnion` 的 `invalid_union`，列出各支标签并写出实际给了哪些键，
 * 让模型直接看出同时传了互斥字段。其余失败仍走 `prettifyError`。
 */
function formatParseError(schema: z.ZodType, value: unknown, error: z.ZodError): string {
  const choices = choicesSchema.safeParse(schema.meta()?.['pgChoices']);
  if (choices.success && choices.data.length > 0 && error.issues.some((i) => i.code === 'invalid_union')) {
    const given = providedKeys(value);
    const parts = choices.data.map((c, i) => `${String.fromCharCode(65 + i)}（${c.label}）`);
    const wrote = given.length === 0 ? '（没有可识别的参数）' : given.join('、');
    return choices.data.length === 2
      ? `构件参数不合法：写法二选一：${parts.join(' 或 ')}；你给了 ${wrote}。`
      : `构件参数不合法：写法只能选一种：${parts.join('、')}；你给了 ${wrote}。`;
  }
  return `构件参数不合法：${z.prettifyError(error)}`;
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value, { error: z.locales.zhCN().localeError });
  if (!result.success) {
    throw new Error(formatParseError(schema, value, result.error));
  }
  return result.data;
}

export function rect(minX: number, minZ: number, maxX: number, maxZ: number): Footprint {
  return parse(footprintSchema, { minX, minZ, maxX, maxZ });
}
