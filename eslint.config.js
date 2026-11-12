/**
 * ESLint 配置：docs/STANDARDS.md 里能机械判定的规则都在这里。
 * 每条自定义限制都写明理由（多数来自 v0.2 的教训），违规时 ESLint 会把理由打印出来。
 *
 * 新增包：在下面的 PACKAGES 里登记一处（层级 + 是否纯函数）。没登记的包会让本配置加载失败。
 */

import { readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * 包登记表：目录名 → 层级与性质。依赖只能指向同层或更低层（docs/DESIGN.md §3）。
 * pure：纯函数层，不做 I/O、不用 Node 内置模块与 Node 全局对象，Node 与浏览器同构。
 * pureFiles：非纯函数包里单独按纯函数规则检查的文件（相对 src/）。约定文件 `x.ts` 对应导出子路径 `@pg/<包>/x`，
 *   纯函数代码可以在运行时 import 这些子路径（docs/BLOCKS-SPEC.md §3.1）。
 */
const PACKAGES = {
  core: { layer: 0, pure: true },
  config: { layer: 0, pure: false },
  blocks: { layer: 1, pure: false, pureFiles: ['registry.ts', 'color.ts', 'capability-catalog.ts', 'block-usages.ts'] },
  analysis: { layer: 1, pure: true },
  geometry: { layer: 1, pure: true },
  modeling: { layer: 1, pure: true },
  design: { layer: 3, pure: true },
  web: { layer: 5, pure: false },
  llm: {
    layer: 2,
    pure: false,
    pureFiles: ['schema.ts', 'sse.ts', 'pricing.ts', 'cost.ts', 'errors.ts', 'mock-sse.ts'],
  },
  store: { layer: 2, pure: false, pureFiles: ['canonical-json.ts', 'events.ts', 'request-codec.ts', 'derive.ts'] },
  sandbox: { layer: 2, pure: false },
  render: {
    layer: 2,
    pure: false,
    pureFiles: [
      'palette.ts',
      'mesh.ts',
      'mesh-parts.ts',
      'model-pack.ts',
      'mc-catalog.ts',
      'camera.ts',
      'scene-buffer.ts',
      'routes.ts',
    ],
  },
  agent: {
    layer: 3,
    pure: false,
    pureFiles: [
      'task-body.ts',
      'gates.ts',
      'massing/tool.ts',
      'tools/schemas.ts',
      'tools/code-edit.ts',
      'tools/submit.ts',
      'tools/check.ts',
      'tools/view.ts',
      'tools/probe.ts',
      'tools/plan.ts',
      'tools/presentation-facts.ts',
      'facts.ts',
      'prompt/system.ts',
      'prompt/build-playbook.ts',
      'prompt/craft-small.ts',
      'prompt/craft.ts',
      'prompt/craft2.ts',
      'prompt/v02hint.ts',
      'prompt/staged.ts',
      'guards/wall.ts',
      'guards/cost.ts',
      'guards/turns.ts',
      'guards/cost-window.ts',
      'guards/context.ts',
      'guards/image.ts',
      'guards/degenerate.ts',
      'guards/stuck.ts',
      'guards/no-tool.ts',
    ],
  },
  interaction: {
    layer: 4,
    pure: false,
    pureFiles: [
      'primitives.ts',
      'requirements.ts',
      'must-ledger.ts',
      'must-links.ts',
      'must-clause.ts',
      'floor-datum.ts',
      'scheme-gate.ts',
      'design-conflict.ts',
      'flush-text.ts',
      'review-evidence.ts',
      'scheme.ts',
      'scheme-validation.ts',
      'review.ts',
      'review-generate.ts',
      'build.ts',
      'schema.ts',
      'report.ts',
      'brief.ts',
      'lint.ts',
      'session.ts',
      'capability.ts',
      'example.ts',
      'example-requirements.ts',
      'prompts.ts',
      'design-intent.ts',
      'design-intent-support.ts',
      'design-intent-draft.ts',
      'design-intent-normalize.ts',
      'design-expand.ts',
      'design-expand-types.ts',
      'design-expand-walls.ts',
      'design-expand-interiors.ts',
      'example-intent.ts',
      'generate-intent.ts',
      'prompts-intent.ts',
      'generate.ts',
      'generate-content.ts',
      'repair.ts',
      'conversation.ts',
      'conversation-intent.ts',
      'conversation-support.ts',
      'conversation-types.ts',
      'conversation-progress.ts',
      'preview-core.ts',
      'preview-plan.ts',
      'preview-plan-draw.ts',
      'preview-axon.ts',
      'preview-axon-geometry.ts',
      'preview-section.ts',
      'preview-materials.ts',
      'preview.ts',
    ],
  },
};

// 登记表必须与 packages/ 实际目录一致，否则新包会悄悄不受任何规则约束。
{
  const root = import.meta.dirname;
  const dirs = readdirSync(join(root, 'packages')).filter((d) => statSync(join(root, 'packages', d)).isDirectory());
  const missing = dirs.filter((d) => !(d in PACKAGES));
  const stale = Object.keys(PACKAGES).filter((d) => !dirs.includes(d));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `eslint.config.js 的 PACKAGES 与 packages/ 不一致。未登记：${missing.join(', ') || '无'}；已不存在：${stale.join(', ') || '无'}`,
    );
  }
}

