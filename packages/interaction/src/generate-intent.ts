/* eslint-disable max-lines */
/**
 * DesignIntent 生成：需求图 → 单工具 submit_intent → DesignIntent.parse → 宿主展开。
 *
 * 负责：请求构造、schema 失败的定点 patch、展开失败的二次定点 patch、可读错误与 usage 汇总。
 * 不负责：真实网络 / 配置、会话状态机、文件写入；client 由调用方注入。
 */
import type { ChatClient } from '@pg/llm/client';
import type { ChatRequest, ChatResponse, Delta, Usage } from '@pg/llm/schema';
import { z } from 'zod';

import { designConflictFromDatum, designConflictsFromWarnings } from './design-conflict.ts';
import type { DesignConflict } from './design-conflict.ts';
import { DesignIntent, IntentValidationError } from './design-intent.ts';
import type { DesignHostContext } from './design-intent.ts';
import { DesignIntentDraft } from './design-intent-draft.ts';
import { normalizeDesignIntent } from './design-intent-normalize.ts';
import type { IntentNormalizationWarning } from './design-intent-normalize.ts';
import { expandDesignIntent } from './design-expand.ts';
import type { DesignFacts, DesignWarning, ResolvedDesign } from './design-expand.ts';
import { findFlushMustEntries } from './floor-datum.ts';
import { buildMustLedger } from './must-ledger.ts';
import {
  completeOnce,
  completeStructured,
  contentJsonRepairRequest,
  extractContentJson,
  GenerationError,
  parseContentSubmission,
  parseToolSubmission,
  requestFor,
  requestForContentJson,
  responseDiagnostics,
} from './generate.ts';
import type { ContentJsonSource, GenerateOptions, GenerationDiagnostics, GenerationResult } from './generate.ts';
import { assertUsableFinishReason, thinkingDiagnostic } from './generate-content.ts';
import type { ResponseFormatEcho } from './generate-content.ts';

import {
  INTENT_DRAFT_SCHEMA_CHARS,
  INTENT_NARRATIVE_TOOL_NAME,
  INTENT_TOOL_NAME,
  intentNarrativePrompt,
  intentPrompt,
} from './prompts-intent.ts';
import type { ClarificationExchange } from './prompts.ts';
import {
  applyRepairPatches,
  issueSummary,
  INTENT_TOP_LEVEL_FIELDS,
  RepairSubmissionSchema,
  repairRequestForIssue,
  submissionTool,
  sumUsage,
} from './repair.ts';
import type { AppliedPatch, StructuredSubmission } from './repair.ts';
import type { RequirementGraph } from './requirements.ts';
import type { DesignScheme, SchemeScope, SchemeStatus } from './scheme.ts';

export type { ContentJsonSource } from './generate.ts';

export const REPAIR_INTENT_TOOL_NAME = 'repair_intent';
// 32k（以及历史 8k 截断点）是项目输出预算；模型单次 API completion 上限是 384K（393,216），不是 32k。
/** 单次完整 intent 比单阶段输出更容易写长；真实茶亭在 8192 处被截断，默认留到 32k。 */
export const DEFAULT_INTENT_MAX_TOKENS = 32_768;
/** 叙事阶段只写 8–15 行；4096 足够，避免 thinking 阶段吃满预算。 */
export const DEFAULT_INTENT_NARRATIVE_MAX_TOKENS = 4_096;
/** content-json 严格序列化阶段的最低输出预算。 */
export const MIN_INTENT_JSON_MAX_TOKENS = 16_384;
/** 整段替换会绕过局部修复，越修越糟；content-json 修复只允许叶子路径。 */
export const INTENT_FORBIDDEN_REPAIR_PATHS = ['/site', '/program'] as const;
/** 叙事用单字符串工具承载；ChatRequest 不允许 tools:[] 的纯文本请求。 */
export const IntentNarrativeSubmission = z.strictObject({ narrative: z.string().min(1).max(8_000) }).readonly();

/** 交互生成进度事件。thinking / content / tool 都是临时流式增量，调用方只能即时展示。 */
export type InteractionStage = 'requirements' | 'intent' | 'repair' | 'expand' | 'lint' | 'preview' | 'artifacts';

