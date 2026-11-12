import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Draft } from './code-edit.ts';
import {
  byteLength,
  countOccurrences,
  editCode,
  lcsLength,
  lineCount,
  readCode,
  windowBlocksWrite,
  writeCode,
} from './code-edit.ts';

const draft = (code: string, version = 1): Draft => ({ code, version });

describe('windowBlocksWrite', () => {
  it('v0 + 提交窗口：不拦，窗口内仍可建立初稿', () => {
    assert.equal(windowBlocksWrite(draft('', 0), true), false);
  });

  it('v1 + 提交窗口：拦整份写入', () => {
    assert.equal(windowBlocksWrite(draft('const x = 1;\n', 1), true), true);
  });

  it('空内容的 v1 仍视为无稿：不拦，避免空稿在窗口内锁死', () => {
    assert.equal(windowBlocksWrite(draft('', 1), true), false);
    assert.equal(windowBlocksWrite(draft(' \n\t', 2), true), false);
  });

  it('v1 + 非窗口：不拦', () => {
    assert.equal(windowBlocksWrite(draft('const x = 1;\n', 1), false), false);
  });
});

describe('writeCode', () => {
  it('写入成功：版本 +1，报行数', () => {
    const result = writeCode(draft('', 0), 'a\nb\n', 100);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.draft, { code: 'a\nb\n', version: 1 });
    assert.equal(result.text, '已写入第 v1 版，2 行。');
  });

  it('超过字节上限：拒绝、版本不变，报字节数与上限', () => {
    const result = writeCode(draft('old', 3), '中文', 5);
    assert.equal(result.kind, 'too-large');
    assert.equal(result.bytes, byteLength('中文'));
    assert.equal(result.limit, 5);
    assert.ok(result.text.includes('超过上限 5 字节'));
    assert.ok(result.text.includes('仍是第 v3 版'));
  });
});

describe('lineCount / byteLength', () => {
  it('末尾换行不算额外一行；空代码 0 行', () => {
    assert.equal(lineCount(''), 0);
    assert.equal(lineCount('a'), 1);
    assert.equal(lineCount('a\nb'), 2);
    assert.equal(lineCount('a\nb\n'), 2);
  });

  it('UTF-8 多字节按字节数', () => {
    assert.equal(byteLength('中'), 3);
    assert.equal(byteLength('ab'), 2);
  });
});

describe('countOccurrences / lcsLength', () => {
  it('允许重叠匹配（C14）', () => {
    assert.equal(countOccurrences('aaa', 'aa'), 2);
    assert.equal(countOccurrences('abcabc', 'abc'), 2);
    assert.equal(countOccurrences('abc', ''), 0);
  });

  it('LCS 长度', () => {
    assert.equal(lcsLength('abcd', 'ac'), 2);
    assert.equal(lcsLength('', 'x'), 0);
  });
});

describe('editCode 成功', () => {
  it('精确替换、版本 +1、带行号片段、行数', () => {
    const result = editCode(draft('a\nb\nc\nd\ne\nf\n', 7), [{ find: 'c', replace: 'C' }]);
    assert.equal(result.kind, 'ok');
    assert.equal(result.draft.version, 8);
    assert.equal(result.draft.code, 'a\nb\nC\nd\ne\nf\n');
    assert.equal(
      result.text,
      '已改为第 v8 版（1 处），6 行。\n第 1 处改动：\n  第 1–5 行：\n    1| a\n    2| b\n    3| C\n    4| d\n    5| e',
    );
  });

  it('多条编辑按顺序作用在前一条结果上', () => {
    const result = editCode(draft('one two three', 1), [
      { find: 'one', replace: '1' },
      { find: 'two', replace: '2' },
    ]);
    assert.equal(result.kind, 'ok');
    assert.equal(result.draft.code, '1 2 three');
    assert.equal(result.draft.version, 2);
    assert.equal((result.text.match(/处改动/g) ?? []).length, 2);
  });

  it('删除（replace 为空）也能生成片段', () => {
    const result = editCode(draft('a\nb\nc', 1), [{ find: 'b\n', replace: '' }]);
    assert.equal(result.kind, 'ok');
    assert.equal(result.draft.code, 'a\nc');
  });
});

describe('editCode 失败且原子', () => {
  it('0 次：edit-not-found，带最接近的一行与提示', () => {
    const result = editCode(draft('w.walls({ height: 3 });', 7), [{ find: 'w.walls({ height: 4 })', replace: 'x' }]);
    assert.equal(result.kind, 'error');
    assert.equal(result.status, 'edit-not-found');
    assert.ok(result.text.includes('出现 0 次'));
    assert.ok(result.text.includes('最接近的一行（第 1 行）'));
    assert.ok(result.text.includes('先用 read_code'));
  });

  it('0 次且逐字失配：edit-not-found，提示按空白归一也无唯一匹配', () => {
    const result = editCode(draft('line one\n\ttarget\nline three', 2), [{ find: 'nope nope', replace: 'x' }]);
    assert.equal(result.kind, 'error');
    assert.equal(result.status, 'edit-not-found');
    assert.ok(result.text.includes('出现 0 次（按空白归一后也没有唯一匹配）'));
    assert.ok(result.text.includes('先用 read_code'));
  });

  it('多次：edit-ambiguous，列出各处起始行号', () => {
    const result = editCode(draft('x\ny\nx\ny\nx\n', 4), [{ find: 'x', replace: 'z' }]);
    assert.equal(result.kind, 'error');
    assert.equal(result.status, 'edit-ambiguous');
    assert.ok(result.text.includes('出现 3 次'));
    assert.ok(result.text.includes('行号：1、3、5'));
    assert.ok(result.text.includes('第 v4 版'));
  });

  it('后面一条失败时前面的也不生效（全程无返回值即原子，原稿未暴露改动）', () => {
    const original = draft('one two', 1);
    const result = editCode(original, [
      { find: 'one', replace: '1' },
      { find: 'missing', replace: '2' },
    ]);
    assert.equal(result.kind, 'error');
    assert.equal(result.status, 'edit-not-found');
    assert.equal(result.text.includes('第 2 条，共 2 条'), true);
    // 原稿对象未被修改
    assert.equal(original.code, 'one two');
  });

  it('find 为空、find === replace：edit-invalid', () => {
    const empty = editCode(draft('abc', 1), [{ find: '', replace: 'x' }]);
    assert.equal(empty.kind, 'error');
    assert.equal(empty.status, 'edit-invalid');
    assert.ok(empty.text.includes('find 为空'));

    const same = editCode(draft('abc', 1), [{ find: 'a', replace: 'a' }]);
    assert.equal(same.kind, 'error');
    assert.equal(same.status, 'edit-invalid');
    assert.ok(same.text.includes('没有变化'));
  });

  it('多条匹配超过 10 处时写"另 N 处"', () => {
    const result = editCode(draft('a'.repeat(12), 1), [{ find: 'a', replace: 'b' }]);
    assert.equal(result.kind, 'error');
    assert.ok(result.text.includes('另 2 处'));
  });
});

