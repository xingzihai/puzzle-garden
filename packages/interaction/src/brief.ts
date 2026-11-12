/**
 * 构建简报编译器与 lint：DesignScheme → design.md + build-task.md + BuildSpec + gates + promptMeta。
 *
 * 负责：四节题面（可被 @pg/agent/task-body 的 extractTaskBody 解析）、机器约束、现有 gates 能表达的门槛、
 * 以及构建前的结构 lint（must 覆盖、数字一致、空间 / 洞口 / 路线引用、预算、禁项、长度）。
 * 不负责：运行构建、调用模型、几何净空 / 路线求解、读文件；本文件是纯函数。
 *
 * 数字规则：题面里的每个阿拉伯数字都必须能在 BuildSpec 中找到（包括 id / 文本里的数字）；
 * lint 不求解几何，只检查结构一致性与“题面没有第二套数字”。
 */
import { gatesSchema } from '@pg/agent/gates';
import type { GateConfig } from '@pg/agent/gates';

import { BuildBrief, BuildSpec } from './build.ts';
import type { BuildGates, BuildMust, BuildMustSource, PromptMeta } from './build.ts';
import { CAPABILITY_CARD_VERSION } from './capability.ts';
import { buildRequirementMustEntries } from './must-ledger.ts';
import { areaOfBounds, boundsSize, ID_MAX } from './primitives.ts';
import type { Bounds, Vec3 } from './primitives.ts';
import { compileDesignReport } from './report.ts';
import type { RequirementGraph } from './requirements.ts';
import type { DesignScheme, SchemeElementKind, SchemeScope } from './scheme.ts';

/** 编译器版本；改变题面结构 / 规则时递增。 */
export const BRIEF_COMPILER_VERSION = '0.1.0';

/** 所有方案都适用的构建边界；与用户禁项一起写进 spec 与第二节。 */
const BASE_FORBIDDEN: readonly string[] = [
  '不得改变已确认方案的主要布局、层数、外部尺寸、层高、入口位置、屋面形式和主要材质',
  '不得增加第二栋主体建筑、城市级场景或超出方案范围的体量',
  '不得承诺或建造当前 World API 不支持的实体物件、动态电梯、完整地下空间展示',
  '不得自行删除或替换用户点名的必须项；无法实现时停止并报告冲突',
];

const SCOPE_LABEL: Readonly<Record<SchemeScope, string>> = {
  exterior: '外观',
  'exterior+entry': '外观 + 入口',
  'exterior+interior': '外观 + 完整室内（主要空间、家具、楼层与固定家具）',
};

/** 方案元素类别 → 现有 World 构件 api；floatingAllowApis 用这些来源名。 */
const WORLD_API_BY_ELEMENT_KIND: Readonly<Record<SchemeElementKind, string>> = {
  wall: 'walls',
  slab: 'floorPlate',
  roof: 'roof',
  stair: 'stair',
  column: 'colonnade',
  railing: 'rail',
  furniture: 'set',
  landscape: 'paving',
  glazing: 'opening',
  marker: 'set',
  canopy: 'roof',
};

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function prefixedId(prefix: 'detail' | 'constraint', id: string): string {
  const head = `${prefix}-`;
  return `${head}${id.slice(0, ID_MAX - head.length)}`;
}

function requirementMusts(scheme: DesignScheme, requirements: RequirementGraph | undefined): BuildMust[] {
  const out: BuildMust[] = [];
  const seen = new Set<string>();
  const push = (id: string, text: string, source: BuildMustSource): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, text, source });
  };
  if (requirements !== undefined) {
    for (const entry of buildRequirementMustEntries(requirements)) {
      push(entry.id, entry.text, entry.source);
    }
  }
  for (const detail of scheme.details) {
    if (detail.priority !== 'must') continue;
    push(prefixedId('detail', detail.id), detail.description, 'detail');
  }
  return out;
}

