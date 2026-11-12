/** 外墙轮廓和材质带的计划；后殿按北向半椭圆离散，不生成室内填充。 */
import type { z } from 'zod';
import type { BlockTable } from '@pg/core/block-state';
import { Writer } from './writer.ts';
import type { Write } from './writer.ts';
import { bounds, wallWrites } from './shapes.ts';
import type { Footprint, wallsSchema } from './schema.ts';

export function apseContains(r: Footprint, x: number, z: number): boolean {
  if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) return false;
  const rx = (r.maxX - r.minX + 1) / 2;
  const rz = r.maxZ - r.minZ + 1;
  const dx = (x - (r.minX + r.maxX) / 2) / rx;
  const dz = (z - r.maxZ) / rz;
  return dx * dx + dz * dz <= 1;
}

export function wallsPlan(table: BlockTable, p: z.output<typeof wallsSchema>): readonly Write[] {
  const location = 'on' in p ? p.on : p;
  const r = location.footprint;
  const y = location.y;
  const height = 'height' in p ? p.height : p.storeys.count * p.storeys.height;
  const writer = new Writer(table);
  const material = writer.material(p.material, true);
  const bands = p.bands
    .map((b) => ({ ...b, state: writer.material(b.material, true) }))
    .sort((a, b) => a.from - b.from);
  let last = -1;
  let lastFrom = -1;
  for (const b of bands) {
    if (b.from > b.to)
      throw new Error(
        `walls.bands from=${String(b.from)} > to=${String(b.to)}：每段必须 from≤to，墙高 ${String(height)}（高度从墙底 0 起）`,
      );
    if (b.to >= height)
      throw new Error(
        `walls.bands 越出墙高：from=${String(b.from)}、to=${String(b.to)}，墙高只有 ${String(height)}（高度从墙底 0 起）`,
      );
    if (b.from <= last)
      throw new Error(
        `walls.bands 与上一段重叠：上一段 from=${String(lastFrom)}、to=${String(last)}，这一段 from=${String(b.from)}` +
          `（高度从墙底 0 起，互不重叠）`,
      );
    last = b.to;
    lastFrom = b.from;
  }
  const stateAt = (cy: number): typeof material =>
    bands.find((b) => cy - y >= b.from && cy - y <= b.to)?.state ?? material;
  if (p.outline === 'rect')
    return wallWrites(r, y, height, p.thickness, material).map((w) => ({ ...w, state: stateAt(w.y) }));
  bounds(r, y, height);
  const horizontal: (readonly [number, number])[] = [];
  let interior = 0;
  for (let z = r.minZ; z <= r.maxZ; z += 1)
    for (let x = r.minX; x <= r.maxX; x += 1) {
      if (!apseContains(r, x, z)) continue;
      let edge = false;
      for (let d = 1; d <= p.thickness; d += 1) {
        if (
          !apseContains(r, x + d, z) ||
          !apseContains(r, x - d, z) ||
          !apseContains(r, x, z + d) ||
          !apseContains(r, x, z - d)
        )
          edge = true;
      }
      if (edge) horizontal.push([x, z]);
      else interior += 1;
    }
  if (interior === 0)
    throw new Error(
      `walls.thickness=${String(p.thickness)} 使后殿没有内部空间：后殿占地 x=${String(r.maxX - r.minX + 1)}、z=${String(r.maxZ - r.minZ + 1)}`,
    );
  const writes: Write[] = [];
  for (let cy = y; cy < y + height; cy += 1)
    for (const [x, z] of horizontal) writes.push({ x, y: cy, z, state: stateAt(cy), writeLayer: 'structure' });
  return writes;
}
