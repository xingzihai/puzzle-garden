/* eslint-disable max-lines */
/**
 * 交互 agent 的结构化生成：调用注入的 ChatClient，通过单个 submit 工具取回需求图或方案。
 *
 * 负责：构造 deepseek 请求、单工具 schema、tool_call 参数解析、零厚度几何修复、schema 失败后的 patch 修复、
 * zod 校验、失败分类（拒绝 / 截断 / 无调用 / 多调用 / 非法 JSON / schema 不通过）与可回放返回值。
 * 不负责：真实网络、配置 / 环境变量、提示词内容、文件写入；本文件是纯函数，I/O 全部由调用方注入。
 */
import type { ZodType } from 'zod';
import type { ChatClient, ChatOutcome, CompleteOptions } from '@pg/llm/client';
import type { ChatRequest, ChatResponse, Usage } from '@pg/llm/schema';

import {
  designPrompt,
  requirementsPrompt,
  REQUIREMENTS_TOOL_NAME,
  SCHEME_CORE_TOOL_NAME,
  SCHEME_ENVELOPE_TOOL_NAME,
  SCHEME_INTERIOR_TOOL_NAME,
  SCHEME_STAGE_FIELDS,
  SCHEME_TOOL_NAME,
  schemeStagePrompt,
} from './prompts.ts';
import type { ClarificationExchange, DesignPromptOptions } from './prompts.ts';
import {
  applyRepairPatches,
  issueSummary,
  repairRequestFor,
  requirementReferenceIssues,
  RepairSubmissionSchema,
  REQUIREMENTS_TOP_LEVEL_FIELDS,
  SCHEME_TOP_LEVEL_FIELDS,
  submissionTool,
  sumUsage,
} from './repair.ts';
import type { AppliedPatch, ApplyPatchResult, RepairSubmission, StructuredSubmission } from './repair.ts';
import {
  attachResponseDiagnostics,
  contentJsonArguments,
  contentJsonRepairRequest,
  requestFor,
  responseDiagnostics,
  submissionArguments,
  toolCallArguments,
} from './generate-content.ts';
import type { ResponseFormatEcho } from './generate-content.ts';
import { RequirementGraph } from './requirements.ts';
import type { RequirementGraph as RequirementGraphType } from './requirements.ts';
import {
  DesignScheme,
  DesignSchemeCore,
  DesignSchemeEnvelope,
  DesignSchemeInterior,
  normalizeSchemeBounds,
} from './scheme.ts';
import type { BoundsRepair, DesignScheme as DesignSchemeType, NormalizedSubmission } from './scheme.ts';

/** 方案输出上限：完整 DesignScheme 约 10–30KB，给 tool_call 参数留足余量。 */
export const DEFAULT_SCHEME_MAX_TOKENS = 32_768;
/** 需求图输出上限：最高思考会占用 completion 预算，16k 在真实 brief 上会截断。 */
export const DEFAULT_REQUIREMENTS_MAX_TOKENS = 32_768;

export {
  contentJsonRepairRequest,
  DEFAULT_MAX_TOKENS,
  extractContentJson,
  requestFor,
  requestForContentJson,
  responseDiagnostics,
  thinkingDiagnostic,
} from './generate-content.ts';
export type { ContentJsonSource } from './generate-content.ts';

/** 定点修复工具名；需求图与方案分开，避免模型把两类 schema 混用。 */
export const REPAIR_REQUIREMENTS_TOOL_NAME = 'repair_requirements';
export const REPAIR_SCHEME_TOOL_NAME = 'repair_scheme';

export type GenerationErrorCode =
  | 'invalid-options'
  | 'request-failed'
  | 'aborted'
  | 'truncated'
  | 'model-refusal'
  | 'no-tool-call'
  | 'no-content-json'
  | 'multiple-tool-calls'
  | 'unexpected-tool'
  | 'invalid-json'
  | 'schema-invalid'
  | 'expand-invalid';