function forbiddenItems(scheme: DesignScheme, requirements: RequirementGraph | undefined): string[] {
  const fromRequirements =
    requirements?.constraints
      .filter((constraint) => constraint.kind === 'forbidden' && (constraint.hard || constraint.source === 'user'))
      .map((constraint) => constraint.text) ?? [];
  return unique([...BASE_FORBIDDEN, ...scheme.forbidden, ...fromRequirements]);
}

function elevationOf(scheme: DesignScheme, levelId: string): number {
  const level = scheme.levels.find((entry) => entry.id === levelId);
  if (level === undefined) throw new Error(`方案 ${scheme.meta.id} 缺少楼层 ${levelId}`);
  return level.elevation;
}

/**
 * 编译机器约束。所有值来自 DesignScheme 或由 bounds 派生；不在这里估算方块体积。
 * 洞口宽高 / 窗台 / 过梁从 bounds 与楼层标高派生，保证只有一套数字。
 */
export function compileBuildSpec(scheme: DesignScheme, requirements?: RequirementGraph): BuildSpec {
  const [footprintX, , footprintZ] = boundsSize(scheme.site.buildingBounds);
  const musts = requirementMusts(scheme, requirements);
  const forbidden = forbiddenItems(scheme, requirements);

  return BuildSpec.parse({
    schemeId: scheme.meta.id,
    schemeRevision: scheme.meta.revision,
    title: scheme.meta.title,
    scope: scheme.meta.scope,
    entranceSide: scheme.site.entranceSide,
    bounds: scheme.site.buildingBounds,
    siteBounds: scheme.site.bounds,
    levels: scheme.levels.map((level) => ({
      id: level.id,
      name: level.name,
      elevation: level.elevation,
      height: level.height,
    })),
    spaces: scheme.spaces.map((space) => ({
      id: space.id,
      name: space.name,
      level: space.level,
      kind: space.kind,
      bounds: space.bounds,
      areaM2: areaOfBounds(space.bounds),
      connections: space.connections,
    })),
    elements: scheme.elements.map((element) => ({
      id: element.id,
      name: element.name,
      level: element.level,
      kind: element.kind,
      bounds: element.bounds,
      material: element.material,
      spaceId: element.spaceId,
    })),
    openings: scheme.openings.map((opening) => {
      const elevation = elevationOf(scheme, opening.level);
      const width = opening.bounds.max[0] - opening.bounds.min[0];
      const height = opening.bounds.max[1] - opening.bounds.min[1];
      return {
        id: opening.id,
        name: opening.name,
        level: opening.level,
        host: opening.host,
        kind: opening.kind,
        side: opening.side,
        bounds: opening.bounds,
        width,
        height,
        sillHeight: opening.bounds.min[1] - elevation,
        headHeight: opening.bounds.max[1] - elevation,
        fill: opening.fill,
        frameMaterial: opening.frameMaterial,
      };
    }),
    routes: scheme.circulation.map((route) => ({
      id: route.id,
      name: route.name,
      kind: route.kind,
      level: route.level,
      width: route.width,
      accessible: route.accessible,
      fromSpaceId: route.fromSpaceId,
      toSpaceId: route.toSpaceId,
      points: route.points,
    })),
    structure: scheme.structure,
    roof: scheme.roof,
    facades: scheme.facades,
    materials: scheme.materials,
    details: scheme.details,
    interiors: scheme.interiors,
    counts: {
      levels: scheme.levels.length,
      spaces: scheme.spaces.length,
      elements: scheme.elements.length,
      openings: scheme.openings.length,
      routes: scheme.circulation.length,
      musts: musts.length,
      footprintX,
      footprintZ,
      footprintAreaM2: areaOfBounds(scheme.site.buildingBounds),
    },
    budget: scheme.budget,
    forbidden,
    musts,
  });
}

