/**
 * Golden tea-house construction recipe (offline, deterministic).
 *
 * Builds the committed 20261022 tea-house BuildSpec with the real `@pg/geometry` world API.
 * The recipe intentionally repairs the known defects of the first diagnostic build:
 *
 * - the floor plate is one cell thick at y0 and keeps the slab element material;
 * - the stone base is a perimeter replacement at the same y0 (no second layer, no project);
 * - every wall cell uses the BuildSheet wall-row material (dominant wall-element material),
 *   with no decorative dark-wood / post layer in the wall plane;
 * - door / window bounds come from the spec exactly; no sill, trim or other block is written
 *   inside an opening. The window is filled with the spec glass block via `opening.fill`;
 * - the gable roof is one cell thick, ridge along x, peakY = roof.ridgeHeight, overhang 1 and
 *   the exact roof material;
 * - each furnitureSpecs.bounds is filled exactly with its material block (half-open bounds),
 *   with no extra furniture or decorations;
 * - no stairs, no gravel pads and no decorative outdoor blocks. The only ground-level cell
 *   outside the wall footprint is a one-cell-deep flush threshold apron under the door, because
 *   the door-threshold checker needs a measurable outdoor adjacent surface.
 *
 * It returns `host.compose().grid`, i.e. the same finished grid the build path hands to the
 * archive / conformance tools.
 */

import { loadRegistry } from '@pg/blocks/load';
import type { Grid } from '@pg/core/grid';
import { createWorld, rect } from '@pg/geometry';
import type { BuildSpec } from '@pg/interaction/schema';

import { buildBuildSheet } from '../build-sheet.ts';

function materialBlock(spec: BuildSpec, materialId: string): string {
  const material = spec.materials.find((candidate) => candidate.id === materialId);
  if (material === undefined) throw new Error(`material ${materialId} is not declared in the BuildSpec`);
  return material.block;
}

function forEachCell(
  bounds: { readonly min: readonly number[]; readonly max: readonly number[] },
  visit: (x: number, y: number, z: number) => void,
): void {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  for (let y = minY ?? 0; y < (maxY ?? 0); y += 1) {
    for (let z = minZ ?? 0; z < (maxZ ?? 0); z += 1) {
      for (let x = minX ?? 0; x < (maxX ?? 0); x += 1) visit(x, y, z);
    }
  }
}

function assertHandleBounds(
  handle: { readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] } },
  expected: { readonly min: readonly number[]; readonly max: readonly number[] },
  what: string,
): void {
  for (let axis = 0; axis < 3; axis += 1) {
    const actualMin = handle.bounds.min[axis] ?? Number.NaN;
    const actualMax = handle.bounds.max[axis] ?? Number.NaN;
    const expectedMin = expected.min[axis] ?? Number.NaN;
    const expectedMax = (expected.max[axis] ?? Number.NaN) - 1;
    if (actualMin !== expectedMin || actualMax !== expectedMax) {
      throw new Error(
        `${what} bounds mismatch on axis ${String(axis)}: actual [${String(actualMin)}, ${String(actualMax)}] ` +
          `vs expected [${String(expectedMin)}, ${String(expectedMax)}]`,
      );
    }
  }
}

/**
 * 墙材从 BuildSheet 的 wall 行读取，而不是 `structure.material` 或 `layers`。
 * 这样配方与模型看到的机器合同、`check:material:wall/structure` 的期望口径三者一致。
 */
function wallMaterial(spec: BuildSpec): string {
  const sheet = buildBuildSheet(spec);
  const wall = sheet.objects.find((object) => object.kind === 'wall');
  if (wall === undefined) throw new Error('BuildSheet has no wall object');
  if (wall.materialBlock === '—') throw new Error('BuildSheet wall material is unresolved');
  return wall.materialBlock;
}

/** Opening `at` is measured from the centred start of the facade's outer span. */
function openingStart(spec: BuildSpec, opening: BuildSpec['openings'][number], horizontal: boolean): number {
  const outerMin = horizontal ? spec.bounds.min[0] : spec.bounds.min[2];
  const outerMax = horizontal ? spec.bounds.max[0] - 1 : spec.bounds.max[2] - 1;
  return outerMin + Math.floor((outerMax - outerMin + 1 - opening.width) / 2);
}

