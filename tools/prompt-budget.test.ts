/**
 * v2 首请求预算复核（W11-12 去重后）。
 *
 * 负责：用项目 tokenizer 实测 v2 fixed / craft-small 生产首请求：
 *   system + tools + task + 调用卡 BuildSheet + 确定性 design digest + 固定开销；
 *   目标 ≤19.5k，生产硬上限由 runner 的 FIRST_REQUEST_HARD_CAP_TOKENS（20k）执行。
 *   digest 用 `musts:'reference'`，must 全文只保留在 BuildSheet（机器合同）。
 *   并确认 v1 回滚路径仍传完整 design.md，不经过 digest。
 * 不负责：跑 live、调用模型；只读固定 fixture 与离线 tokenizer。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { loadConfig } from '@pg/config';
import { BuildSpec } from '@pg/interaction/schema';

import { WINDOW_TOOLS } from '../packages/agent/src/facts.ts';
import { resolvePromptVersion, systemPrompt } from '../packages/agent/src/prompt/system.ts';
import { initialContextMessage } from '../packages/agent/src/request-content.ts';
import { estimateFirstRequestTokens, FIRST_REQUEST_HARD_CAP_TOKENS } from '../packages/agent/src/runner.ts';
import { extractTaskBody } from '../packages/agent/src/task-body.ts';
import { toolDefs } from '../packages/agent/src/tools/schemas.ts';
import { buildBuildSheet } from './build-sheet.ts';
import { buildDesignDigest } from './design-digest.ts';
import { loadTokenCounter } from './tokens.ts';

/** 本轮实测目标；硬上限见 FIRST_REQUEST_HARD_CAP_TOKENS。W11-19 补充调用卡语义后实测 19,413。 */
const FIRST_REQUEST_TARGET = 19_500;

function productionPrompt() {
  const spec = BuildSpec.parse(
    JSON.parse(
      readFileSync(new URL('./fixtures/design-conformance-run9/session/build-spec.json', import.meta.url), 'utf8'),
    ) as unknown,
  );
  const sheet = buildBuildSheet(spec);
  assert.ok(sheet.callCards.length > 0, '真实 fixture 应生成施工调用卡，否则预算复核会空转');

  // 生产 fixed / craft-small 的 v2 system；massing 未接线时与 11 工具 profile 配套。
  const system = systemPrompt({
    worldDts: 'declare const x: 1;',
    maxTurns: 60,
    submitWindow: 3,
    windowTools: WINDOW_TOOLS,
    variant: 'craft-small',
    designAuthority: 'fixed',
    promptVersion: 'v2',
    massingEnabled: false,
  });
  return { spec, sheet, system, tools: JSON.stringify(toolDefs(false)) };
}

function run9Design(): string {
  return readFileSync(new URL('./fixtures/design-conformance-run9/session/design.md', import.meta.url), 'utf8');
}

function run9Task(): string {
  return extractTaskBody(
    readFileSync(new URL('./fixtures/design-conformance-run9/session/build-task.md', import.meta.url), 'utf8'),
  ).text;
}

