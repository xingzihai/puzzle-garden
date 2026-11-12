/**
 * 草模工具的 zod 参数定义与生成的 JSON Schema（AGENT-TARGET.md）。
 *
 * 负责：6 个草模工具的参数 schema、给模型看的 JSON Schema（去掉 `$schema` 键，C19）与完整工具定义数组。
 * 不负责：执行工具（modeling-tools/session.ts）、拼 ChatRequest（runner）、system 提示（modeling-target.ts）。
 * 本文件只依赖 zod 与 agent 内的纯 schema；工具名与描述会进 `versions.tools`，改动要重测。
 */

import type { ToolDef } from '@pg/llm/schema';
import { z } from 'zod';

import { MAX_EDITS, MAX_SUBMIT_NOTE } from '../tools/schemas.ts';

/** 草模工具名的唯一来源：system 提示、分发、测试都从这里取。 */
export const MODEL_TOOL_NAMES = [
  'write_code',
  'read_code',
  'edit_code',
  'run_model',
  'view_model',
  'submit_model',
] as const;
export type ModelToolName = (typeof MODEL_TOOL_NAMES)[number];

export const WriteCodeArgs = z.strictObject({
  code: z.string(),
});

export const ReadCodeArgs = z.strictObject({
  from: z.int().min(1).optional(),
  to: z.int().min(1).optional(),
});

export const EditCodeArgs = z.strictObject({
  edits: z
    .array(
      z.strictObject({
        find: z.string(),
        replace: z.string(),
      }),
    )
    .min(1)
    .max(MAX_EDITS),
});

export const RunModelArgs = z.strictObject({});

export const ViewModelArgs = z.strictObject({});

export const SubmitModelArgs = z.strictObject({
  note: z.string().max(MAX_SUBMIT_NOTE),
});

/** 工具名 → 参数 schema；runner 解析 tool_call 参数时用。 */
export const MODEL_TOOL_ARGS = {
  write_code: WriteCodeArgs,
  read_code: ReadCodeArgs,
  edit_code: EditCodeArgs,
  run_model: RunModelArgs,
  view_model: ViewModelArgs,
  submit_model: SubmitModelArgs,
} as const satisfies Record<ModelToolName, z.ZodType>;

/** 与工具一一对应的描述；改动即改变 `versions.tools`。 */
const DESCRIPTIONS: Record<ModelToolName, string> = {
  write_code: '整份写入当前 TypeScript 建模代码（第一版，或推倒重来）。',
  read_code: '带行号读当前代码；缺省全文，一次最多 400 行。',
  edit_code: '局部修改当前代码：每条 find 必须在当前稿里恰好出现 1 次（逐字匹配），任一条失败则全部不生效。',
  run_model: '对当前代码做类型预检并隔离执行，校验后记录模型文档；成功版本才可看图或提交。',
  view_model:
    '渲染最近一次执行成功的模型文档，图附在本轮末尾；提交前必须对当前版本成功看过图。本运行未配置渲染器时明确说明没有看图。',
  submit_model:
    '提交当前成功版本；当前版本需已成功 view_model，且代码 hash 与文档 hash 必须匹配当前稿，接受后固定快照并写完整交付。',
};

/** 去掉 `$schema` 键后的 JSON Schema（C19）。 */
export function parametersOf(name: ModelToolName): Record<string, unknown> {
  const json = z.toJSONSchema(MODEL_TOOL_ARGS[name]) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

function definitionOf(name: ModelToolName): ToolDef {
  return { type: 'function', function: { name, description: DESCRIPTIONS[name], parameters: parametersOf(name) } };
}

/** 6 个草模工具的完整定义，顺序固定；runner 直接放进 ChatRequest.tools（上限 12）。 */
export const MODEL_TOOL_DEFS: readonly ToolDef[] = MODEL_TOOL_NAMES.map(definitionOf);

/** 名称是否属于草模工具（避免把 `TOOL_NAMES` 的体素工具误当草模工具）。 */
export function isModelToolName(name: string): name is ModelToolName {
  return (MODEL_TOOL_NAMES as readonly string[]).includes(name);
}