/** 结构化提交的输入来源：tool_call 参数，或 message.content 里的 JSON。 */
export type SubmissionOutputMode = 'tool' | 'content-json';

/** 交互层请求的思考档位：max = 当前 provider/schema 允许的最高档；disabled 仅保留既有路径。 */
export type ThinkingPreference = 'max' | 'disabled';

/**
 * 失败诊断。前四项保持既有字段供服务端日志使用；其余字段用于排查 arguments 为空、
 * reasoning 与 usage 去向。原始正文只挂在 GenerationError 上，不进入方案 / artifacts。
 */
export interface GenerationDiagnostics {
  readonly finishReason: ChatResponse['finishReason'];
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly argumentChars: number;
  readonly argumentTruncated: boolean;
  readonly totalTokens?: number;
  readonly promptCacheHitTokens?: number;
  readonly promptCacheMissTokens?: number;
  readonly reasoningTokens?: number;
  readonly usage?: Usage;
  readonly outputMode?: SubmissionOutputMode;
  /** 实际发出的思考配置，例如 `thinking:enabled` / `thinking:disabled` / `reasoning_effort:low`。 */
  readonly thinking?: string;
  readonly contentChars?: number;
  readonly contentTruncated?: boolean;
  readonly reasoningChars?: number;
  readonly reasoningPresent?: boolean;
  readonly rawArguments?: readonly { readonly index: number; readonly text: string }[];
  readonly content?: string;
  readonly reasoningContent?: string;
  /** 首轮提交的诊断；repair 失败时保留原始空 arguments / reasoning 去向。 */
  readonly previous?: GenerationDiagnostics;
}

/** 结构化生成失败；code 用于调用方分类，message 面向日志 / CLI，不静默回退。 */
export class GenerationError extends Error {
  readonly code: GenerationErrorCode;
  readonly diagnostics: GenerationDiagnostics | null;
  /** 失败发生在定点 patch 修复阶段；调用方不应把它当成可静默回退的普通 schema 失败。 */
  readonly repairFailed: boolean;

  constructor(
    code: GenerationErrorCode,
    message: string,
    cause?: unknown,
    diagnostics?: GenerationDiagnostics,
    repairFailed = false,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GenerationError';
    this.code = code;
    this.diagnostics = diagnostics ?? null;
    this.repairFailed = repairFailed;
  }
}

export interface GenerationWarning {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface GenerationResult<T> {
  readonly value: T;
  readonly rawResponse: ChatResponse;
  readonly usage: Usage;
  /** 进入 schema 前做过的确定性几何修复；没有修复时省略。 */
  readonly repairs?: readonly BoundsRepair[];
  /** 本次成功提交实际应用的 JSON Pointer patch；没有 patch 时省略。 */
  readonly patchRepairs?: readonly AppliedPatch[];
  /** 模型返回值被宿主确定性归一化时记录；没有归一化时省略。 */
  readonly warnings?: readonly GenerationWarning[];
}

function mergeWarnings(...groups: readonly (readonly GenerationWarning[] | undefined)[]): GenerationWarning[] {
  const seen = new Set<string>();
  const merged: GenerationWarning[] = [];
  for (const group of groups) {
    for (const warning of group ?? []) {
      const key = JSON.stringify([warning.code, warning.path, warning.message]);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(warning);
    }
  }
  return merged;
}

export interface GenerateOptions {
  /** 只支持价格表里的 deepseek-flash；GPT 需要 owner 另行授权。 */
  readonly model?: 'deepseek-flash';
  readonly maxTokens?: number;
  /** 默认 max：interaction 请求开启 provider 当前允许的最高思考档；build agent 不走这里。 */
  readonly thinking?: ThinkingPreference;
  /** 默认 tool：沿用单工具 submit；content-json：tools: [] + response_format。 */
  readonly outputMode?: SubmissionOutputMode;
  readonly signal?: AbortSignal;
  readonly onDelta?: CompleteOptions['onDelta'];
  readonly beforeRetry?: CompleteOptions['beforeRetry'];
  readonly onAttempt?: CompleteOptions['onAttempt'];
}

export interface ExtractRequirementsInput {
  readonly userText: string;
  readonly existingRequirements?: RequirementGraphType;
  readonly capabilitySummary?: string;
  readonly answers?: readonly ClarificationExchange[];
}

export interface ProposeSchemeOptions extends GenerateOptions, DesignPromptOptions {}

function completeOptions(options: GenerateOptions): CompleteOptions {
  return {
    signal: options.signal ?? new AbortController().signal,
    ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
    beforeRetry: options.beforeRetry ?? (() => 'continue'),
    onAttempt: options.onAttempt ?? (() => undefined),
  };
}

function failureText(outcome: Extract<ChatOutcome, { readonly kind: 'failed' }>): string {
  const failure = outcome.failure;
  return `${failure.class}/${failure.code}${failure.status === null ? '' : ` HTTP ${String(failure.status)}`}：${failure.message}`;
}

function parseSubmissionValue<T>(payload: unknown, toolName: string, schema: ZodType<T>): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new GenerationError('schema-invalid', `${toolName} 参数未通过 schema：${issueSummary(result.error)}`);
  }
  return result.data;
}

