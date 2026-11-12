/** DesignIntent 展开的内部类型；只含类型声明，运行时逻辑在 design-expand*.ts。 */
import type { Bounds } from './primitives.ts';
import type { DesignConflict } from './design-conflict.ts';
import type { DesignIntent, Rect2 } from './design-intent.ts';
import type { FloorDatum, FloorDatumConflict } from './floor-datum.ts';
import type { MustLinkCoverage } from './must-links.ts';
import type { DesignScheme, OpeningKind, Side } from './scheme.ts';

export interface DesignWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface DesignRoomFact {
  readonly id: string;
  readonly level: string;
  readonly nominalAreaM2: number;
  readonly targetAreaM2: number | null;
  readonly deltaPct: number | null;
  readonly occupancy: number;
  readonly daylight: 'required' | 'preferred' | 'none';
  readonly adjacency: readonly string[];
}

export interface DesignFacts {
  readonly derivationVersion: 'r2-mvp-1';
  readonly derivations: readonly string[];
  readonly buildingBounds: Bounds;
  readonly eaveHeight: number;
  readonly ridgeHeight: number;
  readonly entranceSide: Side;
  readonly rooms: readonly DesignRoomFact[];
  readonly counts: {
    readonly levels: number;
    readonly rooms: number;
    readonly spaces: number;
    readonly walls: number;
    readonly exteriorWalls: number;
    readonly sharedWalls: number;
    readonly slabs: number;
    readonly openings: number;
    readonly openingsByKind: Readonly<Record<OpeningKind, number>>;
    readonly furniture: number;
    readonly stairs: number;
  };
  readonly openingHosts: Readonly<Record<string, string>>;
  /** 室内 / 室外 / 入口门槛的同一套标高事实。 */
  readonly datum: FloorDatum;
  /** 要求无台阶但实际存在高差时的持久化冲突；否则为 null。 */
  readonly datumConflict: FloorDatumConflict | null;
  /** must → 方案对象链接覆盖率；旧宿主没有 mustEntries 时 total 为 0。 */
  readonly mustLinks: MustLinkCoverage;
}

export interface ResolvedDesign {
  readonly intent: DesignIntent;
  readonly scheme: DesignScheme;
  readonly facts: DesignFacts;
  readonly warnings: readonly DesignWarning[];
  /** 不再静默的几何降级（室外分区 / 家具 shrink / relocate / drop）。 */
  readonly conflicts: readonly DesignConflict[];
}

export interface Level {
  readonly id: string;
  readonly name: string;
  readonly elevation: number;
  readonly height: number;
  readonly floorMaterialId: string;
}

export interface Room {
  readonly intent: DesignIntent['program']['rooms'][number];
  readonly level: Level;
  readonly rect: Rect2;
  readonly bounds: Bounds;
}

export interface Edge {
  readonly room: Room;
  readonly side: Side;
  readonly axis: 'x' | 'z';
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly sign: 1 | -1;
}

export interface Wall {
  readonly id: string;
  readonly axis: 'x' | 'z';
  readonly exterior: boolean;
  readonly thickness: number;
  readonly bounds: Bounds;
  readonly roomSides: ReadonlyMap<string, Side>;
  readonly intrusions: ReadonlyMap<string, number>;
}
