/**
 * L2 状态卡的生产宿主适配（W11-08）。
 *
 * 负责：把 runner 已持有的稿 / check / view / plan / 预算，与宿主能证明的对象 / 家具 / must 证据
 *   压成一张确定性短卡；没有证据的栏目写 unknown，plan 自报永远单独一行。
 * 不负责：计算 conformance、执行 check、解析模型计划（分别由 tools/check、turn-tools、tools/plan 负责）。
 * 与 `prompt/state-card.ts` 的区别：那个文件是 W11-02 的纯格式契约；生产需要表达
 *   “没有 BuildSheet 时 total 也未知”与“没有 shadow 报告时 objects 未知”，所以这里保留 unknown 维度。
 */

import type { DiffReport, DiffStatus } from '@pg/analysis/object-diff';

import type { CheckOutcome } from './facts.ts';

/** 状态卡格式版本；字段或措辞变化时加 1。 */
export const STATE_CARD_VERSION = 'v1';
/** 设计上限；实际 token 由 tokenizer 测试复核。 */
export const STATE_CARD_MAX_TOKENS = 550;
/** 字符上限与 W11-02 契约一致；ASCII 为主时约 500–550 token。 */
export const STATE_CARD_MAX_CHARS = 2200;

export interface StateCounts {
  readonly pass: number;
  readonly fail: number;
  readonly missing: number;
  readonly unverified?: number;
  readonly extra?: number;
  /** 前 1–3 个非 PASS id；只给 id，不贴全文。 */
  readonly nonPassIds?: readonly string[];
}

export interface MustEvidence {
  /** null 表示没有 BuildSheet，连 must 总数都未知。 */
  readonly total: number | null;
  /** null 表示没有确定性 shadow / verified mapping 证据。 */
  readonly evidence: number | null;
  readonly unverified: number | null;
  readonly notLinked: number | null;
}

export interface StateCardInput {
  /** 模型 plan 的阶段；没有 plan 时写 unknown。 */
  readonly phase?: string;
  readonly draftVersion: number | null;
  readonly lastCheck: {
    readonly version: number;
    readonly outcome: CheckOutcome;
  } | null;
  readonly lastView: { readonly version: number; readonly view?: string } | null;
  /** null 表示没有可用的对象 diff（不是 0 个对象）。 */
  readonly objects: StateCounts | null;
  /** null 表示没有家具核对证据（不是 0 件家具）。 */
  readonly furniture: StateCounts | null;
  /** null 表示完全没有 BuildSheet；evidence=null 表示有合同但没有 shadow 证据。 */
  readonly musts: MustEvidence | null;
  readonly conflicts: {
    readonly count: number;
    readonly ids?: readonly string[];
  };
  /** plan 的自报进度；只是自报，不是 must 证据。 */
  readonly plan: { readonly verified: number; readonly total: number } | null;
  readonly budget: {
    readonly turn: number;
    readonly maxTurns: number | null;
    readonly spentCny: number | null;
    readonly maxCny: number | null;
    readonly wallMinutes: number;
    readonly wallMaxMinutes: number;
    readonly unmetered?: boolean;
  };
  /**
   * 宿主派生的下一步：家具 / must / view / check 优先，plan 的 doing / todo 最后；
   * 最多显示 3 条。只是提示，不改变工具或 submit 判定。
   */
  readonly next?: readonly string[];
  /** 连续两次相同的 check 失败对象 / 错误；只提示，不阻止 edit。 */
  readonly repeatedFailure?: { readonly count: number; readonly target?: string };
}

