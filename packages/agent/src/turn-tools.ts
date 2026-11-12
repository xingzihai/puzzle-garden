/**
 * 一轮里的工具分发与交付（AGENT-SPEC §4、§3.2、§4.4；C12、C13、C14）。runner.ts 的一部分，拆出以控制文件长度。
 *
 * 负责：按序执行一个响应里的全部 tool_call，写 tool.call / tool.result / code.version / check.result /
 *   render.result / versions.render / submit 事件，产出 tool 消息与本轮图片块；提交通过后同轮其余调用回"已提交，未执行"；
 *   坏参数（被替换为 "{}" 的截断 JSON）不执行；提交窗口内拒绝已有草稿的 write_code / view_building
 *   （v0 或空稿仍允许 write_code，否则窗口先于首稿进入会死锁）；同轮多次看图只渲染最后一次。
 *   交付：用 `DEFAULT_REQUESTS.deliver` 渲染、写 delivery/ 与 delivery 事件，渲染失败写 renderMissing。
 * 不负责：主循环、护栏、模型请求与事实行（runner.ts）；工具本身的逻辑（tools/*）。
 * 状态放在调用方传入的 `ToolState` 里（STANDARDS §2：不用模块级可变状态）。
 */

import { createHash } from 'node:crypto';

import type { MassingDocument } from '@pg/geometry';
import type { Message, ToolCall } from '@pg/llm/schema';
import type { RenderRequest, RenderResult, RenderVersion, ViewName } from '@pg/render/render';
import { DEFAULT_REQUESTS } from '@pg/render/render';
import { MAX_CODE_BYTES } from '@pg/sandbox/run';
import type { Ref, StopReason } from '@pg/store/events';
import type { RunWriter } from '@pg/store/run-dir';

import type { CheckOutcome } from './facts.ts';
import type { GateOutcome } from './gates.ts';
import type { ToolCallSummary } from './guards/types.ts';
import { runMassingTool } from './massing/host.ts';
import type { MassingToolHost } from './massing/host.ts';
import { initialMassingState } from './massing/tool.ts';
import type { MassingRunState } from './massing/tool.ts';
import type { TargetBudget } from './target.ts';
import { checkCode } from './tools/check.ts';
import type { CheckDeps, CheckStatus } from './tools/check.ts';
import { editCode, lineCount, readCode, windowBlocksWrite, writeCode } from './tools/code-edit.ts';
import type { Draft, Edit } from './tools/code-edit.ts';
import { probeBuilding } from './tools/probe.ts';
import type { ProbeBox, ProbeInput, ProbePoint, ProbeSection } from './tools/probe.ts';
import { applyPlanAction, initialPlanState } from './tools/plan.ts';
import type { PlanAction, PlanState } from './tools/plan.ts';
import { readMassing } from './tools/read-massing.ts';
import { reference } from './tools/reference.ts';
import { ALL_TOOL_NAMES, TOOL_ARGS } from './tools/schemas.ts';
import type { ToolName } from './tools/schemas.ts';
import { submit } from './tools/submit.ts';
import { viewBuilding } from './tools/view.ts';
import type { ViewCache, ViewContentPart } from './tools/view.ts';

export const NOT_EXECUTED_INVALID_JSON = '参数不是合法 JSON（可能被输出上限截断），没有执行。';
export const NOT_EXECUTED_SUBMITTED = '已提交，未执行';
export const WINDOW_BLOCKED = '提交窗口内不可用';
export const VIEW_SUPERSEDED = '本轮已有看图请求，以最后一次为准。';

const encoder = new TextEncoder();

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 最近一次执行成功的存档。 */
export interface OkArchive {
  readonly version: number;
  readonly hash: string;
  readonly archive: Uint8Array;
  readonly ref: Ref;
}

export interface LastCheck {
  readonly version: number;
  readonly outcome: CheckOutcome;
  readonly hash?: string;
  /** 本次 check 实际存档字节的 sha256；状态卡用它拒绝复用别的存档的 canonical 报告。 */
  readonly archiveHash?: string;
  /** 配了 `--gates` 时最近一次执行成功 check 的门槛判定（AGENT-SPEC §5.1）。 */
  readonly gates?: GateOutcome;
}

/** 上一阶段的设计源（只读）；v2 生产传的是确定性 digest，不是完整 design.md。 */
export interface DesignSource {
  readonly content: string;
  readonly kind: 'full' | 'digest';
  /** fixed 权威才是“已确认设计源”；free 只能标成上一阶段参考源，不能冒充确认。 */
  readonly confirmed: boolean;
}

