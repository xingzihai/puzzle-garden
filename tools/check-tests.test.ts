import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isPureReexport, isTypeOnly, missingTests } from './check-tests.ts';

describe('isPureReexport', () => {
  it('只有 export … from 时为真', () => {
    assert.equal(isPureReexport("// 入口\nexport { a } from './a.ts';\nexport type { B } from './b.ts';\n"), true);
    assert.equal(isPureReexport("export * from './a.ts';\n"), true);
    assert.equal(isPureReexport(''), true);
  });

  it('含其他语句时为假', () => {
    assert.equal(isPureReexport("export { a } from './a.ts';\nexport const x = 1;\n"), false);
    assert.equal(isPureReexport("import { a } from './a.ts';\nexport { a };\n"), false);
    assert.equal(isPureReexport('export function f(): void {}\n'), false);
  });
});

describe('isTypeOnly', () => {
  it('只有类型声明时为真', () => {
    assert.equal(
      isTypeOnly("import type { A } from './a.ts';\nexport interface B { x: A }\nexport type C = B;\n"),
      true,
    );
  });

  it('有运行时代码时为假', () => {
    assert.equal(isTypeOnly('export interface B { x: number }\nexport const y = 1;\n'), false);
    assert.equal(isTypeOnly("import { a } from './a.ts';\nexport type C = typeof a;\n"), false);
  });
});

describe('missingTests', () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);
  const reexport = () => "export * from './a.ts';\n";

  it('有同名测试的源文件通过', () => {
    assert.deepEqual(missingTests(['p/src/a.ts', 'p/src/a.test.ts'], has('p/src/a.test.ts'), reexport), []);
  });

  it('没有测试的源文件报出', () => {
    assert.deepEqual(missingTests(['p/src/a.ts', 'p/src/b.ts'], has('p/src/a.test.ts'), reexport), ['p/src/b.ts']);
  });

  it('基准、声明文件、非 ts 文件、纯转出的 index.ts 不要求测试', () => {
    assert.deepEqual(
      missingTests(['p/src/index.ts', 'p/src/x.bench.ts', 'p/src/w.d.ts', 'p/src/data.json'], has(), reexport),
      [],
    );
  });

  it('只有类型的文件不要求测试', () => {
    assert.deepEqual(
      missingTests(['p/src/t.ts'], has(), () => 'export interface T { x: number }\n'),
      [],
    );
  });

  it('index.ts 含逻辑时要求测试', () => {
    assert.deepEqual(
      missingTests(['p/src/index.ts'], has(), () => 'export const x = 1;\n'),
      ['p/src/index.ts'],
    );
  });

  it('page/main.ts 由集成测试覆盖，不要求同名测试；同目录其他入口仍要求', () => {
    assert.deepEqual(
      missingTests(['packages/render/src/page/main.ts', 'packages/render/src/page/main2.ts'], has(), reexport),
      ['packages/render/src/page/main2.ts'],
    );
  });
});