const oneLine = (text: string, max = 120): string => {
  const clean = text.replace(/\s*\n\s*/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
};

function countsLine(label: string, c: StateCounts): string {
  const extra = c.extra === undefined ? '' : ` extra=${String(c.extra)}`;
  const unverified = c.unverified === undefined ? '' : ` unverified=${String(c.unverified)}`;
  const ids = (c.nonPassIds ?? []).slice(0, 3).map((id) => oneLine(id, 28));
  const tail = ids.length === 0 ? '' : `  non-pass=${ids.join(',')}`;
  return `${label} pass=${String(c.pass)} fail=${String(c.fail)} missing=${String(c.missing)}${unverified}${extra}${tail}`;
}

function mustLine(m: MustEvidence | null, conflicts: StateCardInput['conflicts']): string {
  const ids = (conflicts.ids ?? []).slice(0, 3).map((id) => oneLine(id, 32));
  const conflictText = `conflicts=${String(conflicts.count)}${ids.length === 0 ? '' : ` (${ids.join(', ')})`}`;
  if (m === null) return `must evidence=unknown total=unknown ${conflictText}`;
  const total = m.total === null ? 'unknown' : String(m.total);
  if (m.evidence === null) return `must evidence=unknown total=${total} ${conflictText}`;
  return (
    `must evidence=${String(m.evidence)} unverified=${String(m.unverified ?? 0)} ` +
    `not_linked=${String(m.notLinked ?? 0)} total=${total} ${conflictText}`
  );
}

function planLine(plan: StateCardInput['plan']): string {
  if (plan === null) return 'plan self-report=unknown（不是证据）';
  return `plan self-report=${String(plan.verified)}/${String(plan.total)} verified（不是证据）`;
}

function budgetLine(b: StateCardInput['budget']): string {
  const turn = b.maxTurns === null ? `turn=${String(b.turn)}/∞` : `turn=${String(b.turn)}/${String(b.maxTurns)}`;
  const cost = b.unmetered
    ? 'cost=unmetered'
    : `cost=${b.spentCny === null ? 'unknown' : `¥${b.spentCny.toFixed(2)}`}/${
        b.maxCny === null ? '∞' : `¥${b.maxCny.toFixed(2)}`
      }`;
  return `budget ${turn}  ${cost}  wall=${String(b.wallMinutes)}/${String(b.wallMaxMinutes)}min`;
}

/** 宿主派生 next 的输入；全部来自已有证据，不读环境、不发明设计尺寸。 */
export interface NextActionInput {
  readonly draftVersion: number | null;
  readonly lastCheck: { readonly version: number; readonly outcome: CheckOutcome } | null;
  readonly lastView: { readonly version: number } | null;
  readonly furniture: StateCounts | null;
  readonly musts: MustEvidence | null;
  readonly objects: StateCounts | null;
  /** plan 的 doing / todo；只作为最低优先级候选。 */
  readonly plan?: readonly string[];
}

function shortIds(c: StateCounts): string {
  return (c.nonPassIds ?? [])
    .slice(0, 2)
    .map((id) => oneLine(id, 24))
    .join('/');
}

function furnitureNext(c: StateCounts | null): string | null {
  if (c === null || c.fail + c.missing === 0) return null;
  const ids = shortIds(c);
  if (c.fail > 0 && c.missing > 0) {
    return `furniture ${String(c.fail)} fail/${String(c.missing)} missing：${ids === '' ? '按 BuildSheet 家具表补建' : `先补 ${ids}`}`;
  }
  if (c.fail > 0) return `furniture ${String(c.fail)} fail：先修 ${ids === '' ? '家具' : ids}`;
  return `furniture ${String(c.missing)} missing：${ids === '' ? '按 BuildSheet 家具表补建' : `先补 ${ids}`}`;
}

function mustNext(m: MustEvidence | null, lastCheck: NextActionInput['lastCheck']): string | null {
  if (m === null) return null;
  // check 没有成功时，must evidence 只是 unknown，不是“证据少”；先让 check 错误排前面。
  if (lastCheck !== null && lastCheck.outcome !== 'ok') return null;
  const total = m.total;
  if (total === null || total === 0) return null;
  if (m.evidence === null) return 'must evidence unknown：看 BuildSheet Musts';
  const unverified = m.unverified ?? 0;
  // “少”的界线：0 条证据，或未验证数多于已验证数；接近完成时不打扰。
  if (m.evidence < total && (m.evidence === 0 || unverified > m.evidence)) {
    return `must evidence ${String(m.evidence)}/${String(total)}：看 BuildSheet Musts`;
  }
  return null;
}

function viewNext(input: NextActionInput): string | null {
  if (input.draftVersion === null) return null;
  if (input.lastView !== null) {
    return input.lastView.version < input.draftVersion
      ? `view 过期 v${String(input.lastView.version)}：提交前看一次`
      : null;
  }
  return input.lastCheck?.outcome === 'ok' ? 'view 未看：提交前看一次' : null;
}

function checkNext(input: NextActionInput): string | null {
  const objects = input.objects;
  if (objects !== null && objects.fail + objects.missing > 0) {
    const ids = shortIds(objects);
    return ids === '' ? 'check 有未关闭对象：先 probe/read 再 edit' : `check ${ids}：先 probe/read 再 edit`;
  }
  if (input.lastCheck !== null && input.lastCheck.outcome !== 'ok') {
    return `check v${String(input.lastCheck.version)} ${input.lastCheck.outcome}：先 read 错误行/reference`;
  }
  return null;
}

/**
 * 状态卡 next 的宿主侧优先级：家具 missing/fail > must 证据少 > view 过期 >
 * 当前 check 失败对象 > plan。只返回前 3 条；不改变任何工具行为。
 */
export function nextActions(input: NextActionInput): string[] {
  const out: string[] = [];
  const push = (item: string | null): void => {
    if (item === null || item === '' || out.includes(item) || out.length >= 3) return;
    out.push(item);
  };
  push(furnitureNext(input.furniture));
  push(mustNext(input.musts, input.lastCheck));
  push(viewNext(input));
  push(checkNext(input));
  for (const item of input.plan ?? []) push(oneLine(item.trim(), 60));
  return out;
}

function repeatedLine(r: StateCardInput['repeatedFailure']): string {
  if (r === undefined || r.count < 2) return '';
  const target = r.target === undefined || r.target.trim() === '' ? '' : `（${oneLine(r.target, 32)}）`;
  return `注意：同一错误已连续 ${String(r.count)} 次：先 probe/read/reference，不要继续 edit 同一处${target}`;
}

function nextLine(items: readonly string[]): string {
  if (items.length === 0) return '';
  return `next=${items.map((s, i) => `${String(i + 1)}) ${oneLine(s, 60)}`).join('  ')}`;
}