/** 跨轮的可变 run 状态（工具这一侧）。 */
export interface ToolState {
  draft: Draft;
  lastCheck: LastCheck | null;
  lastOk: OkArchive | null;
  lastViewVersion: number | null;
  /** 累计图片 base64 字节与张数（进入请求体的）。 */
  imageBytes: number;
  images: number;
  inWindow: boolean;
  renderVersionWritten: boolean;
  /** 本 run 由 write_design 写的施工注记；整体替换，deliver 时写进交付。 */
  design: string;
  /** 上一阶段确认的设计源；只读，不随 write_design 改变，也不写回交付的 design.md。 */
  sourceDesign: DesignSource | null;
  /** 最后一次被解析的 submit 的交付说明；deliver 时写进交付。 */
  note: string;
  /** 本会话已登记的草模文档（M1c 默认空）；M2 的 massing 工具成功登记后写入，随 check 透传。 */
  massingDocuments: MassingDocument[];
  /** massing 子运行状态：序号每启动一次 +1（失败也计数），成功记录供复用与 read_massing。 */
  massing: MassingRunState;
  /** 施工计划 / must 清单 / 冲突；只记录，不改变 submit。 */
  plan: PlanState;
}

export function initialToolState(seedCode?: string, sourceDesign?: DesignSource): ToolState {
  return {
    draft: seedCode === undefined || seedCode === '' ? { code: '', version: 0 } : { code: seedCode, version: 1 },
    lastCheck: null,
    lastOk: null,
    lastViewVersion: null,
    imageBytes: 0,
    images: 0,
    inWindow: false,
    renderVersionWritten: false,
    design: '',
    sourceDesign: sourceDesign === undefined || sourceDesign.content === '' ? null : sourceDesign,
    note: '',
    massingDocuments: [],
    massing: initialMassingState(),
    plan: initialPlanState(),
  };
}

export interface ToolContext {
  readonly store: RunWriter;
  readonly turn: number;
  readonly seed: number;
  readonly check: CheckDeps;
  readonly render: (archive: Uint8Array, request: RenderRequest) => Promise<RenderResult>;
  readonly clock: () => number;
  readonly cache: ViewCache;
  /** 本阶段是否要求先写设计文档（`--require-design`，AGENT-SPEC §4.5）。 */
  readonly requireDesign: boolean;
  /** 父预算（含子运行预留 / 结算，SUBAGENT-LOOP-SPEC §3.1）。 */
  readonly budget: TargetBudget;
  /** runTools 中合并外部取消与 run 墙钟截止的信号；massing 子运行透传（§4.2）。 */
  readonly signal?: AbortSignal;
  /** 子运行墙钟用的可中止定时器（§3.2）。 */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 父 run 剩余墙钟毫秒；massing 启动前检查（§2.1 第 4 步）。 */
  readonly remainingWallMs?: () => number;
  /** 草模子运行宿主；未接线时 massing 回 no-host（§6）。 */
  readonly massing?: MassingToolHost;
  /**
   * 交付注记的权威生成器：宿主用当前 check 的 conformance 证据生成。
   * 给定时覆盖模型自述；返回 null 表示证据不可用，仍写不可用说明而不是自述。
   */
  readonly deliveryNote?: (info: { readonly codeVersion: number; readonly hash: string }) => string | null;
}

/** 生成器明确报“证据不可用”时的注记；不能回退到模型自述。 */
const UNAVAILABLE_DELIVERY_NOTE =
  '# 交付注记（conformance 证据不可用）\n\nconformance 证据不可用，不能声明检查通过或接受。\n';

/** 一轮工具执行的产出。 */
export interface TurnTools {
  readonly toolMessages: readonly Extract<Message, { role: 'tool' }>[];
  /** 要拼在本轮事实行之后的图片块（C13）。 */
  readonly images: readonly ViewContentPart[];
  readonly summaries: readonly ToolCallSummary[];
  /** 本轮最后一次 check_code 的结构化测量（facts 事件用）。 */
  readonly measures: unknown;
  /** 宿主缺陷等需要立即停止的原因。 */
  readonly stop: StopReason | null;
  readonly submitted: { readonly draft: Draft; readonly archive: OkArchive } | null;
}