// 前面的 `/` 锚定到导入路径开头：否则 gitignore 语义下 `events` 会匹配 `@pg/store/events`
// 的末段，把纯函数入口误判成 Node 内置模块（`ignore` 包的 group 匹配规则）。
const NODE_BUILTINS = [...new Set(builtinModules.flatMap((m) => [`/${m}`, `/node:${m}`, `/${m}/*`, `/node:${m}/*`]))];

/** 所有产品代码与工具都禁止的写法。 */
const bannedSyntax = [
  {
    selector: "MemberExpression[object.type='MemberExpression'][object.property.name='Math']",
    message: '禁止经 globalThis 访问 Math：直接用 Math，且随机数用 @pg/core/rng。',
  },
  {
    selector: "MemberExpression[object.type='MemberExpression'][object.property.name='process']",
    message: '禁止经 globalThis 访问 process：只有 @pg/config 可以读环境变量。',
  },
  {
    selector:
      "CallExpression[callee.object.name='Reflect'][callee.property.name='construct'] > Identifier[name='Function']",
    message: '禁止构造 Function：模型代码只能在沙箱进程里执行。',
  },
  {
    selector:
      "Program > VariableDeclaration[kind='let'], Program > ExportNamedDeclaration > VariableDeclaration[kind='let']",
    message: '禁止模块级 let（全局可变状态）：通过参数传递上下文。',
  },
  { selector: 'TSEnumDeclaration', message: '不用 enum（不可擦除语法）：用 as const 对象或字面量联合。' },
];

const bannedProperties = [
  { object: 'Math', property: 'random', message: '禁止 Math.random：体素 hash 要可复现，用 @pg/core/rng。' },
  { object: 'process', property: 'env', message: '只有 @pg/config 可以读 process.env。' },
];

/** 纯函数层额外禁止的全局对象（类型上也有，因为 tsconfig 全局带 node types）。 */
const pureGlobals = ['process', 'Buffer', 'require', 'module', '__dirname', '__filename', 'fetch', 'setImmediate'].map(
  (name) => ({ name, message: `纯函数层不能用 Node / I/O 全局对象 ${name}。` }),
);

// 相对路径是否跨出本包 src：要按文件位置解析路径才能判断，正则做不准（`./../../x`、包内深层 `../../util.ts`），
// 所以放在 tools/check-deps.ts 里用解析后的绝对路径检查。