/**
 * 解析一个 submit tool_call。所有失败都抛出 GenerationError；
 * 不尝试从正文、多个调用或非法 JSON 中猜一个“最像”的结果。
 */
export function parseToolSubmission<T>(response: ChatResponse, toolName: string, schema: ZodType<T>): T {
  return parseSubmissionValue(toolCallArguments(response, toolName), toolName, schema);
}

/** 解析 content-json 模式的单个正文 JSON；供展开修复等非 completeStructured 路径复用。 */
export function parseContentSubmission<T>(
  response: ChatResponse,
  label: string,
  schema: ZodType<T>,
  onEcho?: (echo: ResponseFormatEcho) => void,
): T {
  return parseSubmissionValue(contentJsonArguments(response, label, onEcho), label, schema);
}

export async function completeOnce(
  client: ChatClient,
  request: ChatRequest,
  options: GenerateOptions,
): Promise<Extract<ChatOutcome, { readonly kind: 'ok' }>> {
  let outcome: ChatOutcome;
  try {
    outcome = await client.complete(request, completeOptions(options));
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    throw new GenerationError(
      'request-failed',
      `模型请求失败：${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  if (outcome.kind === 'failed') {
    throw new GenerationError('request-failed', `模型请求失败：${failureText(outcome)}`);
  }
  if (outcome.kind === 'aborted-by-caller') {
    throw new GenerationError('aborted', '模型请求被调用方取消，未产生可提交结果。');
  }
  return outcome;
}

/**
 * 结构化提交：首次完整提交 → schema 失败时只发一次 repair patch 请求 → 宿主应用 patch 后重新校验。
 * tool 与 content-json 共用同一套 schema / patch 流程；patch 失败直接抛出可读 schema-invalid。
 */
export async function completeStructured<T>(
  client: ChatClient,
  request: ChatRequest,
  spec: StructuredSubmission<T>,
  options: GenerateOptions,
  onContentJsonEcho?: (echo: ResponseFormatEcho) => void,
): Promise<GenerationResult<T>> {
  const outputMode = options.outputMode ?? 'tool';
  if (outputMode === 'content-json') {
    if (request.tools.length !== 0 || request.response_format?.type !== 'json_object')
      throw new GenerationError(
        'invalid-options',
        'content-json 模式必须使用 requestForContentJson（tools: [] + response_format: json_object）。',
      );
  } else if (request.tools.length === 0)
    throw new GenerationError('invalid-options', 'tool 模式需要至少一个 submit 工具。');

  const first = await completeOnce(client, request, options);
  let parsed: unknown;
  try {
    parsed = submissionArguments(first.response, spec.toolName, outputMode, onContentJsonEcho);
  } catch (error) {
    attachResponseDiagnostics(error, first.response, request, outputMode);
  }
  const firstNormalized = spec.normalize?.(parsed);
  const candidate = firstNormalized?.value ?? parsed;
  const firstResult = spec.schema.safeParse(candidate);
  if (firstResult.success) {
    const warnings = mergeWarnings(firstNormalized?.warnings);
    return {
      value: firstResult.data,
      rawResponse: first.response,
      usage: first.response.usage,
      ...(firstNormalized?.repairs.length ? { repairs: firstNormalized.repairs } : {}),
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  }
  const firstDiagnostics = responseDiagnostics(first.response, request, outputMode);

  const toolRepairRequest = repairRequestFor(request, spec, candidate, firstResult.error);
  const repairRequest = outputMode === 'content-json' ? contentJsonRepairRequest(toolRepairRequest) : toolRepairRequest;
  let repairOutcome: Awaited<ReturnType<typeof completeOnce>>;
  try {
    repairOutcome = await completeOnce(client, repairRequest, options);
  } catch (error) {
    if (!(error instanceof GenerationError)) throw error;
    throw new GenerationError(error.code, error.message, error.cause, error.diagnostics ?? undefined, true);
  }
  const repairDiagnostics: GenerationDiagnostics = {
    ...responseDiagnostics(repairOutcome.response, repairRequest, outputMode),
    previous: firstDiagnostics,
  };

  let patches: RepairSubmission;
  try {
    const repairPayload = submissionArguments(
      repairOutcome.response,
      spec.repairToolName,
      outputMode,
      onContentJsonEcho,
    );
    patches = parseSubmissionValue(repairPayload, spec.repairToolName, RepairSubmissionSchema);
  } catch (error) {
    const code = error instanceof GenerationError && error.code === 'truncated' ? 'truncated' : 'schema-invalid';
    throw new GenerationError(
      code,
      `补丁修复调用失败：${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error.cause : error,
      repairDiagnostics,
      true,
    );
  }

  let patched: ApplyPatchResult;
  try {
    patched = applyRepairPatches(candidate, patches.patches, spec.allowedFields, spec.forbiddenPaths ?? []);
  } catch (error) {
    throw new GenerationError(
      'schema-invalid',
      `修复补丁无效：${error instanceof Error ? error.message : String(error)}`,
      error,
      repairDiagnostics,
      true,
    );
  }

  const patchedNormalized = spec.normalize?.(patched.value);
  const finalCandidate = patchedNormalized?.value ?? patched.value;
  const finalResult = spec.schema.safeParse(finalCandidate);
  if (!finalResult.success) {
    throw new GenerationError(
      'schema-invalid',
      `补丁应用后仍未通过 ${spec.label} schema：${issueSummary(finalResult.error)}`,
      undefined,
      repairDiagnostics,
      true,
    );
  }

  const repairs = [...(firstNormalized?.repairs ?? []), ...(patchedNormalized?.repairs ?? [])];
  const warnings = mergeWarnings(firstNormalized?.warnings, patchedNormalized?.warnings);
  return {
    value: finalResult.data,
    rawResponse: repairOutcome.response,
    usage: sumUsage([first.response.usage, repairOutcome.response.usage]),
    ...(repairs.length === 0 ? {} : { repairs }),
    ...(warnings.length === 0 ? {} : { warnings }),
    patchRepairs: patched.applied,
  };
}

/** 需求图的 id / revision 由宿主控制；在 schema 校验前归一化，并留下 warning。 */
export function normalizeRequirementsIdentity(
  value: unknown,
  existing: RequirementGraphType | undefined,
): NormalizedSubmission {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { value, repairs: [] };
  }
  const record = value as Record<string, unknown>;
  const expectedRevision = existing === undefined ? 1 : existing.revision + 1;
  const rawRevision = record['revision'];
  const rawId = record['id'];
  const warnings: GenerationWarning[] = [];
  if (rawRevision !== expectedRevision) {
    warnings.push({
      code: 'requirements-revision-normalized',
      path: 'requirements.revision',
      message:
        existing === undefined
          ? `首次抽取模型返回 revision=${String(rawRevision)}，宿主强制 revision=1。`
          : `模型返回 revision=${String(rawRevision)}，宿主按旧图 ${String(existing.revision)} + 1 归一为 ${String(expectedRevision)}。`,
    });
  }
  if (existing !== undefined && rawId !== existing.id) {
    warnings.push({
      code: 'requirements-id-normalized',
      path: 'requirements.id',
      message: `模型返回 id=${String(rawId)}，宿主沿用旧 id=${existing.id}。`,
    });
  }
  if (warnings.length === 0) return { value, repairs: [] };
  return {
    value: {
      ...record,
      revision: expectedRevision,
      ...(existing === undefined ? {} : { id: existing.id }),
    },
    repairs: [],
    warnings,
  };
}

