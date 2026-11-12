/**
 * 草模工具的执行与交付（AGENT-TARGET.md §工具实现必须遵守）。
 *
 * 负责：按序执行一轮里的 6 个草模工具，写 tool.call / tool.result / code.version / model.check / submit /
 *   model.delivery 事件，产出 tool 消息、轮末图片、摘要与停止原因；提交后固定快照并写完整交付文件。
 * 不负责：主循环、护栏、请求（runner.ts）；提示词与事实行（modeling-target.ts）；工具参数 schema（schemas.ts）。
 * 代码的读写 / 局部编辑复用 tools/code-edit.ts；隔离执行由注入的 execute 负责，本文件不执行模型代码。
 */

import { createHash } from 'node:crypto';

import type { Message, ToolCall } from '@pg/llm/schema';
import type { ModelDocument } from '@pg/modeling/schema';
import type { ModelExecution } from '@pg/sandbox/modeling';
import type { Ref, StopReason } from '@pg/store/events';
import type { RunWriter } from '@pg/store/run-dir';

import type { ToolCallSummary } from '../guards/types.ts';
import { viewAllowed } from '../guards/image.ts';
import { editCode, lineCount, readCode, windowBlocksWrite, writeCode } from '../tools/code-edit.ts';
import type { Draft, Edit } from '../tools/code-edit.ts';
import type { ViewContentPart } from '../tools/view.ts';
import { consoleText, countsOf, errorText, failureText, geometrySummary, outcomeOf, summarize } from './result.ts';
import type { ModelOutcome } from './result.ts';
import { MODEL_TOOL_ARGS, MODEL_TOOL_NAMES, isModelToolName } from './schemas.ts';
import type { ModelToolName } from './schemas.ts';

export const NOT_EXECUTED_INVALID_JSON = '参数不是合法 JSON（可能被输出上限截断），没有执行。';
export const NOT_EXECUTED_SUBMITTED = '已提交，未执行';
export const VIEW_SUPERSEDED = '本轮已有看图请求，以最后一次为准。';
export const NO_RENDERER =
  '本运行没有配置模型渲染器：view_model 不可用，没有看图（不是模型没有内容，而是宿主未接渲染）。';

/** 提交窗口内允许的工具：只禁已有非空草稿的 write_code（整份重写），读 / 改 / 执行 / 看图 / 提交仍可用。 */
export const MODEL_WINDOW_TOOLS = ['read_code', 'edit_code', 'run_model', 'view_model', 'submit_model'] as const;
export const MODEL_WINDOW_BLOCKED =
  `提交窗口内不能再 write_code 整份写入；仍可用 ${MODEL_WINDOW_TOOLS.join('、')}` +
  '（可读、可改、可执行、可看图、可提交）。';

/** 建模代码 UTF-8 字节上限 256 KiB（MODELING-SPEC §4）；与 sandbox 的 MAX_MODEL_CODE_BYTES 同口径。 */
export const MAX_MODEL_CODE_BYTES = 256 * 1024;

const encoder = new TextEncoder();

/** 一次成功执行的文档快照；submit 固定它，后续改动不得影响。 */
export interface ModelOkDocument {
  readonly version: number;
  readonly code: string;
  readonly codeHash: string;
  readonly document: ModelDocument;
  readonly documentHash: string;
  readonly ref: Ref;
}

/** 接受提交时固定的快照。 */
export interface ModelSubmitted {
  readonly code: string;
  readonly codeHash: string;
  readonly document: ModelDocument;
  readonly documentHash: string;
  readonly documentRef: Ref;
  readonly codeVersion: number;
  readonly note: string;
}

/** 最近一次执行的版本与结果（事实行用）。 */
export interface ModelLastCheck {
  readonly version: number;
  readonly outcome: ModelOutcome;
  readonly hash?: string;
}

/** 跨轮的可变 run 状态（草模工具这一侧）。 */
export interface ModelState {
  draft: Draft;
  lastOk: ModelOkDocument | null;
  lastCheck: ModelLastCheck | null;
  lastViewVersion: number | null;
  note: string;
  submitted: ModelSubmitted | null;
}