/**
 * 生成生产状态卡。截断顺序按设计：先删 next 的细节，再删非关键 id；冲突与预算永不删。
 * 输出确定性：同一输入逐字节相同；不读环境、不取当前时间。
 */
export function formatStateCard(input: StateCardInput): string {
  const phase = input.phase === undefined || input.phase.trim() === '' ? 'unknown' : oneLine(input.phase, 40);
  const draft = input.draftVersion === null ? 'none' : `v${String(input.draftVersion)}`;
  const check = input.lastCheck === null ? 'none' : `v${String(input.lastCheck.version)}:${input.lastCheck.outcome}`;
  const view =
    input.lastView === null
      ? 'none'
      : `v${String(input.lastView.version)}${input.lastView.view === undefined ? '' : `:${oneLine(input.lastView.view, 20)}`}`;

  const nextItems = (input.next ?? [])
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .slice(0, 3);
  const build = (items: readonly string[], keepIds: boolean): string => {
    const objects =
      input.objects === null
        ? 'objects unknown'
        : countsLine('objects', keepIds ? input.objects : { ...input.objects, nonPassIds: [] });
    const furniture =
      input.furniture === null
        ? 'furniture unknown'
        : countsLine('furniture', keepIds ? input.furniture : { ...input.furniture, nonPassIds: [] });
    const next = nextLine(items);
    const repeated = repeatedLine(input.repeatedFailure);
    return [
      `[状态卡 ${STATE_CARD_VERSION}]`,
      `phase=${phase}  draft=${draft}  check=${check}  view=${view}`,
      objects,
      furniture,
      mustLine(input.musts, input.conflicts),
      planLine(input.plan),
      budgetLine(input.budget),
      ...(repeated === '' ? [] : [repeated]),
      ...(next === '' ? [] : [next]),
    ].join('\n');
  };

  // 先按完整内容；超长时逐条删 next，仍超长再删对象 / 家具的 non-pass id。
  for (let count = nextItems.length; count >= 0; count -= 1) {
    const text = build(nextItems.slice(0, count), true);
    if (text.length <= STATE_CARD_MAX_CHARS) return text;
  }
  return build([], false);
}

