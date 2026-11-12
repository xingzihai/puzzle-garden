/**
 * 浏览器端：旋转薄壳 profile 的窄化（MASSING-SPEC §2）。
 *
 * 负责：把 `/api/blueprints` 里元素的可选 `profile` 字段收窄成 @pg/design/schema 的 `LatheProfile`，
 * 按 schema 同口径校验 kind / curvature / 分段数，非法取值抛出可读中文错误。
 * 不负责：曲面求值与三角化（page/lathe.ts）、蓝图其余字段与元素调度（page/scene.ts）。
 *
 * 数据边界：服务端已用 schema 校验；这里只按查看器渲染需要的字段再确认一遍，绝不 eval 或解释源码字符串。
 */
import type { LatheProfile } from '@pg/design/schema';

import { oneOf, requireInt, requireRecord } from './report-parser.ts';

/** 与 schema 一致的取值边界（docs/STANDARDS.md §3：数组与数值都有合理上限）。 */
const CURVATURE_MAX = 20;
const HEIGHT_SEGMENTS_MIN = 4;
const HEIGHT_SEGMENTS_MAX = 128;
const RADIAL_SEGMENTS_MIN = 8;
const RADIAL_SEGMENTS_MAX = 128;

/** 解析 lathe 元素的 profile；非法取值抛错，不做静默回退。 */
export function parseLatheProfile(value: unknown, path: string): LatheProfile {
  const record = requireRecord(value, path);
  const kind = oneOf(record['kind'], ['linear', 'reciprocal'] as const, `${path}.kind`);
  const curvature = requireInt(record['curvature'], `${path}.curvature`);
  const heightSegments = requireInt(record['heightSegments'], `${path}.heightSegments`);
  const radialSegments = requireInt(record['radialSegments'], `${path}.radialSegments`);
  if (curvature < 0 || curvature > CURVATURE_MAX) {
    throw new Error(`${path}.curvature 必须在 0–${String(CURVATURE_MAX)}：${String(curvature)}`);
  }
  if (kind === 'linear' && curvature !== 0) {
    throw new Error(`${path}.curvature 在 linear 时必须为 0（直线母线），实际 ${String(curvature)}`);
  }
  if (kind === 'reciprocal' && curvature < 1) {
    throw new Error(`${path}.curvature 在 reciprocal 时必须 ≥ 1，实际 ${String(curvature)}`);
  }
  if (heightSegments < HEIGHT_SEGMENTS_MIN || heightSegments > HEIGHT_SEGMENTS_MAX) {
    throw new Error(
      `${path}.heightSegments 必须在 ${String(HEIGHT_SEGMENTS_MIN)}–${String(HEIGHT_SEGMENTS_MAX)}：${String(heightSegments)}`,
    );
  }
  if (radialSegments < RADIAL_SEGMENTS_MIN || radialSegments > RADIAL_SEGMENTS_MAX) {
    throw new Error(
      `${path}.radialSegments 必须在 ${String(RADIAL_SEGMENTS_MIN)}–${String(RADIAL_SEGMENTS_MAX)}：${String(radialSegments)}`,
    );
  }
  return { kind, curvature, heightSegments, radialSegments };
}