export function initialModelState(seedCode?: string): ModelState {
  return {
    draft: seedCode === undefined || seedCode === '' ? { code: '', version: 0 } : { code: seedCode, version: 1 },
    lastOk: null,
    lastCheck: null,
    lastViewVersion: null,
    note: '',
    submitted: null,
  };
}

export function draftVersion(state: ModelState): number | null {
  return state.draft.version === 0 ? null : state.draft.version;
}

/** 渲染出来的单张模型视图；dataUrl 进请求体，imageBytes 只算 base64 部分（不含前缀）。 */
export interface RenderedModelView {
  readonly name: string;
  readonly png: Uint8Array;
  readonly sha256: string;
  readonly imageBytes: number;
  readonly dataUrl: string;
}

export interface ModelRenderImage {
  readonly name: string;
  readonly png: Uint8Array;
}

export type ModelExecute = (
  code: string,
  options: { readonly seed: number; readonly signal?: AbortSignal },
) => Promise<ModelExecution>;

export type ModelRender = (
  document: ModelDocument,
  options?: { readonly signal?: AbortSignal },
) => Promise<readonly ModelRenderImage[]>;

/** 共享图片计数与窗口状态；与 runner 的 TargetBudget 同一对象。 */
export interface ModelBudget {
  imageBytes: number;
  images: number;
  inWindow: boolean;
}

export interface ModelToolContext {
  readonly store: RunWriter;
  readonly turn: number;
  readonly seed: number;
  readonly clock: () => number;
  readonly budget: ModelBudget;
  readonly execute: ModelExecute;
  readonly render?: ModelRender;
  readonly cache: Map<string, readonly RenderedModelView[]>;
  readonly signal?: AbortSignal;
}

export interface ModelTurn {
  readonly toolMessages: readonly Extract<Message, { role: 'tool' }>[];
  readonly images: readonly ViewContentPart[];
  readonly summaries: readonly ToolCallSummary[];
  readonly measures: unknown;
  readonly stop: StopReason | null;
  readonly submitted: boolean;
}

/** 模型代码 / 文档的 sha256；与 @pg/sandbox/modeling-protocol 的同名实现同口径（UTF-8 / 规范化 JSON）。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 二进制（如 PNG）的 sha256；不要先转字符串再哈希。 */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function documentHashOf(document: ModelDocument): string {
  return sha256Hex(JSON.stringify(document));
}

function blob(store: RunWriter, data: string | Uint8Array): Ref {
  return store.putBlob(typeof data === 'string' ? encoder.encode(data) : data);
}

interface Mutable {
  toolMessages: Extract<Message, { role: 'tool' }>[];
  images: ViewContentPart[];
  summaries: ToolCallSummary[];
  measures: unknown;
  stop: StopReason | null;
  submitted: boolean;
}

interface Done {
  readonly status: string;
  readonly text: string;
}