function layerPatterns(dir) {
  const own = PACKAGES[dir];
  return Object.entries(PACKAGES)
    .filter(([, p]) => p.layer > own.layer)
    .map(([other]) => ({
      group: [`@pg/${other}`, `@pg/${other}/*`],
      message: `@pg/${dir} 位于第 ${own.layer} 层，不能依赖更高层的 @pg/${other}。`,
    }));
}

/**
 * 纯函数代码在运行时不能 import 非纯入口：否则会间接带进 node:fs 等 I/O。只用 `import type` 不受限制。
 * 纯函数包的全部入口、以及其他包 pureFiles 对应的子路径是纯入口。
 */
function impureEntryPatterns() {
  return Object.entries(PACKAGES)
    .filter(([, p]) => !p.pure)
    .map(([other, p]) => {
      const pureEntries = (p.pureFiles ?? []).map((f) => f.replace(/\.ts$/, ''));
      // 用正则而不是 gitignore 式的 group：group 里排除了 `@pg/x` 之后，`!@pg/x/sub` 无法再把子路径放回来。
      const except = pureEntries.length > 0 ? `(?!(?:${pureEntries.join('|')})$)` : '';
      return {
        regex: `^@pg/${other}(?:/${except}.*)?$`,
        allowTypeImports: true,
        message:
          `@pg/${other} 的这个入口不是纯函数，纯函数代码只能 import type。` +
          (pureEntries.length > 0
            ? `运行时可用的纯入口：${pureEntries.map((e) => `@pg/${other}/${e}`).join('、')}。`
            : ''),
      };
    });
}

/**
 * 非纯函数包里的纯函数文件：套纯函数规则，并且包内相对 import 只能指向同样登记在 pureFiles 里的文件，
 * 否则 `./load.ts` 这样的相对引用会把 I/O 间接带进来。
 */
function pureFileConfig(dir, file, pureFiles) {
  const rules = productRules(dir, true);
  const [, options] = rules['@typescript-eslint/no-restricted-imports'];
  // 允许清单要写成「相对当前文件」的 import 写法：pureFiles 里的路径相对 src/，而规则匹配的是导入字符串。
  // 子目录里的纯函数文件互相引用时（如 prompt/system.ts → ./craft.ts），必须按文件所在目录换算；
  // 更深一层（如 facts.ts → ./tools/plan.ts）还要先放行父目录，否则 gitignore 语义不会重新包含文件。
  const fileDir = dirname(file);
  const allowed = [
    ...new Set(
      pureFiles
        .filter((f) => f !== file)
        .flatMap((f) => {
          const rel = relative(fileDir, f).split(sep).join('/');
          const pattern = rel.startsWith('.') ? rel : `./${rel}`;
          // gitignore 语义：先放行子目录，才能放行目录里的文件；同目录 / 上级目录不需要这一步。
          const parents =
            pattern.startsWith('./') && pattern.split('/').length > 2
              ? pattern
                  .split('/')
                  .slice(1, -1)
                  .map((_, i, parts) => `!./${parts.slice(0, i + 1).join('/')}`)
              : [];
          return [...parents, `!${pattern}`];
        }),
    ),
  ];
  options.patterns.push({
    group: ['./*', '../*', ...allowed],
    message: `@pg/${dir}/${file.replace(/\.ts$/, '')} 是纯函数入口，包内只能相对 import 同样登记为纯函数的文件（${pureFiles.join('、')}）。`,
  });
  return { files: [`packages/${dir}/src/${file}`], rules };
}

/** 一个包（或其中的纯函数文件）产品代码的 import、全局对象与语法限制。 */
function productRules(dir, pure) {
  const own = `@pg/${dir}`;
  return {
    'no-restricted-imports': 'off',
    '@typescript-eslint/no-restricted-imports': [
      'error',
      {
        paths: [{ name: 'node:process', message: '只有 @pg/config 可以读环境变量。' }],
        patterns: [
          ...layerPatterns(dir),
          ...(pure
            ? [
                { group: NODE_BUILTINS, message: `${own} 的这部分是纯函数：不做 I/O，不 import Node 内置模块。` },
                // 包内文件之间走相对路径，不经过包名，所以不需要给本包开例外。
                ...impureEntryPatterns(),
              ]
            : []),
        ],
      },
    ],
    ...(pure
      ? {
          'no-restricted-globals': ['error', ...pureGlobals],
          'no-restricted-syntax': [
            'error',
            ...bannedSyntax,
            { selector: 'ImportExpression', message: `${own} 的这部分是纯函数：不用动态 import。` },
          ],
        }
      : {}),
  };
}