/** 只映射现有 gates 能表达的项；用户禁项、材质、立面等继续留在 BuildSpec。 */
export function compileGates(scheme: DesignScheme): BuildGates {
  const [spanX, , spanZ] = boundsSize(scheme.site.buildingBounds);
  const apis = [...new Set(scheme.elements.map((element) => WORLD_API_BY_ELEMENT_KIND[element.kind]))].sort();
  const wantsReach =
    scheme.circulation.some((route) => route.kind === 'entry') && scheme.spaces.some((space) => space.kind === 'room');
  const config: GateConfig = {
    ...(wantsReach ? { reachAll: true } : {}),
    structureSpans: { x: [1, spanX], z: [1, spanZ] },
    floatingAllowApis: apis,
  };
  return gatesSchema.parse(config);
}

function vecText(value: Vec3): string {
  return `[${value.map((item) => String(item)).join(', ')}]`;
}

function boundsText(bounds: Bounds): string {
  return `x [${String(bounds.min[0])}, ${String(bounds.max[0])}) · y [${String(bounds.min[1])}, ${String(bounds.max[1])}) · z [${String(bounds.min[2])}, ${String(bounds.max[2])})`;
}

function numberText(value: number): string {
  return String(value);
}

function scopeText(scope: SchemeScope): string {
  return SCOPE_LABEL[scope];
}

/**
 * 四节题面。标题与一至四节的格式必须能被 `extractTaskBody` 解析；
 * 所有数字都从 BuildSpec 取，同一个数字只放在一张表里，其他位置引用 id / 表。
 */