async function runModel(state: ModelState, ctx: ModelToolContext, out: Mutable): Promise<Done> {
  const version = draftVersion(state);
  if (version === null) return { status: 'no-code', text: '当前稿还没有代码，先 write_code。' };
  const { code } = state.draft;
  const codeHash = sha256Hex(code);
  const options = ctx.signal === undefined ? { seed: ctx.seed } : { seed: ctx.seed, signal: ctx.signal };
  let execution: ModelExecution;
  try {
    execution = await ctx.execute(code, options);
  } catch (error) {
    // 外部取消（runner 的 deps.signal）不是宿主缺陷：归 aborted + cancelled，不记 internal-error。
    const aborted = ctx.signal?.aborted === true;
    const status = aborted ? 'aborted' : 'internal-error';
    const resultRef = blob(ctx.store, JSON.stringify({ kind: status, message: errorText(error) }));
    ctx.store.append('model.check', ctx.turn, {
      codeVersion: version,
      codeSha: codeHash,
      seed: ctx.seed,
      status,
      result: resultRef,
    });
    state.lastCheck = { version, outcome: 'not-finished' };
    out.stop = aborted ? 'cancelled' : 'internal-error';
    return {
      status,
      text: aborted ? '执行被中止（cancelled）。' : `执行宿主异常（internal-error）：${errorText(error)}`,
    };
  }

  const resultRef = blob(ctx.store, JSON.stringify(summarize(execution)));
  if (execution.kind === 'ok') {
    // documentHash 必须以实际文档复算为准，不信 child 报值（MODELING-SPEC §4）。
    const actualHash = documentHashOf(execution.document);
    if (actualHash !== execution.documentHash || execution.codeHash !== codeHash) {
      ctx.store.append('model.check', ctx.turn, {
        codeVersion: version,
        codeSha: codeHash,
        seed: ctx.seed,
        status: 'internal-error',
        result: blob(ctx.store, JSON.stringify({ kind: 'internal-error', message: '成功结果 hash 与代码/文档不符' })),
      });
      state.lastCheck = { version, outcome: 'not-finished' };
      out.stop = 'internal-error';
      return { status: 'internal-error', text: '执行结果 hash 校验失败（宿主缺陷），已停止。' };
    }
    const documentRef = blob(ctx.store, JSON.stringify(execution.document));
    ctx.store.append('model.check', ctx.turn, {
      codeVersion: version,
      codeSha: codeHash,
      seed: ctx.seed,
      status: 'ok',
      result: resultRef,
      document: documentRef,
      documentHash: actualHash,
    });
    state.lastOk = {
      version,
      code,
      codeHash,
      document: execution.document,
      documentHash: actualHash,
      ref: documentRef,
    };
    state.lastCheck = { version, outcome: 'ok', hash: actualHash };
    out.measures = { kind: 'ok', ...countsOf(execution.document), documentHash: actualHash };
    const log = consoleText(execution.console, execution.consoleTruncated);
    const geometry = geometrySummary(execution.document);
    return {
      status: 'ok',
      text:
        `执行成功：第 v${String(version)} 版，文档 hash ${actualHash.slice(0, 8)}…。\n${geometry}` +
        (log === '' ? '' : `\n${log}`),
    };
  }

  ctx.store.append('model.check', ctx.turn, {
    codeVersion: version,
    codeSha: codeHash,
    seed: ctx.seed,
    status: execution.kind,
    result: resultRef,
  });
  state.lastCheck = { version, outcome: outcomeOf(execution.kind) };
  out.measures = { kind: execution.kind };
  if (execution.kind === 'unsupported') out.stop = 'sandbox-unsupported';
  else if (execution.kind === 'aborted') out.stop = 'cancelled';
  const shown = failureText(execution);
  const log = execution.kind === 'build-error' ? consoleText(execution.console, execution.consoleTruncated) : '';
  return { status: execution.kind, text: log === '' ? shown : `${shown}\n${log}` };
}

function toRendered(image: ModelRenderImage): RenderedModelView {
  const b64 = Buffer.from(image.png).toString('base64');
  return {
    name: image.name,
    png: image.png,
    sha256: sha256Bytes(image.png),
    imageBytes: b64.length,
    dataUrl: `data:image/png;base64,${b64}`,
  };
}

async function runView(state: ModelState, ctx: ModelToolContext, out: Mutable): Promise<Done> {
  if (ctx.render === undefined) return { status: 'no-renderer', text: NO_RENDERER };
  const ok = state.lastOk;
  if (ok === null) return { status: 'no-document', text: '还没有执行成功的版本，先 run_model。' };
  if (!viewAllowed(ctx.budget.imageBytes)) {
    return { status: 'image-budget', text: '累计图片已超过上限，view_model 不再可用。' };
  }
  let views = ctx.cache.get(ok.documentHash);
  if (views === undefined) {
    let rendered: readonly ModelRenderImage[];
    try {
      rendered = await ctx.render(ok.document, ctx.signal === undefined ? undefined : { signal: ctx.signal });
    } catch (error) {
      // 外部取消不是宿主缺陷；render 的 AbortError 与 signal 已中止都归 cancelled。
      if (ctx.signal?.aborted === true) {
        out.stop = 'cancelled';
        return { status: 'aborted', text: '看图被中止（cancelled）。' };
      }
      out.stop = 'internal-error';
      return { status: 'internal-error', text: `渲染宿主异常（internal-error）：${errorText(error)}` };
    }
    if (ctx.signal?.aborted === true) {
      out.stop = 'cancelled';
      return { status: 'aborted', text: '看图被中止（cancelled）。' };
    }
    views = rendered.map(toRendered);
    ctx.cache.set(ok.documentHash, views);
  }
  out.images.push(
    ...views.flatMap((v): ViewContentPart[] => [
      { type: 'text', text: `模型视图 ${v.name}` },
      { type: 'image_url', image_url: { url: v.dataUrl } },
    ]),
  );
  for (const v of views) ctx.budget.imageBytes += v.imageBytes;
  ctx.budget.images += views.length;
  state.lastViewVersion = ok.version;
  return {
    status: 'ok',
    text: `已渲染第 v${String(ok.version)} 版文档 ${String(views.length)} 张，图附在本轮末尾。`,
  };
}

