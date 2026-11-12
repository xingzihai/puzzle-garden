/**
 * 浏览器端：样例 / 版本 / 楼层选择与屋面曲率本地预览的纯逻辑（MASSING-SPEC §3）。
 *
 * 负责：样例（plaza / roof）与各自版本选项、接口 URL、切换样例时的默认视图、曲率滑杆的
 * 参数换算与文案，以及在浏览器内对“本地未保存修改”做结构差异（不依赖服务端 `/api/report` 的预置差异）。
 * 不负责：DOM 与事件（page/main.ts）、曲面几何（page/lathe.ts）、蓝图窄化（page/scene.ts）。
 *
 * 为什么自己算差异：`/api/report` 的 diff 是服务端相对 base 的预置结果，浏览器里改曲率后
 * 它必然与当前模型不对应；这里用纯数据比较给出与页面显示一致的本地差异，且不发起任何 HTTP 写。
 */
import type { BlueprintDiff } from '@pg/design/diff';
import type { Element, LatheProfile, Level } from '@pg/design/schema';

import type { ViewerBlueprint } from './scene.ts';

/** 查看器内置的两个样例；roof 的 lathe 需要后端按 `example=roof` 提供。 */
export type ExampleId = 'plaza' | 'roof';

export interface ExampleOption {
  readonly id: ExampleId;
  readonly label: string;
}

/** 样例下拉的取值与文案；顺序即界面顺序。 */
export const EXAMPLE_OPTIONS: readonly ExampleOption[] = [
  { id: 'plaza', label: '地下广场（粗体量）' },
  { id: 'roof', label: '圆厅旋转壳屋面' },
];

/** 把下拉的字符串解析成已知样例；未知值直接抛错，不回退到 plaza。 */
export function exampleIdOf(value: string): ExampleId {
  for (const option of EXAMPLE_OPTIONS) {
    if (option.id === value) return option.id;
  }
  throw new Error(`未知样例：${value}；允许 ${EXAMPLE_OPTIONS.map((option) => option.id).join('、')}`);
}

export interface VariantOption {
  readonly id: string;
  readonly label: string;
}

/** plaza 沿用旧三版；roof 是三版屋面 profile，后端按此顺序返回数组。 */
const PLAZA_VARIANTS: readonly VariantOption[] = [
  { id: 'base', label: 'base（原始）' },
  { id: 'wider-shop', label: 'wider-shop（加宽衣服店）' },
  { id: 'wider-cinema', label: 'wider-cinema（加宽西影厅）' },
];
const ROOF_VARIANTS: readonly VariantOption[] = [
  { id: 'cone', label: '圆锥（线性 k=0）' },
  { id: 'reciprocal', label: '反比例 k=2' },
  { id: 'curved', label: '更收分 k=6' },
];

/** 样例对应的版本下拉项；`/api/blueprints` 的数组顺序与它一致。 */
export function variantsOf(example: ExampleId): readonly VariantOption[] {
  return example === 'roof' ? ROOF_VARIANTS : PLAZA_VARIANTS;
}

/** 样例的默认版本。 */
export function defaultVariant(example: ExampleId): string {
  return example === 'roof' ? 'cone' : 'base';
}

export interface ViewDefaults {
  readonly level: string;
  readonly showSurface: boolean;
  readonly spaces: boolean;
}

/**
 * 切换样例时的默认视图：roof 是地上模型，必须勾选地表并看全部，否则基底与屋面会被楼层规则隐藏。
 */
export function viewDefaults(example: ExampleId): ViewDefaults {
  return { level: 'all', showSurface: example === 'roof', spaces: true };
}

/** plaza 保持原 URL；roof 明确带 `example=roof`（由后端代理负责）。 */
export function blueprintsUrl(example: ExampleId): string {
  return example === 'roof' ? '/api/blueprints?example=roof' : '/api/blueprints';
}

/** 报告 URL：plaza 仍是 `?variant=`；roof 是 `?example=roof&variant=`。 */
export function reportUrl(example: ExampleId, variant: string): string {
  return example === 'roof'
    ? `/api/report?example=roof&variant=${encodeURIComponent(variant)}`
    : `/api/report?variant=${encodeURIComponent(variant)}`;
}