export function compileTaskMarkdown(spec: BuildSpec): string {
  const lines: string[] = [];
  lines.push(`# ${spec.title}（方案 v${numberText(spec.schemeRevision)}）`, '');

  lines.push('## 一、需求与设计意图', '');
  lines.push(`- 项目：${spec.title}（方案 ${spec.schemeId} v${numberText(spec.schemeRevision)}）。`);
  lines.push(`- 交付范围：${scopeText(spec.scope)}。`);
  lines.push(
    '- 设计依据：design.md 是用户确认的方案全文；本简报把它编译成构建要求，build-spec.json 是同一方案的机器视图。',
  );
  lines.push('- 优先级：先满足第四节必须项与机器约束，再做形式、材质与细部；不得用体量或装饰替代必须项。');
  lines.push(`- 规模：建筑范围 ${boundsText(spec.bounds)}；场地范围 ${boundsText(spec.siteBounds)}。`, '');

  lines.push('## 二、禁止项与边界', '');
  for (const item of spec.forbidden) lines.push(`- ${item}`);
  lines.push('');

  lines.push('## 三、场地、尺寸与建造要求', '');
  lines.push('### 坐标与范围', '');
  lines.push('- 坐标：x 向东、y 向上、z 向南；单位为格，设计尺度按一格约一米计。');
  lines.push('- bounds 为半开区间 [min, max)，不得把端点当作实体格。');
  lines.push(
    `- 建筑 ${numberText(spec.counts.footprintX)} × ${numberText(spec.counts.footprintZ)} 格（地面投影 ${numberText(spec.counts.footprintAreaM2)} m²，外包）；场地与建筑范围见上表。`,
    '',
  );

  lines.push('### 楼层与标高', '');
  lines.push('| 楼层 | 名称 | 标高 | 层高 |');
  lines.push('| --- | --- | --- | --- |');
  for (const level of spec.levels) {
    lines.push(`| ${level.id} | ${level.name} | ${numberText(level.elevation)} | ${numberText(level.height)} |`);
  }
  lines.push('');

  lines.push('### 空间表', '');
  lines.push('| 空间 | 名称 | 楼层 | 类型 | 范围 | 外包面积 | 连接 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const space of spec.spaces) {
    lines.push(
      `| ${space.id} | ${space.name} | ${space.level} | ${space.kind} | ${boundsText(space.bounds)} | ${numberText(space.areaM2)} m² | ${space.connections.length === 0 ? '—' : space.connections.join('、')} |`,
    );
  }
  lines.push('', '面积按 bounds 地面投影计算，未扣墙厚。', '');

  lines.push('### 门窗洞口', '');
  if (spec.openings.length === 0) {
    lines.push('无洞口。', '');
  } else {
    lines.push('| 洞口 | 名称 | 楼层 | 宿主 | 类型 | 朝向 | 范围 | 宽 | 高 | 窗台 | 过梁 | 填充 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const opening of spec.openings) {
      lines.push(
        `| ${opening.id} | ${opening.name} | ${opening.level} | ${opening.host} | ${opening.kind} | ${opening.side} | ${boundsText(opening.bounds)} | ${numberText(opening.width)} | ${numberText(opening.height)} | ${numberText(opening.sillHeight)} | ${numberText(opening.headHeight)} | ${opening.fill} |`,
      );
    }
    lines.push('');
  }

  lines.push('### 交通路线', '');
  if (spec.routes.length === 0) {
    lines.push('未指定显式路线；仍需保证入口与主要空间可进入。', '');
  } else {
    lines.push('| 路线 | 名称 | 类型 | 楼层 | 宽度 | 可达 | 从 | 到 | 关键点（前段） |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const route of spec.routes) {
      const points = route.points
        .slice(0, 12)
        .map((point) => vecText(point))
        .join(' → ');
      const suffix = route.points.length > 12 ? ' → …（完整点表见 build-spec.json）' : '';
      lines.push(
        `| ${route.id} | ${route.name} | ${route.kind} | ${route.level} | ${numberText(route.width)} | ${route.accessible ? '是' : '否'} | ${route.fromSpaceId ?? '—'} | ${route.toSpaceId ?? '—'} | ${points}${suffix} |`,
      );
    }
    lines.push('');
  }

  lines.push('### 结构与屋面', '');
  lines.push(
    `- 结构：${spec.structure.system}；材料 ${spec.structure.material}；跨度 x ${numberText(spec.structure.spanX)}、z ${numberText(spec.structure.spanZ)}；楼板厚 ${numberText(spec.structure.floorThickness)}；最大悬挑 ${numberText(spec.structure.cantilever)}。`,
  );
  lines.push(
    `- 屋面：${spec.roof.form}；材料 ${spec.roof.material}；坡度 ${numberText(spec.roof.pitchDegrees)}°；檐口 ${numberText(spec.roof.eaveHeight)}、屋脊 ${numberText(spec.roof.ridgeHeight)}、挑檐 ${numberText(spec.roof.overhang)}。`,
  );
  if (spec.roof.drainage !== null) lines.push(`- 排水：${spec.roof.drainage}。`);
  if (spec.roof.skylights.length > 0) lines.push(`- 天窗：${spec.roof.skylights.join('、')}。`);
  lines.push('');

  lines.push('### 立面与材质', '');
  if (spec.facades.length === 0) {
    lines.push('未指定立面分层；按 design.md 与材质表处理。', '');
  } else {
    for (const facade of spec.facades) {
      const ratio = facade.windowWallRatio === null ? '未定' : numberText(facade.windowWallRatio);
      lines.push(
        `- ${facade.side}：基座 ${facade.baseMaterialId}；墙身 ${facade.bodyMaterialId}；顶部 ${facade.topMaterialId ?? '—'}；开间 ${numberText(facade.bays)}；窗墙比 ${ratio}。`,
      );
    }
    lines.push('');
  }
  lines.push('| 材质 | 名称 | 方块 | 角色 |');
  lines.push('| --- | --- | --- | --- |');
  for (const material of spec.materials) {
    lines.push(`| ${material.id} | ${material.name} | ${material.block} | ${material.role} |`);
  }
  lines.push('');

  lines.push('### 细部与室内', '');
  if (spec.details.length === 0) {
    lines.push('- 细部：无额外条目。');
  } else {
    for (const detail of spec.details) {
      const count = detail.count === null ? '数量未定' : `${numberText(detail.count)} 处`;
      lines.push(
        `- [${detail.priority}] ${detail.id} ${detail.name}（${detail.where}，${count}）：${detail.description}`,
      );
    }
  }
  if (spec.interiors.length === 0) {
    lines.push(
      spec.scope === 'exterior+interior'
        ? '- 室内：方案声明完整室内，但没有室内条目；构建前应拒绝。'
        : '- 室内：本方案未包含室内设计，不自行扩展完整内饰。',
    );
  } else {
    for (const interior of spec.interiors) {
      const state = interior.included ? '包含' : '暂不包含';
      lines.push(
        `- 室内 ${interior.id}（${interior.name}，空间 ${interior.spaceId}，${state}）：${interior.furniture.length === 0 ? '无固定家具' : interior.furniture.join('、')}。`,
      );
      for (const furniture of interior.furnitureSpecs) {
        const orientation = furniture.orientation === null ? '无朝向' : `${furniture.orientation} 向`;
        lines.push(
          `  - ${furniture.id} ${furniture.name}（${furniture.kind}）：${boundsText(furniture.bounds)}；材质 ${furniture.materialId}；${orientation}。${furniture.notes ?? ''}`,
        );
      }
    }
  }
  lines.push('');

  lines.push('## 四、验收与自由发挥', '');
  lines.push('### 必须项（逐条核对）', '');
  if (spec.musts.length === 0) {
    lines.push('无额外必须项；按第三节表格执行。');
  } else {
    for (const must of spec.musts) lines.push(`- [ ] ${must.id}：${must.text}`);
  }
  lines.push('', '### 自动门槛', '');
  lines.push(
    '- 构建前按 gates.json 检查现有门槛能表达的部分：可达、结构跨度、悬空来源；不能表达的约束继续以 build-spec.json 为准。',
  );
  lines.push('- 构建前 lint 已检查：必须项覆盖、题面数字与 spec 一致、空间 / 洞口 / 路线引用、预算、禁项与任务长度。');
  lines.push('', '### 自由发挥', '');
  lines.push(
    '- 在不改变主要布局、层数、外部尺寸、层高、入口位置、屋面形式和主要材质的前提下，构造做法、局部装饰、铺装图案、灯具与家具细节可自行处理。',
  );
  lines.push(
    '- 若方案未包含室内，不要自行扩展完整内饰；若方案声明完整室内，必须完成主要空间、家具、楼层与固定家具，不能只做空壳。',
  );
  lines.push(
    '- 遇到无法实现、与 spec 冲突或需要改方案的情况：停止并报告冲突位置、原因与建议，不要自行修改已确认方案。',
    '',
  );

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/** 编译完整简报；requirements 可选，给了才把 must / 用户禁项写进 spec 与题面。 */
export function compileBuildBrief(scheme: DesignScheme, requirements?: RequirementGraph): BuildBrief {
  const spec = compileBuildSpec(scheme, requirements);
  const designMarkdown = compileDesignReport(scheme, requirements);
  const taskMarkdown = compileTaskMarkdown(spec);
  const gates = compileGates(scheme);
  const promptMeta: PromptMeta = {
    compilerVersion: BRIEF_COMPILER_VERSION,
    schemeId: scheme.meta.id,
    schemeRevision: scheme.meta.revision,
    requirementsGraphId: requirements?.id ?? scheme.meta.sourceRequirements.graphId,
    requirementsRevision: requirements?.revision ?? scheme.meta.sourceRequirements.revision,
    capabilityCardVersion: CAPABILITY_CARD_VERSION,
    designReportChars: designMarkdown.length,
    taskChars: taskMarkdown.length,
  };
  return BuildBrief.parse({ designMarkdown, taskMarkdown, spec, gates, promptMeta });
}

export { lintBrief } from './lint.ts';
export type { BriefIssue, BriefIssueCode } from './lint.ts';
