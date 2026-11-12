/**
 * 网页会话摘要的纯格式化函数：方案卡数据与 brief 统计。
 *
 * 负责：SessionState / DesignScheme → WebSummary，BuildBrief → WebBriefStats。
 * 不负责：会话状态机、I/O、模型调用；由 interaction-server-session.ts 与恢复逻辑共用。
 */

import type { BuildBrief, DesignScheme, SchemeScope } from '@pg/interaction/schema';
import type { SessionState } from '@pg/interaction/session';

import type { WebBriefStats, WebSummary } from './interaction-server-session.ts';

const SCOPE_LABEL: Readonly<Record<SchemeScope, string>> = {
  exterior: '外观',
  'exterior+entry': '外观 + 入口',
  'exterior+interior': '外观 + 完整室内',
};

export function sectionSummary(state: SessionState, scheme: DesignScheme): WebSummary {
  const requirements = state.requirements;
  const musts =
    requirements === null
      ? []
      : requirements.requirements
          .filter((item) => item.priority === 'must' && item.status !== 'rejected')
          .map((item) => `[${item.id}] ${item.text}`);
  return {
    schemeId: scheme.meta.id,
    revision: scheme.meta.revision,
    title: scheme.meta.title,
    concept: scheme.meta.concept,
    scope: scheme.meta.scope,
    scopeLabel: SCOPE_LABEL[scheme.meta.scope],
    rooms: scheme.spaces.filter((space) => space.kind !== 'outdoor').map((space) => space.name),
    musts,
    open: scheme.open.map((item) => item.question),
    decisions: scheme.decisions.slice(0, 6).map((item) => `${item.topic}：${item.choice}`),
  };
}

function gateLines(gates: BuildBrief['gates']): string[] {
  const lines: string[] = [];
  if (gates.forbidApis !== undefined) lines.push(`禁用 API：${gates.forbidApis.join('、')}`);
  if (gates.symmetry !== undefined) {
    const at = gates.symmetry.at === undefined ? '' : ` @ ${String(gates.symmetry.at)}`;
    lines.push(`对称轴：${gates.symmetry.axis}${at}，至少 ${String(gates.symmetry.min)}`);
  }
  if (gates.structureSpans !== undefined) {
    lines.push(
      `结构跨度：x ${gates.structureSpans.x.map(String).join('–')}，z ${gates.structureSpans.z.map(String).join('–')}`,
    );
  }
  if (gates.reachAll === true) lines.push('全部目标可达');
  if (gates.reachInsideWalls !== undefined) {
    lines.push(`墙内可达比例 ≥ ${String(gates.reachInsideWalls.minRatio)}`);
  }
  if (gates.floatingAllowApis !== undefined) {
    lines.push(`悬空允许：${gates.floatingAllowApis.join('、') || '无'}`);
  }
  if (gates.sourceRegions !== undefined) lines.push(`来源区域：${String(gates.sourceRegions.length)} 处`);
  return lines.length === 0 ? ['未设置额外门槛'] : lines;
}

export function briefStats(brief: BuildBrief): WebBriefStats {
  return {
    designChars: brief.designMarkdown.length,
    taskChars: brief.taskMarkdown.length,
    gates: gateLines(brief.gates),
  };
}
