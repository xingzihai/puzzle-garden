import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkExactVersions, checkPackage, escapesPackage, importsOf, packageNameOf } from './check-deps.ts';

describe('packageNameOf', () => {
  it('归约子路径与作用域包', () => {
    assert.equal(packageNameOf('@pg/core/rng'), '@pg/core');
    assert.equal(packageNameOf('zod'), 'zod');
    assert.equal(packageNameOf('zod/mini'), 'zod');
  });

  it('相对路径与 Node 内置模块不算外部包', () => {
    assert.equal(packageNameOf('./a.ts'), null);
    assert.equal(packageNameOf('node:fs'), null);
    assert.equal(packageNameOf('fs'), null);
  });
});

describe('importsOf', () => {
  it('收集静态 import、re-export 与动态 import，忽略字符串里的字样', () => {
    const src = [
      "import { a } from '@pg/core/rng';",
      "import type { B } from 'zod';",
      "export { c } from 'three';",
      "const m = await import('puppeteer-core');",
      'const s = \'import x from "fake"\';',
    ].join('\n');
    assert.deepEqual(importsOf(src, 'x.ts'), ['@pg/core/rng', 'zod', 'three', 'puppeteer-core']);
  });
});

describe('escapesPackage', () => {
  const pkg = '/repo/packages/a';
  const file = '/repo/packages/a/src/deep/x.ts';

  it('包内相对路径（含深层目录回退）不算跨包', () => {
    assert.equal(escapesPackage('./y.ts', file, pkg), false);
    assert.equal(escapesPackage('../util.ts', file, pkg), false);
    assert.equal(escapesPackage('../../package.json', file, pkg), false);
  });

  it('各种写法跨出本包都能识别', () => {
    assert.equal(escapesPackage('../../../b/src/x.ts', file, pkg), true);
    assert.equal(escapesPackage('./../../../b/src/x.ts', file, pkg), true);
    assert.equal(escapesPackage('..//..//..//b/x.ts', file, pkg), true);
    assert.equal(escapesPackage('/repo/packages/b/src/x.ts', file, pkg), true);
    assert.equal(escapesPackage('../../../a-other/x.ts', file, pkg), true, '同名前缀的兄弟目录');
  });

  it('包名与内置模块不算相对路径', () => {
    assert.equal(escapesPackage('@pg/b', file, pkg), false);
    assert.equal(escapesPackage('node:fs', file, pkg), false);
  });
});

describe('checkPackage', () => {
  const base = { name: '@pg/a', dir: '/repo/packages/a' };
  const src = (text: string, isTest = false) => [{ file: '/repo/packages/a/src/x.ts', text, isTest }];

  it('声明过的依赖、自身、内置模块都通过', () => {
    const problems = checkPackage({
      ...base,
      declared: new Set(['zod', '@pg/core']),
      sources: src("import 'zod';\nimport '@pg/core/rng';\nimport '@pg/a/y';\nimport 'node:fs';"),
    });
    assert.deepEqual(problems, []);
  });

  it('未声明的依赖报错（包括类型 import）', () => {
    const problems = checkPackage({
      ...base,
      declared: new Set(),
      sources: src("import type { X } from '@pg/core';\nimport 'zod';"),
    });
    assert.deepEqual(
      problems.map((p) => p.specifier),
      ['@pg/core', 'zod'],
    );
  });

  it('测试文件可以用未声明的依赖，但仍不能相对路径跨包', () => {
    const problems = checkPackage({
      ...base,
      declared: new Set(),
      sources: src("import fc from 'fast-check';\nimport '../../b/src/x.ts';", true),
    });
    assert.deepEqual(
      problems.map((p) => p.specifier),
      ['../../b/src/x.ts'],
    );
  });
});

describe('checkExactVersions', () => {
  it('精确版本通过，workspace 内部包的 * 通过', () => {
    assert.deepEqual(checkExactVersions('p', { zod: '4.6.5', '@pg/core': '*' }), []);
  });

  it('范围版本报错', () => {
    const bad = { a: '^1.0.0', b: '~1.0.0', c: '>=1', d: '*', e: '1.x', f: 'latest', g: '1 - 2' };
    assert.deepEqual(
      checkExactVersions('p', bad).map((p) => p.specifier),
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    );
  });
});
