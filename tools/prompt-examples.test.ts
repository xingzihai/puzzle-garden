/**
 * 提示词可执行代码块预检门禁（Wave 11 W11-01 / W11-06a）。
 *
 * 负责：从 `packages/agent/src/prompt/v2/` 下的 `.ts` 文件、`build-playbook.ts` 导出的
 *   `V2_PRECHECK_EXAMPLES`（v2 语法卡）与显式标记 `@precheck` 的示例文件里抽出 ```ts 代码块，
 *   用真实 `world.d.ts` + `createPrechecker` 包裹后预检；`text` 代码块不参与。
 * 不负责：v1 提示词迁移。v1 的 `BUILD_PLAYBOOK_SECTION` 仍使用未导出的 `Bounds` 类型，
 *   按 Wave 11 文件所有权留给 W11-02 处理；这里只扫描已能通过预检的 v1 craft 范例，
 *   并在下方显式列出 legacy 例外，避免把已知债务静默变成门禁噪音。
 * 边界：只做离线类型预检，不执行代码、不联网、不依赖 bwrap。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPrechecker } from '@pg/sandbox/precheck';

import { V2_PRECHECK_EXAMPLES, V2_PRECHECK_PRELUDE } from '../packages/agent/src/prompt/build-playbook.ts';
import { CRAFT_EXAMPLES } from '../packages/agent/src/prompt/craft.ts';
import { CRAFT_SMALL_EXAMPLES } from '../packages/agent/src/prompt/craft-small.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const V2_DIR = join(ROOT, 'packages/agent/src/prompt/v2');
const EXPLICIT_DIR = join(ROOT, 'tools/fixtures/prompt-precheck');
const MARKER = '@precheck';
const TS_FENCE = /```ts[ \t]*\r?\n([\s\S]*?)```/g;
const declaration = readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');

interface ExampleSource {
  readonly name: string;
  readonly text: string;
}

/** 从 markdown / 模板字符串源码里取出 ```ts 代码块正文；```text 等其他围栏不匹配。 */
function tsBlocks(markdown: string): string[] {
  return [...markdown.matchAll(TS_FENCE)].map((match) => match[1] ?? '');
}

/** 模板字符串源码里的反引号与 `${` 都带反斜杠；还原后才能识别代码围栏。 */
function decodeTemplateSource(source: string): string {
  return source.replaceAll('\\`', '`').replaceAll('\\${', '${');
}

function filesUnder(dir: string, predicate: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((entry) => join(dir, entry))
    .filter(predicate)
    .sort();
}

/** v2 提示词模块：测试文件里可能有故意写坏的反例，不纳入生产提示词门禁。 */
function v2Sources(): ExampleSource[] {
  return filesUnder(V2_DIR, (file) => file.endsWith('.ts') && !file.endsWith('.test.ts')).map((file) => ({
    name: relative(ROOT, file),
    text: decodeTemplateSource(readFileSync(file, 'utf8')),
  }));
}

/** 显式 `@precheck` 示例：文件可以混放 ```text 骨架，只有 ```ts 块会被预检。 */
function explicitSources(): ExampleSource[] {
  return filesUnder(EXPLICIT_DIR, (file) => file.endsWith('.md'))
    .filter((file) => readFileSync(file, 'utf8').includes(MARKER))
    .map((file) => ({ name: relative(ROOT, file), text: readFileSync(file, 'utf8') }));
}

/**
 * v1 legacy 正向样例：只列已经能通过预检的 craft / craft-small 范例。
 * 明确例外：`BUILD_PLAYBOOK_SECTION` 的茶亭骨架把未导出的 `Bounds` 写进函数签名，
 * 属 W11-02 要迁移的已知 legacy 债务；本门禁不扫描它，也不把它当作通过。
 */
const LEGACY_V1_EXAMPLES: readonly ExampleSource[] = [
  { name: 'packages/agent/src/prompt/craft.ts#CRAFT_EXAMPLES', text: CRAFT_EXAMPLES },
  { name: 'packages/agent/src/prompt/craft-small.ts#CRAFT_SMALL_EXAMPLES', text: CRAFT_SMALL_EXAMPLES },
];

/** 示例片段是顶层辅助函数；补一个空 build 入口，满足预检的模块形态。 */
function wrapForPrecheck(blocks: readonly string[]): string {
  return `${blocks.join('\n')}\nexport default function build(w: World): void {\n  void w;\n}\n`;
}

