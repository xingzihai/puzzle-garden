/** 执行结果摘要与反馈文本：预检（含空诊断）、各失败类型、console 行数 / 字符上限。 */
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { createModel } from '@pg/modeling/model';
import type { ModelExecution } from '@pg/sandbox/modeling';

import {
  GEOMETRY_MAX_CHARS,
  consoleText,
  countsOf,
  failureText,
  geometrySummary,
  outcomeOf,
  summarize,
} from './result.ts';

interface Entry {
  readonly level: 'log' | 'warn' | 'error';
  readonly text: string;
}

function boxDocument() {
  const model = createModel();
  model.box({ id: 'b', name: '块', role: 'volume', color: '#112233', size: [2, 3, 4] });
  return model.finish();
}

it('countsOf / summarize 不计 console 正文，只留条数', () => {
  const document = boxDocument();
  assert.deepEqual(countsOf(document).parts, 1);
  const summary = summarize({
    kind: 'ok',
    document,
    codeHash: 'a',
    documentHash: 'b',
    console: [{ level: 'log', text: 'x' }],
    consoleTruncated: 3,
  });
  assert.equal(summary.kind, 'ok');
  assert.equal(summary.console, 1);
  assert.equal(summary.consoleTruncated, 3);
});

it('outcomeOf 把各 kind 归到四类', () => {
  assert.equal(outcomeOf('ok'), 'ok');
  assert.equal(outcomeOf('precheck-error'), 'precheck-failed');
  assert.equal(outcomeOf('build-error'), 'build-error');
  assert.equal(outcomeOf('timeout'), 'not-finished');
  assert.equal(outcomeOf('aborted'), 'not-finished');
});

it('failureText：空诊断显示 message，非空显示行列与条数', () => {
  const timeout = failureText({ kind: 'precheck-error', message: '类型预检超时（5000ms）', diagnostics: [], total: 0 });
  assert.match(timeout, /类型预检超时/);
  assert.doesNotMatch(timeout, /0 处/);
  const oom = failureText({ kind: 'precheck-error', message: '类型预检内存超限（512MiB）', diagnostics: [], total: 0 });
  assert.match(oom, /内存超限/);
  const listed = failureText({
    kind: 'precheck-error',
    message: '代码未通过预检：2 处问题',
    diagnostics: [
      { line: 1, column: 2, code: 'A', message: '坏一', source: '' },
      { line: 3, column: 4, code: 'B', message: '坏二', source: '' },
    ],
    total: 2,
  });
  assert.match(listed, /第 1 行第 2 列：坏一/);
  assert.match(listed, /第 3 行第 4 列：坏二/);
});

it('failureText：覆盖每种失败类型', () => {
  assert.match(
    failureText({ kind: 'build-error', message: 'm', name: 'E', line: 1, column: 2, console: [], consoleTruncated: 0 }),
    /执行出错（E/,
  );
  assert.match(failureText({ kind: 'timeout', message: 'm', timeoutMs: 5000 }), /5000ms/);
  assert.match(failureText({ kind: 'out-of-memory', message: '内存' }), /内存超限：内存/);
  assert.match(failureText({ kind: 'output-too-large', message: 'm', bytes: 10, limit: 5 }), /10 字节 > 5/);
  assert.match(failureText({ kind: 'crashed', message: '崩', stderrHead: '' }), /崩/);
  assert.match(failureText({ kind: 'aborted', message: 'm' }), /中止/);
  assert.match(failureText({ kind: 'too-large', message: 'm', bytes: 2, limit: 1 }), /没有执行/);
  assert.match(failureText({ kind: 'unsupported', message: '无 bwrap' }), /无 bwrap/);
});

it('consoleText：空返回空串，正常逐条列出', () => {
  assert.equal(consoleText([], 0), '');
  const text = consoleText(
    [
      { level: 'log', text: 'a' },
      { level: 'error', text: 'b' },
    ],
    0,
  );
  assert.match(text, /console 输出 2 条/);
  assert.match(text, /\[log\] a/);
  assert.match(text, /\[error\] b/);
});