const testFiles = ['**/*.test.ts'];

export default tseslint.config(
  {
    // tools/interaction-web 是浏览器原生 ES module / HTML / CSS，不经过 TypeScript project service。
    ignores: [
      'node_modules/',
      '**/node_modules/',
      '.work/',
      '.opencode/',
      'coverage/',
      'assets/',
      'tools/interaction-web/',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },

  // 通用规则：packages 与 tools
  {
    files: ['packages/*/src/**/*.ts', 'tools/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 600, skipBlankLines: false, skipComments: false }],
      'no-restricted-syntax': ['error', ...bannedSyntax],
      'no-restricted-properties': ['error', ...bannedProperties],
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'node:process', message: '只有 @pg/config 可以读环境变量；需要 argv 等请用全局 process。' }],
        },
      ],
      'no-new-func': 'error',
      'no-eval': 'error',
      'no-var': 'error',
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      eqeqeq: ['error', 'always'],
    },
  },

  // 各包：层级边界与纯函数限制。测试文件同样受层级约束，但可以用 node:test 等内置模块。
  // pureFiles 放在包规则之后，同一文件上后出现的配置覆盖前面的。
  ...Object.entries(PACKAGES).flatMap(([dir, meta]) => [
    { files: [`packages/${dir}/src/**/*.ts`], ignores: testFiles, rules: productRules(dir, meta.pure) },
    ...(meta.pureFiles ?? []).map((f) => pureFileConfig(dir, f, meta.pureFiles)),
    {
      files: [`packages/${dir}/src/**/*.test.ts`],
      rules: { 'no-restricted-imports': ['error', { patterns: layerPatterns(dir) }] },
    },
  ]),

  // @pg/config 是唯一允许读 env 的包
  {
    files: ['packages/config/src/config.ts'],
    rules: {
      'no-restricted-properties': ['error', ...bannedProperties.filter((p) => p.object !== 'process')],
      'no-restricted-syntax': ['error', ...bannedSyntax.filter((s) => !s.selector.includes("'process'"))],
    },
  },

  // SANDBOX-SPEC §9：只给这两个文件局部放开规则，并在文件头写明理由（其它文件不放开）。
  {
    // 替换 Math.random、删除全局是它的职责；动态 delete 是删除列表的唯一写法。
    files: ['packages/sandbox/src/child-globals.ts'],
    rules: {
      '@typescript-eslint/no-dynamic-delete': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    // child 需要在写出整帧后调用 process.exit；直接使用全局 process。
    files: ['packages/sandbox/src/child.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },

  {
    // browser.test.ts 用手写假件替代 Chrome：空实现、同步返回 Promise、故意不用的参数都是刻意的。
    files: ['packages/render/src/browser.test.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  // benchmark/ 下的 .ts 是喂给隔离沙箱的模型代码样例：全局 Model / Point2 由 bwrap 预检注入，
  // 不在仓库 tsconfig 的 include 里（根 tsc 会因缺少那些全局而误报）。只做语法级检查，不做类型感知规则。
  {
    files: ['benchmark/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { parserOptions: { projectService: false, project: false } },
  },

  // 测试文件：放宽行数；只放行 node:test 的 describe / it 不 await
  {
    files: testFiles,
    rules: {
      'max-lines': ['error', { max: 800 }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it', 'test', 'suite'] },
          ],
        },
      ],
    },
  },

  // 本文件自身是 JS
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
