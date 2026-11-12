/** world 的公开类型与句柄定义；不实现几何，也不登记调用（实现见 world.ts）。 */
import type { z } from 'zod';
import type { Bounds } from '@pg/core/grid';
import type { Role } from '@pg/modeling/schema';
import type { Composition } from './writer.ts';
import type {
  Surface,
  Facade,
  Side,
  Point,
  WriteLayer,
  Footprint,
  wallsSchema,
  pavingSchema,
  stairSchema,
  mirrorSchema,
  plinthSchema,
  openingSchema,
  floorPlateSchema,
  stepsSchema,
  roofSchema,
  colonnadeSchema,
  railSchema,
  enclosureSchema,
  massingImportSchema,
  surfaceShellSchema,
} from './schema.ts';

export interface OpeningHandle {
  readonly bounds: Bounds;
  readonly side: Side;
  /** 洞贯穿的墙厚；R6 找门内侧面一格用。 */
  readonly thickness: number;
}
export interface FacadeHandle extends Facade {
  /** 宿主调用编号（开洞的 Hole 只允许落在它上面，outside / frame / canopy 只允许擦碰它）。 */
  readonly host: number;
  readonly opening: (index: number) => OpeningHandle;
}
export interface PlinthHandle {
  readonly bounds: Bounds;
  readonly top: Surface;
  readonly edge: (side: Side) => FacadeHandle;
}
export interface WallsHandle {
  readonly bounds: Bounds;
  readonly top: Surface;
  readonly inner: Surface;
  readonly facade: (side: Side) => FacadeHandle;
  readonly storey: (index: number) => Surface;
}
export interface FloorPlateHandle {
  readonly bounds: Bounds;
  readonly top: Surface;
  readonly region: Surface;
}
export interface StairHandle {
  readonly bounds: Bounds;
  readonly path: readonly Point[];
}
export interface RoofHandle {
  readonly bounds: Bounds;
  readonly peak: Point;
  readonly eaveLine: Surface;
  /** 只有平屋面有承托面；坡屋面不能直接承托第二栋。 */
  readonly top?: Surface;
}
export interface ColonnadeHandle {
  readonly bounds: Bounds;
  readonly top: Surface;
  readonly bays: readonly Surface[];
}
export interface EnclosureHandle {
  readonly bounds: Bounds;
  readonly inner: Surface;
  readonly gate: OpeningHandle;
  /** 传了 gate.gatehouse 时必有；屋面挂 top 上会自动封山墙（§8.4）。 */
  readonly gatehouse?: { readonly bounds: Bounds; readonly top: Surface };
}
/** 草模导入的汇总计数（MASSING-CONVERSION-SPEC §4 的 counts，逐项与体素化内核一致）。 */
export interface MassingCounts {
  readonly parts: number;
  readonly cells: number;
  readonly triangles: number;
  readonly shellParts: number;
  readonly solidParts: number;
  readonly emptyParts: number;
  readonly leakyParts: number;
  readonly isolatedCells: number;
  readonly isolatedRemoved: number;
}
export interface MassingPartHandle {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  /** 放置后的世界格闭区间包围盒；该部件被清理成空时为 null。 */
  readonly bounds: Bounds | null;
  readonly cellCount: number;
}
export interface MassingHandle {
  /** 放置后的世界格闭区间包围盒；空结果在抛出 empty-import 前不会返回句柄。 */
  readonly bounds: Bounds | null;
  readonly parts: readonly MassingPartHandle[];
  readonly counts: MassingCounts;
}
/** 参数化壳的句柄（SURFACE-SHELL-SPEC §4）：只给世界包围盒与计数，不提供锚点。 */
export interface SurfaceShellHandle {
  /** 放置后的世界格闭区间包围盒；空壳在抛出 empty-shell 前不会返回句柄。 */
  readonly bounds: Bounds;
  readonly cellCount: number;
  /** solid:true 且曲面开放时回退为壳、未填内部；壳模式恒 false。 */
  readonly leaky: boolean;
}
export type SurfaceReference = Surface | { readonly top: Surface };
type LocatedInput<T> = Omit<T, 'on'> & { readonly on?: SurfaceReference };
type WallsInput = z.input<typeof wallsSchema>;
type WallsOptions =
  | Exclude<WallsInput, { readonly on: Surface }>
  | (Omit<Extract<WallsInput, { readonly on: Surface }>, 'on'> & { readonly on: Surface | { readonly top: Surface } });