it('consoleText：行数与字符数双重上限，超出写明另有几条', () => {
  const many: Entry[] = Array.from({ length: 30 }, (_, i) => ({ level: 'log', text: `第 ${String(i)} 行` }));
  const capped = consoleText(many, 5);
  assert.match(capped, /console 输出 30 条/);
  assert.match(capped, /额度超限丢弃 5 条/);
  assert.match(capped, /另有 \d+ 条未显示/);
  const long = consoleText([{ level: 'log', text: 'x'.repeat(5000) }], 0);
  assert.equal(long.length < 2200, true);
});

it('summarize 失败结果原样保留（含诊断），成功不复制文档', () => {
  const failure: ModelExecution = {
    kind: 'precheck-error',
    message: 'm',
    diagnostics: [{ line: 1, column: 1, code: 'A', message: 'd', source: '' }],
    total: 1,
  };
  assert.equal(summarize(failure), failure);
});

it('geometrySummary：小文档给出总览、总包围盒与每部件行', () => {
  const model = createModel();
  model.box({ id: 'base', name: '基座', role: 'floor', color: '#9a9a9a', size: [32, 1, 20] });
  model.box({
    id: 'tower',
    name: '塔',
    role: 'volume',
    color: '#aabbcc',
    size: [4, 9, 4],
    transform: { translate: [14, 0, 8] },
  });
  const text = geometrySummary(model.finish());
  assert.match(text, /几何摘要：2 个部件/);
  assert.match(text, /总包围盒 x\[0,32\] y\[0,9\] z\[0,20\]/);
  assert.match(text, /- base「基座」box 尺寸 32×1×20，y 0~1/);
  assert.match(text, /- tower「塔」box 尺寸 4×9×4，y 0~9/);
});

it('geometrySummary：小数保留 ≤3 位并去掉多余的 0', () => {
  const model = createModel();
  model.box({
    id: 'p',
    name: '板',
    role: 'floor',
    color: '#112233',
    size: [1.5, 2, 3],
    transform: { translate: [0.25, 0, 0] },
  });
  const text = geometrySummary(model.finish());
  assert.match(text, /尺寸 1\.5×2×3/);
  assert.match(text, /y 0~2/);
  assert.doesNotMatch(text, /0\.000|\b0\.0\b|\.000000/);
});

it('geometrySummary：部件数超过上限折叠为“另有 N 个部件未列出”', () => {
  const model = createModel();
  for (let i = 0; i < 15; i += 1) {
    model.box({ id: `p${String(i)}`, name: `件${String(i)}`, role: 'volume', color: '#112233', size: [1, 1, 1] });
  }
  const text = geometrySummary(model.finish());
  assert.ok(text.length <= GEOMETRY_MAX_CHARS, '不应超过硬上限');
  assert.match(text, /- p11「件11」/);
  assert.doesNotMatch(text, /- p12「件12」/);
  assert.match(text, /另有 3 个部件未列出/);
  assert.doesNotMatch(text, /已截断/);
});

it('geometrySummary：>12 部件且名字超长时截断并注明“已截断”，硬上限成立', () => {
  const model = createModel();
  const name = `很长的部件名${'字'.repeat(90)}`;
  for (let i = 0; i < 20; i += 1) {
    model.box({ id: `b${String(i)}`, name, role: 'volume', color: '#112233', size: [1, 1, 1] });
  }
  const text = geometrySummary(model.finish());
  assert.ok(text.length <= GEOMETRY_MAX_CHARS, '不应超过硬上限');
  assert.match(text, /已截断/);
  assert.match(text, /另有 \d+ 个部件未列出/);
});

it('geometrySummary：空文档只给计数，不编造包围盒', () => {
  assert.equal(geometrySummary(createModel().finish()), '几何摘要：0 个部件，0 顶点，0 三角');
});
