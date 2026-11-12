/** 会话层的 intent 设计适配：构造宿主上下文并调用 proposeIntent。 */
import type { ChatClient } from '@pg/llm/client';

import type { DesignConflict } from './design-conflict.ts';
import type { DesignIntent } from './design-intent.ts';
import type { DesignFacts, DesignWarning } from './design-expand.ts';
import type { SubmissionOutputMode } from './generate.ts';
import { createIntentHost, proposeIntent } from './generate-intent.ts';
import type { IntentStageDiagnostic, InteractionProgressCallback } from './generate-intent.ts';
import type { ClarificationExchange } from './prompts.ts';
import type { RequirementGraph } from './requirements.ts';
import type { DesignScheme, SchemeScope } from './scheme.ts';

export interface GenerateIntentDesignInput {
  readonly client: ChatClient;
  readonly requirements: RequirementGraph;
  readonly revision: number;
  readonly schemeId?: string;
  readonly scope?: SchemeScope;
  readonly maxBlocks?: number;
  readonly maxCostCny?: number | null;
  readonly exchanges: readonly ClarificationExchange[];
  readonly previousScheme?: DesignScheme;
  readonly previousIntent?: DesignIntent;
  readonly feedback?: string;
  readonly say?: (text: string) => void;
  /** 默认由宿主决定；网页 live 用 content-json，mock 可继续 tool。 */
  readonly outputMode?: SubmissionOutputMode;
  /** 仅即时展示；thinking / content 不进入返回结果。 */
  readonly onProgress?: InteractionProgressCallback;
}

export interface GenerateIntentDesignResult {
  readonly scheme: DesignScheme;
  readonly intent: DesignIntent;
  readonly facts: DesignFacts;
  readonly warnings: readonly DesignWarning[];
  readonly conflicts: readonly DesignConflict[];
  readonly stageDiagnostics: readonly IntentStageDiagnostic[];
}

/** 生成 intent 并展开为 scheme；修订时把上一版 intent 交给提示词做定向修改。 */
export async function generateIntentDesign(input: GenerateIntentDesignInput): Promise<GenerateIntentDesignResult> {
  if (input.previousScheme !== undefined && input.previousIntent === undefined) {
    input.say?.('上一版会话没有保存 DesignIntent；本次按当前需求重新生成，定向保留能力受限。');
  }
  const schemeId = input.schemeId ?? input.previousScheme?.meta.id ?? 'scheme-draft';
  const scope = input.scope ?? input.previousScheme?.meta.scope ?? 'exterior+interior';
  const host = createIntentHost(input.requirements, {
    schemeId,
    revision: input.revision,
    maxBlocks: input.maxBlocks ?? 20_000,
    maxCostCny: input.maxCostCny ?? null,
    floorThickness: 1,
  });
  const result = await proposeIntent(input.client, input.requirements, host, {
    scope,
    answers: input.exchanges,
    ...(input.previousIntent === undefined ? {} : { previousIntent: input.previousIntent }),
    ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
    ...(input.outputMode === undefined ? {} : { outputMode: input.outputMode }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });
  return {
    scheme: result.scheme,
    intent: result.intent,
    facts: result.facts,
    warnings: result.warnings,
    conflicts: result.conflicts,
    stageDiagnostics: result.stageDiagnostics,
  };
}
