/**
 * massing 子运行编排（SUBAGENT-LOOP-SPEC §2–§7）：复用、可选资产容量检查、预算预留、
 * 有界 runRun、交付校验与登记、合成图、结算及事件回放。失败不杀父 run；子目录只落在父 run 下。
 * 不负责工具 schema / 注册、命名、主循环护栏与读源码；宿主缺执行或渲染依赖时返回 no-host。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ChatClient } from '@pg/llm/client';
import { ModelDocument } from '@pg/modeling/schema';
import { checkAssets } from '@pg/sandbox/run';
import type { MassingDocumentAsset } from '@pg/sandbox/run';
import type { Event, Ref, StopReason } from '@pg/store/events';
import type { RunReader, RunWriter } from '@pg/store/run-dir';
import { createRunDir, openRunDir } from '@pg/store/run-dir';

import { viewAllowed } from '../guards/image.ts';
import { createModelingTarget } from '../modeling-target.ts';
import { errorText, geometrySummary } from '../modeling-tools/result.ts';
import { documentHashOf } from '../modeling-tools/session.ts';
import type { ModelExecute, ModelRender } from '../modeling-tools/session.ts';
import { runRun } from '../runner.ts';
import type { ExternalVersions, RunnerInput } from '../runner.ts';
import type { ToolContext, ToolState } from '../turn-tools.ts';
import type { ViewContentPart } from '../tools/view.ts';
import {
  MASSING_ABORTED,
  MASSING_CHILD_WALL_MS,
  MASSING_IMAGE_SKIPPED,
  MASSING_MIN_PARENT_WALL_MS,
  MASSING_NO_HOST,
  MASSING_REJECTED_WALL,
  MASSING_REPLAY_MISSING,
  MASSING_SUBMIT_WINDOW,
  effectiveMassingMaxCny,
  effectiveMassingMaxTurns,
  formatMassingDirExists,
  formatMassingFailure,
  formatMassingHostError,
  formatMassingRejectedBudget,
  formatMassingRenderFailed,
  formatMassingReuse,
  formatMassingSuccess,
  massingAdvice,
  massingChildSeed,
  massingDir,
  massingId,
  massingReuseKey,
  massingRunId,
  massingStopDescription,
} from './tool.ts';
import type { MassingRequest } from './tool.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** contact 合成图（`renderModelContact` 的返回；name 恒为 contact）。 */
export interface MassingContactImage {
  readonly name: string;
  readonly png: Uint8Array;
}
export type MassingContactRender = (
  document: ModelDocument,
  options?: { readonly signal?: AbortSignal },
) => Promise<MassingContactImage>;

/** 子运行宿主依赖；由 CLI 在 tools 入口层组装（agent 不能 import @pg/web）。 */
export interface MassingHostDeps {
  /** 子运行的 ChatClient；缺省复用父 runner 的 client（同一实例，串行调用）。 */
  readonly client?: ChatClient;
  /** 子运行隔离执行；与 render / renderContact 任一缺失都回 no-host。 */
  readonly execute?: ModelExecute;
  readonly render?: ModelRender;
  readonly renderContact?: MassingContactRender;
  /** 子 `run.start` 的 ExternalVersions 工厂（git.diff 的 blob 要写进子 store）。 */
  readonly versions?: (store: RunWriter) => ExternalVersions;
  /** `createModelingTarget` 的建模版本。 */
  readonly modeling?: { readonly modelingApi: number; readonly modelFormat: number };
  /** script 模式子 `run.start.script` 的元数据（live 为 undefined）。 */
  readonly script?: { readonly name: string; readonly sha256: string };
  /** 回放模式：原父 run 的 reader，按 callId 找 `subrun.result` 重建（§7.2）。 */
  readonly replayParent?: RunReader;
  /** host 侧再收紧的上限（§1.1、§3）。 */
  readonly limits?: { readonly maxCny?: number; readonly maxTurns?: number; readonly wallMs?: number };
  /** 可选启用 sandbox 资产容量检查；传 [] 也启用。种子与会话文档合计，缺省保持旧调用行为。 */
  readonly seedDocuments?: readonly MassingDocumentAsset[];
}

/** runner 组装好的宿主：deps + 父 client / 时钟 / token 计数 / 模式（step 6 与 §7.2）。 */
export interface MassingToolHost {
  readonly deps: MassingHostDeps;
  readonly client: ChatClient;
  readonly clock: () => number;
  readonly countTokens: (text: string) => number;
  readonly mode: 'live' | 'script' | 'replay';
  readonly config: RunnerInput['config'];
}

export interface MassingToolOutcome {
  readonly status: string;
  readonly text: string;
  readonly images: readonly ViewContentPart[];
}