export type InteractionProgressEvent =
  | {
      readonly kind: 'stage';
      readonly stage: InteractionStage;
      readonly status: 'start' | 'done' | 'error';
      readonly detail?: string;
    }
  | { readonly kind: 'thinking'; readonly stage: InteractionStage; readonly text: string }
  | { readonly kind: 'content'; readonly stage: InteractionStage; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly stage: InteractionStage;
      readonly name: string;
      readonly status: 'start' | 'delta' | 'done';
      readonly index?: number;
      readonly text?: string;
    }
  | {
      readonly kind: 'patch';
      readonly stage: 'repair' | 'expand';
      readonly path: string;
      readonly op: 'replace' | 'add' | 'remove';
    }
  | {
      readonly kind: 'file';
      readonly stage: 'artifacts';
      readonly status: 'start' | 'done' | 'error';
      readonly path: string;
      readonly bytes?: number;
    }
  | {
      readonly kind: 'question';
      readonly stage: 'requirements' | 'intent';
      readonly id: string;
      readonly text: string;
      readonly choices?: readonly string[];
    };

export type InteractionProgressCallback = (event: InteractionProgressEvent) => void;

export interface IntentStageDiagnostic {
  readonly stage: 'narrative' | 'intent' | 'repair';
  readonly outputMode: 'tool' | 'content-json';
  readonly thinking: string;
  readonly maxTokens: number;
  readonly promptChars: number;
  readonly schemaChars: number;
  readonly contentChars: number;
  readonly reasoningChars: number;
  readonly finishReason: ChatResponse['finishReason'];
  readonly usage: Usage;
  readonly contentPreview?: string;
  readonly reasoningPreview?: string;
}

export interface ProposeIntentOptions extends GenerateOptions {
  readonly previousIntent?: DesignIntent;
  readonly feedback?: string;
  readonly answers?: readonly ClarificationExchange[];
  readonly capabilitySummary?: string;
  /** 期望交付范围；给出时 intent.meta.scope 必须一致。 */
  readonly scope?: SchemeScope;
  /** 默认 content-json 开启叙事；tool 模式默认关闭，保持旧路径。 */
  readonly narrative?: boolean;
  readonly narrativeMaxTokens?: number;
  /** 流式进度：thinking / content / tool / patch / stage；只用于前端临时展示。 */
  readonly onProgress?: InteractionProgressCallback;
}

export interface IntentGenerationResult {
  readonly intent: DesignIntent;
  readonly scheme: DesignScheme;
  readonly facts: DesignFacts;
  readonly warnings: readonly DesignWarning[];
  /** 统一后的 gate / datum / 室外分区 / 家具几何冲突；不含普通 alias warning。 */
  readonly conflicts: readonly DesignConflict[];
  readonly normalizationWarnings: readonly IntentNormalizationWarning[];
  readonly contentFallbacks: readonly { readonly tool: string; readonly source: ContentJsonSource }[];
  readonly schemaPatchCount: number;
  readonly expandPatchCount: number;
  /** 归一化 + 展开阶段实际应用成功的 repair_intent 轮数（0..2）；无效补丁重试不计。 */
  readonly repairRoundCount: number;
  readonly usage: Usage;
  readonly rawResponse: ChatResponse;
  readonly patchRepairs?: readonly AppliedPatch[];
  /** 各阶段实际 thinking / max_tokens / schema 字符数与输出摘要；不进入最终 intent。 */
  readonly stageDiagnostics: readonly IntentStageDiagnostic[];
}

export interface IntentHostOptions {
  readonly schemeId?: string;
  readonly revision?: number;
  readonly status?: SchemeStatus;
  readonly maxBlocks?: number;
  readonly targetBlocks?: number | null;
  readonly maxCostCny?: number | null;
  readonly forbidden?: readonly string[];
  readonly defaultMaterialId?: string;
  readonly floorThickness?: number;
  readonly roofThickness?: number;
  readonly requirementIds?: readonly string[];
}

/**
 * 从需求图与会话输入构造宿主上下文。预算 / 禁项 / requirementIds 都由宿主给出，
 * 模型不写这些字段；缺省预算沿用现有小体量示例的 20k。
 */
