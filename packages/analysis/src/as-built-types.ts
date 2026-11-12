/**
 * 通用 as-built 对象图的类型（CONF-NEXT-02C 第一刀，`.work/conf-next-02-first-cut.md` §3）。
 *
 * 负责：7 类对象（wall / slab / roof / opening / site / furniture / unknown）与图级汇总的形状。
 * 不负责：提取逻辑（见 `as-built.ts`）、diff、submit。
 *
 * 本文件只含类型（外加 schema 版本字面量），按 tools/check-tests.ts 的规则不需要配对测试。
 */

import type { Sample } from './sample.ts';

export type ObjectKind = 'wall' | 'slab' | 'roof' | 'opening' | 'site' | 'furniture' | 'unknown';

export type Confidence = 'high' | 'medium' | 'low';
export type SupportState = 'grounded' | 'supported' | 'unsupported' | 'unknown';

/** 半开包围盒：一格 `(x,y,z)` 占 `[x,x+1) × [y,y+1) × [z,z+1)`。 */
export interface AsBuiltBounds {
  readonly min: readonly [number, number, number];
  /** 半开上界，每轴 max > min。 */
  readonly max: readonly [number, number, number];
}

export interface MaterialCount {
  /** 规范方块名（`state.name`），不含属性。 */
  readonly block: string;
  readonly cells: number;
}

export interface SourceRef {
  /** 按 id 升序，最多 8 条。 */
  readonly calls: readonly { readonly id: number; readonly api: string; readonly line: number }[];
}

/**
 * 最小支撑事实。第一刀只保留状态与直接下方对象；不做 contacts、反向 supports、遮挡。
 * 形状固定为 `{ state, supportedBy? } | null`（first-cut §3.2/§6 已同步）。
 */
export interface AsBuiltSupport {
  readonly state: SupportState;
  /** 按 id 排序的直接下方对象；没有时省略。 */
  readonly supportedBy?: readonly string[];
}

export interface AsBuiltObjectBase {
  readonly id: string;
  readonly kind: ObjectKind;
  /** 半开 `[min,max)`；墙对象取面板几何包络（含共享拐角）。 */
  readonly bounds: AsBuiltBounds;
  /** 对象 owner 的非空气格数；opening 为填充格数。 */
  readonly cells: number;
  /** owner 的不同 `(x,z)` 列数。 */
  readonly footprintCells: number;
  /** 按 block 名升序。 */
  readonly materials: readonly MaterialCount[];
  /** 按 `(y,z,x)` 升序，最多 20 个。 */
  readonly samples: readonly Sample[];
  readonly confidence: Confidence;
  readonly source: SourceRef;
  /** 触及 grid.bounds() 边界；不代表对象不完整。 */
  readonly clipped: boolean;
  /** wall / slab / roof / furniture 给出状态；opening 为 unknown；site / unknown 为 null。 */
  readonly support: AsBuiltSupport | null;
}

export interface WallObject extends AsBuiltObjectBase {
  readonly kind: 'wall';
  readonly wall: {
    /** 墙沿 x 或 z 延伸。 */
    readonly axis: 'x' | 'z';
    /** 法向平面坐标；axis='x' 时是 z，axis='z' 时是 x。 */
    readonly plane: number;
    readonly lengthCells: number;
    readonly heightCells: number;
  };
}

export interface SlabObject extends AsBuiltObjectBase {
  readonly kind: 'slab';
  readonly slab: {
    readonly topY: number;
    readonly bottomY: number;
    readonly thicknessCells: number;
    /** 不同 `(x,z)` 列数。 */
    readonly areaCells: number;
  };
}

export interface RoofObject extends AsBuiltObjectBase {
  readonly kind: 'roof';
  readonly roof: {
    readonly formHint: 'flat' | 'pitched' | 'stepped' | 'complex' | 'unknown';
    /** 暴露顶面最低格 y。 */
    readonly eaveY: number;
    /** 暴露顶面最高格 y。 */
    readonly ridgeY: number;
    /** 暴露顶面格数，不是体积格数。 */
    readonly topCells: number;
    /** 坡度，0.1° 取整；无法计算为 null。 */
    readonly pitchDegrees: number | null;
    /** 屋脊线方向；flat 为 null。 */
    readonly ridgeAxis: 'x' | 'z' | null;
    /** 屋脊宽度（沿坡向的格数）；flat 为 null。 */
    readonly ridgeWidth: number | null;
  };
}

export interface OpeningObject extends AsBuiltObjectBase {
  readonly kind: 'opening';
  /** 宿主墙对象 id；无法确定为 null。 */
  readonly host: string | null;
  readonly opening: {
    readonly subtype: 'window' | 'door' | 'passage' | 'unknown';
    readonly fill: 'glass' | 'door-panel' | 'air' | 'solid' | 'unknown';
    readonly widthCells: number;
    readonly heightCells: number;
    readonly depthCells: number;
    /** 洞口体积中的空气格数。 */
    readonly voidCells: number;
    /** 洞口体积中的非空气填充格数；等于基类 cells。 */
    readonly fillCells: number;
    /** 最低格 y（闭）。 */
    readonly sillY: number;
    /** 上界（半开），等于 bounds.max[1]。 */
    readonly headY: number;
  };
}

export interface SiteObject extends AsBuiltObjectBase {
  readonly kind: 'site';
  readonly site: {
    readonly subtype: 'ground' | 'pad' | 'other';
    readonly topY: number;
    readonly areaCells: number;
  };
}

export type FurnitureSubtype = 'bed' | 'storage' | 'shelf' | 'table' | 'bench' | 'counter' | 'seat' | 'light' | 'other';

export interface FurnitureObject extends AsBuiltObjectBase {
  readonly kind: 'furniture';
  readonly furniture: {
    readonly subtype: FurnitureSubtype;
    /**
     * 长条凳类体量的座位数：`floor(最长水平跨度 / 0.8)`；不是长条凳为 null。
     * 仅按几何换算，不把 `other` 猜成 table / counter。
     */
    readonly seatCapacity: number | null;
    /** 垂直格数；token 家具也给出。 */
    readonly heightCells?: number;
  };
}

export interface UnknownObject extends AsBuiltObjectBase {
  readonly kind: 'unknown';
  readonly unknown: {
    readonly reason: 'no-rule-match' | 'ambiguous-geometry' | 'isolated-fill';
  };
}

export type AsBuiltObject =
  WallObject | SlabObject | RoofObject | OpeningObject | SiteObject | FurnitureObject | UnknownObject;

export interface AsBuiltDiagnostic {
  readonly code: 'unrepresented-void' | 'ambiguous-component';
  readonly count: number;
  readonly note: string | null;
}

export interface AsBuiltObjectGraph {
  readonly schemaVersion: 1;
  readonly bounds: AsBuiltBounds | null;
  readonly measurement: {
    readonly unit: 'voxel-cell';
    readonly boundsConvention: 'half-open [min,max)';
    readonly coordinateSystem: 'x-east, y-up, z-south';
    readonly toleranceCells: 0;
  };
  readonly objects: readonly AsBuiltObject[];
  readonly summary: {
    readonly totalCells: number;
    readonly assignedCells: number;
    readonly unknownCells: number;
    readonly objectCounts: Readonly<Record<ObjectKind, number>>;
    readonly confidenceCounts: Readonly<Record<Confidence, number>>;
  };
  readonly coverage: {
    readonly totalCells: number;
    readonly assignedCells: number;
    readonly unknownCells: number;
    /** 空网格为 null。 */
    readonly assignedRatio: number | null;
  };
  readonly diagnostics: readonly AsBuiltDiagnostic[];
}