describe('editCode 空白归一匹配（精确优先）', () => {
  it('缩进不同（tab 对空格）时归一后唯一，按原文区间替换并注明', () => {
    // 稿里是制表符缩进；find 用两个空格，逐字匹配不到，归一后唯一。
    const result = editCode(draft('line one\n\ttarget\nline three', 2), [{ find: '  target', replace: 'x' }]);
    assert.equal(result.kind, 'ok');
    assert.equal(result.draft.code, 'line one\n\tx\nline three');
    assert.ok(result.text.includes('第 1 处改动（按空白归一匹配应用）：'));
  });

  it('跨行多字符空白按真实区间替换，不因长度不同错位', () => {
    const result = editCode(draft('alpha\n    beta\ngamma', 1), [{ find: 'alpha\n  beta', replace: 'alpha\nbeta' }]);
    assert.equal(result.kind, 'ok');
    assert.equal(result.draft.code, 'alpha\nbeta\ngamma');
  });

  it('tab / 空格混用', () => {
    const result = editCode(draft('x\ty', 1), [{ find: 'x y', replace: 'X Y' }]);
    assert.equal(result.kind, 'ok');
    assert.equal(result.draft.code, 'X Y');
  });

  it('行尾空白不同', () => {
    const result = editCode(draft('foo   \nbar\nbaz', 1), [{ find: 'foo\nbar', replace: 'FOO\nBAR' }]);
    assert.equal(result.kind, 'ok');
    assert.equal(result.draft.code, 'FOO\nBAR\nbaz');
  });

  it('精确唯一时不走归一（精确优先）', () => {
    // "a a" 在稿里精确 1 次；归一后 "a a" 会出现 3 次，必须用精确的那一处。
    const result = editCode(draft('a a\na\ta', 1), [{ find: 'a a', replace: 'Z' }]);
    assert.equal(result.kind, 'ok');
    assert.equal(result.draft.code, 'Z\na\ta');
    assert.ok(!result.text.includes('空白归一'));
  });

  it('归一后多处：edit-ambiguous，不得猜', () => {
    const result = editCode(draft('\ta\n a', 1), [{ find: ' a ', replace: 'x' }]);
    assert.equal(result.kind, 'error');
    assert.equal(result.status, 'edit-ambiguous');
    assert.ok(result.text.includes('按空白归一后出现 2 次'));
  });

  it('find 全是空白：归一后为空，edit-not-found', () => {
    const result = editCode(draft('abc', 1), [{ find: '   ', replace: 'x' }]);
    assert.equal(result.kind, 'error');
    assert.equal(result.status, 'edit-not-found');
  });

  it('归一后 0 处：edit-not-found', () => {
    const result = editCode(draft('alpha beta', 1), [{ find: 'gamma delta', replace: 'x' }]);
    assert.equal(result.kind, 'error');
    assert.equal(result.status, 'edit-not-found');
  });
});

describe('readCode', () => {
  const five = draft('l1\nl2\nl3\nl4\nl5', 3);

  it('缺省全文，闭区间 [from, to]', () => {
    assert.equal(readCode(five).text, '第 v3 版，共 5 行，显示 1–5：\n1| l1\n2| l2\n3| l3\n4| l4\n5| l5');
    assert.equal(readCode(five, 2, 3).text, '第 v3 版，共 5 行，显示 2–3：\n2| l2\n3| l3');
  });

  it('超出 400 行截到 from + 399 并注明', () => {
    const big = draft(Array.from({ length: 500 }, (_, i) => `L${String(i + 1)}`).join('\n'), 1);
    const result = readCode(big, 1, 500);
    assert.ok(result.text.includes('显示 1–400'));
    assert.ok(result.text.includes('（已截断，显示 1–400，共 500 行）'));
    assert.ok(!result.text.includes('L401|'));
  });

  it('空稿、越界与非法区间给出可读错误', () => {
    assert.equal(readCode(draft('', 2)).text, '第 v2 版，共 0 行。');
    assert.ok(readCode(five, 99).text.includes('超出范围'));
    assert.ok(readCode(five, 3, 1).text.includes('小于 from'));
    assert.ok(readCode(five, 0).text.includes('≥ 1'));
    assert.ok(readCode(five, 1, Number.NaN).text.includes('≥ 1'));
  });
});