type SubmitDecision =
  | { readonly accepted: true; readonly text: string; readonly internal: false }
  | { readonly accepted: false; readonly text: string; readonly internal: boolean };

function evaluateSubmit(state: ModelState): SubmitDecision {
  const version = draftVersion(state);
  if (version === null) return { accepted: false, text: '当前稿还没有代码，先 write_code。', internal: false };
  const check = state.lastCheck;
  if (check === null)
    return { accepted: false, text: `当前稿第 v${String(version)} 版还没 run_model。`, internal: false };
  if (check.version !== version) {
    return {
      accepted: false,
      text: `当前稿第 v${String(version)} 版还没 run_model（最近执行的是第 v${String(check.version)} 版），先 run_model。`,
      internal: false,
    };
  }
  if (check.outcome !== 'ok') {
    return {
      accepted: false,
      text: `第 v${String(version)} 版执行未成功（${check.outcome}），先修改并 run_model 成功后再提交。`,
      internal: false,
    };
  }
  const ok = state.lastOk;
  if (ok?.version !== version) {
    return { accepted: false, text: `第 v${String(version)} 版没有成功快照，先 run_model。`, internal: false };
  }
  if (sha256Hex(state.draft.code) !== ok.codeHash) {
    return {
      accepted: false,
      text: `第 v${String(version)} 版代码已改动，成功结果已过期，先 run_model。`,
      internal: false,
    };
  }
  if (documentHashOf(ok.document) !== ok.documentHash) {
    return { accepted: false, text: '成功快照的文档 hash 校验失败（宿主缺陷）。', internal: true };
  }
  if (ok.document.parts.length === 0) {
    return {
      accepted: false,
      text: `第 v${String(version)} 版文档没有任何部件（parts 为空）：run_model 可以空成功，但提交必须至少有一个部件。`,
      internal: false,
    };
  }
  if (state.lastViewVersion !== version) {
    return {
      accepted: false,
      text:
        `第 v${String(version)} 版还没有成功看过图：` +
        '任务要求交付前查看当前版本，请先 view_model，看图确认后再 submit_model。',
      internal: false,
    };
  }
  return { accepted: true, text: `已提交第 v${String(version)} 版。`, internal: false };
}

function runSubmit(
  call: ToolCall,
  args: Readonly<Record<string, unknown>>,
  state: ModelState,
  ctx: ModelToolContext,
  out: Mutable,
): Done {
  state.note = args['note'] as string;
  const decision = evaluateSubmit(state);
  const version = draftVersion(state);
  if (version !== null) {
    ctx.store.append('submit', ctx.turn, {
      callId: call.id,
      codeVersion: version,
      accepted: decision.accepted,
      ...(decision.accepted ? {} : { reason: decision.text }),
    });
  }
  if (decision.internal) {
    out.stop = 'internal-error';
    return { status: 'internal-error', text: decision.text };
  }
  if (decision.accepted && state.lastOk !== null) {
    state.submitted = {
      code: state.lastOk.code,
      codeHash: state.lastOk.codeHash,
      document: state.lastOk.document,
      documentHash: state.lastOk.documentHash,
      documentRef: state.lastOk.ref,
      codeVersion: state.lastOk.version,
      note: state.note,
    };
    out.submitted = true;
  }
  return { status: decision.accepted ? 'accepted' : 'rejected', text: decision.text };
}

function saveVersion(state: ModelState, ctx: ModelToolContext, via: 'write_code' | 'edit_code'): void {
  const { draft } = state;
  ctx.store.append('code.version', ctx.turn, {
    version: draft.version,
    code: blob(ctx.store, draft.code),
    via,
    lines: lineCount(draft.code),
  });
}

