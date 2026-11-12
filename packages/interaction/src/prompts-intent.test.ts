import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileBuildBrief, lintBrief } from './brief.ts';
import { expandDesignIntent } from './design-expand.ts';
import { DesignIntent } from './design-intent.ts';
import { DesignIntentDraft } from './design-intent-draft.ts';
import { normalizeDesignIntent } from './design-intent-normalize.ts';
import { exampleIntent } from './example-intent.ts';
import { exampleRequirements } from './example-requirements.ts';
import { createIntentHost } from './generate-intent.ts';
import { buildMustLedger } from './must-ledger.ts';
import { renderPreviewBundle } from './preview.ts';
import { RequirementGraph } from './requirements.ts';
import {
  compactRequirementsForIntent,
  INTENT_DRAFT_SCHEMA_TEXT,
  INTENT_EXAMPLE,
  INTENT_FIELDS,
  INTENT_MATERIAL_PALETTE,
  INTENT_SYSTEM,
  INTENT_TOOL_NAME,
  intentPrompt,
} from './prompts-intent.ts';

test('intent 提示词：12 字段契约、完整示例、无旧对象名或冲突词', () => {
  const prompt = intentPrompt(exampleRequirements(), {
    schemeId: 'scheme-tea',
    revision: 1,
    maxBlocks: 20_000,
    maxCostCny: 100_000,
    scope: 'exterior+interior',
  });
  assert.equal(INTENT_TOOL_NAME, 'submit_intent');
  assert.equal(INTENT_FIELDS.length, 12);
  assert.deepEqual(Object.keys(INTENT_EXAMPLE).sort(), [...INTENT_FIELDS].sort());
  assert.match(prompt.system, /12 个顶层字段/);
  assert.match(prompt.system, /宿主会注入/);
  assert.match(prompt.system, /确定性展开/);
  assert.match(prompt.system, /完整最小 DesignIntent JSON 示例/);
  assert.ok(prompt.system.includes(JSON.stringify(INTENT_EXAMPLE, null, 2)));
  for (const field of INTENT_FIELDS) assert.match(prompt.system, new RegExp(field));
  assert.match(prompt.system, /Rect2/);
  assert.match(prompt.system, /"role": "entrance"/);
  assert.match(prompt.system, /"role": "structure"/);
  assert.match(prompt.system, /"kind": "center"/);
  assert.match(prompt.system, /"kind": "wall"/);
  assert.match(prompt.system, /"kind": "corner"/);
  assert.match(prompt.system, /局部 id 必须写/);
  assert.match(prompt.system, /共享边不要写 exterior/);
  assert.equal(prompt.system.includes(INTENT_DRAFT_SCHEMA_TEXT), false);

  const all = `${prompt.system}\n${prompt.user}`;
  for (const banned of ['DesignScheme', 'hostRoomId', '17 个顶层字段', 'slabThickness', '完整室内', '提交前自查']) {
    assert.equal(all.includes(banned), false, `prompt 不应包含 ${banned}`);
  }
  assert.doesNotMatch(prompt.system, /不要写\s*(notes|id)/);
  assert.doesNotMatch(prompt.user, /"requirements":\s*\[/);
  assert.doesNotMatch(prompt.user, /"ambiguities":\s*\[/);
  assert.match(prompt.user, /不要写进 DesignIntent/);
  assert.match(prompt.user, /方块预算上限：20000/);
  assert.match(prompt.user, /meta\.scope 必须写这个值/);
});

test('content-json 输出格式明确要求不调用工具、只输出单个 JSON', () => {
  const prompt = intentPrompt(exampleRequirements(), {
    schemeId: 'scheme-tea',
    revision: 1,
    maxBlocks: 20_000,
    outputFormat: 'content-json',
  });
  assert.match(prompt.user, /JSON-only content 模式/);
  assert.match(prompt.user, /不要调用任何工具/);
  assert.match(prompt.user, /只输出 DesignIntent JSON 本体/);
  assert.match(prompt.user, /不要包含 type \/ response_format \/ tool_call \/ arguments/);
  assert.doesNotMatch(prompt.user, /只调用一次 submit_intent/);
  assert.match(prompt.user, /12 个字段/);
  assert.ok(prompt.system.includes(INTENT_DRAFT_SCHEMA_TEXT));
  assert.match(prompt.system, /"program"/);
  assert.match(prompt.system, /"additionalProperties":false/);
  assert.match(prompt.system, /完整 JSON Schema/);
});

test('compactRequirementsForIntent 生成紧凑 brief，不 dump 完整 RequirementGraph', () => {
  const brief = compactRequirementsForIntent(exampleRequirements(), [
    { question: '预算和风格有什么要求？', answer: '克制一点，木石为主。' },
  ]);
  assert.match(brief, /## 用户声音（1–3 句）/);
  const voiceLines = brief.split('\n').filter((line) => line.startsWith('- 用户原话') || line.startsWith('- 确认回答'));
  assert.ok(voiceLines.length >= 1 && voiceLines.length <= 3);
  assert.match(brief, /## 必须（2 条，全部全文；不得只按 id 推断）/);
  assert.match(brief, /must \[req-use\]/);
  assert.match(brief, /forbidden \[reqc-forbid\]/);
  assert.match(brief, /budget \[reqc-budget\]/);
  assert.match(brief, /## 场地/);
  assert.match(brief, /24 × 20 格/);
  assert.match(brief, /entrance\.side=north/);
  assert.match(brief, /## 需求空间/);
  assert.match(brief, /\| reqsp-tea \| 喝茶区 \| room \| 48 \| f1 \| reqsp-counter \| required \|/);
  assert.match(brief, /## 可用材质/);
  const materialLines = brief.split('\n').filter((line) => line.startsWith('- m-'));
  assert.equal(materialLines.length, INTENT_MATERIAL_PALETTE.length);
  assert.equal(INTENT_MATERIAL_PALETTE.length, 12);
  assert.match(brief, /## 可引用 id/);
  assert.match(brief, /req: req-use/);
  assert.match(brief, /con: reqc-budget/);
  assert.doesNotMatch(brief, /"requirements":/);
  assert.doesNotMatch(brief, /"ambiguities":/);
  assert.ok(brief.length < 4_000);
  assert.equal(INTENT_SYSTEM.includes('"requirements": ['), false);
});

test('提示词中的完整示例通过 Draft / strict / expand / BuildBrief / lint / preview', () => {
  const requirements = exampleRequirements();
  const draft = DesignIntentDraft.parse(INTENT_EXAMPLE);
  assert.equal(draft.program.levels.length, 1);
  const strict = DesignIntent.parse(INTENT_EXAMPLE);
  assert.equal(strict.openings[0]?.role, 'entrance');
  assert.equal(strict.materials[0]?.role, 'structure');
  assert.equal(strict.furniture[1]?.anchor.kind, 'wall');
  assert.equal(strict.furniture[2]?.anchor.kind, 'corner');

  const normalized = normalizeDesignIntent(INTENT_EXAMPLE);
  assert.deepEqual(normalized.warnings, []);
  const resolved = expandDesignIntent(
    normalized.intent,
    createIntentHost(requirements, { schemeId: 'scheme-example', revision: 1 }),
  );
  assert.equal(resolved.scheme.meta.id, 'scheme-example');
  assert.equal(resolved.facts.counts.rooms, 1);
  assert.equal(resolved.facts.counts.openings, 2);
  assert.equal(resolved.facts.counts.furniture, 4);

  const brief = compileBuildBrief(resolved.scheme, requirements);
  assert.deepEqual(lintBrief(brief, requirements), []);
  assert.ok(renderPreviewBundle(resolved.scheme).files.length >= 5);
});

test('previousIntent + feedback 进入定向修订段，要求保留未点名区域', () => {
  const prompt = intentPrompt(exampleRequirements(), {
    schemeId: 'scheme-tea',
    revision: 2,
    maxBlocks: 20_000,
    previousIntent: exampleIntent(),
    feedback: '南侧屋檐再深一点，其他保持原样。',
  });
  assert.match(prompt.user, /修订任务（定向修改，不是重新设计）/);
  assert.match(prompt.user, /南侧屋檐再深一点/);
  assert.match(prompt.user, /未点名区域/);
  assert.match(prompt.user, /"title": "稻田茶亭"/);
});

const RUN7_REQUIREMENTS = RequirementGraph.parse(
  JSON.parse(readFileSync(new URL('../fixtures/run7-requirements.json', import.meta.url), 'utf8')),
);

function normalizedText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

test('run-7：31 条 must 全部全文进入 intent prompt，且没有 id-only 截断', () => {
  const prompt = intentPrompt(RUN7_REQUIREMENTS, {
    schemeId: 'scheme-run7',
    revision: 1,
    maxBlocks: 20_000,
    scope: 'exterior+interior',
  });
  const user = prompt.user;
  const ledger = buildMustLedger(RUN7_REQUIREMENTS);
  const musts = RUN7_REQUIREMENTS.requirements.filter(
    (requirement) => requirement.priority === 'must' && requirement.status !== 'rejected',
  );

  assert.equal(ledger.counts.total, 41);
  assert.ok(user.length <= 12_000, `intent user prompt ${String(user.length)} chars > 12000`);

  for (const requirement of musts) {
    assert.ok(
      user.includes(normalizedText(requirement.text)),
      `must 全文未进入 prompt：${requirement.id} / ${requirement.text}`,
    );
  }
  for (const entry of ledger.entries) {
    assert.ok(user.includes(`[${entry.sourceId}]`), `must id 未进入 prompt：${entry.sourceId}`);
    assert.ok(user.includes(normalizedText(entry.text)), `ledger 全文未进入 prompt：${entry.sourceId} / ${entry.text}`);
  }

  assert.match(user, /必须（31 条，全部全文；不得只按 id 推断）/);
  assert.ok(user.includes('4m 长、2m 宽'), 'run-7 长桌 4m×2m 要求缺失');
  assert.ok(user.includes('4m 长、1m 宽'), 'run-7 长凳 4m×1m 要求缺失');
  assert.ok(user.includes('各 5 座'), 'run-7 5+5 座位要求缺失');
  assert.ok(user.includes('西墙中段'), 'run-7 柜台西墙中段要求缺失');
  assert.equal(user.includes('其余 must 只保留 id'), false);
  assert.equal(
    user.split('\n').some((line) => /^-\s*must\s*\[[^\]]+\]\s*$/.test(line)),
    false,
    'prompt 不应出现只有 id 的 must 行',
  );
});
