/**
 * 建模对象：createModel() 返回一个收集部件、生成 ModelDocument 的记录器。
 *
 * 负责：调用参数的运行期校验（除函数字段用 typeof 外全部走 zod）、按 operation 生成网格、
 * 解析并记录变换、部件 id 唯一、顶点 / 三角上限在添加时与 finish 时双重把关、
 * finish 返回独立快照且之后拒绝继续添加（避免交付件被后续调用污染）。
 * 不负责：schema 定义（schema.ts）、网格算法（box / revolve / extrude）、变换求值（transform.ts）、
 * 隔离执行与文件保存（后续 @pg/sandbox/modeling）。
 *
 * 公共选项：id,name,role,color 必填；role ∈ volume|roof|floor|connection；color 为小写 #rrggbb；
 * 可选 material（方块名或带状态写法，只查格式；注册表校验在运行反馈与体素导入两处）；
 * 可选 transform（Euler XYZ 弧度，缩放各轴 > 0，缺省单位变换）。
 */
import { bezierPoint } from './bezier.ts';
import { boxMesh } from './box.ts';
import { ModelError, formatIssues } from './errors.ts';
import { extrudeMesh } from './extrude.ts';
import { computeBounds } from './mesh.ts';
import { checkOutline } from './polygon.ts';
import { sampleRevolve, sampleSurface } from './parametric.ts';
import {
  BezierPointsSchema,
  BezierT,
  BoxOptionsSchema,
  ExtrudeOptionsSchema,
  MAX_PARTS,
  MAX_TRIANGLES,
  MAX_VERTICES,
  MODEL_VERSION,
  ModelDocument,
  Part,
  RevolveOptionsSchema,
  SurfaceOptionsSchema,
} from './schema.ts';
import type { PartSource, Point2, Role, TransformInput, Vec3 } from './schema.ts';
import { applyTransform, resolveTransform } from './transform.ts';

