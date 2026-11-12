/**
 * 模型可见类型声明字符串：与包根 `model.d.ts` 同源，供隔离沙箱预检直接读取，避免再拼一份。
 *
 * 负责：以常量形式保存 `export default function build(model: Model)` 所需的全部类型声明，
 * 并提供 modelDeclaration() 取值函数。
 * 不负责：真正的类型检查（@pg/sandbox 后续步骤）、运行期 schema（schema.ts）。
 * 一致性由 declaration.test.ts 逐字符比对 model.d.ts 保证。
 */

/** 与 packages/modeling/model.d.ts 逐字符相同的声明文本（含末尾换行）。 */
export const MODEL_DECLARATION = `// 模型可见声明（docs/MODELING-SPEC.md §3）：与 src/declaration.ts 的 MODEL_DECLARATION 同源，由 declaration.test.ts 校验。
// 模型代码入口：export default function build(model: Model): void；无 import、无异步、不返回结果。
// 数值约定：坐标与顶点允许有限浮点，绝对值 ≤ 100000；色值为小写 #rrggbb；变换为 Euler XYZ 弧度，缩放各轴 > 0。

/** 只读三元组 [x, y, z]。 */
export type Vec3 = readonly [number, number, number];
/** 只读二元组；在 outline 里是 (x, z)，在 profile 返回值里是 [radius, height]。 */
export type Point2 = readonly [number, number];
/** 部件角色。 */
export type PartRole = 'volume' | 'roof' | 'floor' | 'connection';
/** 每部件变换；缺省单位变换。 */
export interface Transform {
  readonly translate?: Vec3;
  readonly rotate?: Vec3;
  readonly scale?: Vec3;
}
/** 所有部件共有的选项。 */
export interface CommonOptions {
  readonly id: string;
  readonly name: string;
  readonly role: PartRole;
  readonly color: string;
  /** 可选材质：可写方块名（如 deepslate_tiles）或带状态写法（如 oak_stairs[facing=north]）；在建模运行与体素导入两处校验。 */
  readonly material?: string;
  readonly transform?: Transform;
}
/** box：以局部原点为最小角，正尺寸。 */
export interface BoxOptions extends CommonOptions {
  readonly size: Vec3;
}
/** revolve：绕局部 +y 轴旋转母线，profile(t) → [radius, height]，t 从 0 到 1。 */
export interface RevolveOptions extends CommonOptions {
  readonly profile: (t: number) => Point2;
  readonly profileSegments?: number;
  readonly radialSegments?: number;
}
/** extrude：简单轮廓（凸或凹）沿 +y 拉伸，闭合顶底。 */
export interface ExtrudeOptions extends CommonOptions {
  readonly outline: readonly Point2[];
  readonly height: number;
}
/** surface：参数曲面，position(u, v) → [x, y, z]，u、v ∈ [0, 1]；v=0 或 v=vSegments 整行采样重合时自动收成单个尖点（扇面连接相邻行）。 */
export interface SurfaceOptions extends CommonOptions {
  readonly uSegments: number; // 整数 4..128
  readonly vSegments: number; // 整数 4..128
  readonly closedU?: boolean; // 默认 false；true 时 u 方向首尾相接（无缝）
  readonly position: (u: number, v: number) => readonly [number, number, number]; // u,v∈[0,1]
}
/** 部件包围盒。 */
export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}
/** 记录进 source 的已解析变换，三分量齐全。 */
export interface TransformDocument {
  readonly translate: Vec3;
  readonly rotate: Vec3;
  readonly scale: Vec3;
}
export interface BoxParameters {
  readonly size: Vec3;
  readonly transform: TransformDocument;
}
export interface RevolveParameters {
  readonly profileSegments: number;
  readonly radialSegments: number;
  readonly sampledProfile: readonly Point2[];
  readonly transform: TransformDocument;
}
export interface ExtrudeParameters {
  readonly outline: readonly Point2[];
  readonly height: number;
  readonly transform: TransformDocument;
}
export interface SurfaceParameters {
  readonly uSegments: number;
  readonly vSegments: number;
  readonly closedU: boolean;
  readonly transform: TransformDocument;
}
/** source 可辨识联合：operation 为判别字段，parameters 只含可序列化数据。 */
export type PartSource =
  | { readonly operation: 'box'; readonly parameters: BoxParameters }
  | { readonly operation: 'revolve'; readonly parameters: RevolveParameters }
  | { readonly operation: 'extrude'; readonly parameters: ExtrudeParameters }
  | { readonly operation: 'surface'; readonly parameters: SurfaceParameters };
/** 单个部件：平坦 xyz 顶点与三角索引，indices 每三个一组。 */
export interface Part {
  readonly id: string;
  readonly name: string;
  readonly role: PartRole;
  readonly color: string;
  /** 可选材质：可写方块名或带状态写法；在建模运行与体素导入两处校验。 */
  readonly material?: string;
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly bounds: Bounds;
  readonly source: PartSource;
}
/** finish 返回的完整文档；version 2 起部件可带 material，读取兼容 version 1 的旧文档。 */
export interface ModelDocument {
  readonly version: 1 | 2;
  readonly parts: readonly Part[];
}
/** 模型代码在隔离进程里只拿到这个接口。 */
export interface Model {
  readonly box: (options: BoxOptions) => void;
  readonly revolve: (options: RevolveOptions) => void;
  readonly extrude: (options: ExtrudeOptions) => void;
  readonly surface: (options: SurfaceOptions) => void;
  readonly bezier: (points: readonly [Point2, Point2, Point2, Point2], t: number) => Point2;
  readonly finish: () => ModelDocument;
}
`;

/** 返回模型可见声明字符串；沙箱预检可直接把它当虚拟 `.d.ts` 使用。 */
export function modelDeclaration(): string {
  return MODEL_DECLARATION;
}
