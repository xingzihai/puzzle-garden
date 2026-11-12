/**
 * Real run-7 acceptance fixture: build a deterministic perfect grid from a compiled BuildSpec.
 *
 * No hard-coded run-7 coordinates live here. Walls/slabs come from `spec.elements`,
 * openings from `spec.openings`, and the gable roof from `spec.bounds` + `spec.roof`.
 * The helper only encodes the construction recipe (slab, wall shell, carved openings,
 * window glass, flush door apron, 25° gable profile) so conformance can be recomputed
 * from whatever spec the real design path produced.
 */

import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import type { BlockState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Grid } from '@pg/core/grid';
import type { BuildSpec } from '@pg/interaction/schema';

interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

function blockFor(spec: BuildSpec, materialId: string): string {
  const material = spec.materials.find((candidate) => candidate.id === materialId);
  return material?.block ?? materialId;
}

function firstWithRole(spec: BuildSpec, role: BuildSpec['materials'][number]['role']): string | null {
  const material = spec.materials.find((candidate) => candidate.role === role);
  return material?.block ?? null;
}

function inside(bounds: Bounds, x: number, y: number, z: number): boolean {
  return (
    x >= bounds.min[0] &&
    x < bounds.max[0] &&
    y >= bounds.min[1] &&
    y < bounds.max[1] &&
    z >= bounds.min[2] &&
    z < bounds.max[2]
  );
}

function forEachCell(bounds: Bounds, visit: (x: number, y: number, z: number) => void): void {
  for (let x = bounds.min[0]; x < bounds.max[0]; x += 1) {
    for (let y = bounds.min[1]; y < bounds.max[1]; y += 1) {
      for (let z = bounds.min[2]; z < bounds.max[2]; z += 1) visit(x, y, z);
    }
  }
}

/** Gable top per slope coordinate: monotonic stair from eave to one interior ridge cell. */
function gableProfile(length: number, eave: number, ridge: number): readonly number[] {
  if (length <= 0) return [];
  const rise = Math.max(0, ridge - eave);
  const ridgeIndex = Math.max(1, Math.min(length - 2, Math.floor(length / 2) - 1));
  const profile: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const scaled =
      index <= ridgeIndex ? (rise * index) / ridgeIndex : (rise * (length - 1 - index)) / (length - 1 - ridgeIndex);
    profile.push(eave + Math.floor(scaled));
  }
  return profile;
}

export interface PerfectGridOptions {
  /** Absolute y of the one-cell outdoor apron in front of the first door; defaults to floor top. */
  readonly outdoorY?: number;
  /**
   * Add one extra, unmodeled high-confidence south window separated from the spec window.
   * Used as a negative control: it must become a soft `extra` opening, never satisfy a must.
   */
  readonly extraSouthWindow?: boolean;
}

/**
 * Build the perfect run-7 grid from a compiled spec:
 * - slab / wall element bounds are filled with their declared material;
 * - every opening bounds is carved out of the wall shell;
 * - windows are filled with the role=glass block inside the opening;
 * - the door gets a one-cell outdoor apron at floor-top height so the entry is flush;
 * - the gable roof uses the spec's eave/ridge/pitch/overhang and a single interior ridge.
 */