/** 所有部件共有的选项。 */
export interface CommonOptions {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly color: string;
  readonly material?: string;
  readonly transform?: TransformInput;
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

/** surface：参数曲面，position(u, v) → [x, y, z]，u、v ∈ [0, 1]。 */
export interface SurfaceOptions extends CommonOptions {
  readonly uSegments: number;
  readonly vSegments: number;
  readonly closedU?: boolean;
  readonly position: (u: number, v: number) => readonly [number, number, number];
}

/** 建模入口对象；模型代码在隔离进程里只拿到这个接口。 */
export interface Model {
  readonly box: (options: BoxOptions) => void;
  readonly revolve: (options: RevolveOptions) => void;
  readonly extrude: (options: ExtrudeOptions) => void;
  readonly surface: (options: SurfaceOptions) => void;
  readonly bezier: (points: readonly [Point2, Point2, Point2, Point2], t: number) => Point2;
  readonly finish: () => ModelDocument;
}

/** profile 字段与 position 字段的 typeof 检查在 parametric.ts（函数不序列化、不进 schema）。 */

interface PartDraft {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly color: string;
  readonly material?: string | undefined;
  readonly positions: number[];
  readonly indices: number[];
  readonly source: PartSource;
}

/** 创建一个建模记录器；同一对象上 finish 之后不能再添加部件。 */
export function createModel(): Model {
  const parts: Part[] = [];
  const ids = new Set<string>();
  let vertexTotal = 0;
  let triangleTotal = 0;
  let finished = false;

  function assertActive(operation: string): void {
    if (finished) {
      throw new ModelError(
        `finish() 之后不能再调用 ${operation}：已交付的 ModelDocument 是独立快照，不会随新调用变化；请新建 createModel()。`,
      );
    }
  }

  function addPart(draft: PartDraft): void {
    if (ids.has(draft.id)) throw new ModelError(`部件 id 重复：${draft.id}（每个部件的 id 必须唯一）`);
    if (parts.length >= MAX_PARTS) throw new ModelError(`部件数已达上限 ${String(MAX_PARTS)}，不能再添加 ${draft.id}`);
    const vertexCount = draft.positions.length / 3;
    const triangleCount = draft.indices.length / 3;
    if (vertexTotal + vertexCount > MAX_VERTICES) {
      throw new ModelError(
        `总顶点数将超过上限 ${String(MAX_VERTICES)}：已有 ${String(vertexTotal)}，本部件 ${String(vertexCount)}`,
      );
    }
    if (triangleTotal + triangleCount > MAX_TRIANGLES) {
      throw new ModelError(
        `总三角数将超过上限 ${String(MAX_TRIANGLES)}：已有 ${String(triangleTotal)}，本部件 ${String(triangleCount)}`,
      );
    }
    const candidate: Part = {
      id: draft.id,
      name: draft.name,
      role: draft.role,
      color: draft.color,
      ...(draft.material === undefined ? {} : { material: draft.material }),
      positions: draft.positions,
      indices: draft.indices,
      bounds: computeBounds(draft.positions),
      source: draft.source,
    };
    const parsed = Part.safeParse(candidate);
    if (!parsed.success) throw new ModelError(`部件 ${draft.id} 的网格非法：${formatIssues(parsed.error.issues)}`);
    parts.push(parsed.data);
    ids.add(parsed.data.id);
    vertexTotal += vertexCount;
    triangleTotal += triangleCount;
  }

  function box(options: BoxOptions): void {
    assertActive('box');
    const parsed = BoxOptionsSchema.safeParse(options);
    if (!parsed.success) throw new ModelError(`box 参数无效：${formatIssues(parsed.error.issues)}`);
    const data = parsed.data;
    const size: Vec3 = [data.size[0], data.size[1], data.size[2]];
    const transform = resolveTransform(data.transform);
    const mesh = applyTransform(boxMesh(size), transform);
    addPart({
      id: data.id,
      name: data.name,
      role: data.role,
      color: data.color,
      material: data.material,
      positions: mesh.positions,
      indices: mesh.indices,
      source: { operation: 'box', parameters: { size, transform } },
    });
  }

  function revolve(options: RevolveOptions): void {
    assertActive('revolve');
    const parsed = RevolveOptionsSchema.safeParse(options);
    if (!parsed.success) throw new ModelError(`revolve 参数无效：${formatIssues(parsed.error.issues)}`);
    const data = parsed.data;
    const sampled = sampleRevolve({
      profile: data.profile,
      ...(data.profileSegments === undefined ? {} : { profileSegments: data.profileSegments }),
      ...(data.radialSegments === undefined ? {} : { radialSegments: data.radialSegments }),
      ...(data.transform === undefined ? {} : { transform: data.transform }),
    });
    addPart({
      id: data.id,
      name: data.name,
      role: data.role,
      color: data.color,
      material: data.material,
      positions: sampled.positions,
      indices: sampled.indices,
      source: { operation: 'revolve', parameters: sampled.parameters },
    });
  }

  function extrude(options: ExtrudeOptions): void {
    assertActive('extrude');
    const parsed = ExtrudeOptionsSchema.safeParse(options);
    if (!parsed.success) throw new ModelError(`extrude 参数无效：${formatIssues(parsed.error.issues)}`);
    const data = parsed.data;
    const checked = checkOutline(data.outline);
    if (!checked.ok) throw new ModelError(`extrude 轮廓非法：${checked.error}`);
    const transform = resolveTransform(data.transform);
    const mesh = applyTransform(extrudeMesh(checked.outline, data.height, checked.convex), transform);
    addPart({
      id: data.id,
      name: data.name,
      role: data.role,
      color: data.color,
      material: data.material,
      positions: mesh.positions,
      indices: mesh.indices,
      source: { operation: 'extrude', parameters: { outline: checked.outline, height: data.height, transform } },
    });
  }

  function surface(options: SurfaceOptions): void {
    assertActive('surface');
    const parsed = SurfaceOptionsSchema.safeParse(options);
    if (!parsed.success) throw new ModelError(`surface 参数无效：${formatIssues(parsed.error.issues)}`);
    const data = parsed.data;
    const sampled = sampleSurface({
      position: data.position,
      uSegments: data.uSegments,
      vSegments: data.vSegments,
      ...(data.closedU === undefined ? {} : { closedU: data.closedU }),
      ...(data.transform === undefined ? {} : { transform: data.transform }),
    });
    addPart({
      id: data.id,
      name: data.name,
      role: data.role,
      color: data.color,
      material: data.material,
      positions: sampled.positions,
      indices: sampled.indices,
      source: { operation: 'surface', parameters: sampled.parameters },
    });
  }

  function bezier(points: readonly [Point2, Point2, Point2, Point2], t: number): Point2 {
    const parsedPoints = BezierPointsSchema.safeParse(points);
    if (!parsedPoints.success) {
      throw new ModelError(`bezier 的 points 必须是 4 个 [number, number]：${formatIssues(parsedPoints.error.issues)}`);
    }
    const parsedT = BezierT.safeParse(t);
    if (!parsedT.success) throw new ModelError(`bezier 的 t 必须是有限数：${formatIssues(parsedT.error.issues)}`);
    return bezierPoint(parsedPoints.data, parsedT.data);
  }

  function finish(): ModelDocument {
    const parsed = ModelDocument.safeParse({ version: MODEL_VERSION, parts });
    if (!parsed.success) throw new ModelError(`finish 生成的 ModelDocument 非法：${formatIssues(parsed.error.issues)}`);
    finished = true;
    return parsed.data;
  }

  return { box, revolve, extrude, surface, bezier, finish };
}
