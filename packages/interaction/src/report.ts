/**
 * 设计报告编译器：把一份 DesignScheme 编译成中文 Markdown（用户确认用的方案全文）。
 *
 * 负责：项目概念、需求与来源、场地、面积 / 空间表、楼层标高、平面 / 剖面说明、结构、屋面、
 * 立面 / 材质、细部、室内、必须项 / 自由范围、未决问题。
 * 不负责：读文件、调用模型、渲染预览、做净值 / 净空求解；本文件是纯函数。
 *
 * 数字口径：面积只按 space.bounds 的地面投影计算并明确标注“外包、未扣墙厚”；
 * 报告不写方案字段之外的数字，也不把估算说成实测。
 */
import { deriveFloorDatum } from './floor-datum.ts';
import type { FloorDatumResult } from './floor-datum.ts';
import { areaOfBounds, boundsSize } from './primitives.ts';
import type { Bounds, Vec3 } from './primitives.ts';
import type { RequirementGraph, RequirementPriority, RequirementSource, RequirementStatus } from './requirements.ts';
import type {
  CirculationKind,
  DesignScheme,
  MaterialRole,
  OpeningKind,
  RoofForm,
  SchemeScope,
  SchemeSpaceKind,
  SchemeStatus,
  Side,
  StructureSystem,
} from './scheme.ts';

const STATUS_LABEL: Readonly<Record<SchemeStatus, string>> = {
  draft: '草案',
  review: '待评审',
  confirmed: '已确认',
  superseded: '已被替代',
};

const SCOPE_LABEL: Readonly<Record<SchemeScope, string>> = {
  exterior: '外观',
  'exterior+entry': '外观 + 入口',
  'exterior+interior': '外观 + 完整室内（主要空间、家具、楼层与固定家具）',
};

const SIDE_LABEL: Readonly<Record<Side, string>> = {
  north: '北',
  east: '东',
  south: '南',
  west: '西',
};

const SPACE_KIND_LABEL: Readonly<Record<SchemeSpaceKind, string>> = {
  room: '房间',
  circulation: '交通',
  void: '挑空',
  service: '服务',
  outdoor: '室外',
};

const OPENING_KIND_LABEL: Readonly<Record<OpeningKind, string>> = {
  door: '门',
  window: '窗',
  opening: '洞口',
  gate: '院门',
};

const CIRCULATION_KIND_LABEL: Readonly<Record<CirculationKind, string>> = {
  entry: '入口',
  corridor: '走廊',
  stair: '楼梯',
  ramp: '坡道',
  path: '路径',
};

const STRUCTURE_LABEL: Readonly<Record<StructureSystem, string>> = {
  'load-bearing-walls': '墙承重',
  'post-and-beam': '梁柱',
  frame: '框架',
  mixed: '混合',
};

const ROOF_LABEL: Readonly<Record<RoofForm, string>> = {
  flat: '平屋面',
  gable: '双坡屋面',
  hip: '四坡屋面',
  shed: '单坡屋面',
  butterfly: '反坡屋面',
  curved: '曲面屋面',
  other: '其他屋面',
};

const MATERIAL_ROLE_LABEL: Readonly<Record<MaterialRole, string>> = {
  structure: '结构',
  wall: '墙体',
  roof: '屋面',
  floor: '楼地面',
  trim: '收边 / 线脚',
  furniture: '家具',
  landscape: '景观',
  glass: '玻璃',
};

const REQUIREMENT_PRIORITY_LABEL: Readonly<Record<RequirementPriority, string>> = {
  must: '必须',
  should: '应当',
  could: '可选',
};

const REQUIREMENT_SOURCE_LABEL: Readonly<Record<RequirementSource, string>> = {
  user: '用户',
  agent: '代理',
  default: '默认',
  imported: '导入',
};

const REQUIREMENT_STATUS_LABEL: Readonly<Record<RequirementStatus, string>> = {
  proposed: '提议',
  assumed: '假定',
  confirmed: '已确认',
  rejected: '已拒绝',
  unresolved: '未决',
};

function vecText(value: Vec3): string {
  return `[${value.map((item) => String(item)).join(', ')}]`;
}