/** 需求抽取：用户原话 / 已有需求图 / 澄清回答 / 能力卡摘要 → RequirementGraph。 */
export async function extractRequirements(
  client: ChatClient,
  input: ExtractRequirementsInput,
  options: GenerateOptions = {},
): Promise<GenerationResult<RequirementGraphType>> {
  if (input.userText.trim() === '') {
    throw new GenerationError('invalid-options', '需求抽取的 userText 不能为空。');
  }
  const prompt = requirementsPrompt({
    userText: input.userText,
    ...(input.existingRequirements === undefined ? {} : { existingRequirements: input.existingRequirements }),
    ...(input.capabilitySummary === undefined ? {} : { capabilitySummary: input.capabilitySummary }),
    ...(input.answers === undefined ? {} : { answers: input.answers }),
  });
  const tool = submissionTool(
    REQUIREMENTS_TOOL_NAME,
    '提交完整的 RequirementGraph。只在所有歧义、矛盾、缺失与能力限制都标注后调用一次。',
    RequirementGraph,
  );
  const generated = await completeStructured(
    client,
    requestFor(prompt.system, prompt.user, tool, {
      ...options,
      maxTokens: options.maxTokens ?? DEFAULT_REQUIREMENTS_MAX_TOKENS,
    }),
    {
      toolName: REQUIREMENTS_TOOL_NAME,
      repairToolName: REPAIR_REQUIREMENTS_TOOL_NAME,
      label: 'RequirementGraph',
      allowedFields: REQUIREMENTS_TOP_LEVEL_FIELDS,
      schema: RequirementGraph,
      normalize: (value) => normalizeRequirementsIdentity(value, input.existingRequirements),
    },
    options,
  );
  return generated;
}