export function buildRun7PerfectGrid(spec: BuildSpec, options: PerfectGridOptions = {}): Grid {
  const registry = loadRegistry();
  const grid = createGrid(registry.table);
  const call = grid.defineCall('set', 1, { fixture: `run7-perfect:${spec.schemeId}:${String(spec.schemeRevision)}` });
  const states = new Map<string, BlockState>();
  const put = (x: number, y: number, z: number, block: string): void => {
    let state = states.get(block);
    if (state === undefined) {
      state = parseState(registry.table, block);
      states.set(block, state);
    }
    grid.set(x, y, z, state, 0, call);
  };
  const fill = (bounds: Bounds, block: string): void => {
    forEachCell(bounds, (x, y, z) => {
      put(x, y, z, block);
    });
  };

  const level = spec.levels[0];
  if (level === undefined) throw new Error('BuildSpec.levels is empty');
  const standingY = level.elevation;
  const floorTopY = standingY - spec.structure.floorThickness;

  const slabElements = spec.elements.filter((element) => element.kind === 'slab');
  const wallElements = spec.elements.filter((element) => element.kind === 'wall');
  if (slabElements.length === 0) throw new Error('run-7 perfect grid needs at least one slab element');
  if (wallElements.length === 0) throw new Error('run-7 perfect grid needs at least one wall element');

  for (const element of slabElements) fill(element.bounds, blockFor(spec, element.material));
  for (const element of wallElements) {
    forEachCell(element.bounds, (x, y, z) => {
      const carved = spec.openings.some((opening) => inside(opening.bounds, x, y, z));
      if (!carved) put(x, y, z, blockFor(spec, element.material));
    });
  }

  const glass = firstWithRole(spec, 'glass') ?? 'glass';
  for (const opening of spec.openings) {
    if (opening.kind === 'window') fill(opening.bounds, glass);
  }

  // Build the confirmed interiors as one-cell-high furniture volumes. The as-built extractor
  // recognizes raised furniture above the floor; lights stay distinct via their block shape.
  for (const interior of spec.interiors) {
    for (const furniture of interior.furnitureSpecs) {
      fill(furniture.bounds, blockFor(spec, furniture.materialId));
    }
  }

  if (options.extraSouthWindow === true) {
    const southWall = spec.elements.find(
      (element) => element.kind === 'wall' && element.bounds.max[2] === spec.bounds.max[2],
    );
    const windowTemplate = spec.openings.find((opening) => opening.kind === 'window' && opening.side === 'south');
    if (southWall === undefined) throw new Error('extra south window needs a south wall element');
    if (windowTemplate === undefined) throw new Error('extra south window needs a south window template');
    const x = Math.max(southWall.bounds.min[0], spec.bounds.max[0] - 2, windowTemplate.bounds.max[0] + 1);
    if (x + 1 > southWall.bounds.max[0]) throw new Error('extra south window would touch the wall corner');
    const z = southWall.bounds.max[2] - 1;
    for (let y = windowTemplate.bounds.min[1]; y < windowTemplate.bounds.max[1]; y += 1) put(x, y, z, glass);
  }

  // Flush threshold + one-cell outdoor apron at floor-top height, like the documented
  // run-7 “室内外齐平、不设台阶” entry; no step is introduced above or below.
  const ground = firstWithRole(spec, 'landscape') ?? 'gravel';
  const structural = firstWithRole(spec, 'structure') ?? blockFor(spec, spec.structure.material);
  const door = spec.openings.find((opening) => opening.kind !== 'window');
  if (door !== undefined) {
    const outdoorY = options.outdoorY ?? floorTopY;
    for (let x = door.bounds.min[0]; x < door.bounds.max[0]; x += 1) {
      if (door.side === 'north' || door.side === 'south') {
        const plane = door.bounds.min[2];
        const outward = door.side === 'north' ? plane - 1 : plane + 1;
        put(x, outdoorY, outward, ground);
        for (let z = door.bounds.min[2]; z < door.bounds.max[2]; z += 1) {
          put(x, outdoorY, z, structural);
        }
        for (let y = door.bounds.min[1]; y < door.bounds.max[1]; y += 1) {
          for (let z = door.bounds.min[2]; z < door.bounds.max[2]; z += 1) {
            // Opening bounds may be one cell deep; only clear the carved shell, never
            // the floor / threshold cell at floorTopY.
            if (y !== outdoorY) put(x, y, z, 'air');
          }
        }
      } else {
        const plane = door.bounds.min[0];
        const outward = door.side === 'west' ? plane - 1 : plane + 1;
        put(outward, outdoorY, door.bounds.min[2], ground);
      }
    }
  }

  if (spec.roof.form !== 'gable') {
    fill(
      {
        min: [spec.bounds.min[0] - spec.roof.overhang, spec.roof.eaveHeight, spec.bounds.min[2] - spec.roof.overhang],
        max: [
          spec.bounds.max[0] + spec.roof.overhang,
          spec.roof.eaveHeight + 1,
          spec.bounds.max[2] + spec.roof.overhang,
        ],
      },
      blockFor(spec, spec.roof.material),
    );
    return grid;
  }

  const roofBlock = blockFor(spec, spec.roof.material);
  const minX = spec.bounds.min[0] - spec.roof.overhang;
  const maxX = spec.bounds.max[0] + spec.roof.overhang;
  const minZ = spec.bounds.min[2] - spec.roof.overhang;
  const maxZ = spec.bounds.max[2] + spec.roof.overhang;
  const ridgeAlongX = maxX - minX >= maxZ - minZ;
  const profile = gableProfile(ridgeAlongX ? maxZ - minZ : maxX - minX, spec.roof.eaveHeight, spec.roof.ridgeHeight);

  for (let x = minX; x < maxX; x += 1) {
    for (let z = minZ; z < maxZ; z += 1) {
      const index = ridgeAlongX ? z - minZ : x - minX;
      const top = profile[index] ?? spec.roof.eaveHeight;
      for (let y = spec.roof.eaveHeight; y <= top; y += 1) put(x, y, z, roofBlock);
    }
  }

  return grid;
}
