/**
 * L2 状态卡（W11-02）：每轮由宿主生成、模型只读的事实卡。
 *
 * 负责：把阶段、稿/检查/看图版本、对象与家具计数、must 证据、plan 自报、冲突、预算与下一步
 *   压成一张固定格式、确定性的短卡；plan 自报永远与 must 证据分栏，没有宿主证据时写 unknown。
 * 不负责：计算 check / shadow / must 映射（由宿主提供），也不改 facts.ts 的 400 字符事实行。
 * 边界：这是给后续 host 接线用的纯函数与格式规范；本轮不修改 facts.ts / runner。
 */

/** 状态卡格式版本；字段或措辞变化时加 1。 */
export const STATE_CARD_VERSION = 'v1';

/** 硬上限（契约测试用官方 tokenizer 复核）。 */
export const STATE_CARD_MAX_TOKENS = 550;
/** 字符上限；状态卡以 ASCII 为主，2200 字符约 500–550 token。 */
export const STATE_CARD_MAX_CHARS = 2200;

export interface StateCounts {
  readonly pass: number;
  readonly fail: number;
  readonly missing: number;
  /** 家具核对通常没有 unverified；缺省时不写这一栏。 */
  readonly unverified?: number;
  readonly extra?: number;
  /** 前 1–3 个非 PASS id；只给 id，不贴全文。 */
  readonly nonPassIds?: readonly string[];
}

export interface MustEvidence {
  readonly total: number;
  /** false 表示没有确定性 shadow / verified mapping 证据：只能写 unknown。 */
  readonly hasEvidence: boolean;
  readonly evidence: number;
  readonly unverified: number;
  readonly notLinked: number;
  readonly conflicts: number;
  readonly conflictIds?: readonly string[];
}

export interface StateCardInput {
  /** 模型 plan 的阶段；没有 plan 时写 unknown。 */
  readonly phase?: string;
  readonly draftVersion: number | null;
  readonly lastCheck: {
    readonly version: number;
    readonly outcome: 'ok' | 'precheck-failed' | 'build-error' | 'not-finished';
  } | null;
  readonly lastView: { readonly version: number; readonly view?: string } | null;
  readonly objects: StateCounts;
  readonly furniture: StateCounts;
  readonly musts: MustEvidence;
  /** plan 的自报进度；只是自报，不是 must 证据。 */
  readonly plan?: { readonly verified: number; readonly total: number };
  readonly budget: {
    readonly turn: number;
    readonly maxTurns: number | null;
    readonly spentCny: number;
    readonly maxCny: number;
    readonly wallMinutes: number;
    readonly wallMaxMinutes: number;
  };
  /** 模型 plan 的 doing / todo；最多显示 3 条，宿主不发明设计动作。 */
  readonly next?: readonly string[];
}

/** 文档用的格式示例（数字是字段示例，不是建筑默认值）。 */
export const STATE_CARD_SPEC = `[状态卡 v1]
phase=roof  draft=v7  check=v7:ok  view=v7:iso-se
objects pass=4 fail=0 missing=1 unverified=1 extra=0  non-pass=wall#3
furniture pass=3 fail=1 missing=2  non-pass=table#1
must evidence=3 unverified=4 not_linked=2 total=9 conflicts=1 (conflict-flush-entry)
plan self-report=2/6 verified（不是证据）
budget turn=12/50  cost=¥0.42/¥1.60  wall=6/18min
next=1) roof bounds  2) south window probe`;

const outcomeText = (outcome: NonNullable<StateCardInput['lastCheck']>['outcome']): string => outcome;

function countsLine(label: string, c: StateCounts): string {
  const extra = c.extra === undefined ? '' : ` extra=${String(c.extra)}`;
  const unverified = c.unverified === undefined ? '' : ` unverified=${String(c.unverified)}`;
  const ids = c.nonPassIds ?? [];
  const shown = ids.slice(0, 3).filter((id) => id.trim() !== '');
  const tail = shown.length === 0 ? '' : `  non-pass=${shown.join(',')}`;
  return `${label} pass=${String(c.pass)} fail=${String(c.fail)} missing=${String(c.missing)}${unverified}${extra}${tail}`;
}