/** 曲率滑杆是否可用：只有 roof 样例有旋转壳 profile。 */
export function curvatureEditable(example: ExampleId): boolean {
  return example === 'roof';
}

/** 由曲率值派生 profile：k=0 是 linear，k≥1 是 reciprocal；分段数保持原值。 */
export function applyCurvature(profile: LatheProfile, curvature: number): LatheProfile {
  if (!Number.isInteger(curvature) || curvature < 0 || curvature > 20) {
    throw new Error(`曲率必须是 0–20 的整数：${String(curvature)}`);
  }
  return {
    kind: curvature === 0 ? 'linear' : 'reciprocal',
    curvature,
    heightSegments: profile.heightSegments,
    radialSegments: profile.radialSegments,
  };
}

/** 母线公式文本，与 @pg/design/roof-example 的 notes 同一口径。 */
export function curveFormula(kind: LatheProfile['kind']): string {
  return kind === 'linear' ? 'r(t)=R·(1−t)' : 'r(t)=R·(1−t)/(1+k·t)';
}

/** `#curve-info` 的文案：公式与 R / H / k / 底顶标高，全部取元素实际包围盒与 profile。 */
export function curveInfoText(element: Element): string {
  const profile = element.profile;
  if (profile === undefined) throw new Error(`元素 ${element.id} 不是 lathe（缺少 profile）`);
  const baseRadius = (element.bounds.max[0] - element.bounds.min[0]) / 2;
  const height = element.bounds.max[1] - element.bounds.min[1];
  const bottom = element.bounds.min[1];
  const top = element.bounds.max[1];
  return (
    `母线 ${profile.kind}：${curveFormula(profile.kind)} ｜ ` +
    `R=${String(baseRadius)}、H=${String(height)}、k=${String(profile.curvature)}、底 y=${String(bottom)}、顶 y=${String(top)}`
  );
}

/** 楼层下拉项：id 用 level.id，文案带名称；`all` 的补语区分地下 / 地上。 */
export function levelOptions(example: ExampleId, levels: readonly Level[]): readonly { id: string; label: string }[] {
  const allLabel = example === 'roof' ? '全部（地上）' : '全部（地下）';
  return [
    { id: 'all', label: allLabel },
    ...levels.map((level) => ({ id: level.id, label: `${level.id}（${level.name}）` })),
  ];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 结构相等：与原 @pg/design/diff 同口径，跳过值为 undefined 的可选键。 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => rightKeys.includes(key) && sameValue(left[key], right[key]))
    );
  }
  return false;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 浏览器内差异：按 id 比较完整字段，数组按 id 排序，语义与 @pg/design/diff 一致。
 * 用于本地参数预览时替换服务端预置差异，避免差异计数与当前模型不对应。
 */
export function localDiffOf(base: ViewerBlueprint, target: ViewerBlueprint): BlueprintDiff {
  const baseElements = new Map(base.elements.map((element) => [element.id, element]));
  const targetElements = new Map(target.elements.map((element) => [element.id, element]));
  const added = [...targetElements.keys()].filter((id) => !baseElements.has(id)).sort(compareIds);
  const removed = [...baseElements.keys()].filter((id) => !targetElements.has(id)).sort(compareIds);
  const changed: string[] = [];
  for (const [id, element] of baseElements) {
    const next = targetElements.get(id);
    if (next !== undefined && !sameValue(element, next)) changed.push(id);
  }
  const baseSpaces = new Map(base.spaces.map((space) => [space.id, space]));
  const targetSpaces = new Map(target.spaces.map((space) => [space.id, space]));
  const spacesChanged: string[] = [];
  for (const [id, space] of baseSpaces) {
    const next = targetSpaces.get(id);
    if (next === undefined || !sameValue(space, next)) spacesChanged.push(id);
  }
  for (const id of targetSpaces.keys()) {
    if (!baseSpaces.has(id)) spacesChanged.push(id);
  }
  return { added, removed, changed: changed.sort(compareIds), spacesChanged: spacesChanged.sort(compareIds) };
}