interface Mutable {
  toolMessages: Extract<Message, { role: 'tool' }>[];
  images: ViewContentPart[];
  summaries: ToolCallSummary[];
  measures: unknown;
  stop: StopReason | null;
  submitted: TurnTools['submitted'];
}

interface Done {
  readonly status: string;
  readonly text: string;
}

export function draftVersion(state: ToolState): number | null {
  return state.draft.version === 0 ? null : state.draft.version;
}

function checkOutcomeOf(status: CheckStatus): CheckOutcome {
  if (status === 'ok') return 'ok';
  if (status.startsWith('precheck-')) return 'precheck-failed';
  if (status === 'build-error') return 'build-error';
  return 'not-finished';
}

function isToolName(name: string): name is ToolName {
  return (ALL_TOOL_NAMES as readonly string[]).includes(name);
}

function issuesText(issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]): string {
  return issues.map((i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`).join('；');
}

function blob(store: RunWriter, data: string | Uint8Array): Ref {
  return store.putBlob(typeof data === 'string' ? encoder.encode(data) : data);
}

function writeRenderVersion(state: ToolState, ctx: ToolContext, version: RenderVersion): void {
  if (state.renderVersionWritten) return;
  ctx.store.append('versions.render', ctx.turn, { render: { ...version, flags: [...version.flags] } });
  state.renderVersionWritten = true;
}

function saveVersion(state: ToolState, ctx: ToolContext, via: 'write_code' | 'edit_code'): void {
  const { draft } = state;
  ctx.store.append('code.version', ctx.turn, {
    version: draft.version,
    code: blob(ctx.store, draft.code),
    via,
    lines: lineCount(draft.code),
  });
}

async function runCheck(state: ToolState, ctx: ToolContext, out: Mutable): Promise<Done> {
  const { draft } = state;
  if (draftVersion(state) === null) return { status: 'no-code', text: '当前稿还没有代码，先 write_code。' };
  const r = await checkCode(
    { code: draft.code, version: draft.version, seed: ctx.seed, massingDocuments: state.massingDocuments },
    ctx.check,
  );
  if (r.status === 'internal-error') out.stop = 'internal-error';
  if (r.status === 'sandbox-unsupported') out.stop = 'sandbox-unsupported';
  if (r.precheck === null) return { status: r.status, text: r.text };
  const archiveRef = r.archive === undefined ? undefined : blob(ctx.store, r.archive);
  ctx.store.append('check.result', ctx.turn, {
    codeVersion: draft.version,
    codeSha: sha256Hex(encoder.encode(draft.code)),
    seed: ctx.seed,
    precheck: r.precheck,
    run: r.run,
    ...(archiveRef === undefined ? {} : { archive: archiveRef }),
    ...(r.apiCalls === undefined ? {} : { apiCalls: { ...r.apiCalls } }),
  });
  if (out.stop !== null) return { status: r.status, text: r.text };
  const outcome = checkOutcomeOf(r.status);
  const gatesPart = r.gates === undefined ? {} : { gates: r.gates };
  if (r.run?.kind === 'ok' && r.archive !== undefined && archiveRef !== undefined) {
    state.lastOk = { version: draft.version, hash: r.run.hash, archive: r.archive, ref: archiveRef };
    state.lastCheck = {
      version: draft.version,
      outcome,
      hash: r.run.hash,
      archiveHash: sha256Hex(r.archive),
      ...gatesPart,
    };
  } else {
    state.lastCheck = { version: draft.version, outcome, ...gatesPart };
  }
  out.measures = r.measures ?? null;
  return { status: r.status, text: r.text };
}

async function runView(
  views: readonly ViewName[] | undefined,
  state: ToolState,
  ctx: ToolContext,
  out: Mutable,
): Promise<Done> {
  const ok = state.lastOk;
  if (ok === null) return { status: 'no-archive', text: '还没有执行成功的版本，先 check_code。' };
  const r = await viewBuilding(
    {
      archive: ok.archive,
      archiveVersion: ok.version,
      archiveHash: ok.hash,
      draftVersion: draftVersion(state),
      ...(views === undefined ? {} : { views }),
      imageBytes: state.imageBytes,
    },
    { render: ctx.render, clock: ctx.clock, cache: ctx.cache },
  );
  if (r.kind === 'failed') {
    if (r.internal) out.stop = 'internal-error';
    return { status: r.status, text: r.text };
  }
  if (r.version !== undefined) writeRenderVersion(state, ctx, r.version);
  ctx.store.append('render.result', ctx.turn, {
    purpose: 'iterate',
    kind: 'ok',
    images: r.images.map((im) => ({
      view: im.view,
      png: blob(ctx.store, im.png),
      pixelsPerCell: im.pixelsPerCell,
      frameFill: im.frameFill,
    })),
    wallMs: Math.max(0, Math.round(r.wallMs)),
  });
  out.images.push(...r.content);
  for (const im of r.images) state.imageBytes += im.imageBytes;
  state.images += r.images.length;
  state.lastViewVersion = ok.version;
  return { status: 'ok', text: r.text };
}

function runSubmit(
  call: ToolCall,
  args: Readonly<Record<string, unknown>>,
  state: ToolState,
  ctx: ToolContext,
  out: Mutable,
): Done {
  // schema 已校验 note 为 string；保存下来供 deliver 写 delivery/note.md。
  state.note = args['note'] as string;
  const r = submit({
    draftVersion: draftVersion(state),
    lastCheck: state.lastCheck,
    requireDesign: ctx.requireDesign,
    design: state.design,
  });
  const version = draftVersion(state);
  if (version !== null) {
    ctx.store.append('submit', ctx.turn, {
      callId: call.id,
      codeVersion: version,
      accepted: r.accepted,
      ...(r.accepted ? {} : { reason: r.text }),
    });
  }
  if (r.accepted && state.lastOk !== null) out.submitted = { draft: state.draft, archive: state.lastOk };
  return { status: r.accepted ? 'accepted' : 'rejected', text: r.text };
}

/** 参数已通过 schema 的一次调用。 */
async function execute(
  name: ToolName,
  args: Readonly<Record<string, unknown>>,
  call: ToolCall,
  isLastView: boolean,
  state: ToolState,
  ctx: ToolContext,
  out: Mutable,
): Promise<Done> {
  switch (name) {
    case 'write_code': {
      // schema 已校验 code 为 string
      const r = writeCode(state.draft, args['code'] as string, MAX_CODE_BYTES);
      if (r.kind === 'ok') {
        state.draft = r.draft;
        saveVersion(state, ctx, 'write_code');
      }
      return { status: r.kind, text: r.text };
    }
    case 'edit_code': {
      // schema 已校验 edits 为 {find, replace}[]
      const r = editCode(state.draft, args['edits'] as readonly Edit[]);
      if (r.kind === 'error') return { status: r.status, text: r.text };
      state.draft = r.draft;
      saveVersion(state, ctx, 'edit_code');
      // 自动 check：把“改完必验”压进同一轮，减少一轮往返；仍走同一套 report-only 汇总。
      const checked = await runCheck(state, ctx, out);
      return {
        status: checked.status,
        text: `${r.text}\n自动检查（edit_code 后）：\n${checked.text}`,
      };
    }
    case 'read_code':
      // schema 已校验 from / to 为可选正整数
      return {
        status: 'ok',
        text: readCode(state.draft, args['from'] as number | undefined, args['to'] as number | undefined).text,
      };
    case 'check_code':
      return runCheck(state, ctx, out);
    case 'view_building':
      if (!isLastView) return { status: 'superseded', text: VIEW_SUPERSEDED };
      // schema 已校验 views 为 ViewName[]
      return runView(args['views'] as readonly ViewName[] | undefined, state, ctx, out);
    case 'plan': {
      const result = applyPlanAction(state.plan, args as unknown as PlanAction);
      state.plan = result.state;
      return { status: 'ok', text: result.text };
    }
    case 'probe': {
      const ok = state.lastOk;
      if (ok === null) return { status: 'no-archive', text: '还没有执行成功的版本，先 check_code。' };
      // schema 已校验 points / box / section 恰好一个。
      const input: ProbeInput = {
        archive: ok.archive,
        archiveVersion: ok.version,
        draftVersion: draftVersion(state),
        ...(args['points'] === undefined ? {} : { points: args['points'] as readonly ProbePoint[] }),
        ...(args['box'] === undefined ? {} : { box: args['box'] as ProbeBox }),
        ...(args['section'] === undefined ? {} : { section: args['section'] as ProbeSection }),
      };
      const r = probeBuilding(input, { registry: ctx.check.registry });
      return { status: r.status, text: r.text };
    }
    case 'submit':
      return runSubmit(call, args, state, ctx, out);
    case 'write_design': {
      // schema 已校验 content 为非空字符串
      const content = args['content'] as string;
      state.design = content;
      blob(ctx.store, content); // 存 blob 留痕（事件里不再单独记设计文档）
      return { status: 'ok', text: `已写入设计文档，${String(content.length)} 字符。` };
    }
    case 'read_design': {
      const source = state.sourceDesign;
      if (source === null) {
        return {
          status: 'ok',
          text: state.design === '' ? '还没有设计文档；先 write_design。' : state.design,
        };
      }
      const sourceName = source.confirmed ? '已确认设计源' : '上一阶段设计源';
      const sourceLabel =
        source.kind === 'digest'
          ? `【${sourceName}（只读；确定性摘要，完整 design.md 未随 run 传入）】`
          : `【${sourceName}（只读；来自上一阶段 design.md）】`;
      const sourceCaveat =
        source.kind === 'digest'
          ? '以上是意图 / 风格摘要；数字、对象与 must 全文以 BuildSheet 为准。完整 design 未随 run 传入，如需细节看 BuildSheet / 题面。'
          : `以上是${source.confirmed ? '上一阶段确认的' : '上一阶段的'}设计源；write_design 只写本 run 的施工注记，不会覆盖它。`;
      const noteLabel = '【本 run 的 write_design 注记（可整体替换；不是设计源）】';
      const note =
        state.design === '' ? '本 run 尚未写设计注记；需要施工计划时用 write_design 写自己的注记。' : state.design;
      return {
        status: 'ok',
        text: `${sourceLabel}\n${source.content}\n\n${sourceCaveat}\n\n${noteLabel}\n${note}`,
      };
    }
    case 'reference': {
      // schema 已校验 scope 为 api / block，query 为非空字符串。
      const r = reference({ scope: args['scope'] as string, query: args['query'] as string });
      return { status: r.status, text: r.text };
    }
    case 'massing': {
      // schema 已校验 brief/maxTurns/maxCny 与可选 seed；子运行编排在 massing/host.ts。
      const r = await runMassingTool(
        {
          brief: args['brief'] as string,
          maxTurns: args['maxTurns'] as number,
          maxCny: args['maxCny'] as number,
          ...(args['seed'] === undefined ? {} : { seed: args['seed'] as number }),
        },
        call.id,
        state,
        ctx,
      );
      out.images.push(...r.images);
      return { status: r.status, text: r.text };
    }
    case 'read_massing':
      return readMassing(
        state.massing.runs,
        args['id'] as string,
        args['from'] as number | undefined,
        args['to'] as number | undefined,
      );
  }
}

/**
 * 按序执行一个响应里的全部工具调用。`invalidIndices` 是 client 替换成 "{}" 的截断参数下标（C12）。
 * 遇到宿主缺陷（`stop`）时立即返回，其余调用不执行也不回 tool 消息（run 随即结束，不再发请求）。
 */
export async function runToolCalls(
  calls: readonly ToolCall[],
  invalidIndices: ReadonlySet<number>,
  state: ToolState,
  ctx: ToolContext,
): Promise<TurnTools> {
  const out: Mutable = { toolMessages: [], images: [], summaries: [], measures: null, stop: null, submitted: null };
  const lastView = calls.findLastIndex((c) => c.function.name === 'view_building');
  for (const [index, call] of calls.entries()) {
    const started = ctx.clock();
    const { name, arguments: raw } = call.function;
    let parsed: unknown;
    let parse: 'ok' | 'invalid-json' | 'invalid-args' = invalidIndices.has(index) ? 'invalid-json' : 'ok';
    if (parse === 'ok') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parse = 'invalid-json';
      }
    }
    const known = isToolName(name);
    const checked = known && parse === 'ok' ? TOOL_ARGS[name].safeParse(parsed) : null;
    if (parse === 'ok' && checked?.success !== true) parse = 'invalid-args';
    ctx.store.append('tool.call', ctx.turn, { callId: call.id, name, arguments: blob(ctx.store, raw), parse });

    let done: Done;
    if (out.submitted !== null) done = { status: 'skipped-submitted', text: NOT_EXECUTED_SUBMITTED };
    else if (parse === 'invalid-json') done = { status: 'invalid-json', text: NOT_EXECUTED_INVALID_JSON };
    else if (!known) {
      done = {
        status: 'unknown-tool',
        text: `没有名为 ${name} 的工具，没有执行。可用：${ALL_TOOL_NAMES.join('、')}。`,
      };
    } else if (!checked?.success) {
      done = { status: 'invalid-args', text: `参数不合法，没有执行：${issuesText(checked?.error.issues ?? [])}` };
    } else if (
      (name === 'write_code' && windowBlocksWrite(state.draft, state.inWindow)) ||
      (state.inWindow && (name === 'view_building' || name === 'massing'))
    ) {
      done = { status: 'window-blocked', text: WINDOW_BLOCKED };
    } else {
      // safeParse 成功后 data 是对象（6 个 schema 都是 strictObject）
      const args = checked.data as Readonly<Record<string, unknown>>;
      done = await execute(name, args, call, index === lastView, state, ctx, out);
    }
    ctx.store.append('tool.result', ctx.turn, {
      callId: call.id,
      name,
      text: blob(ctx.store, done.text),
      status: done.status,
      wallMs: Math.max(0, Math.round(ctx.clock() - started)),
    });
    out.toolMessages.push({ role: 'tool', tool_call_id: call.id, content: done.text });
    out.summaries.push({ name, arguments: raw, result: done.text });
    if (out.stop !== null) break;
  }
  return out;
}

/** 交付提交的那一版（§4.4）：交付图失败不阻止交付，写 renderMissing。 */
export async function deliver(
  sub: NonNullable<TurnTools['submitted']>,
  state: ToolState,
  ctx: ToolContext,
): Promise<{ readonly codeVersion: number; readonly hash: string }> {
  const started = ctx.clock();
  const r = await ctx.render(sub.archive.archive, DEFAULT_REQUESTS.deliver);
  const wallMs = (): number => Math.max(0, Math.round(ctx.clock() - started));
  const files: { path: string; bytes: Uint8Array }[] = [
    { path: 'building.ts', bytes: encoder.encode(sub.draft.code) },
    { path: 'building.pgar', bytes: sub.archive.archive },
  ];
  // 设计文档与交付说明是本阶段交付物（AGENT-SPEC §4.5）：非空才写文件与事件字段。
  const designRef = state.design === '' ? undefined : blob(ctx.store, state.design);
  if (designRef !== undefined) files.push({ path: 'design.md', bytes: encoder.encode(state.design) });
  // 生产构建由宿主用 conformance 证据生成注记；模型自述只作为 designer-note.md 留档。
  const hasGenerator = ctx.deliveryNote !== undefined;
  const generatedNote =
    ctx.deliveryNote === undefined
      ? null
      : ctx.deliveryNote({ codeVersion: sub.draft.version, hash: sub.archive.hash });
  // 有生成器但证据不可用时，写“不可用”而不是回退到模型自述。
  const note = hasGenerator ? (generatedNote ?? UNAVAILABLE_DELIVERY_NOTE) : state.note;
  if (hasGenerator && state.note !== '') {
    files.push({ path: 'designer-note.md', bytes: encoder.encode(state.note) });
  }
  if (note !== '') files.push({ path: 'note.md', bytes: encoder.encode(note) });
  const renders: { view: string; png: Ref }[] = [];
  let renderMissing: string | undefined;
  if (r.kind === 'ok') {
    writeRenderVersion(state, ctx, r.version);
    const images = r.images.map((im) => {
      const png = blob(ctx.store, im.png);
      renders.push({ view: im.view, png });
      files.push({ path: `render/${im.view}.png`, bytes: im.png });
      return { view: im.view, png, pixelsPerCell: im.pixelsPerCell, frameFill: im.frameFill };
    });
    ctx.store.append('render.result', ctx.turn, { purpose: 'deliver', kind: 'ok', images, wallMs: wallMs() });
  } else {
    renderMissing = `交付渲染失败：${r.kind}`;
    ctx.store.append('render.result', ctx.turn, { purpose: 'deliver', kind: r.kind, images: [], wallMs: wallMs() });
  }
  const body = {
    code: blob(ctx.store, sub.draft.code),
    archive: sub.archive.ref,
    hash: sub.archive.hash,
    codeVersion: sub.draft.version,
    renders,
    ...(designRef === undefined ? {} : { design: designRef }),
    ...(note === '' ? {} : { note }),
    ...(generatedNote === null ? {} : { noteSource: 'conformance-evidence' as const }),
    ...(renderMissing === undefined ? {} : { renderMissing }),
  };
  files.push({ path: 'delivery.json', bytes: encoder.encode(`${JSON.stringify(body, null, 2)}\n`) });
  ctx.store.writeDelivery(files);
  ctx.store.append('delivery', ctx.turn, body);
  return { codeVersion: sub.draft.version, hash: sub.archive.hash };
}