export function buildTeaHouseRecipeGrid(spec: BuildSpec): Grid {
  const registry = loadRegistry();
  const host = createWorld(registry.table);
  const world = host.world;

  const level = spec.levels[0];
  if (level === undefined) throw new Error('BuildSpec has no level');

  const slab = spec.elements.find((element) => element.kind === 'slab');
  if (slab === undefined) throw new Error('BuildSpec has no slab element');
  const slabBlock = materialBlock(spec, slab.material);
  const slabY = slab.bounds.min[1];
  const slabThickness = slab.bounds.max[1] - slab.bounds.min[1];
  const footprint = rect(slab.bounds.min[0], slab.bounds.min[2], slab.bounds.max[0] - 1, slab.bounds.max[2] - 1);

  const firstFacade = spec.facades.at(0);
  if (firstFacade === undefined) throw new Error('BuildSpec has no facade');
  const baseBlock = materialBlock(spec, firstFacade.baseMaterialId);

  const wallBlock = wallMaterial(spec);
  const wallY = level.elevation;
  const wallHeight = spec.bounds.max[1] - wallY;

  // 1. Floor plate: exact slab element bounds, one layer, slab material.
  world.floorPlate({
    footprint,
    y: slabY,
    thickness: slabThickness,
    material: slabBlock,
  });

  // 2. Stone base ring: replace the perimeter cells of the same y0 layer. No second layer
  //    and no outward projection, so the slab envelope and the entry datum stay unchanged.
  for (let x = footprint.minX; x <= footprint.maxX; x += 1) {
    world.set(x, slabY, footprint.minZ, baseBlock);
    world.set(x, slabY, footprint.maxZ, baseBlock);
  }
  for (let z = footprint.minZ + 1; z < footprint.maxZ; z += 1) {
    world.set(footprint.minX, slabY, z, baseBlock);
    world.set(footprint.maxX, slabY, z, baseBlock);
  }

  // 3. Walls: exact wall plane, one material, no decorative posts or dark-wood courses.
  const walls = world.walls({
    footprint,
    y: wallY,
    height: wallHeight,
    thickness: 1,
    material: wallBlock,
  });
  assertHandleBounds(walls, spec.bounds, 'wall envelope');

  // 4. Openings: derive the API placement from the spec bounds. The opening call carves the
  //    wall and writes glass only inside a window's bounds; nothing else is written there.
  const glassMaterial = spec.materials.find((material) => material.role === 'glass');
  const glassBlock = glassMaterial?.block ?? 'glass';
  for (const opening of spec.openings) {
    const horizontal = opening.side === 'north' || opening.side === 'south';
    const start = openingStart(spec, opening, horizontal);
    const minHorizontal = horizontal ? opening.bounds.min[0] : opening.bounds.min[2];
    const at = minHorizontal - start;
    const sill = opening.bounds.min[1] - wallY;
    const height = opening.bounds.max[1] - opening.bounds.min[1];
    if (height !== opening.height) {
      throw new Error(
        `opening ${opening.id}: bounds height ${String(height)} != spec height ${String(opening.height)}`,
      );
    }
    const handle = world.opening({
      in: walls.facade(opening.side),
      kind: opening.kind === 'window' ? 'window' : 'door',
      width: opening.width,
      height,
      sill,
      at,
      ...(opening.kind === 'window' ? { fill: glassBlock } : {}),
    });
    assertHandleBounds(handle, opening.bounds, `opening ${opening.id}`);
  }

  // 5. Gable roof: one-cell shell, ridge along x, exact peak / overhang / material.
  const roofBlock = materialBlock(spec, spec.roof.material);
  const roof = world.roof({
    on: walls,
    kind: 'gable',
    ridge: 'x',
    peakY: spec.roof.ridgeHeight,
    overhang: spec.roof.overhang,
    thickness: 1,
    material: roofBlock,
    gableMaterial: roofBlock,
  });
  assertHandleBounds(
    roof,
    {
      min: [spec.bounds.min[0] - spec.roof.overhang, spec.roof.eaveHeight, spec.bounds.min[2] - spec.roof.overhang],
      max: [
        spec.bounds.max[0] + spec.roof.overhang,
        spec.roof.ridgeHeight + 1,
        spec.bounds.max[2] + spec.roof.overhang,
      ],
    },
    'roof',
  );

  // 6. Furniture: fill each spec envelope exactly, with only its declared material.
  for (const interior of spec.interiors) {
    for (const item of interior.furnitureSpecs) {
      const block = materialBlock(spec, item.materialId);
      forEachCell(item.bounds, (x, y, z) => {
        world.set(x, y, z, block);
      });
    }
  }

  // 7. Flush entry transition. The conformance threshold check needs one measurable outdoor
  //    surface directly outside the door. Add exactly one cell of the same floor-top level
  //    across the door width, using the base stone. This is not a gravel pad / terrace / step:
  //    it is the minimum surface that proves "室内外齐平" and is never raised above y=slabY.
  for (const opening of spec.openings) {
    if (opening.kind === 'window') continue;
    const [minX, , minZ] = opening.bounds.min;
    const [maxX, , maxZ] = opening.bounds.max;
    const x0 = minX;
    const x1 = maxX - 1;
    const z0 = minZ;
    const z1 = maxZ - 1;
    const put = (x: number, z: number): void => {
      world.set(x, slabY, z, baseBlock);
    };
    if (opening.side === 'north') {
      for (let x = x0; x <= x1; x += 1) put(x, z0 - 1);
    } else if (opening.side === 'south') {
      for (let x = x0; x <= x1; x += 1) put(x, z1 + 1);
    } else if (opening.side === 'west') {
      for (let z = z0; z <= z1; z += 1) put(x0 - 1, z);
    } else {
      for (let z = z0; z <= z1; z += 1) put(x1 + 1, z);
    }
  }

  // 8. No stairs, no gravel pads, no decorative blocks: the composed grid is the building
  //    plus the one-cell flush entry transition above.
  return host.compose().grid;
}