function validateProposedScheme(
  scheme: DesignSchemeType,
  requirements: RequirementGraphType,
  options: ProposeSchemeOptions,
): void {
  if (
    scheme.meta.sourceRequirements.graphId !== requirements.id ||
    scheme.meta.sourceRequirements.revision !== requirements.revision
  ) {
    throw new GenerationError(
      'schema-invalid',
      `方案 meta.sourceRequirements=${scheme.meta.sourceRequirements.graphId} v${String(scheme.meta.sourceRequirements.revision)}，与需求图 ${requirements.id} v${String(requirements.revision)} 不一致。`,
    );
  }
  if (options.schemeId !== undefined && scheme.meta.id !== options.schemeId) {
    throw new GenerationError('schema-invalid', `方案 id=${scheme.meta.id}，与要求的 ${options.schemeId} 不一致。`);
  }
  if (options.revision !== undefined && scheme.meta.revision !== options.revision) {
    throw new GenerationError(
      'schema-invalid',
      `方案 revision=${String(scheme.meta.revision)}，与要求的 ${String(options.revision)} 不一致。`,
    );
  }
  if (options.previousScheme !== undefined) {
    if (scheme.meta.id !== options.previousScheme.meta.id) {
      throw new GenerationError(
        'schema-invalid',
        `修订方案的 id=${scheme.meta.id} 与上一版 ${options.previousScheme.meta.id} 不一致；定向修订不能换方案。`,
      );
    }
    if (scheme.meta.revision !== options.previousScheme.meta.revision + 1) {
      throw new GenerationError(
        'schema-invalid',
        `修订方案 revision=${String(scheme.meta.revision)}，上一版是 ${String(options.previousScheme.meta.revision)}；必须递增 1。`,
      );
    }
  }
  if (options.scope !== undefined && scheme.meta.scope !== options.scope) {
    throw new GenerationError('schema-invalid', `方案范围=${scheme.meta.scope}，与要求的 ${options.scope} 不一致。`);
  }
  const referenceIssues = requirementReferenceIssues(scheme, requirements);
  const firstReferenceIssue = referenceIssues[0];
  if (firstReferenceIssue !== undefined) {
    throw new GenerationError('schema-invalid', firstReferenceIssue);
  }
}