export function createIntentHost(requirements: RequirementGraph, options: IntentHostOptions = {}): DesignHostContext {
  const forbidden =
    options.forbidden ??
    requirements.constraints
      .filter((constraint) => constraint.kind === 'forbidden' && (constraint.hard || constraint.source === 'user'))
      .map((constraint) => constraint.text);
  const flushMustIds = findFlushMustEntries(requirements).map((entry) => entry.id);
  return {
    schemeId: options.schemeId ?? 'scheme-draft',
    revision: options.revision ?? 1,
    status: options.status ?? 'draft',
    sourceRequirements: { graphId: requirements.id, revision: requirements.revision },
    maxBlocks: options.maxBlocks ?? 20_000,
    targetBlocks: options.targetBlocks ?? null,
    maxCostCny: options.maxCostCny ?? null,
    forbidden,
    requirementIds: options.requirementIds ?? [
      ...requirements.requirements.map((item) => item.id),
      ...requirements.constraints.map((item) => item.id),
      ...requirements.capabilities.map((item) => item.id),
    ],
    ...(options.defaultMaterialId === undefined ? {} : { defaultMaterialId: options.defaultMaterialId }),
    ...(options.floorThickness === undefined ? {} : { floorThickness: options.floorThickness }),
    ...(options.roofThickness === undefined ? {} : { roofThickness: options.roofThickness }),
    flushRequired: flushMustIds.length > 0,
    flushMustIds,
    // 完整 MustLedger（与 compileBuildSpec 同源、同序、不截断）。
    mustEntries: buildMustLedger(requirements).entries,
  };
}

/** 最终结果不携带思考正文；reasoning 只在流式进度与失败诊断里出现。 */
function withoutReasoning(response: ChatResponse): ChatResponse {
  const message = { ...response.message };
  delete message.reasoning_content;
  return { ...response, message };
}

function expandFailure(error: unknown, repairFailed = false): GenerationError {
  if (error instanceof IntentValidationError) {
    const location = error.path === '' ? '' : ` ${error.path}`;
    return new GenerationError(
      'expand-invalid',
      `DesignIntent 展开失败（${error.code}）${location}: ${error.message}`,
      error,
      undefined,
      repairFailed,
    );
  }
  return new GenerationError(
    'expand-invalid',
    `DesignIntent 展开失败：${error instanceof Error ? error.message : String(error)}`,
    error,
    undefined,
    repairFailed,
  );
}

function expandRepairError(message: string, cause?: unknown, diagnostics?: GenerationDiagnostics): GenerationError {
  return new GenerationError('expand-invalid', message, cause, diagnostics, true);
}

/** 兼容旧调用点：默认严格（纯 JSON / ```json fence）；allowEmbedded 才启用散文回退。 */
export function extractIntentContentJson(
  content: string,
  options: { readonly allowEmbedded?: boolean } = {},
): { readonly value: Record<string, unknown>; readonly source: ContentJsonSource } | null {
  return extractContentJson(content, options);
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAnyField(value: unknown, fields: readonly string[]): boolean {
  return jsonObject(value) && fields.some((field) => Object.hasOwn(value, field));
}

const CONTENT_FALLBACK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [INTENT_TOOL_NAME]: INTENT_TOP_LEVEL_FIELDS,
  [REPAIR_INTENT_TOOL_NAME]: ['patches'],
};

/**
 * 只在工具参数为空 / `{}` / 缺少本工具任何有效顶层字段时，才尝试从正文提取 JSON。
 * 参数非空但非法 JSON 时不回退，保持原有 invalid-json 行为。
 */
export function withContentFallback(
  client: ChatClient,
  onFallback: (tool: string, source: ContentJsonSource) => void,
): ChatClient {
  return {
    async complete(request, options) {
      const outcome = await client.complete(request, options);
      if (outcome.kind !== 'ok') return outcome;
      const calls = outcome.response.message.tool_calls ?? [];
      if (calls.length !== 1) return outcome;
      const call = calls[0];
      if (call === undefined) return outcome;
      const tool = call.function.name;
      const expected = CONTENT_FALLBACK_FIELDS[tool];
      if (expected === undefined) return outcome;
      const raw = call.function.arguments.trim();
      let parsed: unknown = {};
      if (raw !== '') {
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          return outcome;
        }
      }
      if (hasAnyField(parsed, expected)) return outcome;
      const content = outcome.response.message.content;
      if (typeof content !== 'string' || content.trim() === '') return outcome;
      const candidate = extractContentJson(content, { allowEmbedded: true });
      if (candidate === null || !hasAnyField(candidate.value, expected)) return outcome;
      onFallback(tool, candidate.source);
      return {
        ...outcome,
        response: {
          ...outcome.response,
          message: {
            ...outcome.response.message,
            tool_calls: [
              {
                ...call,
                function: {
                  ...call.function,
                  arguments: JSON.stringify(candidate.value),
                },
              },
            ],
          },
        },
      };
    },
  };
}