function mustLine(m: MustEvidence): string {
  const conflicts = m.conflictIds === undefined ? '' : ` (${m.conflictIds.slice(0, 3).join(', ')})`;
  const common = `total=${String(m.total)} conflicts=${String(m.conflicts)}${conflicts}`;
  if (!m.hasEvidence) return `must evidence=unknown  ${common}`;
  return (
    `must evidence=${String(m.evidence)} unverified=${String(m.unverified)} ` +
    `not_linked=${String(m.notLinked)} ${common}`
  );
}

function planLine(plan: StateCardInput['plan']): string {
  if (plan === undefined) return 'plan self-report=unknown（不是证据）';
  return `plan self-report=${String(plan.verified)}/${String(plan.total)} verified（不是证据）`;
}

function budgetLine(b: StateCardInput['budget']): string {
  const turn = b.maxTurns === null ? `turn=${String(b.turn)}/∞` : `turn=${String(b.turn)}/${String(b.maxTurns)}`;
  return (
    `budget ${turn}  cost=¥${b.spentCny.toFixed(2)}/¥${b.maxCny.toFixed(2)}  ` +
    `wall=${String(b.wallMinutes)}/${String(b.wallMaxMinutes)}min`
  );
}

function nextLine(items: readonly string[] | undefined): string {
  if (items === undefined) return '';
  const cleaned = items
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .slice(0, 3);
  if (cleaned.length === 0) return '';
  return `next=${cleaned.map((s, i) => `${String(i + 1)}) ${s.length > 60 ? `${s.slice(0, 59)}…` : s}`).join('  ')}`;
}

/**
 * 生成状态卡。截断顺序按设计：先删 next 的细节，再删非关键 id；冲突与预算永不删。
 * 输出确定性：同一输入逐字节相同；不读环境、不取当前时间。
 */
export function formatStateCard(input: StateCardInput): string {
  const phase = input.phase === undefined || input.phase.trim() === '' ? 'unknown' : input.phase.trim();
  const draft = input.draftVersion === null ? 'none' : `v${String(input.draftVersion)}`;
  const check =
    input.lastCheck === null ? 'none' : `v${String(input.lastCheck.version)}:${outcomeText(input.lastCheck.outcome)}`;
  const view =
    input.lastView === null
      ? 'none'
      : `v${String(input.lastView.version)}${input.lastView.view === undefined ? '' : `:${input.lastView.view}`}`;
  const header = `[状态卡 ${STATE_CARD_VERSION}]`;
  const versionLine = `phase=${phase}  draft=${draft}  check=${check}  view=${view}`;
  const objectLine = countsLine('objects', input.objects);
  const furnitureLine = countsLine('furniture', input.furniture);
  const evidence = mustLine(input.musts);
  const plan = planLine(input.plan);
  const budget = budgetLine(input.budget);
  let next = nextLine(input.next);

  const build = (): string =>
    [header, versionLine, objectLine, furnitureLine, evidence, plan, budget, ...(next === '' ? [] : [next])].join('\n');

  // 超长时先删 next 的条目，再删对象 / 家具的 non-pass id；冲突、must 与预算不动。
  let text = build();
  while (text.length > STATE_CARD_MAX_CHARS && next !== '') {
    const items = (input.next ?? []).slice(0, Math.max(0, (next.match(/\d\)/g) ?? []).length - 1));
    next = nextLine(items);
    text = build();
  }
  if (text.length > STATE_CARD_MAX_CHARS) {
    const trimmedObjects = { ...input.objects, nonPassIds: [] };
    const trimmedFurniture = { ...input.furniture, nonPassIds: [] };
    text = [
      header,
      versionLine,
      countsLine('objects', trimmedObjects),
      countsLine('furniture', trimmedFurniture),
      evidence,
      plan,
      budget,
      ...(next === '' ? [] : [next]),
    ].join('\n');
  }
  return text;
}
