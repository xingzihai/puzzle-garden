/**
 * 测试配对检查：`packages/` 下每个产品源文件都必须有同名的 `*.test.ts`。
 *
 * 为什么需要：Node 的覆盖率只统计被测试 import 过的文件，一个完全没有测试的新文件
 * 不会出现在覆盖率报告里，覆盖率门禁就拦不住它（2026-09-29 实测）。
 *
 * 例外：`*.bench.ts`、`*.d.ts`、只有类型声明的文件，以及只含 `export … from` 的 `index.ts`
 * （一旦出现运行时语句就必须有测试，防止把逻辑藏进这些文件躲检查）。
 * 用法：node tools/check-tests.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/** 文件是否只由 `export … from '…'` 与 `export type … from '…'` 组成（允许注释与空行）。 */
export function isPureReexport(source: string): boolean {
  const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return sf.statements.every((s) => ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined);
}

/** 文件是否只含类型：interface、type 别名、`import type`、`export type … from`（没有运行时代码可测）。 */
export function isTypeOnly(source: string): boolean {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return sf.statements.every(
    (s) =>
      ts.isInterfaceDeclaration(s) ||
      ts.isTypeAliasDeclaration(s) ||
      (ts.isImportDeclaration(s) && s.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) ||
      (ts.isExportDeclaration(s) && s.isTypeOnly),
  );
}

/**
 * 由集成测试覆盖、不要求同名单元测试的入口：
 * - `packages/render/src/page/main.ts`：离不开画布与 WebGL（RENDER-SPEC §3.2），由 `render.integration.test.ts` 覆盖。
 * - `packages/web/src/page/main.ts`：草模 DOM/WebGL 入口，由 `viewer.integration.test.ts` 覆盖。
 * - `packages/agent/src/cli-deps.ts`：只做真实 I/O 组装（prechecker / Chrome / 文件），单元测试会牵进 Chrome，
 *   由 `run.integration.test.ts` 覆盖。参数解析已拆到可单测的 `cli-args.ts`。
 * 这是 STANDARDS §8 列出的例外。
 */
export const COVERED_BY_INTEGRATION =
  /(?:^|\/)(?:packages\/(?:render|web)\/src\/page\/main|packages\/web\/src\/page\/mesh-viewer|packages\/agent\/src\/cli-deps)\.ts$/;

/** 返回缺少配对测试的源文件。`exists`、`read` 注入便于测试。 */
export function missingTests(
  files: readonly string[],
  exists: (path: string) => boolean,
  read: (path: string) => string,
): string[] {
  return files
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.bench.ts') && !f.endsWith('.d.ts'))
    .filter((f) => !COVERED_BY_INTEGRATION.test(f))
    .filter((f) => !(/(?:^|\/)index\.ts$/.test(f) && isPureReexport(read(f))))
    .filter((f) => !isTypeOnly(read(f)))
    .filter((f) => !exists(f.replace(/\.ts$/, '.test.ts')));
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const packagesDir = join(root, 'packages');
  const files = readdirSync(packagesDir)
    .sort()
    .filter((pkg) => statSync(join(packagesDir, pkg)).isDirectory())
    .flatMap((pkg) => listFiles(join(packagesDir, pkg, 'src')));
  const missing = missingTests(files, existsSync, (p) => readFileSync(p, 'utf8'));
  for (const f of missing) {
    const rel = relative(root, f);
    console.error(`${rel}：缺少 ${rel.replace(/\.ts$/, '.test.ts')}`);
  }
  if (missing.length > 0) {
    console.error(`\n测试配对检查未通过：${String(missing.length)} 个源文件没有测试`);
    process.exitCode = 1;
  } else {
    console.log('测试配对检查通过');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
