/**
 * BuildBrief 构建前 lint：只做结构检查，不求解净空 / 路线。
 *
 * 负责：四节题面可解析、must 覆盖、数字与 BuildSpec 一致、空间 / 洞口 / 路线引用、
 * 预算、禁项、任务 / 报告长度。
 * 不负责：读文件、调用模型、几何求解；本文件是纯函数。
 */
import { extractTaskBody } from '@pg/agent/task-body';

import { MAX_DESIGN_CHARS, MAX_TASK_CHARS } from './build.ts';
import type { BuildBrief, BuildSpec } from './build.ts';
import { boundsWithin } from './primitives.ts';
import type { RequirementGraph } from './requirements.ts';

export type BriefIssueCode =
  | 'section-format'
  | 'must-missing'
  | 'must-not-in-spec'
  | 'must-duplicate'
  | 'number-unknown'
  | 'forbidden-missing'
  | 'forbidden-duplicate'
  | 'duplicate-id'
  | 'level-reference'
  | 'space-reference'
  | 'element-reference'
  | 'opening-reference'
  | 'route-reference'
  | 'opening-size'
  | 'interior-missing'
  | 'bounds-outside-site'
  | 'count-mismatch'
  | 'budget'
  | 'task-too-long'
  | 'design-too-long'
  | 'table-4x2'
  | 'no-chairs'
  | 'door-clearance-1m'
  | 'counter-table-1m'
  | 'scheme-gate'
  | 'datum-conflict';

export interface BriefIssue {
  readonly code: BriefIssueCode;
  readonly message: string;
}

function collectNumbers(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 20) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(String(value));
    return;
  }
  if (typeof value === 'string') {
    for (const match of value.matchAll(/-?\d+(?:\.\d+)?/g)) out.add(match[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectNumbers(item, out, depth + 1);
  }
}

function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicated.add(id);
    seen.add(id);
  }
  return [...duplicated];
}

function expectedHeadings(spec: BuildSpec): readonly string[] {
  return [
    `# ${spec.title}`,
    '## 一、需求与设计意图',
    '## 二、禁止项与边界',
    '## 三、场地、尺寸与建造要求',
    '## 四、验收与自由发挥',
  ];
}

/**
 * 构建前 lint。requirements 可选；给了就额外核对“需求图里的 must 是否都进了 spec”。
 */
