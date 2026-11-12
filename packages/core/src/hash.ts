/**
 * 网格 hash：128 位、与写入顺序无关（docs/CORE-SPEC.md §5）。
 *
 * 负责：判断两栋建筑的实体格集合是否相同。只看 (x, y, z, 规范状态)，不看部件、调用与挖空记录。
 * 不负责：抗恶意碰撞（求和式组合，没有对抗场景）。
 * v0.2 用排序后的 FNV-1a 32 位（v02:v0.2beta/agent/lib/voxel.js:13），50 万格时碰撞概率不可忽略，故改为 128 位。
 */

import { formatState } from './block-state.ts';
import type { Grid } from './grid.ts';

const SEEDS = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f] as const;

function fmix32(input: number): number {
  let h = input;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const encoder = new TextEncoder();

/** FNV-1a 32 位，按 UTF-8 字节。 */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of encoder.encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function step(h: number, k: number): number {
  return (Math.imul(fmix32(h ^ k), 5) + 0xe6546b64) >>> 0;
}

function mix(seed: number, x: number, y: number, z: number, s: number): number {
  return fmix32(step(step(step(step(seed, x >>> 0), y >>> 0), z >>> 0), s));
}

function hex8(n: number): string {
  return n.toString(16).padStart(8, '0');
}

/** 32 个小写十六进制字符。同一实体格集合 ⇔（在不考虑碰撞时）同一 hash。 */
export function hashGrid(grid: Grid): string {
  const acc = [0, 0, 0, 0];
  // 同一状态在一栋建筑里会出现很多次，缓存 fnv1a 结果；缓存只活在这次调用里。
  const cache = new Map<string, number>();
  for (const { x, y, z, state } of grid.cells()) {
    const text = formatState(state);
    let s = cache.get(text);
    if (s === undefined) {
      s = fnv1a(text);
      cache.set(text, s);
    }
    for (let i = 0; i < 4; i += 1) acc[i] = ((acc[i] ?? 0) + mix(SEEDS[i] ?? 0, x, y, z, s)) >>> 0;
  }
  const n = grid.size >>> 0;
  return acc.map((a, i) => hex8(fmix32(a ^ n ^ (SEEDS[i] ?? 0)))).join('');
}