/** `subrun.result` 的标量字段；text / image 由 {@link writeSubrunResult} 另存 blob。 */
interface SubrunFields {
  readonly runId: string;
  readonly dir: string;
  readonly callId: string;
  readonly ordinal: number;
  readonly status: 'success' | 'failed' | 'aborted' | 'rejected';
  readonly reason?: string;
  readonly stopReason?: StopReason;
  readonly reservedCny: number;
  readonly costCny: number;
  readonly turns: number;
  readonly code?: Ref;
  readonly document?: Ref;
  readonly documentHash?: string;
}

function writeSubrunResult(
  store: RunWriter,
  turn: number,
  fields: SubrunFields,
  text: string,
  image: Uint8Array | null,
): void {
  store.append('subrun.result', turn, {
    ...fields,
    text: store.putBlob(encoder.encode(text)),
    ...(image === null ? {} : { image: store.putBlob(image) }),
  });
}

/**
 * 把 contact PNG 作为图片块附加并计入父图片预算（§5.4）。没有图或累计图片超过软上限时返回空数组；
 * 调用方据返回是否为空在文本里注明。
 */
function attachContact(id: string, png: Uint8Array | null, state: ToolState): ViewContentPart[] {
  if (png === null || !viewAllowed(state.imageBytes)) return [];
  const b64 = Buffer.from(png).toString('base64');
  state.imageBytes += b64.length;
  state.images += 1;
  return [
    { type: 'text', text: `草模合成图 ${id}` },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
  ];
}

/** 渲染失败的 kind：优先错误对象上的 `kind`，否则错误名或单行消息（§6 的 `render-failed`）。 */
function renderFailureKind(error: unknown): string {
  if (error instanceof Error) {
    const kind = (error as { readonly kind?: unknown }).kind;
    if (typeof kind === 'string' && kind !== '') return kind;
    if (error.name !== '' && error.name !== 'Error') return error.name;
    const head = error.message.split('\n')[0] ?? '';
    return head === '' ? 'error' : head.slice(0, 120);
  }
  return 'error';
}

/** 宿主依赖是否可以真正启动子运行（缺执行 / 渲染 / 版本依赖都回 no-host）。 */
function usableDeps(
  deps: MassingHostDeps | undefined,
): deps is MassingHostDeps &
  Required<Pick<MassingHostDeps, 'execute' | 'render' | 'renderContact' | 'versions' | 'modeling'>> {
  return (
    deps?.execute !== undefined &&
    deps.render !== undefined &&
    deps.renderContact !== undefined &&
    deps.versions !== undefined &&
    deps.modeling !== undefined
  );
}

/**
 * 执行一次 massing 调用。返回的状态取 SUBAGENT-LOOP-SPEC §6 的值；所有分支都不设 run.stop。
 * 宿主不可用（没接线或缺执行 / 渲染 / 版本依赖）时返回 no-host，不伪造结果。
 */