export function lintBrief(brief: BuildBrief, requirements?: RequirementGraph): BriefIssue[] {
  const issues: BriefIssue[] = [];
  const spec = brief.spec;
  const add = (code: BriefIssueCode, message: string): void => {
    issues.push({ code, message });
  };

  let taskOk = true;
  try {
    extractTaskBody(brief.taskMarkdown);
  } catch (error) {
    taskOk = false;
    add(
      'section-format',
      `四节题面无法被 extractTaskBody 解析：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const heading of expectedHeadings(spec)) {
    if (!brief.taskMarkdown.includes(heading)) add('section-format', `题面缺少标题或章节：${heading}`);
  }

  const mustIds = new Set<string>();
  for (const must of spec.musts) {
    if (mustIds.has(must.id)) add('must-duplicate', `必须项 id 重复：${must.id}`);
    mustIds.add(must.id);
    if (!brief.taskMarkdown.includes(must.id)) add('must-missing', `必须项 ${must.id} 没有出现在题面里`);
    if (!brief.taskMarkdown.includes(must.text)) add('must-missing', `必须项 ${must.id} 的文本没有完整出现在题面里`);
  }
  if (requirements !== undefined) {
    for (const requirement of requirements.requirements) {
      if (requirement.priority !== 'must' || requirement.status === 'rejected') continue;
      if (!mustIds.has(requirement.id)) {
        add('must-not-in-spec', `需求图里的必须项 ${requirement.id} 没有进入 BuildSpec.musts`);
      }
    }
  }

  const forbiddenSeen = new Set<string>();
  for (const item of spec.forbidden) {
    if (forbiddenSeen.has(item)) add('forbidden-duplicate', `禁项重复：${item}`);
    forbiddenSeen.add(item);
    if (!brief.taskMarkdown.includes(item)) add('forbidden-missing', `禁项没有出现在题面第二节：${item}`);
  }

  for (const [label, ids] of [
    ['楼层', spec.levels.map((entry) => entry.id)],
    ['空间', spec.spaces.map((entry) => entry.id)],
    ['元素', spec.elements.map((entry) => entry.id)],
    ['洞口', spec.openings.map((entry) => entry.id)],
    ['路线', spec.routes.map((entry) => entry.id)],
  ] as const) {
    for (const id of duplicateIds(ids)) add('duplicate-id', `${label} id 重复：${id}`);
  }

  const levelIds = new Set(spec.levels.map((level) => level.id));
  const spaceIds = new Set(spec.spaces.map((space) => space.id));
  const elementIds = new Set(spec.elements.map((element) => element.id));

  for (const space of spec.spaces) {
    if (!levelIds.has(space.level)) add('level-reference', `空间 ${space.id} 引用了不存在的楼层 ${space.level}`);
    for (const connection of space.connections) {
      if (!spaceIds.has(connection)) {
        add('space-reference', `空间 ${space.id} 引用了不存在的连接空间 ${connection}`);
      }
    }
  }
  for (const element of spec.elements) {
    if (!levelIds.has(element.level)) add('level-reference', `元素 ${element.id} 引用了不存在的楼层 ${element.level}`);
    if (element.spaceId !== null && !spaceIds.has(element.spaceId)) {
      add('space-reference', `元素 ${element.id} 引用了不存在的空间 ${element.spaceId}`);
    }
  }

  const levelElevation = new Map(spec.levels.map((level) => [level.id, level.elevation]));
  for (const opening of spec.openings) {
    if (!levelIds.has(opening.level)) add('level-reference', `洞口 ${opening.id} 引用了不存在的楼层 ${opening.level}`);
    if (!elementIds.has(opening.host))
      add('opening-reference', `洞口 ${opening.id} 引用了不存在的宿主 ${opening.host}`);
    const width = opening.bounds.max[0] - opening.bounds.min[0];
    const height = opening.bounds.max[1] - opening.bounds.min[1];
    if (width !== opening.width || height !== opening.height) {
      add('opening-size', `洞口 ${opening.id} 的宽高与 bounds 不一致`);
    }
    const elevation = levelElevation.get(opening.level);
    if (elevation !== undefined) {
      const sill = opening.bounds.min[1] - elevation;
      const head = opening.bounds.max[1] - elevation;
      if (sill !== opening.sillHeight || head !== opening.headHeight) {
        add('opening-size', `洞口 ${opening.id} 的窗台 / 过梁与楼层标高不一致`);
      }
      if (sill < 0 || head <= 0) add('opening-size', `洞口 ${opening.id} 的窗台或过梁不合理`);
    }
  }

  for (const route of spec.routes) {
    if (!levelIds.has(route.level)) add('level-reference', `路线 ${route.id} 引用了不存在的楼层 ${route.level}`);
    if (route.fromSpaceId !== null && !spaceIds.has(route.fromSpaceId)) {
      add('route-reference', `路线 ${route.id} 引用了不存在的起点空间 ${route.fromSpaceId}`);
    }
    if (route.toSpaceId !== null && !spaceIds.has(route.toSpaceId)) {
      add('route-reference', `路线 ${route.id} 引用了不存在的终点空间 ${route.toSpaceId}`);
    }
  }

  if (spec.scope === 'exterior+interior') {
    if (spec.interiors.length === 0) {
      add('interior-missing', '方案声明完整室内，但没有任何室内条目');
    } else {
      const included = new Set(
        spec.interiors.filter((interior) => interior.included).map((interior) => interior.spaceId),
      );
      const missing = spec.spaces.filter((space) => space.kind === 'room' && !included.has(space.id));
      if (missing.length > 0) {
        add(
          'interior-missing',
          `方案声明完整室内，但主要房间没有室内条目：${missing.map((space) => space.id).join('、')}`,
        );
      }
      for (const interior of spec.interiors) {
        if (interior.included && interior.furnitureSpecs.length === 0) {
          add('interior-missing', `室内 ${interior.id} 没有结构化家具；家具名列表不能直接交给构建层`);
        }
      }
    }
  }

  if (!boundsWithin(spec.bounds, spec.siteBounds)) {
    add('bounds-outside-site', '建筑范围超出场地范围');
  }

  if (spec.counts.levels !== spec.levels.length) add('count-mismatch', 'counts.levels 与 levels 数量不一致');
  if (spec.counts.spaces !== spec.spaces.length) add('count-mismatch', 'counts.spaces 与 spaces 数量不一致');
  if (spec.counts.elements !== spec.elements.length) add('count-mismatch', 'counts.elements 与 elements 数量不一致');
  if (spec.counts.openings !== spec.openings.length) add('count-mismatch', 'counts.openings 与 openings 数量不一致');
  if (spec.counts.routes !== spec.routes.length) add('count-mismatch', 'counts.routes 与 routes 数量不一致');
  if (spec.counts.musts !== spec.musts.length) add('count-mismatch', 'counts.musts 与 musts 数量不一致');

  if (spec.budget.targetBlocks !== null && spec.budget.targetBlocks > spec.budget.maxBlocks) {
    add('budget', '预算目标方块数超过上限');
  }
  if (spec.budget.estimatedBlocks !== null && spec.budget.estimatedBlocks > spec.budget.maxBlocks) {
    add('budget', '预算估算方块数超过上限');
  }
  if (spec.budget.maxCostCny !== null && spec.budget.maxCostCny <= 0) {
    add('budget', '预算金额必须为正数');
  }

  if (brief.taskMarkdown.length > MAX_TASK_CHARS) {
    add('task-too-long', `题面 ${String(brief.taskMarkdown.length)} 字符，超过上限 ${String(MAX_TASK_CHARS)}`);
  }
  if (brief.designMarkdown.length > MAX_DESIGN_CHARS) {
    add(
      'design-too-long',
      `设计报告 ${String(brief.designMarkdown.length)} 字符，超过上限 ${String(MAX_DESIGN_CHARS)}`,
    );
  }

  if (taskOk) {
    const allowed = new Set<string>();
    collectNumbers(spec, allowed);
    const reported = new Set<string>();
    const lines = brief.taskMarkdown.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      for (const match of line.matchAll(/-?\d+(?:\.\d+)?/g)) {
        const token = match[0];
        if (allowed.has(token) || reported.has(token)) continue;
        reported.add(token);
        add('number-unknown', `题面第 ${String(index + 1)} 行出现 BuildSpec 中没有的数字 ${token}`);
      }
    }
  }

  return issues;
}