function boundsText(bounds: Bounds): string {
  return `x [${String(bounds.min[0])}, ${String(bounds.max[0])}) · y [${String(bounds.min[1])}, ${String(bounds.max[1])}) · z [${String(bounds.min[2])}, ${String(bounds.max[2])})`;
}

function sizeText(bounds: Bounds): string {
  const [x, y, z] = boundsSize(bounds);
  return `${String(x)} × ${String(y)} × ${String(z)} 格`;
}

function areaText(bounds: Bounds): string {
  return `${String(areaOfBounds(bounds))} m²`;
}

function listOrNone(items: readonly string[], none: string): string {
  return items.length === 0 ? none : items.join('、');
}

function materialName(scheme: DesignScheme, id: string): string {
  return scheme.materials.find((material) => material.id === id)?.name ?? id;
}

/**
 * 编译设计报告。requirements 可选：给了就逐条列出来源与原话；没给时只列方案内设计决策，
 * 不假装知道用户原话。
 */
export function compileDesignReport(scheme: DesignScheme, requirements?: RequirementGraph): string {
  const lines: string[] = [];
  const meta = scheme.meta;
  const datum = deriveFloorDatum(scheme, requirements);

  lines.push(`# ${meta.title}`, '');
  lines.push(`- 方案：${meta.id} v${String(meta.revision)}`);
  lines.push(`- 状态：${STATUS_LABEL[meta.status]}`);
  lines.push(`- 范围：${SCOPE_LABEL[meta.scope]}`);
  lines.push(`- 概念：${meta.concept}`);
  lines.push(`- 来源需求图：${meta.sourceRequirements.graphId} v${String(meta.sourceRequirements.revision)}`, '');

  lines.push('## 项目概念', '');
  lines.push(meta.concept, '');

  lines.push('## 用户需求与来源', '');
  if (requirements === undefined) {
    lines.push('本报告未附带需求图；以下只列方案内可追溯的设计决策，不代写用户原话。', '');
  } else {
    lines.push(`- 需求图：${requirements.id} v${String(requirements.revision)}`);
    lines.push(`- 摘要：${requirements.summary}`, '');
    for (const requirement of requirements.requirements) {
      const quote = requirement.quote === null ? '' : `；原话：“${requirement.quote}”`;
      lines.push(
        `- [${REQUIREMENT_PRIORITY_LABEL[requirement.priority]} / ${REQUIREMENT_SOURCE_LABEL[requirement.source]} / ${REQUIREMENT_STATUS_LABEL[requirement.status]}] ${requirement.text}${quote}`,
      );
    }
    if (requirements.preferences.length > 0) {
      lines.push('', '### 偏好');
      for (const preference of requirements.preferences) {
        lines.push(`- [${preference.kind} / ${preference.strength} / ${preference.status}] ${preference.text}`);
      }
    }
    if (requirements.constraints.length > 0) {
      lines.push('', '### 约束');
      for (const constraint of requirements.constraints) {
        const hard = constraint.hard ? '硬约束' : '建议';
        const value = constraint.value === null ? '' : `（${constraint.value}）`;
        lines.push(`- [${constraint.kind} / ${hard}] ${constraint.text}${value}`);
      }
    }
    lines.push('');
  }

  lines.push('## 设计决策', '');
  if (scheme.decisions.length === 0) {
    lines.push('无单独记录的设计决策。', '');
  } else {
    for (const decision of scheme.decisions) {
      lines.push(
        `- [${decision.source === 'user' ? '用户确认' : decision.source === 'agent' ? '代理建议' : '默认值'} / ${decision.status}] ${decision.topic}：${truthfulFlushText(decision.choice, datum)}（理由：${truthfulFlushText(decision.rationale, datum)}）`,
      );
    }
    lines.push('');
  }

  lines.push('## 场地', '');
  lines.push(`- 场地范围：${boundsText(scheme.site.bounds)}`);
  lines.push(`- 建筑范围：${boundsText(scheme.site.buildingBounds)}（${sizeText(scheme.site.buildingBounds)}）`);
  const orientation = scheme.site.orientation === 'unknown' ? '未定' : SIDE_LABEL[scheme.site.orientation];
  lines.push(`- 朝向：${orientation}；入口：${SIDE_LABEL[scheme.site.entranceSide]}`);
  if (scheme.site.notes !== null) lines.push(`- 场地说明：${scheme.site.notes}`);
  if (scheme.site.outdoorZones.length === 0) {
    lines.push('- 室外分区：无');
  } else {
    lines.push('- 室外分区：');
    for (const zone of scheme.site.outdoorZones) {
      lines.push(`  - ${zone.name}（${zone.kind}，${boundsText(zone.bounds)}）：${zone.material}`);
    }
  }
  lines.push('');

  lines.push('## 面积与空间表', '');
  lines.push('| 空间 | 楼层 | 类型 | 范围 | 外包面积 | 连接 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const space of scheme.spaces) {
    lines.push(
      `| ${space.name}（${space.id}） | ${space.level} | ${SPACE_KIND_LABEL[space.kind]} | ${boundsText(space.bounds)} | ${areaText(space.bounds)} | ${listOrNone(space.connections, '—')} |`,
    );
  }
  lines.push('', '面积按空间 bounds 的地面投影计算，未扣墙厚；不把外包面积当作净面积。', '');

  lines.push('## 楼层与标高', '');
  lines.push('| 楼层 | 标高 | 层高 |');
  lines.push('| --- | --- | --- |');
  for (const level of scheme.levels) {
    lines.push(`| ${level.name}（${level.id}） | ${String(level.elevation)} | ${String(level.height)} |`);
  }
  lines.push('', ...floorDatumLines(datum), '');

  lines.push('## 平面与剖面说明', '');
  lines.push('### 平面', '');
  for (const level of scheme.levels) {
    const names = scheme.spaces.filter((space) => space.level === level.id).map((space) => space.name);
    lines.push(`- ${level.name}（标高 ${String(level.elevation)}）：${listOrNone(names, '无空间')}`);
  }
  if (scheme.circulation.length === 0) {
    lines.push('- 交通：未记录显式路线。');
  } else {
    for (const route of scheme.circulation) {
      const first = route.points[0];
      const last = route.points[route.points.length - 1];
      const ends = first === undefined || last === undefined ? '' : `，${vecText(first)} → ${vecText(last)}`;
      lines.push(
        `- 交通：${route.name}（${CIRCULATION_KIND_LABEL[route.kind]}，宽 ${String(route.width)} 格，${String(route.points.length)} 个站立点${ends}）`,
      );
    }
  }
  lines.push('', '### 门窗洞口', '');
  if (scheme.openings.length === 0) {
    lines.push('未记录门窗洞口。');
  } else {
    for (const opening of scheme.openings) {
      const width = opening.bounds.max[0] - opening.bounds.min[0];
      const height = opening.bounds.max[1] - opening.bounds.min[1];
      lines.push(
        `- ${opening.name}（${OPENING_KIND_LABEL[opening.kind]}，${SIDE_LABEL[opening.side]}，宿主 ${opening.host}）：${boundsText(opening.bounds)}，宽 ${String(width)} 格、高 ${String(height)} 格。`,
      );
    }
  }
  lines.push('', '### 剖面', '');
  for (const level of scheme.levels) {
    lines.push(`- ${level.name}：标高 ${String(level.elevation)}，层高 ${String(level.height)} 格。`);
  }
  lines.push(
    `- 屋面：檐口标高 ${String(scheme.roof.eaveHeight)}，屋脊标高 ${String(scheme.roof.ridgeHeight)}，挑檐 ${String(scheme.roof.overhang)} 格。`,
  );
  lines.push(
    `- 结构跨度：x ${String(scheme.structure.spanX)} 格、z ${String(scheme.structure.spanZ)} 格；楼板厚 ${String(scheme.structure.floorThickness)} 格。`,
  );
  lines.push('', '本报告只给方案层面的标高与尺寸；精确净空、逐格路线与结构可行性由后续确定性检查给出。', '');

  lines.push('## 结构', '');
  lines.push(`- 体系：${STRUCTURE_LABEL[scheme.structure.system]}；材料：${scheme.structure.material}`);
  lines.push(`- 跨度：x ${String(scheme.structure.spanX)} 格、z ${String(scheme.structure.spanZ)} 格`);
  lines.push(
    `- 楼板厚：${String(scheme.structure.floorThickness)} 格；最大悬挑：${String(scheme.structure.cantilever)} 格`,
  );
  if (scheme.structure.notes !== null) lines.push(`- 说明：${scheme.structure.notes}`);
  lines.push('');

  lines.push('## 屋面', '');
  const roofSegmentCount = scheme.elements.filter((element) => element.kind === 'roof').length;
  if (roofSegmentCount > 1) {
    lines.push(
      `- 多段屋面：共 ${String(roofSegmentCount)} 段，按顶层平面分解；以下数值为主屋面（面积最大段），段间谷脊构造未建模。`,
    );
  }
  lines.push(`- 形式：${ROOF_LABEL[scheme.roof.form]}；材料：${scheme.roof.material}`);
  lines.push(`- 坡度：${String(scheme.roof.pitchDegrees)}°`);
  lines.push(
    `- 檐口 / 屋脊 / 挑檐：${String(scheme.roof.eaveHeight)} / ${String(scheme.roof.ridgeHeight)} / ${String(scheme.roof.overhang)} 格`,
  );
  if (scheme.roof.drainage !== null) lines.push(`- 排水：${scheme.roof.drainage}`);
  if (scheme.roof.skylights.length > 0) lines.push(`- 天窗：${scheme.roof.skylights.join('、')}`);
  if (scheme.roof.notes !== null) lines.push(`- 说明：${scheme.roof.notes}`);
  lines.push('');

  lines.push('## 立面与材质', '');
  lines.push('### 立面', '');
  if (scheme.facades.length === 0) {
    lines.push('未记录立面分层。');
  } else {
    for (const facade of scheme.facades) {
      const top = facade.topMaterialId === null ? '—' : materialName(scheme, facade.topMaterialId);
      const ratio = facade.windowWallRatio === null ? '未定' : String(facade.windowWallRatio);
      lines.push(
        `- ${SIDE_LABEL[facade.side]}立面：基座 ${materialName(scheme, facade.baseMaterialId)}；墙身 ${materialName(scheme, facade.bodyMaterialId)}；顶部 ${top}；开间 ${String(facade.bays)}；窗墙比 ${ratio}`,
      );
    }
  }
  lines.push('', '### 材质', '');
  for (const material of scheme.materials) {
    lines.push(`- ${material.name}（${material.id}）：${material.block}，${MATERIAL_ROLE_LABEL[material.role]}`);
  }
  lines.push('');

  lines.push('## 细部', '');
  if (scheme.details.length === 0) {
    lines.push('无细部条目。', '');
  } else {
    for (const detail of scheme.details) {
      const count = detail.count === null ? '未定数量' : `${String(detail.count)} 处`;
      lines.push(`- [${detail.priority}] ${detail.name}（${detail.where}，${count}）：${detail.description}`);
    }
    lines.push('');
  }

  lines.push('## 室内', '');
  if (scheme.interiors.length === 0) {
    lines.push(
      scheme.meta.scope === 'exterior+interior'
        ? '方案声明完整室内，但没有记录任何室内设计；这是未完成项，不能交给构建层。'
        : '本方案未包含室内设计；构建范围以方案 meta.scope 为准，不自行扩展完整内饰。',
      '',
    );
  } else {
    for (const interior of scheme.interiors) {
      const state = interior.included ? '包含' : '暂不包含';
      lines.push(
        `- ${interior.name}（空间 ${interior.spaceId}，${state}）：${listOrNone(interior.furniture, '无固定家具')}`,
      );
      for (const furniture of interior.furnitureSpecs) {
        const orientation = furniture.orientation === null ? '无朝向' : `${SIDE_LABEL[furniture.orientation]}向`;
        lines.push(
          `  - ${furniture.name}（${furniture.kind}，${boundsText(furniture.bounds)}，${materialName(scheme, furniture.materialId)}，${orientation}）${furniture.notes === null ? '' : `：${furniture.notes}`}`,
        );
      }
    }
    lines.push('');
  }

  lines.push('## 必须项与自由范围', '');
  lines.push('### 必须项', '');
  const mustRequirements =
    requirements?.requirements.filter(
      (requirement) => requirement.priority === 'must' && requirement.status !== 'rejected',
    ) ?? [];
  const mustDetails = scheme.details.filter((detail) => detail.priority === 'must');
  if (mustRequirements.length === 0 && mustDetails.length === 0) {
    lines.push('无额外必须项；按方案表执行。');
  } else {
    for (const requirement of mustRequirements) {
      lines.push(`- [${requirement.id}] ${requirement.text}`);
    }
    for (const detail of mustDetails) {
      lines.push(`- [${detail.id}] ${detail.description}`);
    }
  }
  lines.push('', '### 自由范围', '');
  const freeItems = scheme.open.filter((item) => item.freeForBuilder);
  if (freeItems.length === 0) {
    lines.push('未额外授权自由发挥；按方案执行。');
  } else {
    for (const item of freeItems) {
      lines.push(`- ${truthfulFlushText(item.question, datum)}`);
    }
  }
  lines.push(
    '- 在不改变主要布局、层数、外部尺寸、层高、入口位置、屋面形式和主要材质的前提下，构造做法、局部装饰、铺装图案、灯具与家具细节可由构建层自行处理。',
    '',
  );

  lines.push('## 未决问题', '');
  if (scheme.open.length === 0) {
    lines.push('无未决问题。');
  } else {
    for (const item of scheme.open) {
      const assumption =
        item.defaultAssumption === null
          ? '无默认假设'
          : `默认假设：${truthfulFlushText(item.defaultAssumption, datum)}`;
      lines.push(
        `- [${item.status}/${item.owner}/${item.impact}] ${truthfulFlushText(item.question, datum)}；${assumption}`,
      );
    }
  }
  lines.push('');

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

function floorDatumLines(result: FloorDatumResult): string[] {
  const datum = result.datum;
  const lines = ['### 标高与入口'];
  lines.push(
    `- 室内站立面 y${String(datum.standingY)}（standingY）；楼板顶格 y${String(datum.slabTopY)}（slabTopY）；室外地面 y${String(datum.gradeY)}（gradeY）。`,
  );
  if (datum.entryTransition === 'flush') {
    lines.push(
      `- 入口：室内外同高（flush）；入口底 y${String(datum.entryThresholdY)}，室外地面 y${String(datum.gradeY)}；${
        datum.source === 'raise-site' ? '场地/基座与楼面同高（raise-site）。' : '按现有场地标高。'
      }`,
    );
  } else if (datum.entryTransition === 'one-step') {
    lines.push(
      `- 入口：1 格高差（one-step）；入口底 y${String(datum.entryThresholdY)}，室外地面 y${String(datum.gradeY)}；${
        result.flushRequired
          ? `未满足“无台阶”要求，已记录冲突 ${result.conflict?.id ?? 'conflict-flush-entry'}，建议将场地/基座抬至 y${String(datum.standingY)}。`
          : '当前需求未要求无台阶入口，按现状记录。'
      }`,
    );
  } else {
    lines.push('- 入口：未识别（unknown）；不能声称室内外同高。');
  }
  const doors = datum.doors.map((band) => `${band.id} y${String(band.minY)}..${String(band.maxY)}`).join('、') || '—';
  const windows =
    datum.windows.map((band) => `${band.id} y${String(band.minY)}..${String(band.maxY)}`).join('、') || '—';
  lines.push(`- 门洞：${doors}；窗：${windows}。`);
  if (result.conflict !== null) {
    lines.push(`- 冲突：${result.conflict.id}；${result.conflict.actual}；处置：${result.conflict.resolution}`);
  }
  lines.push('- 本节以 DesignScheme 的实际 bounds 为准；设计决策 / 未决项中与本节日冲突的标高表述已按实际高差改写。');
  return lines;
}

function truthfulFlushText(text: string, result: FloorDatumResult): string {
  if (result.datum.entryTransition === 'flush') return text;
  return text.replaceAll('齐平', '同高（未实现）');
}
