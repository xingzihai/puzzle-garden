/**
 * 依赖检查（docs/STANDARDS.md §2、§6）：
 *
 * 1. 每个 workspace 包的产品代码 import 的外部包，都必须在它自己的 package.json 的 dependencies 里声明。
 *    npm workspaces 会把依赖提升到根 node_modules，没声明也能解析，层级规则与"依赖只加在用到它的包里"
 *    就会被悄悄绕过。测试文件可以用根 devDependencies（如 fast-check）。
 * 2. 相对路径不能跨出本包目录：跨包必须走包名。需要按文件位置解析路径才能判断，所以放在这里而不是 ESLint。
 * 3. 根与各包的依赖版本必须是精确版本（不带 ^ ~ > < * x 等范围）。
 *
 * 用法：node tools/check-deps.ts
 */

import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { z } from 'zod';

const DepMap = z.record(z.string(), z.string());
const PackageJson = z.object({
  name: z.string(),
  dependencies: DepMap.optional(),
  devDependencies: DepMap.optional(),
  peerDependencies: DepMap.optional(),
  optionalDependencies: DepMap.optional(),
});

export interface DepProblem {
  readonly file: string;
  readonly specifier: string;
  readonly message: string;
}

/** 把 import 说明符归约为包名：`@pg/core/rng` → `@pg/core`，`zod/mini` → `zod`。 */
export function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return name === undefined || name === '' ? null : name;
}

/** 取出一个源文件里全部静态与动态 import 的说明符。 */
export function importsOf(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 相对或绝对路径解析后是否落在 `pkgDir` 之外。 */
export function escapesPackage(specifier: string, fromFile: string, pkgDir: string): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return false;
  const target = resolve(dirname(fromFile), specifier);
  const base = pkgDir.endsWith(sep) ? pkgDir : pkgDir + sep;
  return !(target + sep).startsWith(base);
}

export interface PackageSources {
  readonly name: string;
  readonly dir: string;
  readonly declared: ReadonlySet<string>;
  readonly sources: readonly { readonly file: string; readonly text: string; readonly isTest: boolean }[];
}

/** 检查一个包的 import：未声明的外部包、跨出本包的相对路径。 */
export function checkPackage(pkg: PackageSources): DepProblem[] {
  const problems: DepProblem[] = [];
  for (const { file, text, isTest } of pkg.sources) {
    for (const specifier of importsOf(text, file)) {
      if (escapesPackage(specifier, file, pkg.dir)) {
        problems.push({ file, specifier, message: `相对路径跨出了 ${pkg.name}：跨包引用必须走包名（@pg/xxx）` });
        continue;
      }
      if (isTest) continue;
      const name = packageNameOf(specifier);
      if (name === null || name === pkg.name || pkg.declared.has(name)) continue;
      problems.push({
        file,
        specifier,
        message: `${pkg.name} 使用了 ${name}，但没有在 package.json 的 dependencies 里声明`,
      });
    }
  }
  return problems;
}

const RANGE = /[\^~<>*|]|\s|^x$|\.x(?:\.|$)|^latest$/i;

/** 依赖版本必须精确；workspace 内部包允许 `*`（npm workspaces 的惯例写法）。 */
export function checkExactVersions(file: string, deps: Readonly<Record<string, string>>): DepProblem[] {
  const problems: DepProblem[] = [];
  for (const [name, version] of Object.entries(deps)) {
    if (name.startsWith('@pg/')) continue;
    if (RANGE.test(version)) {
      problems.push({ file, specifier: name, message: `${name} 的版本 "${version}" 不是精确版本` });
    }
  }
  return problems;
}

function listSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSources(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function readPackageJson(path: string): z.infer<typeof PackageJson> {
  return PackageJson.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const problems: DepProblem[] = [];

  const rootPkg = readPackageJson(join(root, 'package.json'));
  for (const field of ['dependencies', 'devDependencies'] as const) {
    problems.push(...checkExactVersions('package.json', rootPkg[field] ?? {}));
  }

  const packagesDir = join(root, 'packages');
  for (const dir of readdirSync(packagesDir).sort()) {
    const pkgDir = join(packagesDir, dir);
    const manifest = join(pkgDir, 'package.json');
    if (!statSync(pkgDir).isDirectory()) continue;
    if (!existsSync(manifest)) {
      problems.push({ file: relative(root, pkgDir), specifier: '', message: '缺少 package.json' });
      continue;
    }
    const pkg = readPackageJson(manifest);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      problems.push(...checkExactVersions(relative(root, manifest), pkg[field] ?? {}));
    }
    problems.push(
      ...checkPackage({
        name: pkg.name,
        dir: pkgDir,
        declared: new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]),
        sources: listSources(join(pkgDir, 'src')).map((file) => ({
          file,
          text: readFileSync(file, 'utf8'),
          isTest: file.endsWith('.test.ts'),
        })),
      }),
    );
  }

  for (const p of problems) {
    console.error(`${relative(root, p.file) || p.file}  ${p.specifier === '' ? '' : `'${p.specifier}'：`}${p.message}`);
  }
  if (problems.length > 0) {
    console.error(`\n依赖检查未通过：${String(problems.length)} 处`);
    process.exitCode = 1;
  } else {
    console.log('依赖检查通过');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
