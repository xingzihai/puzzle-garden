/**
 * 结构化提交的定点修复：JSON Pointer patch 的 schema、校验、应用与 repair 请求构造。
 *
 * 负责：限制 patch 数量 / 路径 / 允许字段，深拷贝后按 replace / add / remove 应用；
 * 把失败对象与 zod issue 组装成只返回 patch 的 repair 请求。
 * 不负责：调用模型、schema 本身、需求 / 方案的跨集合校验；本文件是纯函数。
 */
import { ChatRequest } from '@pg/llm/schema';
import type { ChatResponse, ToolDef, Usage } from '@pg/llm/schema';
import { z } from 'zod';

import type { GenerationDiagnostics } from './generate.ts';
import type { RequirementGraph } from './requirements.ts';
import type { DesignScheme, NormalizedSubmission } from './scheme.ts';

export const MAX_PATCHES = 20;
/** repair 也保留 thinking；8192 在真实茶亭里被 thinking 8,157 + 正文 76 截断。 */
export const REPAIR_MAX_TOKENS = 32_768;
export const REPAIR_MIN_MAX_TOKENS = 16_384;

export const REQUIREMENTS_TOP_LEVEL_FIELDS = [
  'id',
  'revision',
  'summary',
  'requirements',
  'spaces',
  'site',
  'constraints',
  'preferences',
  'ambiguities',
  'conflicts',
  'missing',
  'capabilities',
  'decisions',
] as const;

export const SCHEME_TOP_LEVEL_FIELDS = [
  'meta',
  'site',
  'levels',
  'spaces',
  'elements',
  'openings',
  'circulation',
  'structure',
  'roof',
  'facades',
  'materials',
  'details',
  'interiors',
  'decisions',
  'open',
  'budget',
  'forbidden',
] as const;

export const INTENT_TOP_LEVEL_FIELDS = [
  'meta',
  'site',
  'program',
  'envelope',
  'openings',
  'structure',
  'roof',
  'facades',
  'materials',
  'furniture',
  'decisions',
  'open',
] as const;

/** 只提交 JSON Pointer patch，不重写完整对象。 */
export interface StructuredSubmission<T> {
  readonly toolName: string;
  readonly repairToolName: string;
  readonly label: string;
  readonly allowedFields: readonly string[];
  readonly schema: z.ZodType<T>;
  readonly normalize?: (value: unknown) => NormalizedSubmission;
  /** 禁止整段替换的 JSON Pointer；修复必须定位到具体子字段。 */
  readonly forbiddenPaths?: readonly string[];
}

export interface AppliedPatch {
  readonly path: string;
  readonly op: 'replace' | 'add' | 'remove';
}

export interface ApplyPatchResult {
  readonly value: unknown;
  readonly applied: readonly AppliedPatch[];
}

function withoutSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

export function submissionTool(name: string, description: string, schema: z.ZodType): ToolDef {
  return {
    type: 'function',
    function: { name, description, parameters: withoutSchema(schema) },
  };
}