/**
 * 分阶段方案生成：core → envelope → interior，合并后再跑完整 DesignScheme 校验。
 * 单次完整提交在真实模型上经常只输出前几个字段；分阶段缩小每次输出与 schema 体积。
 */
export async function proposeSchemeStaged(
  client: ChatClient,
  requirements: RequirementGraphType,
  options: ProposeSchemeOptions = {},
): Promise<GenerationResult<DesignSchemeType>> {
  const stageMaxTokens = options.maxTokens ?? DEFAULT_SCHEME_MAX_TOKENS;
  const corePrompt = schemeStagePrompt('core', { requirements }, options);
  const core = await completeStructured(
    client,
    requestFor(
      corePrompt.system,
      corePrompt.user,
      submissionTool(
        SCHEME_CORE_TOOL_NAME,
        '提交方案核心字段：meta / site / levels / spaces / budget / forbidden。',
        DesignSchemeCore,
      ),
      { ...options, maxTokens: stageMaxTokens },
    ),
    {
      toolName: SCHEME_CORE_TOOL_NAME,
      repairToolName: REPAIR_SCHEME_TOOL_NAME,
      label: 'submit_scheme_core',
      allowedFields: SCHEME_STAGE_FIELDS.core,
      schema: DesignSchemeCore,
      normalize: normalizeSchemeBounds,
    },
    options,
  );
  const envelopePrompt = schemeStagePrompt('envelope', { requirements, core: core.value }, options);
  const envelope = await completeStructured(
    client,
    requestFor(
      envelopePrompt.system,
      envelopePrompt.user,
      submissionTool(
        SCHEME_ENVELOPE_TOOL_NAME,
        '提交建筑构件层：elements / openings / circulation / structure / roof / facades / materials。',
        DesignSchemeEnvelope,
      ),
      { ...options, maxTokens: stageMaxTokens },
    ),
    {
      toolName: SCHEME_ENVELOPE_TOOL_NAME,
      repairToolName: REPAIR_SCHEME_TOOL_NAME,
      label: 'submit_scheme_envelope',
      allowedFields: SCHEME_STAGE_FIELDS.envelope,
      schema: DesignSchemeEnvelope,
      normalize: normalizeSchemeBounds,
    },
    options,
  );
  const interiorPrompt = schemeStagePrompt(
    'interior',
    { requirements, core: core.value, envelope: envelope.value },
    options,
  );
  const interior = await completeStructured(
    client,
    requestFor(
      interiorPrompt.system,
      interiorPrompt.user,
      submissionTool(
        SCHEME_INTERIOR_TOOL_NAME,
        '提交细部与室内层：details / interiors / decisions / open。',
        DesignSchemeInterior,
      ),
      { ...options, maxTokens: stageMaxTokens },
    ),
    {
      toolName: SCHEME_INTERIOR_TOOL_NAME,
      repairToolName: REPAIR_SCHEME_TOOL_NAME,
      label: 'submit_scheme_interior',
      allowedFields: SCHEME_STAGE_FIELDS.interior,
      schema: DesignSchemeInterior,
      normalize: normalizeSchemeBounds,
    },
    options,
  );

  const merged = { ...core.value, ...envelope.value, ...interior.value };
  const parsed = DesignScheme.safeParse(merged);
  if (!parsed.success) {
    throw new GenerationError(
      'schema-invalid',
      `分阶段方案合并后未通过 DesignScheme：${issueSummary(parsed.error)}`,
      undefined,
      {
        finishReason: interior.rawResponse.finishReason,
        promptTokens: sumUsage([core.usage, envelope.usage, interior.usage]).prompt_tokens,
        completionTokens: sumUsage([core.usage, envelope.usage, interior.usage]).completion_tokens,
        argumentChars:
          (core.rawResponse.message.tool_calls ?? []).reduce((n, call) => n + call.function.arguments.length, 0) +
          (envelope.rawResponse.message.tool_calls ?? []).reduce((n, call) => n + call.function.arguments.length, 0) +
          (interior.rawResponse.message.tool_calls ?? []).reduce((n, call) => n + call.function.arguments.length, 0),
        argumentTruncated:
          core.rawResponse.finishReason === 'length' ||
          envelope.rawResponse.finishReason === 'length' ||
          interior.rawResponse.finishReason === 'length',
      },
    );
  }
  const scheme = parsed.data;
  validateProposedScheme(scheme, requirements, options);
  const repairs = [...(core.repairs ?? []), ...(envelope.repairs ?? []), ...(interior.repairs ?? [])];
  const patchRepairs = [
    ...(core.patchRepairs ?? []),
    ...(envelope.patchRepairs ?? []),
    ...(interior.patchRepairs ?? []),
  ];
  return {
    value: scheme,
    rawResponse: interior.rawResponse,
    usage: sumUsage([core.usage, envelope.usage, interior.usage]),
    ...(repairs.length === 0 ? {} : { repairs }),
    ...(patchRepairs.length === 0 ? {} : { patchRepairs }),
  };
}