async function executeTool(
  name: ModelToolName,
  args: Readonly<Record<string, unknown>>,
  call: ToolCall,
  isLastView: boolean,
  state: ModelState,
  ctx: ModelToolContext,
  out: Mutable,
): Promise<Done> {
  switch (name) {
    case 'write_code': {
      const r = writeCode(state.draft, args['code'] as string, MAX_MODEL_CODE_BYTES);
      if (r.kind === 'ok') {
        state.draft = r.draft;
        saveVersion(state, ctx, 'write_code');
      }
      return { status: r.kind, text: r.text };
    }
    case 'edit_code': {
      const r = editCode(state.draft, args['edits'] as readonly Edit[]);
      if (r.kind === 'error') return { status: r.status, text: r.text };
      state.draft = r.draft;
      saveVersion(state, ctx, 'edit_code');
      return { status: 'ok', text: r.text };
    }
    case 'read_code':
      return {
        status: 'ok',
        text: readCode(state.draft, args['from'] as number | undefined, args['to'] as number | undefined).text,
      };
    case 'run_model':
      return runModel(state, ctx, out);
    case 'view_model':
      if (!isLastView) return { status: 'superseded', text: VIEW_SUPERSEDED };
      return runView(state, ctx, out);
    case 'submit_model':
      return runSubmit(call, args, state, ctx, out);
  }
}

function issuesText(issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]): string {
  return issues.map((i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`).join('；');
}

/**
 * 按序执行一个响应里的全部草模工具调用。`invalidIndices` 是 client 替换成 "{}" 的截断参数下标（C12）。
 * 每个调用前先看 `ctx.signal`：已中止就不再执行剩余调用（含 submit），直接以 cancelled 停止；
 * 这样同一轮里某个工具执行期间被中止后，后面的写 / 提交也不会在截止后继续。遇到宿主缺陷（stop）时同理立即返回。
 */
export async function runModelToolCalls(
  calls: readonly ToolCall[],
  invalidIndices: ReadonlySet<number>,
  state: ModelState,
  ctx: ModelToolContext,
): Promise<ModelTurn> {
  const out: Mutable = { toolMessages: [], images: [], summaries: [], measures: null, stop: null, submitted: false };
  const lastView = calls.findLastIndex((c) => c.function.name === 'view_model');
  for (const [index, call] of calls.entries()) {
    // 轮内每个 tool 之前检查一次：信号已中止就不执行该调用，不写 tool.call/result，也不接受提交。
    if (ctx.signal?.aborted === true) {
      out.stop = 'cancelled';
      break;
    }
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
    const known = isModelToolName(name);
    const checked = known && parse === 'ok' ? MODEL_TOOL_ARGS[name].safeParse(parsed) : null;
    if (parse === 'ok' && checked?.success !== true) parse = 'invalid-args';
    ctx.store.append('tool.call', ctx.turn, { callId: call.id, name, arguments: blob(ctx.store, raw), parse });

    let done: Done;
    if (state.submitted !== null) done = { status: 'skipped-submitted', text: NOT_EXECUTED_SUBMITTED };
    else if (parse === 'invalid-json') done = { status: 'invalid-json', text: NOT_EXECUTED_INVALID_JSON };
    else if (!known) {
      done = {
        status: 'unknown-tool',
        text: `没有名为 ${name} 的工具，没有执行。可用：${MODEL_TOOL_NAMES.join('、')}。`,
      };
    } else if (!checked?.success) {
      done = { status: 'invalid-args', text: `参数不合法，没有执行：${issuesText(checked?.error.issues ?? [])}` };
    } else if (name === 'write_code' && windowBlocksWrite(state.draft, ctx.budget.inWindow)) {
      done = { status: 'window-blocked', text: MODEL_WINDOW_BLOCKED };
    } else {
      done = await executeTool(name, checked.data, call, index === lastView, state, ctx, out);
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
  return {
    toolMessages: out.toolMessages,
    images: out.images,
    summaries: out.summaries,
    measures: out.measures,
    stop: out.stop,
    submitted: out.submitted,
  };
}
