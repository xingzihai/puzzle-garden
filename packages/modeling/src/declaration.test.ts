/** 声明一致性：MODEL_DECLARATION 与包根 model.d.ts 逐字符相同，且能用 TypeScript 校验好坏样本。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { MODEL_DECLARATION, modelDeclaration } from './declaration.ts';

const declarationPath = fileURLToPath(new URL('../model.d.ts', import.meta.url));

describe('MODEL_DECLARATION', () => {
  it('与包根 model.d.ts 逐字符相同（单一事实源）', () => {
    assert.equal(readFileSync(declarationPath, 'utf8'), MODEL_DECLARATION);
  });

  it('modelDeclaration() 返回同一字符串', () => {
    assert.equal(modelDeclaration(), MODEL_DECLARATION);
  });

  it('是一份能通过 TypeScript 严格编译的声明', () => {
    assert.deepEqual(messages(''), []);
  });
});

/** 把声明与样本拼成一个虚拟模块编译，返回诊断；好坏样本共用。 */
function diagnostics(body: string): readonly ts.Diagnostic[] {
  const source = `${MODEL_DECLARATION}\n${body}`;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: false,
  };
  const host = ts.createCompilerHost(options);
  const previous = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, language, onError, shouldCreateNewSourceFile) =>
    fileName === '/virtual/model.ts'
      ? ts.createSourceFile(fileName, source, language, true)
      : previous(fileName, language, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram(['/virtual/model.ts'], options, host);
  return ts.getPreEmitDiagnostics(program);
}

function messages(body: string): string[] {
  return diagnostics(body).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

describe('声明能作为预检边界', () => {
  it('接受合法的 build 入口与五类调用', () => {
    const good = `declare const model: Model;
      model.box({ id: 'b', name: '盒', role: 'volume', color: '#000000', size: [1, 2, 3], material: 'deepslate_tiles' });
      const profile = (t: number): Point2 => [16 * (1 - t) / (1 + 4 * t), 24 * t];
      model.revolve({ id: 'r', name: '屋顶', role: 'roof', color: '#8899aa', profile, profileSegments: 32, radialSegments: 48 });
      model.extrude({ id: 'e', name: '柱', role: 'floor', color: '#000000', outline: [[0, 0], [4, 0], [4, 3]], height: 5 });
      const position = (u: number, v: number): readonly [number, number, number] => [u, 0, v];
      model.surface({ id: 's', name: '曲面', role: 'roof', color: '#8899aa', uSegments: 8, vSegments: 8, closedU: true, position });
      const point: Point2 = model.bezier([[0, 0], [1, 0], [1, 1], [0, 1]], 0.5);
      const doc: ModelDocument = model.finish();
      void [point, doc];`;
    assert.deepEqual(messages(good), []);
  });

  it('拒绝拼错的 role、非函数 profile、非法尺寸与非法 material', () => {
    const bad = `declare const model: Model;
      model.box({ id: 'b', name: '盒', role: 'wall', color: '#000000', size: [1, 2, 3] });
      model.box({ id: 'b2', name: '盒', role: 'volume', color: '#000000', size: [1, 2, 3], material: 5 });
      model.revolve({ id: 'r', name: '屋顶', role: 'roof', color: '#000000', profile: 5 });
      model.surface({ id: 's', name: '面', role: 'roof', color: '#000000', uSegments: 8, vSegments: 8, position: 5 });
      model.extrude({ id: 'e', name: '柱', role: 'floor', color: '#000000', outline: [[0, 0], [1, 0], [0, 1]], height: '5' });`;
    const codes = diagnostics(bad).map((diagnostic) => diagnostic.code);
    assert.ok(codes.includes(2322), `至少应有一个类型不匹配，实际 ${JSON.stringify(codes)}`);
    assert.ok(messages(bad).length > 0);
  });
});