export function issueSummary(error: z.ZodError): string {
  const issues = error.issues.slice(0, 12);
  const lines = issues.map((issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`);
  const hidden = error.issues.length - issues.length;
  return hidden > 0 ? `${lines.join('；')}；另有 ${String(hidden)} 条问题` : lines.join('；');
}

/** 解码 JSON Pointer；拒绝根路径、空段与 `..`，避免 patch 越界或指向不可控位置。 */
function pointerSegments(path: string): readonly string[] | null {
  if (!path.startsWith('/') || path.length <= 1) return null;
  const raw = path.slice(1).split('/');
  const decoded: string[] = [];
  for (const segment of raw) {
    if (segment === '' || segment === '..' || /~(?![01])/.test(segment)) return null;
    const decodedSegment = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (decodedSegment === '__proto__' || decodedSegment === 'constructor' || decodedSegment === 'prototype') {
      return null;
    }
    decoded.push(decodedSegment);
  }
  return decoded;
}

function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function pathToPointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return `/${path.map((token) => escapePointerToken(String(token))).join('/')}`;
}

const RepairOpSchema = z.enum(['replace', 'add', 'remove']);
const JsonPointer = z
  .string()
  .min(2)
  .max(512)
  .refine((path) => pointerSegments(path) !== null, 'path 必须是合法 JSON Pointer：以 / 开头、非根、无 ..');

const RepairPatchSchema = z
  .strictObject({
    path: JsonPointer,
    op: RepairOpSchema.optional(),
    value: z.unknown().optional(),
  })
  .superRefine((patch, ctx) => {
    if (patch.op !== 'remove' && patch.value === undefined) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'replace / add 必须提供 value' });
    }
  });

export const RepairSubmissionSchema = z
  .strictObject({
    patches: z.array(RepairPatchSchema).min(1).max(MAX_PATCHES).readonly(),
  })
  .readonly();
/** 输入类型允许省略 op（默认 replace）；解析后的输出类型会补齐。 */
export type RepairPatch = z.input<typeof RepairPatchSchema>;
export type RepairSubmission = z.output<typeof RepairSubmissionSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArrayIndex(token: string, length: number, allowEnd: boolean): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(token)) return null;
  const index = Number(token);
  if (!Number.isSafeInteger(index)) return null;
  return index <= length && (allowEnd || index < length) ? index : null;
}

function childAt(container: unknown, token: string, path: string): unknown {
  if (Array.isArray(container)) {
    const index = parseArrayIndex(token, container.length, false);
    if (index === null) throw new Error(`补丁路径 ${path} 的数组下标 ${token} 无效`);
    return container[index];
  }
  if (isRecord(container)) {
    if (!Object.hasOwn(container, token)) throw new Error(`补丁路径 ${path} 不存在：${token}`);
    return container[token];
  }
  throw new Error(`补丁路径 ${path} 经过了非对象 / 数组值`);
}

function parentOf(document: unknown, segments: readonly string[], path: string): unknown {
  let parent = document;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const token = segments[index];
    if (token === undefined) throw new Error(`补丁路径 ${path} 缺少段`);
    parent = childAt(parent, token, path);
  }
  return parent;
}

function resolveOp(document: unknown, segments: readonly string[], patch: RepairPatch): AppliedPatch['op'] {
  if (patch.op !== undefined) return patch.op;
  const parent = parentOf(document, segments, patch.path);
  const last = segments[segments.length - 1];
  if (last === undefined) throw new Error(`补丁路径 ${patch.path} 缺少末段`);
  if (Array.isArray(parent)) {
    if (last === '-') return 'add';
    const index = parseArrayIndex(last, parent.length, true);
    if (index === null) throw new Error(`补丁路径 ${patch.path} 的数组下标 ${last} 无效`);
    return index < parent.length ? 'replace' : 'add';
  }
  if (isRecord(parent)) return Object.hasOwn(parent, last) ? 'replace' : 'add';
  throw new Error(`补丁路径 ${patch.path} 的父级不是对象 / 数组`);
}

function applyOnePatch(
  document: unknown,
  segments: readonly string[],
  patch: RepairPatch,
  op: AppliedPatch['op'],
): void {
  let parent = document;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const token = segments[index];
    if (token === undefined) throw new Error(`补丁路径 ${patch.path} 缺少段`);
    parent = childAt(parent, token, patch.path);
  }
  const last = segments[segments.length - 1];
  if (last === undefined) throw new Error(`补丁路径 ${patch.path} 缺少末段`);

  if (Array.isArray(parent)) {
    if (op === 'add') {
      if (last === '-') {
        parent.push(patch.value);
        return;
      }
      const index = parseArrayIndex(last, parent.length, true);
      if (index === null) throw new Error(`补丁路径 ${patch.path} 的数组下标 ${last} 无效`);
      parent.splice(index, 0, patch.value);
      return;
    }
    const index = parseArrayIndex(last, parent.length, false);
    if (index === null) throw new Error(`补丁路径 ${patch.path} 的数组下标 ${last} 无效`);
    if (op === 'remove') parent.splice(index, 1);
    else parent[index] = patch.value;
    return;
  }

  if (isRecord(parent)) {
    if (op === 'add') {
      parent[last] = patch.value;
      return;
    }
    if (!Object.hasOwn(parent, last)) throw new Error(`补丁路径 ${patch.path} 不存在：${last}`);
    if (op === 'remove') Reflect.deleteProperty(parent, last);
    else parent[last] = patch.value;
    return;
  }

  throw new Error(`补丁路径 ${patch.path} 的父级不是对象 / 数组`);
}

/**
 * 按 JSON Pointer 应用 patch：深拷贝失败对象，替换 / 新增 / 删除，只允许修改 allowedFields 顶层字段。
 * patch 为空、无实际变化、越界或路径不存在都抛出可读错误，不静默跳过。
 */
export function applyRepairPatches(
  payload: unknown,
  patches: readonly RepairPatch[],
  allowedFields: readonly string[],
  forbiddenPaths: readonly string[] = [],
): ApplyPatchResult {
  if (patches.length === 0) throw new Error('补丁为空：patches 至少需要一条');
  const allowed = new Set(allowedFields);
  const forbidden = new Set(forbiddenPaths);
  const document = structuredClone(payload);
  const applied: AppliedPatch[] = [];
  const serialize = (value: unknown): string => JSON.stringify(value);

  for (const patch of patches) {
    if (patch.op !== 'remove' && patch.value === undefined) {
      throw new Error(`补丁 ${patch.path} 的 replace / add 缺少 value`);
    }
    const segments = pointerSegments(patch.path);
    if (segments === null) throw new Error(`补丁路径不是合法 JSON Pointer：${patch.path}`);
    const top = segments[0];
    if (top === undefined) throw new Error(`补丁路径不能是根：${patch.path}`);
    if (!allowed.has(top)) {
      throw new Error(`补丁路径 ${patch.path} 的顶层字段 ${top} 不属于本次允许字段：${allowedFields.join(' / ')}`);
    }
    if (forbidden.has(patch.path)) {
      throw new Error(`补丁路径 ${patch.path} 禁止整段替换；请定位到具体子字段`);
    }

    const op = resolveOp(document, segments, patch);
    const before = serialize(document);
    applyOnePatch(document, segments, patch, op);
    if (serialize(document) !== before) applied.push({ path: patch.path, op });
  }

  if (applied.length === 0 || serialize(document) === serialize(payload)) {
    throw new Error('补丁没有改变任何字段');
  }
  return { value: document, applied };
}

function issueFeedback(error: z.ZodError): string {
  const issues = error.issues.slice(0, 30);
  const lines = issues.map((issue) => `${pathToPointer(issue.path)}: ${issue.message}`);
  const hidden = error.issues.length - issues.length;
  return hidden > 0 ? `${lines.join('\n')}\n- 另有 ${String(hidden)} 条问题` : lines.join('\n');
}

function repairUserPrompt<T>(spec: StructuredSubmission<T>, candidate: unknown, issues: string): string {
  const json = JSON.stringify(candidate, null, 2);
  const forbidden =
    spec.forbiddenPaths === undefined || spec.forbiddenPaths.length === 0
      ? ''
      : `\n- 禁止整段替换：${spec.forbiddenPaths.join('、')}；必须定位到具体子字段。`;
  return `## 上一次提交（已做宿主确定性几何修复，仍未通过校验）
\`\`\`json
${json}
\`\`\`

## 校验问题
${issues}

## 允许修改的顶层字段
${spec.allowedFields.join(' / ')}

## 只返回 patch
- 只调用一次 ${spec.repairToolName}，参数形如 {"patches":[...]}；不要重写完整对象。
- path 使用 JSON Pointer（如 /site/outdoorZones/0/bounds）；必须 / 开头、非根、不能含 ..；最多 ${String(MAX_PATCHES)} 条。
- 修改或新增用 {"path":"...","value":...}（op 省略时字段存在则 replace、缺失则 add；数组可用 op:"add" 配 "-" 追加）；删除用 {"path":"...","op":"remove"}。
- 只能改上面允许的字段；不要删除未点名的字段，不要猜 id，不要用空数组掩盖缺失内容。${forbidden}
- 无法用 patch 修正时也不要提交完整对象；宿主会对无效 patch 直接报错。`;
}

function repairRequestWithIssues<T>(
  request: ChatRequest,
  spec: StructuredSubmission<T>,
  candidate: unknown,
  issues: string,
): ChatRequest {
  const first = request.messages[0];
  const originalSystem = first?.role === 'system' ? first.content : '';
  const system = `${originalSystem}\n\n【定点修复 / ${spec.label}】上一次提交未通过校验。无论上文是否要求完整提交，本次只返回 patch，不要重写完整对象；只能修改允许的顶层字段。`;
  const tool = submissionTool(
    spec.repairToolName,
    `只提交 ${spec.label} 的 JSON Pointer patch，不重写完整对象；允许字段：${spec.allowedFields.join(' / ')}。`,
    RepairSubmissionSchema,
  );
  return ChatRequest.parse({
    ...request,
    messages: [
      { role: 'system', content: system },
      ...request.messages.slice(1),
      { role: 'user', content: repairUserPrompt(spec, candidate, issues) },
    ],
    tools: [tool],
    max_tokens: Math.max(REPAIR_MIN_MAX_TOKENS, Math.min(request.max_tokens ?? REPAIR_MAX_TOKENS, REPAIR_MAX_TOKENS)),
  });
}

export function repairRequestFor<T>(
  request: ChatRequest,
  spec: StructuredSubmission<T>,
  candidate: unknown,
  error: z.ZodError,
): ChatRequest {
  return repairRequestWithIssues(request, spec, candidate, issueFeedback(error));
}

/** 展开失败等非 zod 错误：用 path + message 组装同样的定点修复请求。 */
export function repairRequestForIssue<T>(
  request: ChatRequest,
  spec: StructuredSubmission<T>,
  candidate: unknown,
  path: readonly PropertyKey[],
  message: string,
): ChatRequest {
  return repairRequestWithIssues(request, spec, candidate, `${pathToPointer(path)}: ${message}`);
}

export function sumUsage(usages: readonly Usage[]): Usage {
  const sum = (key: 'prompt_tokens' | 'completion_tokens' | 'total_tokens'): number =>
    usages.reduce((total, usage) => total + usage[key], 0);
  const hit = usages.every((usage) => usage.prompt_cache_hit_tokens !== undefined)
    ? usages.reduce((total, usage) => total + (usage.prompt_cache_hit_tokens ?? 0), 0)
    : undefined;
  const miss = usages.every((usage) => usage.prompt_cache_miss_tokens !== undefined)
    ? usages.reduce((total, usage) => total + (usage.prompt_cache_miss_tokens ?? 0), 0)
    : undefined;
  return {
    prompt_tokens: sum('prompt_tokens'),
    completion_tokens: sum('completion_tokens'),
    total_tokens: sum('total_tokens'),
    ...(hit === undefined ? {} : { prompt_cache_hit_tokens: hit }),
    ...(miss === undefined ? {} : { prompt_cache_miss_tokens: miss }),
  };
}

/** 方案的 requirementIds 只能落在需求图的 req / con / cap 上。 */
export function requirementReferenceIssues(scheme: DesignScheme, requirements: RequirementGraph): readonly string[] {
  const known = new Set([
    ...requirements.requirements.map((item) => item.id),
    ...requirements.constraints.map((item) => item.id),
    ...requirements.capabilities.map((item) => item.id),
  ]);
  const issues: string[] = [];
  for (const [index, detail] of scheme.details.entries()) {
    detail.requirementIds.forEach((reference, refIndex) => {
      if (!known.has(reference)) {
        issues.push(
          `details.${String(index)}.requirementIds.${String(refIndex)}: 细部 ${detail.id} 引用了不存在的 id ${reference}（只允许 requirements / constraints / capabilities）`,
        );
      }
    });
  }
  for (const [index, decision] of scheme.decisions.entries()) {
    decision.requirementIds.forEach((reference, refIndex) => {
      if (!known.has(reference)) {
        issues.push(
          `decisions.${String(index)}.requirementIds.${String(refIndex)}: 决策 ${decision.id} 引用了不存在的 id ${reference}（只允许 requirements / constraints / capabilities）`,
        );
      }
    });
  }
  return issues;
}

export function diagnosticsOf(response: ChatResponse): GenerationDiagnostics {
  return {
    finishReason: response.finishReason,
    promptTokens: response.usage.prompt_tokens,
    completionTokens: response.usage.completion_tokens,
    argumentChars: (response.message.tool_calls ?? []).reduce(
      (total, call) => total + call.function.arguments.length,
      0,
    ),
    argumentTruncated: response.finishReason === 'length',
  };
}