/** 方案设计：先单次完整提交并尝试 patch 修复；只有截断 / 非法 JSON 才切到分阶段生成。 */
export async function proposeScheme(
  client: ChatClient,
  requirements: RequirementGraphType,
  options: ProposeSchemeOptions = {},
): Promise<GenerationResult<DesignSchemeType>> {
  const prompt = designPrompt(requirements, options);
  const tool = submissionTool(
    SCHEME_TOOL_NAME,
    '提交完整的 DesignScheme。必须包含场地、楼层、空间、构件、门窗、交通、结构、屋面、立面、材质、细部、室内、决策、未决、预算与禁项。',
    DesignScheme,
  );
  let result: GenerationResult<DesignSchemeType>;
  try {
    result = await completeStructured(
      client,
      requestFor(prompt.system, prompt.user, tool, {
        ...options,
        maxTokens: options.maxTokens ?? DEFAULT_SCHEME_MAX_TOKENS,
      }),
      {
        toolName: SCHEME_TOOL_NAME,
        repairToolName: REPAIR_SCHEME_TOOL_NAME,
        label: 'DesignScheme',
        allowedFields: SCHEME_TOP_LEVEL_FIELDS,
        schema: DesignScheme,
        normalize: normalizeSchemeBounds,
      },
      options,
    );
  } catch (error) {
    if (error instanceof GenerationError && error.repairFailed) throw error;
    if (
      !(error instanceof GenerationError) ||
      (error.code !== 'schema-invalid' && error.code !== 'truncated' && error.code !== 'invalid-json')
    ) {
      throw error;
    }
    return proposeSchemeStaged(client, requirements, options);
  }
  validateProposedScheme(result.value, requirements, options);
  return result;
}