type PavingPathInput = Extract<z.input<typeof pavingSchema>, { readonly from: unknown }>;
type StairInput = z.input<typeof stairSchema>;
type ReferencedStair<T> = T extends StairInput
  ? Omit<T, 'from' | 'to'> & {
      readonly from: SurfaceReference;
      readonly to: SurfaceReference;
    }
  : never;

export interface World {
  readonly set: (x: number, y: number, z: number, block: string, writeLayer?: WriteLayer) => void;
  readonly box: (from: Point, to: Point, block: string, writeLayer?: WriteLayer) => void;
  readonly get: (x: number, y: number, z: number) => string;
  readonly part: (name: string, fn: () => void) => void;
  readonly mirror: (options: z.input<typeof mirrorSchema>, fn: () => void) => void;
  readonly plinth: (
    options: Omit<z.input<typeof plinthSchema>, 'under'> & { readonly under?: SurfaceReference | undefined },
  ) => PlinthHandle;
  readonly walls: (options: WallsOptions) => WallsHandle;
  readonly opening: (
    options: Omit<z.input<typeof openingSchema>, 'in'> & { readonly in: FacadeHandle },
  ) => OpeningHandle;
  readonly floorPlate: (options: z.input<typeof floorPlateSchema>) => FloorPlateHandle;
  readonly stair: (options: ReferencedStair<StairInput>) => StairHandle;
  readonly steps: (
    options: Omit<z.input<typeof stepsSchema>, 'to'> & {
      readonly to: OpeningHandle | FacadeHandle;
    },
  ) => StairHandle;
  readonly roof: (options: LocatedInput<z.input<typeof roofSchema>>) => RoofHandle;
  readonly colonnade: (options: LocatedInput<z.input<typeof colonnadeSchema>>) => ColonnadeHandle;
  readonly rail: (options: Omit<z.input<typeof railSchema>, 'along'> & { readonly along: SurfaceReference }) => {
    readonly bounds: Bounds;
  };
  readonly enclosure: (options: z.input<typeof enclosureSchema>) => EnclosureHandle;
  readonly paving: (
    options:
      | { readonly region: Footprint; readonly material: string }
      | (Omit<PavingPathInput, 'from' | 'to'> & {
          readonly from: OpeningHandle;
          readonly to: number | OpeningHandle;
        }),
  ) => { readonly bounds: Bounds };
  /** 草模导入（模型可见）：id 来自 massing 工具，选项见 massingImportSchema。 */
  readonly massingImport: (id: string, options?: z.input<typeof massingImportSchema>) => MassingHandle;
  /** 参数化壳（模型可见，SURFACE-SHELL-SPEC）：公式采样→体素化→写结构层；选项见 surfaceShellSchema。 */
  readonly surfaceShell: (options: SurfaceShellInput) => SurfaceShellHandle;
}
/** surfaceShell 的输入：schema 里 position / profile 是 unknown（函数不进 schema），这里给出可调用的函数类型。 */
export type SurfaceShellInput = SurfaceShellSurfaceInput | SurfaceShellRevolveInput;
export type SurfaceShellSurfaceInput = Omit<
  Extract<z.input<typeof surfaceShellSchema>, { readonly kind: 'surface' }>,
  'position'
> & { readonly position: (u: number, v: number) => readonly [number, number, number] };
export type SurfaceShellRevolveInput = Omit<
  Extract<z.input<typeof surfaceShellSchema>, { readonly kind: 'revolve' }>,
  'profile'
> & { readonly profile: (t: number) => readonly [number, number] };
export interface WorldHost {
  readonly world: World;
  readonly compose: () => Composition;
}