test('v2 fixed 生产首请求：去重后实测 ≤19.5k（生产硬上限 20k）', () => {
  const count = loadTokenCounter().count;
  const { spec, sheet, system, tools } = productionPrompt();
  const task = run9Task();
  const design = run9Design();
  const digest = buildDesignDigest(design, spec, { countTokens: count, musts: 'reference' });
  const context = initialContextMessage(digest, [], {
    hasInitialDraft: false,
    buildSheet: sheet.markdown,
    designAuthority: 'fixed',
  });
  assert.equal(typeof context.content, 'string', '生产 fixed 首请求应为纯文本第三条消息');
  const contextText = context.content as string;

  const parts = {
    system: count(system),
    tools: count(tools),
    task: count(task),
    digest: count(digest),
    buildSheet: count(sheet.markdown),
    context: count(contextText),
    fullDesign: count(design),
  } as const;
  const first = estimateFirstRequestTokens({
    system,
    toolsJson: tools,
    task,
    context: contextText,
    countTokens: count,
  });

  // v2 system 目前 7,266：W11-19 补齐 floorPlate/walls 底部 y、opening 净宽与 frame 语义后
  // 从 7,050 调到 7,300；仍锁“不回退”。
  assert.ok(parts.system <= 7_300, `v2 system ${String(parts.system)} > 7300`);
  assert.ok(contextText.includes('【已确认施工合同（BuildSheet，机器真相）】'));
  assert.ok(contextText.includes(`# 设计摘要：${spec.title}`));
  assert.ok(!contextText.includes('## 用户需求与来源'), 'v2 首请求不应再携带完整 design.md');
  // must 全文只保留在 BuildSheet；digest 不得重复，也不得把 must 语义删掉。
  assert.ok(digest.includes('## 9. Must 摘要（'), 'digest 应保留 must 摘要引用');
  assert.ok(digest.includes('BuildSheet 的「Musts」段'), 'digest 应指向 BuildSheet must 全文');
  for (const must of spec.musts) {
    assert.ok(!digest.includes(must.text), `digest 不应重复 must 全文 ${must.id}`);
    assert.ok(sheet.markdown.includes(must.text), `BuildSheet 必须保留 must 全文 ${must.id}`);
  }
  assert.ok(
    first <= FIRST_REQUEST_TARGET,
    `v2 首请求 ${String(first)} > ${String(FIRST_REQUEST_TARGET)}（system ${String(parts.system)} + tools ${String(parts.tools)} + task ${String(parts.task)} + context ${String(parts.context)} + overhead；digest ${String(parts.digest)}，BuildSheet ${String(parts.buildSheet)}，完整 design ${String(parts.fullDesign)}）`,
  );
  assert.ok(
    first <= FIRST_REQUEST_HARD_CAP_TOKENS,
    `v2 首请求 ${String(first)} > 生产硬上限 ${String(FIRST_REQUEST_HARD_CAP_TOKENS)}`,
  );
  // 下界只防测试退回 1.2k 合成摘要；真实 BuildSheet 的 must 全文 / 调用卡必须仍在。
  assert.ok(first >= 18_000, `v2 首请求只有 ${String(first)}，疑似丢了 BuildSheet must / 调用卡`);
});

test('v1 fixed 回滚路径：仍携带完整 design.md，不经过 digest', () => {
  const count = loadTokenCounter().count;
  const { spec, sheet } = productionPrompt();
  const design = run9Design();
  const digest = buildDesignDigest(design, spec);
  const v1 = initialContextMessage(design, [], {
    hasInitialDraft: false,
    buildSheet: sheet.markdown,
    designAuthority: 'fixed',
  });
  const v2 = initialContextMessage(digest, [], {
    hasInitialDraft: false,
    buildSheet: sheet.markdown,
    designAuthority: 'fixed',
  });
  assert.equal(typeof v1.content, 'string');
  assert.equal(typeof v2.content, 'string');
  const v1Text = v1.content as string;
  const v2Text = v2.content as string;
  assert.ok(v1Text.includes('## 用户需求与来源'));
  assert.ok(v1Text.includes('## 必须项与自由范围'));
  assert.ok(v1Text.includes('严格 10m×8m 单层矩形茶亭'));
  assert.ok(!v1Text.includes('# 设计摘要：'));
  assert.ok(count(v1Text) > count(v2Text), 'v1 完整 design 应比 v2 digest 更长');
  assert.ok(count(v1Text) - count(v2Text) > 3_000, 'v1 与 v2 的 design 段应有明显差异');
});

test('v2 默认/opt-in 状态：默认配置仍是 v1，PG_PROMPT_VERSION=v2 才启用', () => {
  const env = { PG_LLM_BASE_URL: 'https://api.example.com/v1/' } as const;
  const byDefault = loadConfig(env);
  const optedIn = loadConfig({ ...env, PG_PROMPT_VERSION: 'v2' });
  assert.equal(byDefault.promptVersion, 'v1', '当前默认必须仍是 v1');
  assert.equal(optedIn.promptVersion, 'v2', 'PG_PROMPT_VERSION=v2 应进入配置');
  assert.equal(
    resolvePromptVersion({ promptVersion: byDefault.promptVersion, designAuthority: 'fixed', variant: 'craft-small' }),
    'v1',
  );
  assert.equal(
    resolvePromptVersion({ promptVersion: optedIn.promptVersion, designAuthority: 'fixed', variant: 'craft-small' }),
    'v2',
  );
});
