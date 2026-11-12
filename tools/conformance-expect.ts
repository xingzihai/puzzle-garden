/**
 * BuildSpec → 中性期望对象投影（CONF-NEXT-03 第一刀）。
 *
 * 负责：只从 BuildSpec 的结构字段派生 wall / slab / roof / opening 的期望包络，供
 * `@pg/analysis/object-diff` 使用。
 * 不负责：diff、读 building.pgar、CLI、家具 / 场地语义。
 *
 * 关键口径：不直接相信 `BuildSpec.elements` 的 bounds（H2/H3 的 roofElement、H1–H4 的
 * floor element 都可能是旧口径）。墙 / 板从 `spec.bounds` + `levels` 派生；屋面从
 * `spec.roof` 派生；洞口直接用 `spec.openings` 的字段。
 */

import type {
  DiffBounds,
  DiffObjectKind,
  ExpectedObject,
  ExpectedOpening,
  ExpectedRoof,
  ExpectedSlab,
  ExpectedWall,
} from '@pg/analysis/object-diff';
import type { BuildSpec } from '@pg/interaction/schema';

export interface ExpectedProjectionCounts {
  readonly wall: number;
  readonly slab: number;
  readonly roof: number;
  readonly opening: number;
}

export interface ExpectedProjection {
  readonly objects: readonly ExpectedObject[];
  readonly counts: ExpectedProjectionCounts;
  readonly notes: readonly string[];
}

function box(min: readonly [number, number, number], max: readonly [number, number, number]): DiffBounds {
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}

function openingSubtype(kind: BuildSpec['openings'][number]['kind']): 'window' | 'door' {
  return kind === 'window' ? 'window' : 'door';
}

export function projectExpectedObjects(spec: BuildSpec): ExpectedProjection {
  const notes: string[] = [];
  const levels = new Map(spec.levels.map((level) => [level.id, level]));
  const walls: ExpectedWall[] = [];
  const slabs: ExpectedSlab[] = [];
  const multiLevel = spec.levels.length > 1;
  if (multiLevel) {
    notes.push('multi-level wall / slab envelope projection is not supported by the first cut; marked unverified');
  }

  for (const level of spec.levels) {
    const wallReason =
      multiLevel || spec.bounds.max[1] <= level.elevation
        ? multiLevel
          ? 'multi-level wall envelope projection is not supported by the first cut'
          : 'spec.bounds.max[1] is not above the level elevation'
        : null;
    walls.push({
      id: `wall:${level.id}`,
      kind: 'wall',
      bounds: box(
        [spec.bounds.min[0], level.elevation, spec.bounds.min[2]],
        [spec.bounds.max[0], spec.bounds.max[1], spec.bounds.max[2]],
      ),
      unverifiedReason: wallReason,
    });
    slabs.push({
      id: `slab:${level.id}`,
      kind: 'slab',
      bounds: box(
        [spec.bounds.min[0], level.elevation - 1, spec.bounds.min[2]],
        [spec.bounds.max[0], level.elevation, spec.bounds.max[2]],
      ),
      unverifiedReason: multiLevel ? 'multi-level slab envelope projection is not supported by the first cut' : null,
    });
  }

  const roofBounds = box(
    [spec.bounds.min[0] - spec.roof.overhang, spec.roof.eaveHeight, spec.bounds.min[2] - spec.roof.overhang],
    [spec.bounds.max[0] + spec.roof.overhang, spec.roof.ridgeHeight + 1, spec.bounds.max[2] + spec.roof.overhang],
  );
  const roof: ExpectedRoof = {
    id: 'roof',
    kind: 'roof',
    bounds: roofBounds,
    unverifiedReason: spec.roof.ridgeHeight < spec.roof.eaveHeight ? 'roof.ridgeHeight is below roof.eaveHeight' : null,
    form: spec.roof.form,
    pitchDegrees: spec.roof.pitchDegrees,
    eaveY: spec.roof.eaveHeight,
    ridgeY: spec.roof.ridgeHeight,
    overhang: spec.roof.overhang,
  };
  if (spec.roof.segments !== undefined && spec.roof.segments.length > 1) {
    notes.push('roof segments collapsed into one expected envelope; segment-level comparison is not supported');
  }

  const openings: ExpectedOpening[] = spec.openings.map((opening) => {
    const level = levels.get(opening.level);
    const elevation = level?.elevation ?? opening.bounds.min[1];
    const sillY = elevation + opening.sillHeight;
    const headY = elevation + opening.headHeight;
    const reason =
      level === undefined
        ? `opening.level ${opening.level} is not present in spec.levels`
        : headY <= sillY
          ? 'opening headHeight is not above sillHeight'
          : null;
    return {
      id: `opening:${opening.id}`,
      kind: 'opening',
      bounds: box(opening.bounds.min, opening.bounds.max),
      unverifiedReason: reason,
      subtype: openingSubtype(opening.kind),
      side: opening.side,
      width: opening.width,
      height: opening.height,
      sillY,
      headY,
      hostId: opening.host,
    };
  });

  const objects: ExpectedObject[] = [...walls, ...slabs, roof, ...openings];
  return {
    objects,
    counts: {
      wall: walls.length,
      slab: slabs.length,
      roof: 1,
      opening: openings.length,
    },
    notes,
  };
}

export function expectedObjectCounts(objects: readonly ExpectedObject[]): ExpectedProjectionCounts {
  const counts: Record<DiffObjectKind, number> = { wall: 0, slab: 0, roof: 0, opening: 0 };
  for (const object of objects) counts[object.kind] += 1;
  return {
    wall: counts.wall,
    slab: counts.slab,
    roof: counts.roof,
    opening: counts.opening,
  };
}
