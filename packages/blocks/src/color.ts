/**
 * 材质候选与最近色（MASSING-CONVERSION-SPEC §7，M1b1）：从方块注册表筛出可作默认材质的立方体方块，
 * 并按整数平方 RGB 距离选最近色。
 *
 * 负责：候选筛选（{@link colorCandidates}）与最近色（{@link nearestColorBlock}）。不负责：读数据（load.ts）、
 * 注册表校验（registry.ts）、role 材质族池与错误分类（@pg/geometry/src/massing-material.ts）。
 * 本文件是纯函数：Node 与浏览器都能用，ESLint 的 pureFiles 规则强制；运行时只 import 同包纯文件 `registry.ts`。
 */

import type { BlockRegistry, Family } from './registry.ts';

/** 经资产通道注入给转换层的颜色候选（MASSING-CONVERSION-SPEC §5.2）。 */
export interface MassingColorCandidate {
  readonly id: string;
  /** 0xRRGGBB 整数。 */
  readonly rgb: number;
  readonly family: Family;
}

/**
 * 从注册表生成默认材质候选：只取形态为 `cube`、有颜色且颜色置信度非 `low`、非透明、无发光的方块，
 * 按 id 码点升序（MASSING-CONVERSION-SPEC §7）。
 */
export function colorCandidates(registry: BlockRegistry): readonly MassingColorCandidate[] {
  const out: MassingColorCandidate[] = [];
  for (const id of registry.ids()) {
    const info = registry.get(id);
    if (info === undefined) continue;
    if (info.shape !== 'cube') continue;
    const color = info.color;
    if (color.source === 'none') continue;
    if (color.confidence === 'low') continue;
    if (info.transparent) continue;
    if (info.luminance !== 0) continue;
    out.push({ id: info.id, rgb: color.rgb, family: info.family });
  }
  // registry.ids() 已按码点升序，这里再排一次是契约而非依赖上游顺序。
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze(out);
}

/** 两个 0xRRGGBB 颜色的整数平方欧氏距离（sRGB 直接算，无 sqrt；MASSING-CONVERSION-SPEC §7）。 */
function squaredRgbDistance(a: number, b: number): number {
  const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff);
  const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff);
  const db = (a & 0xff) - (b & 0xff);
  return dr * dr + dg * dg + db * db;
}

/**
 * 最近颜色候选：整数平方 RGB 距离最小；距离相同按 id 码点升序，保证确定性（STANDARDS §5）。
 * 候选为空时响亮抛错，不静默返回空串（STANDARDS §4）。沿用 tools/v02-block-colors.ts 的口径。
 */
export function nearestColorBlock(rgb: number, candidates: readonly MassingColorCandidate[]): MassingColorCandidate {
  if (candidates.length === 0) {
    throw new Error('最近色映射没有候选方块：宿主注入的颜色候选表为空，无法解析默认材质');
  }
  let best: MassingColorCandidate | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = squaredRgbDistance(rgb, candidate.rgb);
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && candidate.id < best.id)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best === undefined) {
    throw new Error('最近色映射没有候选方块：宿主注入的颜色候选表为空，无法解析默认材质');
  }
  return best;
}