/** v2 语法卡假定在 build(w) 内执行；prelude 提供占位符，块本身放进入口函数。 */
function wrapV2ForPrecheck(block: string): string {
  return `${V2_PRECHECK_PRELUDE}\nexport default function build(w: World): void {\n${block}\n}\n`;
}

function failureText(result: Awaited<ReturnType<ReturnType<typeof createPrechecker>['check']>>): string {
  if (result.kind !== 'failed') return result.kind;
  return result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`).join(' | ');
}

test('v2 提示词与 @precheck 示例的 ts 代码块都通过 world.d.ts 预检', async () => {
  const v2 = v2Sources();
  const explicit = explicitSources();
  const v2Blocks = v2.flatMap((source) => tsBlocks(source.text));
  const explicitBlocks = explicit.flatMap((source) => tsBlocks(source.text));
  assert.ok(explicitBlocks.length > 0, '至少应有一个显式 @precheck 的 ts 示例，门禁不能空转');
  assert.ok(V2_PRECHECK_EXAMPLES.length > 0, 'v2 build-playbook 应导出至少一个预检块，门禁不能空转');
  if (existsSync(V2_DIR)) assert.ok(v2Blocks.length > 0, 'v2 目录存在，但没有任何 ts 代码块可预检');

  const prechecker = createPrechecker(declaration);
  try {
    for (const source of [...v2, ...explicit, ...LEGACY_V1_EXAMPLES]) {
      for (const [index, block] of tsBlocks(source.text).entries()) {
        const result = await prechecker.check(wrapForPrecheck([block]));
        assert.equal(result.kind, 'ok', `${source.name} 第 ${String(index + 1)} 个 ts 块: ${failureText(result)}`);
      }
    }
    // v2 语法卡是片段：每张单独加中性占位符 prelude，避免不同卡片的同名 const 互相冲突。
    for (const [index, block] of V2_PRECHECK_EXAMPLES.entries()) {
      const result = await prechecker.check(wrapV2ForPrecheck(block));
      assert.equal(result.kind, 'ok', `build-playbook v2 第 ${String(index + 1)} 张语法卡: ${failureText(result)}`);
    }
  } finally {
    await prechecker.close();
  }
});

test('v2 预检只覆盖 build-playbook 的语法卡，不扫描 v1 的 Bounds legacy 段', () => {
  assert.equal(V2_PRECHECK_EXAMPLES.length, 6, 'v2 应有 6 张构件语法卡');
  for (const block of V2_PRECHECK_EXAMPLES) {
    assert.ok(!block.includes('Bounds'), 'v2 预检块不应包含未导出的 Bounds');
  }
  assert.ok(!V2_PRECHECK_PRELUDE.includes('Bounds'), '预检 prelude 不应伪造 Bounds 类型');
  // W11-07：prelude 是提示词里可见的同一份卡片约定，不是测试私藏的注入。
  assert.ok(V2_PRECHECK_PRELUDE.includes('export default function build(w: World)'), 'prelude 应说明 build(w: World)');
});

test('text / tsx 代码块不参与预检', () => {
  const markdown = [
    '```ts',
    'const valid = 1;',
    '```',
    '```text',
    'const invalid: Bounds = null as never;',
    '```',
    '```tsx',
    'const alsoIgnored: Bounds = null as never;',
    '```',
  ].join('\n');
  assert.deepEqual(tsBlocks(markdown), ['const valid = 1;\n']);
});

test('门禁有牙齿：故意写 Bounds 的 ts 代码块必须预检失败', async () => {
  const badBlock = 'function assertCellBounds(actual: Bounds): void {\n  void actual;\n}\n';
  const prechecker = createPrechecker(declaration);
  try {
    // 即使加上 v2 的中性 prelude，也不允许把 Bounds 伪装成已定义类型。
    const result = await prechecker.check(wrapV2ForPrecheck(badBlock));
    if (result.kind !== 'failed') assert.fail(`预期预检失败，实际 ${result.kind}`);
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === 'TS2304' && diagnostic.message.includes("'Bounds'")),
      `没有抓住 Bounds：${failureText(result)}`,
    );
  } finally {
    await prechecker.close();
  }
});