/** repair 请求由 repair.ts 在 system 开头追加固定标记；据此把流式增量归到 repair 阶段。 */
function progressStageForRequest(request: ChatRequest): 'intent' | 'repair' {
  const system = request.messages[0];
  return system?.role === 'system' && system.content.includes('【定点修复') ? 'repair' : 'intent';
}

/**
 * 把 complete 的 onDelta 转成进度事件，同时保留调用方自己的 onDelta / 取消语义。
 * reasoning 只即时转发，不缓存进结果。
 */
function withProgress(client: ChatClient, onProgress: InteractionProgressCallback | undefined): ChatClient {
  if (onProgress === undefined) return client;
  return {
    async complete(request, options) {
      const stage = progressStageForRequest(request);
      const toolName = request.tools[0]?.function.name;
      const system = request.messages[0]?.role === 'system' ? request.messages[0].content : '';
      const detail = system.includes('【设计叙事】') ? 'narrative' : (toolName ?? 'content-json');
      onProgress({ kind: 'stage', stage, status: 'start', detail });
      if (toolName !== undefined) onProgress({ kind: 'tool', stage, name: toolName, status: 'start' });
      const onDelta = (delta: Delta): 'continue' | 'abort' => {
        if (delta.kind === 'reasoning') {
          onProgress({ kind: 'thinking', stage, text: delta.text });
        } else if (delta.kind === 'content') {
          onProgress({ kind: 'content', stage, text: delta.text });
        } else if (toolName !== undefined) {
          onProgress({
            kind: 'tool',
            stage,
            name: toolName,
            status: 'delta',
            index: delta.index,
            text: delta.text,
          });
        }
        return options.onDelta?.(delta) ?? 'continue';
      };
      try {
        const outcome = await client.complete(request, { ...options, onDelta });
        if (outcome.kind === 'ok') {
          onProgress({ kind: 'stage', stage, status: 'done' });
          if (toolName !== undefined) onProgress({ kind: 'tool', stage, name: toolName, status: 'done' });
        } else {
          onProgress({
            kind: 'stage',
            stage,
            status: 'error',
            detail: outcome.kind === 'failed' ? `${outcome.failure.class}/${outcome.failure.code}` : 'aborted',
          });
        }
        return outcome;
      } catch (error) {
        onProgress({
          kind: 'stage',
          stage,
          status: 'error',
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

function arrayIndexById(basis: unknown, collectionPath: readonly string[], id: string): number | null {
  let current: unknown = basis;
  for (const key of collectionPath) {
    if (!jsonObject(current)) return null;
    current = current[key];
  }
  if (!Array.isArray(current)) return null;
  const index = current.findIndex((item) => jsonObject(item) && item['id'] === id);
  return index < 0 ? null : index;
}

/**
 * 展开错误常用 `furniture.<id>` / `openings.<id>` / `envelope.stairs.<id>` / `decisions.<id>` 定位；
 * repair 请求必须转换成数组下标，否则模型照抄 `/furniture/f-xxx` 会被补丁管线拒绝。
 */
function patchPath(error: IntentValidationError, basis: unknown): readonly PropertyKey[] | null {
  if (error.path === '' || error.path === '(root)') return null;
  const segments = error.path.split('.');
  const top = segments[0];
  if (top === undefined || !INTENT_TOP_LEVEL_FIELDS.includes(top as (typeof INTENT_TOP_LEVEL_FIELDS)[number])) {
    return null;
  }
  if ((top === 'furniture' || top === 'openings') && segments[1] !== undefined) {
    const index = arrayIndexById(basis, [top], segments[1]);
    if (index !== null) return [top, index, ...segments.slice(2)];
  }
  if (top === 'envelope' && segments[1] === 'stairs' && segments[2] !== undefined) {
    const index = arrayIndexById(basis, ['envelope', 'stairs'], segments[2]);
    if (index !== null) return ['envelope', 'stairs', index, ...segments.slice(3)];
  }
  if (top === 'decisions' && segments[1] !== undefined) {
    const index = arrayIndexById(basis, ['decisions'], segments[1]);
    if (index !== null) return ['decisions', index, ...segments.slice(2)];
  }
  return segments;
}

function responseFormatEchoWarning(echo: ResponseFormatEcho): IntentNormalizationWarning {
  return {
    code: 'response-format-echo-dropped',
    path: echo.field,
    message: `模型在顶层回显了 ${echo.field}（${JSON.stringify(echo.value)}），已按 response_format 回显剥离`,
  };
}

function promptCharsOf(request: ChatRequest): number {
  return request.messages.reduce(
    (total, message) => total + (typeof message.content === 'string' ? message.content.length : 0),
    0,
  );
}

function narrativeFromResponse(response: ChatResponse): string {
  const calls = response.message.tool_calls ?? [];
  if (calls.length > 1) throw new Error(`叙事返回了 ${String(calls.length)} 个工具调用；只能有一个。`);
  const call = calls[0];
  if (call !== undefined) {
    if (call.function.name !== INTENT_NARRATIVE_TOOL_NAME) {
      throw new Error(`叙事调用了 ${call.function.name}，预期是 ${INTENT_NARRATIVE_TOOL_NAME}。`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.function.arguments) as unknown;
    } catch (error) {
      throw new Error(`叙事工具参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    const value = IntentNarrativeSubmission.safeParse(parsed);
    if (!value.success) throw new Error(`叙事工具参数未通过 schema：${issueSummary(value.error)}`);
    return value.data.narrative.trim();
  }
  return response.message.content?.trim() ?? '';
}

function stageDiagnostic(
  stage: IntentStageDiagnostic['stage'],
  request: ChatRequest,
  response: ChatResponse,
  outputMode: 'tool' | 'content-json',
  schemaChars: number,
  textOverride?: string,
): IntentStageDiagnostic {
  const content = textOverride ?? response.message.content ?? '';
  const reasoning = response.message.reasoning_content ?? '';
  return {
    stage,
    outputMode,
    thinking: thinkingDiagnostic(request),
    maxTokens: request.max_tokens ?? 0,
    promptChars: promptCharsOf(request),
    schemaChars,
    contentChars: content.length,
    reasoningChars: reasoning.length,
    finishReason: response.finishReason,
    usage: response.usage,
    ...(content === '' ? {} : { contentPreview: content.slice(0, 200) }),
    ...(reasoning === '' ? {} : { reasoningPreview: reasoning.slice(0, 200) }),
  };
}

/**
 * 生成并展开 DesignIntent。content-json 默认先跑一次 thinking enabled 的短叙事，再以
 * thinking disabled 注入完整 JSON Schema 做严格序列化；schema / 展开失败仍走定点 patch。
 */
export async function proposeIntent(
  client: ChatClient,
  requirements: RequirementGraph,
  host: DesignHostContext,
  options: ProposeIntentOptions = {},
): Promise<IntentGenerationResult> {
  if (
    host.sourceRequirements.graphId !== requirements.id ||
    host.sourceRequirements.revision !== requirements.revision
  ) {
    throw new GenerationError(
      'invalid-options',
      `宿主 sourceRequirements=${host.sourceRequirements.graphId} v${String(host.sourceRequirements.revision)} 与需求图 ${requirements.id} v${String(requirements.revision)} 不一致。`,
    );
  }
  // 默认保留既有单工具提交；content-json 由调用方显式开启，避免未接进度 / 解析的宿主被切换。
  const outputMode = options.outputMode ?? 'tool';
  const stageDiagnostics: IntentStageDiagnostic[] = [];
  const narrativeWarnings: DesignWarning[] = [];
  const progressClient = withProgress(client, options.onProgress);

  // 阶段一：thinking enabled 的短设计叙事，只作为下一阶段上下文；失败降级跳过。
  const narrativeEnabled = options.narrative ?? outputMode === 'content-json';
  let narrative = '';
  if (narrativeEnabled) {
    const narrativePrompt = intentNarrativePrompt(requirements, {
      schemeId: host.schemeId,
      revision: host.revision,
      maxBlocks: host.maxBlocks,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(host.maxCostCny === undefined || host.maxCostCny === null ? {} : { maxCostCny: host.maxCostCny }),
      ...(options.answers === undefined ? {} : { answers: options.answers }),
      ...(options.previousIntent === undefined ? {} : { previousIntent: options.previousIntent }),
      ...(options.feedback === undefined ? {} : { feedback: options.feedback }),
    });
    const narrativeOptions: GenerateOptions = {
      ...options,
      outputMode,
      thinking: 'max',
      maxTokens: options.narrativeMaxTokens ?? DEFAULT_INTENT_NARRATIVE_MAX_TOKENS,
    };
    const narrativeRequest = requestFor(
      narrativePrompt.system,
      narrativePrompt.user,
      submissionTool(
        INTENT_NARRATIVE_TOOL_NAME,
        '提交 8–15 行设计叙事纯文本；narrative 参数只放叙事正文，不要 DesignIntent JSON。',
        IntentNarrativeSubmission,
      ),
      narrativeOptions,
    );
    try {
      const narrativeOutcome = await completeOnce(progressClient, narrativeRequest, narrativeOptions);
      assertUsableFinishReason(narrativeOutcome.response, 'intent-narrative');
      const content = narrativeFromResponse(narrativeOutcome.response);
      if (content === '') throw new Error('叙事正文为空');
      narrative = content;
      stageDiagnostics.push(
        stageDiagnostic('narrative', narrativeRequest, narrativeOutcome.response, outputMode, 0, narrative),
      );
    } catch (error) {
      narrativeWarnings.push({
        code: 'narrative-skipped',
        path: 'intent.narrative',
        message: `设计叙事失败，已跳过并直接生成 JSON：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // 阶段二：严格 JSON 序列化。content-json 注入同一份 Draft schema，并关闭 thinking。
  const prompt = intentPrompt(requirements, {
    schemeId: host.schemeId,
    revision: host.revision,
    maxBlocks: host.maxBlocks,
    outputFormat: outputMode,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(host.maxCostCny === undefined || host.maxCostCny === null ? {} : { maxCostCny: host.maxCostCny }),
    ...(options.answers === undefined ? {} : { answers: options.answers }),
    ...(options.capabilitySummary === undefined ? {} : { capabilitySummary: options.capabilitySummary }),
    ...(options.previousIntent === undefined ? {} : { previousIntent: options.previousIntent }),
    ...(options.feedback === undefined ? {} : { feedback: options.feedback }),
    ...(narrative === '' ? {} : { narrative }),
  });
  const spec: StructuredSubmission<DesignIntentDraft> = {
    toolName: INTENT_TOOL_NAME,
    repairToolName: REPAIR_INTENT_TOOL_NAME,
    label: 'DesignIntentDraft',
    allowedFields: INTENT_TOP_LEVEL_FIELDS,
    schema: DesignIntentDraft,
    forbiddenPaths: INTENT_FORBIDDEN_REPAIR_PATHS,
  };
  const contentJsonEchoes: ResponseFormatEcho[] = [];
  const recordEcho = (echo: ResponseFormatEcho): void => {
    contentJsonEchoes.push(echo);
  };
  const jsonMaxTokens =
    outputMode === 'content-json'
      ? Math.max(options.maxTokens ?? DEFAULT_INTENT_MAX_TOKENS, MIN_INTENT_JSON_MAX_TOKENS)
      : (options.maxTokens ?? DEFAULT_INTENT_MAX_TOKENS);
  const effectiveOptions: GenerateOptions = {
    ...options,
    outputMode,
    maxTokens: jsonMaxTokens,
    ...(outputMode === 'content-json' ? { thinking: 'disabled' as const } : {}),
  };
  const request =
    outputMode === 'content-json'
      ? requestForContentJson(prompt.system, prompt.user, effectiveOptions)
      : requestFor(
          prompt.system,
          prompt.user,
          submissionTool(
            INTENT_TOOL_NAME,
            '提交完整的 DesignIntent draft（12 个顶层字段）。只写设计意图；3D bounds、面积、counts、宿主 id 与预算由宿主处理。',
            DesignIntentDraft,
          ),
          effectiveOptions,
        );

  const contentFallbacks: { readonly tool: string; readonly source: ContentJsonSource }[] = [];
  const contentFallbackWarnings: DesignWarning[] = [];
  const effectiveClient =
    outputMode === 'tool'
      ? withContentFallback(progressClient, (tool, source) => {
          contentFallbacks.push({ tool, source });
          contentFallbackWarnings.push({
            code: 'content-fallback',
            path: tool,
            message: `${tool} 的 arguments 为空或缺少有效字段，已从 message.content 提取 ${source} JSON`,
          });
        })
      : progressClient;
  let generated: GenerationResult<DesignIntentDraft> = await completeStructured(
    effectiveClient,
    request,
    spec,
    effectiveOptions,
    recordEcho,
  );
  stageDiagnostics.push(
    stageDiagnostic(
      'intent',
      request,
      generated.rawResponse,
      outputMode,
      outputMode === 'content-json' ? INTENT_DRAFT_SCHEMA_CHARS : 0,
    ),
  );
  const emitProgress = (event: InteractionProgressEvent): void => {
    options.onProgress?.(event);
  };
  for (const patch of generated.patchRepairs ?? []) {
    emitProgress({ kind: 'patch', stage: 'repair', path: patch.path, op: patch.op });
  }
  const schemaPatchCount = generated.patchRepairs?.length ?? 0;
  let expandPatchCount = 0;
  let normalizationWarnings: readonly IntentNormalizationWarning[] = [];
  let draft: unknown = generated.value;
  let intent: DesignIntent | undefined;
  let resolved: ResolvedDesign | undefined;
  let lastError: IntentValidationError | undefined;
  let postSchemaPatches = 0;
  /** 补丁应用失败后的额外请求次数；独立于成功修复轮，避免无效补丁被当成修复进度。 */
  let invalidPatchRetries = 0;
  const patchRepairs = [...(generated.patchRepairs ?? [])];
  emitProgress({ kind: 'stage', stage: 'expand', status: 'start' });
  try {
    while (postSchemaPatches <= 2) {
      try {
        if (intent === undefined) {
          const normalized = normalizeDesignIntent(draft);
          intent = normalized.intent;
          normalizationWarnings = normalized.warnings;
          if (options.scope !== undefined && intent.meta.scope !== options.scope) {
            throw new GenerationError(
              'schema-invalid',
              `DesignIntent meta.scope=${intent.meta.scope}，与要求的 ${options.scope} 不一致。`,
            );
          }
        }
        resolved = expandDesignIntent(intent, host);
        break;
      } catch (error) {
        if (!(error instanceof IntentValidationError)) throw error;
        lastError = error;
        if (postSchemaPatches >= 2) break;
        const basis = intent ?? draft;
        const path = patchPath(error, basis);
        if (path === null) throw expandFailure(error, postSchemaPatches > 0);
        const repairHint =
          error.code === 'entrance-invalid'
            ? `${error.message}。修复建议：入口门宽 2 时，入口房间外包至少 4×3 格（两侧各留 1 格墙厚）；优先扩大入口房间或把入口并入主空间，不要缩小主入口门宽。`
            : error.code === 'furniture-out-of-room'
              ? `${error.message}。修复建议：先判断家具目标是否为无墙无顶的半室外平台 / 露台。若是：把对应的 /program/rooms/<i> 条目移除，将同一 rect 追加到 /site/outdoorZones/-（补 id、name、kind=terrace、materialId、notes），家具 roomId 改为新 outdoorZone id；平台不写墙 / 洞口 / 屋面，openings 与 envelope.walls 中引用旧 roomId 的条目改挂相邻室内房间或移除，相邻房间的 adjacency 同步更新。若目标确是有墙有顶的室内房间：扩大房间或缩小家具 footprint / height；若 roomId 指向 circulation，把家具改挂相邻 room / service 或删除。不要缩小主入口门宽。`
              : error.message;
        const toolRepairRequest = repairRequestForIssue(request, spec, basis, path, repairHint);
        let repairRequest =
          outputMode === 'content-json' ? contentJsonRepairRequest(toolRepairRequest) : toolRepairRequest;
        const repairUsages: Usage[] = [];
        for (;;) {
          let repairOutcome;
          try {
            repairOutcome = await completeOnce(effectiveClient, repairRequest, effectiveOptions);
          } catch (repairError) {
            throw expandRepairError(
              `展开修复调用失败：${repairError instanceof Error ? repairError.message : String(repairError)}`,
              repairError,
            );
          }
          repairUsages.push(repairOutcome.response.usage);
          const repairDiagnostics: GenerationDiagnostics = {
            ...responseDiagnostics(repairOutcome.response, repairRequest, outputMode),
            previous: responseDiagnostics(generated.rawResponse, request, outputMode),
          };
          stageDiagnostics.push(
            stageDiagnostic(
              'repair',
              repairRequest,
              repairOutcome.response,
              outputMode,
              outputMode === 'content-json' ? INTENT_DRAFT_SCHEMA_CHARS : 0,
            ),
          );
          if (repairOutcome.response.finishReason === 'length') {
            throw expandRepairError('展开失败后的定点修复被截断，未应用 patch。', undefined, repairDiagnostics);
          }
          let patches;
          try {
            patches =
              outputMode === 'content-json'
                ? parseContentSubmission(
                    repairOutcome.response,
                    REPAIR_INTENT_TOOL_NAME,
                    RepairSubmissionSchema,
                    recordEcho,
                  )
                : parseToolSubmission(repairOutcome.response, REPAIR_INTENT_TOOL_NAME, RepairSubmissionSchema);
          } catch (patchError) {
            throw expandRepairError(
              `展开修复补丁解析失败：${patchError instanceof Error ? patchError.message : String(patchError)}`,
              patchError,
              repairDiagnostics,
            );
          }
          let patched;
          try {
            patched = applyRepairPatches(
              basis,
              patches.patches,
              INTENT_TOP_LEVEL_FIELDS,
              INTENT_FORBIDDEN_REPAIR_PATHS,
            );
          } catch (patchError) {
            const detail = patchError instanceof Error ? patchError.message : String(patchError);
            if (invalidPatchRetries >= 1) {
              throw expandRepairError(`展开修复补丁无效（已重试 1 次）：${detail}`, patchError, repairDiagnostics);
            }
            invalidPatchRetries += 1;
            const retryHint = `${repairHint}\n补丁无效：${detail}；请返回合法 JSON Pointer；数组越界时用现有下标或 op:add / '-' 追加`;
            const retryToolRequest = repairRequestForIssue(request, spec, basis, path, retryHint);
            repairRequest =
              outputMode === 'content-json' ? contentJsonRepairRequest(retryToolRequest) : retryToolRequest;
            continue;
          }
          if (patched.applied.length === 0) {
            throw expandRepairError('展开修复补丁没有改变任何 intent 字段。', undefined, repairDiagnostics);
          }
          if (intent === undefined) {
            draft = patched.value;
          } else {
            const reparsed = DesignIntent.safeParse(patched.value);
            if (!reparsed.success) {
              throw expandRepairError(
                `展开修复后仍未通过 DesignIntent：${issueSummary(reparsed.error)}`,
                undefined,
                repairDiagnostics,
              );
            }
            intent = reparsed.data;
          }
          postSchemaPatches += 1;
          expandPatchCount += patched.applied.length;
          patchRepairs.push(...patched.applied);
          for (const patch of patched.applied) {
            emitProgress({ kind: 'patch', stage: 'expand', path: patch.path, op: patch.op });
          }
          generated = {
            ...generated,
            rawResponse: repairOutcome.response,
            usage: sumUsage([generated.usage, ...repairUsages]),
            ...(patchRepairs.length === 0 ? {} : { patchRepairs }),
          };
          break;
        }
      }
    }
    if (resolved === undefined || intent === undefined) throw expandFailure(lastError, true);
  } catch (error) {
    emitProgress({
      kind: 'stage',
      stage: 'expand',
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  emitProgress({ kind: 'stage', stage: 'expand', status: 'done' });

  const allNormalizationWarnings = [...contentJsonEchoes.map(responseFormatEchoWarning), ...normalizationWarnings];
  const warningConflicts = designConflictsFromWarnings([...allNormalizationWarnings, ...resolved.warnings]);
  const datumConflicts =
    resolved.facts.datumConflict === null ? [] : [designConflictFromDatum(resolved.facts.datumConflict)];
  return {
    intent,
    scheme: resolved.scheme,
    facts: resolved.facts,
    warnings: [...narrativeWarnings, ...contentFallbackWarnings, ...allNormalizationWarnings, ...resolved.warnings],
    conflicts: [...warningConflicts, ...datumConflicts],
    normalizationWarnings: allNormalizationWarnings,
    contentFallbacks,
    schemaPatchCount,
    expandPatchCount,
    repairRoundCount: postSchemaPatches,
    usage: generated.usage,
    rawResponse: withoutReasoning(generated.rawResponse),
    ...(generated.patchRepairs === undefined ? {} : { patchRepairs: generated.patchRepairs }),
    stageDiagnostics,
  };
}