// ───────────── 宿主证据的只读投影 ─────────────

/** 只读 DiffReport 的共享字段；测试可用最小 fixture，不伪造未使用字段。 */
export type DiffReportLike = Pick<DiffReport, 'items'> & {
  readonly summary: Pick<DiffReport['summary'], 'pass' | 'fail' | 'missing' | 'extra' | 'unverified'>;
};

function itemId(item: DiffReport['items'][number]): string {
  return item.expectedId ?? item.actualId ?? item.id;
}

/** 连续错误检测用的稳定指纹；同一批非 PASS 对象 / 同一段错误文本才算相同。 */
export interface FailureFingerprint {
  readonly key: string;
  readonly target: string | null;
}

function textFailureFingerprint(text: string): FailureFingerprint | null {
  const ids = [
    ...new Set(
      [...text.matchAll(/(?:^|[\s；、])(FAIL|MISSING|UNVERIFIED)\s+([^\s（、；]+)/g)]
        .map((match) => `${match[1] ?? ''}:${match[2] ?? ''}`)
        .filter((entry) => !entry.endsWith(':')),
    ),
  ].sort();
  if (ids.length > 0) {
    return {
      key: `items:${ids.join('|')}`,
      target:
        ids
          .slice(0, 2)
          .map((entry) => entry.slice(entry.indexOf(':') + 1))
          .join('/') || null,
    };
  }
  // 预检 / 执行错误：只比较错误正文；版本、行号、列号变化不算新错误。
  if (!/(执行出错|类型预检未通过|执行超时|内存不足|无法返回|没有可用的 bwrap)/.test(text)) return null;
  const normalized = text
    .replace(/第 v\d+ 版：/g, '')
    .replace(/building\.ts:\d+:\d+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return normalized === '' ? null : { key: `error:${normalized}`, target: null };
}

/**
 * 从 canonical 报告或 check 文本取失败指纹。报告优先；全 PASS 返回 null。
 * 只用于提示“同一错误连续 2 次”，不参与任何门禁。
 */
export function failureFingerprint(report: DiffReportLike | null, checkText: string | null): FailureFingerprint | null {
  if (report !== null) {
    const pending = report.items.filter((item) => item.status !== 'pass');
    if (pending.length === 0) return null;
    const key = pending
      .map((item) => `${item.status}:${itemId(item)}`)
      .sort()
      .join('|');
    const target = pending.slice(0, 2).map(itemId).join('/');
    return { key: `items:${key}`, target: target === '' ? null : target };
  }
  return checkText === null ? null : textFailureFingerprint(checkText);
}

/** 从 canonical / 对象图 diff 报告取计数与前 3 个非 PASS id。 */
export function countsFromReport(report: DiffReportLike): StateCounts {
  const nonPassIds = report.items
    .filter((item) => item.status !== 'pass')
    .map(itemId)
    .filter((id) => id.trim() !== '')
    .slice(0, 3);
  return {
    pass: report.summary.pass,
    fail: report.summary.fail,
    missing: report.summary.missing,
    unverified: report.summary.unverified,
    extra: report.summary.extra,
    nonPassIds,
  };
}

/** BuildSheet 里可机器读取的 must 链接与冲突；markdown 是生产唯一传入的合同形态。 */
export interface BuildSheetFacts {
  readonly totalMusts: number;
  readonly musts: readonly {
    readonly id: string;
    readonly scope: string;
    /** 投影对象 id；`未链接` / declared-only 不进入此列表。 */
    readonly objectIds: readonly string[];
  }[];
  readonly conflictIds: readonly string[];
}

function sectionAfter(markdown: string, heading: RegExp): string | null {
  const match = heading.exec(markdown);
  if (match === null) return null;
  const rest = markdown.slice(match.index + match[0].length);
  const end = /^## /m.exec(rest);
  return end === null ? rest : rest.slice(0, end.index);
}

/** 解析 BuildSheet markdown 的 Musts / 冲突段；失败返回 null，不猜合同。 */
export function parseBuildSheetFacts(markdown: string): BuildSheetFacts | null {
  const heading = /^## Musts（(\d+)）[^\n]*$/m;
  const mustSection = sectionAfter(markdown, heading);
  if (mustSection === null) return null;
  const totalMusts = Number(heading.exec(markdown)?.[1] ?? '0');
  const musts: BuildSheetFacts['musts'][number][] = [];
  for (const line of mustSection.split('\n')) {
    const arrow = line.indexOf(' → ');
    const head = arrow < 0 ? '' : line.slice(0, arrow);
    const idMatch = /^- `([^`]+)`/.exec(head);
    const scopeMatch = /\(([a-z]+)/.exec(head);
    if (idMatch === null || scopeMatch === null) continue;
    const raw =
      arrow < 0
        ? ''
        : (line
            .slice(arrow + ' → '.length)
            .split('；')[0]
            ?.trim() ?? '');
    const objectIds =
      raw === '' || raw.includes('未链接') || raw === '—'
        ? []
        : raw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '' && s !== '—');
    musts.push({ id: idMatch[1] ?? '', scope: scopeMatch[1] ?? 'none', objectIds });
  }
  const conflictSection = sectionAfter(markdown, /^## 冲突[^\n]*$/m) ?? '';
  const conflictIds = [...conflictSection.matchAll(/^-\s+\*\*([^*]+)\*\*/gm)].map((m) => m[1] ?? '');
  return { totalMusts, musts, conflictIds: conflictIds.filter((id) => id !== '') };
}

/**
 * 只有 BuildSheet 的 verified 链接 + report 中对应对象全 PASS 才算 must 证据。
 * declared / 关键词链接 / 未链接一律不算；没有报告时 evidence=null（unknown），但 total 仍可显示。
 */
export function mustEvidenceFrom(facts: BuildSheetFacts, report: DiffReportLike | null): MustEvidence {
  if (report === null) {
    return { total: facts.totalMusts, evidence: null, unverified: null, notLinked: null };
  }
  const statuses = new Map<string, DiffStatus[]>();
  const add = (id: string, status: DiffStatus): void => {
    const list = statuses.get(id);
    if (list === undefined) statuses.set(id, [status]);
    else list.push(status);
  };
  for (const item of report.items) {
    add(itemId(item), item.status);
    if (item.id.startsWith('expected:')) add(item.id.slice('expected:'.length), item.status);
  }
  let evidence = 0;
  let unverified = 0;
  let notLinked = 0;
  for (const must of facts.musts) {
    if (must.objectIds.length === 0) {
      notLinked += 1;
      continue;
    }
    const allPass =
      must.scope === 'verified' &&
      must.objectIds.every((id) => {
        const found = statuses.get(id);
        return found !== undefined && found.length > 0 && found.every((status) => status === 'pass');
      });
    if (allPass) evidence += 1;
    else unverified += 1;
  }
  return {
    total: facts.totalMusts,
    evidence,
    unverified,
    notLinked,
  };
}

/** check_code 文本里的家具核对段；没有该段返回 null（unknown），不把“没显示”当 0。 */
export function parseFurnitureCounts(text: string): StateCounts | null {
  const match =
    /家具核对（仅报告）：pass (\d+) \/ fail (\d+) \/ missing (\d+) \/ extra (\d+)(?: \/ unverified (\d+))?/.exec(text);
  if (match === null) return null;
  const nonPassIds = [
    ...new Set(
      [...text.matchAll(/^-\s+(?:FAIL|MISSING|EXTRA|UNVERIFIED)\s+furniture\s+([^\s：]+)/gm)].map((m) => m[1] ?? ''),
    ),
  ].filter((id) => id !== '');
  return {
    pass: Number(match[1]),
    fail: Number(match[2]),
    missing: Number(match[3]),
    extra: Number(match[4]),
    ...(match[5] === undefined ? {} : { unverified: Number(match[5]) }),
    ...(nonPassIds.length === 0 ? {} : { nonPassIds: nonPassIds.slice(0, 3) }),
  };
}
