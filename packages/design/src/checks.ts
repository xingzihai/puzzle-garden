/**
 * 净空检查：判断每个 Clearance 是否被非忽略实体侵入（MASSING-SPEC §2）。
 *
 * 负责：对已通过 schema 校验的 Blueprint 做轴对齐包围盒求交，报告侵入的净空与元素。
 * 不负责：schema 校验（引用完整性、id 唯一性在 schema.ts 里）、通路 / 结构 / 实体能力判定。
 *
 * 判定口径：
 * - 墙 / 楼板 / 楼梯 / 家具 / glazing / 地表景观（landscape）都是实体，全部参与判定。
 * - marker 是标注点而非实体，不参与（它没有体积语义，只用于定位说明）。
 * - 楔体（wedge-x / wedge-z）没有精确求交实现，按其轴对齐包围盒保守判定：
 *   包围盒与净空相交即报问题，因此可能报出楔体实际未占用的角部；结果消息里会注明。
 * - 旋转薄壳（lathe）同样按包围盒保守判定：只承诺"包围盒相交"，不承诺精确壳体外形，
 *   可能报出壳内或壳外的空腔；结果消息里会注明。
 * - 区间是半开 [min, max)，面贴面（aMax == bMin）不算相交。
 *
 * 本报告只证明所列净空未被几何侵入，不声称所有通路 / 结构 / 实体能力通过。
 */
import type { Blueprint, Bounds } from './schema.ts';

export interface CheckIssue {
  readonly code: string;
  readonly message: string;
  readonly elementIds: readonly string[];
}

export interface CheckReport {
  readonly issues: readonly CheckIssue[];
  readonly checkedClearances: number;
  readonly status: 'pass' | 'issues';
}

/** id 的显式排序：不用 localeCompare（docs/STANDARDS.md §5）。 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 半开区间 [min, max) 的轴对齐包围盒求交；任一轴分离即不相交。 */
function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.min[0] < b.max[0] &&
    b.min[0] < a.max[0] &&
    a.min[1] < b.max[1] &&
    b.min[1] < a.max[1] &&
    a.min[2] < b.max[2] &&
    b.min[2] < a.max[2]
  );
}

/**
 * 报告每个净空区被哪些非忽略实体侵入。一个净空一条 issue，elementIds 按 id 排序。
 */
export function checkBlueprint(blueprint: Blueprint): CheckReport {
  const issues: CheckIssue[] = [];
  for (const clearance of blueprint.clearances) {
    const ignored = new Set(clearance.ignoreElementIds);
    // 非 box 形体的保守性分类：wedge 是楔体，lathe 是旋转薄壳；两者都只按包围盒判定。
    const hit: { readonly id: string; readonly conservative: 'wedge' | 'lathe' | null }[] = [];
    for (const element of blueprint.elements) {
      // marker 不参与：它是标注点，没有实体体积。
      if (element.kind === 'marker') continue;
      if (ignored.has(element.id)) continue;
      if (boundsIntersect(clearance.bounds, element.bounds)) {
        let conservative: 'wedge' | 'lathe' | null;
        if (element.shape === 'box') conservative = null;
        else if (element.shape === 'lathe') conservative = 'lathe';
        else conservative = 'wedge';
        hit.push({ id: element.id, conservative });
      }
    }
    if (hit.length === 0) continue;
    hit.sort((left, right) => compareIds(left.id, right.id));
    const ids = hit.map((entry) => entry.id);
    const notes: string[] = [];
    const wedgeIds = hit.filter((entry) => entry.conservative === 'wedge').map((entry) => entry.id);
    if (wedgeIds.length > 0) notes.push(`楔体 ${wedgeIds.join('、')} 按包围盒保守判定`);
    const latheIds = hit.filter((entry) => entry.conservative === 'lathe').map((entry) => entry.id);
    if (latheIds.length > 0) notes.push(`旋转薄壳 ${latheIds.join('、')} 按包围盒保守判定，不承诺精确外形`);
    const conservativeNote = notes.length > 0 ? `；${notes.join('；')}` : '';
    issues.push({
      code: 'clearance-intrusion',
      message: `净空 ${clearance.id}（${clearance.name}）被 ${ids.join('、')} 侵入${conservativeNote}`,
      elementIds: ids,
    });
  }
  return {
    issues,
    checkedClearances: blueprint.clearances.length,
    status: issues.length > 0 ? 'issues' : 'pass',
  };
}