export async function runMassingTool(
  request: MassingRequest,
  callId: string,
  state: ToolState,
  ctx: ToolContext,
): Promise<MassingToolOutcome> {
  const host = ctx.massing;
  const deps = host?.deps;
  if (host === undefined || deps === undefined) {
    return { status: 'no-host', text: MASSING_NO_HOST, images: [] };
  }
  const effMaxCny = effectiveMassingMaxCny(request.maxCny, deps.limits?.maxCny);
  const effMaxTurns = effectiveMassingMaxTurns(request.maxTurns, deps.limits?.maxTurns);
  const key = massingReuseKey({
    brief: request.brief,
    maxTurns: effMaxTurns,
    maxCny: effMaxCny,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
  });

  // 步骤 2：同键的成功结果直接复用；不预留、不启动，图片重新附加并按 base64 字节再计一次（§2.3）。
  const reused = state.massing.runs.find((run) => run.key === key);
  if (reused !== undefined) {
    const images = attachContact(reused.id, reused.image, state);
    const skipped = reused.image !== null && images.length === 0;
    const text = skipped ? `${formatMassingReuse(reused)}\n${MASSING_IMAGE_SKIPPED}` : formatMassingReuse(reused);
    // 复用也写 subrun.result：回放按 callId 重建，否则同一调用的回放会 replay-missing（§7.2）。
    writeSubrunResult(
      ctx.store,
      ctx.turn,
      {
        runId: reused.runId,
        dir: reused.dir,
        callId,
        ordinal: reused.ordinal,
        status: 'success',
        reason: 'reuse',
        reservedCny: 0,
        costCny: 0,
        turns: 0,
      },
      text,
      skipped ? null : reused.image,
    );
    return { status: 'ok', text, images };
  }

  if (host.mode === 'replay') return replayMassing(host, callId, state, ctx);
  // 回放只需要 replayParent；真正的启动才要求执行 / 渲染 / 版本依赖齐全（§6 的 no-host）。
  if (!usableDeps(deps)) return { status: 'no-host', text: MASSING_NO_HOST, images: [] };
  const capacityFailure = (document?: ModelDocument): string | null => {
    if (deps.seedDocuments === undefined) return null;
    const documents = [...deps.seedDocuments, ...state.massingDocuments];
    if (document !== undefined) documents.push({ id: 'pending', document });
    const failure = checkAssets({ documents }, document === undefined);
    return failure === null
      ? null
      : `草模资产容量不足（${failure.reason}）：现有/待登记 ${String(failure.documents)} 份，` +
          `文档字节 ${String(failure.bytes)}，上限 ${String(failure.limit)}；旧资产保留，请使用已有引用。`;
  };
  const preflight = capacityFailure();
  if (preflight !== null) return { status: 'rejected-assets', text: `未启动子运行；${preflight}`, images: [] };

  // 步骤 3：父预算先预留后结算（§3.1）；拿不到额度不启动。
  const budget = ctx.budget;
  if (!budget.reserveSubrun(effMaxCny)) {
    return {
      status: 'rejected-budget',
      text: formatMassingRejectedBudget(budget.remainingCny(), effMaxCny),
      images: [],
    };
  }
  let settled = false;
  let actualCny: number | null = null;
  const settle = (actual: number): void => {
    if (settled) return;
    settled = true;
    budget.settleSubrun(effMaxCny, actual);
  };

  const ordinal = state.massing.ordinal + 1;
  const id = massingId(ordinal);
  const runId = massingRunId(ordinal);
  const dir = massingDir(ordinal);
  const childRoot = join(ctx.store.dir, 'sub');
  const childDir = join(childRoot, runId);
  const hostWallMs = deps.limits?.wallMs ?? MASSING_CHILD_WALL_MS;
  let started = false;
  const { execute, render, renderContact, versions, modeling, script } = deps;
  try {
    // 步骤 4：父剩余墙钟不足就释放预留并拒绝。
    const remaining = ctx.remainingWallMs?.() ?? Number.POSITIVE_INFINITY;
    if (remaining < MASSING_MIN_PARENT_WALL_MS) {
      settle(0);
      return { status: 'rejected', text: MASSING_REJECTED_WALL, images: [] };
    }
    const childWallMs = Math.min(hostWallMs, remaining);
    // 步骤 5：已存在即拒绝（对齐 tools/model-agent.ts 的拒绝覆盖）。
    if (existsSync(childDir)) {
      settle(0);
      return { status: 'rejected', text: formatMassingDirExists(dir), images: [] };
    }
    // 步骤 6：序号每启动一次 +1（失败也计数，§2.3）。
    state.massing.ordinal = ordinal;
    started = true;

    const childInput: RunnerInput = {
      task: { raw: request.brief, fed: request.brief, source: null },
      seed: request.seed ?? massingChildSeed(ctx.seed, ordinal),
      limits: {
        maxCostCny: effMaxCny,
        maxTurns: effMaxTurns,
        wallMs: childWallMs,
        submitWindow: MASSING_SUBMIT_WINDOW,
      },
      mode: host.mode === 'live' ? 'live' : 'script',
      variant: 'base',
      config: host.mode === 'live' ? host.config : null,
      parent: { runId: ctx.store.runId, dir: '../..', callId, turn: ctx.turn },
      ...(host.mode === 'script' && script !== undefined ? { script } : {}),
    };
    const childStore = createRunDir(childRoot, runId);
    const outcome = await runRun(childInput, {
      target: createModelingTarget({ execute, render, versions: modeling }),
      client: host.client,
      store: childStore,
      clock: host.clock,
      ...(ctx.sleep === undefined ? {} : { sleep: ctx.sleep }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      versions: versions(childStore),
      countTokens: host.countTokens,
    });

    // 步骤 7：等子 outcome 落定后读事件；异常不抛给父 run（§6）。
    const reader = openRunDir(childStore.dir);
    const events = reader.events();
    const end = events.find((event) => event.type === 'run.end');
    const childCost = end?.body.totals.costCny ?? null;
    const turns = end?.body.totals.turns ?? outcome.turns;

    if (outcome.stopReason === null) {
      const delivery = events.find((event) => event.type === 'model.delivery');
      if (delivery === undefined) throw new Error('子运行报告交付成功，但事件流里没有 model.delivery');
      const codeBytes = reader.blob(delivery.body.code.sha256);
      const documentBytes = reader.blob(delivery.body.document.sha256);
      const document = ModelDocument.parse(JSON.parse(decoder.decode(documentBytes)));
      const hash = documentHashOf(document);
      if (hash !== delivery.body.hash) {
        throw new Error(`子运行文档 hash 与交付不符：交付 ${delivery.body.hash}，复算 ${hash}`);
      }
      const capacity = capacityFailure(document);
      if (capacity !== null) {
        actualCny = childCost ?? effMaxCny;
        const text = `子运行已交付但未登记；${capacity} 已花费 ¥${String(actualCny)}，详见 ${dir}。`;
        writeSubrunResult(
          ctx.store,
          ctx.turn,
          {
            runId,
            dir,
            callId,
            ordinal,
            status: 'failed',
            reason: 'assets-too-large',
            reservedCny: effMaxCny,
            costCny: actualCny,
            turns,
          },
          text,
          null,
        );
        return { status: 'failed', text, images: [] };
      }
      const source = decoder.decode(codeBytes);
      const codeRef = ctx.store.putBlob(codeBytes);
      const documentRef = ctx.store.putBlob(documentBytes);

      // 步骤 8：成功交付且图片预算允许时渲染合成图（§5.1、§5.4）。
      let contact: Uint8Array | null = null;
      let renderFailure: string | null = null;
      let aborted = false;
      if (!viewAllowed(state.imageBytes)) {
        ctx.store.append('render.result', ctx.turn, {
          purpose: 'massing',
          kind: 'image-budget-skip',
          images: [],
          wallMs: 0,
        });
      } else {
        const renderStarted = host.clock();
        try {
          const image = await renderContact(document, ctx.signal === undefined ? undefined : { signal: ctx.signal });
          contact = image.png;
          ctx.store.append('render.result', ctx.turn, {
            purpose: 'massing',
            kind: 'ok',
            images: [
              {
                view: 'contact',
                png: ctx.store.putBlob(image.png),
                pixelsPerCell: 0,
                frameFill: 0,
              },
            ],
            wallMs: Math.max(0, Math.round(host.clock() - renderStarted)),
          });
        } catch (error) {
          const wallMs = Math.max(0, Math.round(host.clock() - renderStarted));
          if (ctx.signal?.aborted === true) {
            aborted = true;
            ctx.store.append('render.result', ctx.turn, {
              purpose: 'massing',
              kind: 'aborted',
              images: [],
              wallMs,
            });
          } else {
            renderFailure = renderFailureKind(error);
            ctx.store.append('render.result', ctx.turn, {
              purpose: 'massing',
              kind: renderFailure,
              images: [],
              wallMs,
            });
          }
        }
      }

      const baseText = formatMassingSuccess({
        id,
        dir,
        source: codeRef,
        document: documentRef,
        documentHash: hash,
        geometry: geometrySummary(document),
      });
      let status = 'ok';
      let text = baseText;
      if (aborted) {
        status = 'aborted';
        text = `${baseText}\n子运行已交付，但合成图被中止，随父 run 取消。`;
      } else if (renderFailure !== null) {
        status = 'render-failed';
        text = `${baseText}\n${formatMassingRenderFailed(id, renderFailure)}`;
      } else if (contact === null) {
        text = `${baseText}\n${MASSING_IMAGE_SKIPPED}`;
      }
      const images = attachContact(id, contact, state);
      if (contact !== null && images.length === 0) text = `${baseText}\n${MASSING_IMAGE_SKIPPED}`;

      // 步骤 8：登记成功记录与文档，供复用与 check_code 资产通道（id 用 massing#N）。
      state.massing.runs.push({
        id,
        ordinal,
        runId,
        dir,
        key,
        text,
        source,
        image: contact,
        document,
        documentHash: hash,
      });
      state.massingDocuments.push({ id, document });
      writeSubrunResult(
        ctx.store,
        ctx.turn,
        {
          runId,
          dir,
          callId,
          ordinal,
          status: 'success',
          reservedCny: effMaxCny,
          costCny: childCost ?? effMaxCny,
          turns,
          code: codeRef,
          document: documentRef,
          documentHash: hash,
        },
        text,
        contact,
      );
      actualCny = childCost ?? effMaxCny;
      return { status, text, images };
    }

    // 步骤 7：未交付 → 失败 / 中止映射；不设父 run.stop。
    actualCny = outcome.stopReason === 'internal-error' ? effMaxCny : (childCost ?? effMaxCny);
    const failedFields: SubrunFields = {
      runId,
      dir,
      callId,
      ordinal,
      status: outcome.stopReason === 'cancelled' ? 'aborted' : 'failed',
      stopReason: outcome.stopReason,
      reservedCny: effMaxCny,
      costCny: actualCny,
      turns,
    };
    if (outcome.stopReason === 'cancelled') {
      writeSubrunResult(ctx.store, ctx.turn, failedFields, MASSING_ABORTED, null);
      return { status: 'aborted', text: MASSING_ABORTED, images: [] };
    }
    if (outcome.stopReason === 'internal-error') {
      const detail = end?.body.failure?.message ?? `子运行以 internal-error 结束，详见 ${dir}/events.jsonl`;
      const text = formatMassingHostError(detail);
      writeSubrunResult(ctx.store, ctx.turn, failedFields, text, null);
      return { status: 'failed', text, images: [] };
    }
    const text = formatMassingFailure({
      description: massingStopDescription(outcome.stopReason, {
        maxTurns: effMaxTurns,
        maxCny: effMaxCny,
        wallMs: childWallMs,
      }),
      turns,
      costCny: actualCny,
      advice: massingAdvice(outcome.stopReason),
    });
    writeSubrunResult(ctx.store, ctx.turn, failedFields, text, null);
    return { status: 'failed', text, images: [] };
  } catch (error) {
    if (!started) {
      // 启动前的意外宿主缺陷：不扣费、不吞错，交 runner 收 internal-error。
      settle(0);
      throw error;
    }
    actualCny ??= effMaxCny;
    const text = formatMassingHostError(errorText(error));
    writeSubrunResult(
      ctx.store,
      ctx.turn,
      {
        runId,
        dir,
        callId,
        ordinal,
        status: 'failed',
        reason: 'host-error',
        reservedCny: effMaxCny,
        costCny: actualCny,
        turns: 0,
      },
      text,
      null,
    );
    return { status: 'failed', text, images: [] };
  } finally {
    // 拿不到子花费（子宿主异常 / 读事件失败）按预留全额（§3.1）。
    settle(actualCny ?? effMaxCny);
  }
}

/**
 * 回放模式（§7.2）：不启动子运行，按 callId 找原父 run 的 `subrun.result`，取 text / image 重建工具结果；
 * 成功记录还要重建源码、文档与复用状态，后续 check_code 的资产通道与 read_massing 才能逐字一致。
 * 缺记录 → `replay-missing`。
 */
function replayMassing(host: MassingToolHost, callId: string, state: ToolState, ctx: ToolContext): MassingToolOutcome {
  const parent = host.deps.replayParent;
  if (parent === undefined) return { status: 'replay-missing', text: MASSING_REPLAY_MISSING, images: [] };
  const record = parent
    .events()
    .find(
      (event): event is Extract<Event, { type: 'subrun.result' }> =>
        event.type === 'subrun.result' && event.body.callId === callId,
    );
  if (record === undefined) return { status: 'replay-missing', text: MASSING_REPLAY_MISSING, images: [] };

  const text = decoder.decode(parent.blob(record.body.text.sha256));
  const image = record.body.image === undefined ? null : parent.blob(record.body.image.sha256);
  // 原 run 的花费已包含子花费：回放按记录补记，事实行与后续预算判断才和原 run 一致。
  state.massing.ordinal = Math.max(state.massing.ordinal, record.body.ordinal);
  ctx.budget.settleSubrun(record.body.costCny, record.body.costCny);

  if (record.body.status === 'success' && record.body.code !== undefined && record.body.document !== undefined) {
    const source = decoder.decode(parent.blob(record.body.code.sha256));
    try {
      const document = ModelDocument.parse(JSON.parse(decoder.decode(parent.blob(record.body.document.sha256))));
      const hash = documentHashOf(document);
      if (record.body.documentHash === undefined || record.body.documentHash === hash) {
        const id = massingId(record.body.ordinal);
        state.massing.runs.push({
          id,
          ordinal: record.body.ordinal,
          runId: record.body.runId,
          dir: record.body.dir,
          key: '',
          text,
          source,
          image,
          document,
          documentHash: hash,
        });
        state.massingDocuments.push({ id, document });
      }
    } catch {
      // 记录里的文档坏掉：不登记（check_code 会按 asset-missing 报），仍返回原文本。
    }
  }

  const images = attachContact(massingId(record.body.ordinal), image, state);
  const skipped = image !== null && images.length === 0;
  return {
    status: record.body.status === 'success' ? 'ok' : record.body.status === 'aborted' ? 'aborted' : 'failed',
    text: skipped ? `${text}\n${MASSING_IMAGE_SKIPPED}` : text,
    images,
  };
}
