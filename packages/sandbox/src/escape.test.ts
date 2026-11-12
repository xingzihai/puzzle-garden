import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { escapeControl, redactHostPaths, sanitizeText } from './escape.ts';

describe('escapeControl：控制字符转义', () => {
  test('ANSI / OSC / 回车 / 双向控制符 / NUL 都转义', () => {
    assert.equal(escapeControl('\u001b[2J'), '\\u{001B}[2J');
    // OSC：ESC ] 0 ; x BEL
    assert.equal(escapeControl('\u001b]0;x\u0007'), '\\u{001B}]0;x\\u{0007}');
    assert.equal(escapeControl('a\rb'), 'a\\u{000D}b');
    assert.equal(escapeControl('a\u202eb'), 'a\\u{202E}b');
    assert.equal(escapeControl('a\u2066b'), 'a\\u{2066}b');
    assert.equal(escapeControl('a\u0000b'), 'a\\u{0000}b');
    assert.equal(escapeControl('a\u007fb'), 'a\\u{007F}b');
    assert.equal(escapeControl('a\u0085b'), 'a\\u{0085}b');
  });

  test('新增区间每个端点都转义：U+061C、U+200B–U+200F、U+2028、U+2029、U+2060–U+2064、U+FEFF', () => {
    const cases: readonly [string, string][] = [
      ['\u061c', '\\u{061C}'],
      ['\u200b', '\\u{200B}'],
      ['\u200f', '\\u{200F}'],
      ['\u2028', '\\u{2028}'],
      ['\u2029', '\\u{2029}'],
      ['\u2060', '\\u{2060}'],
      ['\u2064', '\\u{2064}'],
      ['\ufeff', '\\u{FEFF}'],
    ];
    for (const [char, escaped] of cases) {
      assert.equal(escapeControl(`a${char}b`), `a${escaped}b`, `U+${char.codePointAt(0)!.toString(16)}`);
    }
  });

  test('换行与制表符原样保留，普通文本与中文标点不变', () => {
    assert.equal(escapeControl('a\nb\tc'), 'a\nb\tc');
    assert.equal(escapeControl('普通文本 stone_bricks'), '普通文本 stone_bricks');
    assert.equal(
      escapeControl('中文，。！？；：、"“”‘’（）【】《》·—…nb_'),
      '中文，。！？；：、"“”‘’（）【】《》·—…nb_',
    );
  });
});

describe('redactHostPaths / sanitizeText：宿主路径脱敏', () => {
  const repoRoot = '/home/alice/work/puzzle-garden/';

  test('仓库根的 file:// 与裸路径替换为 <host>，模型帧 pg:building 原样保留', () => {
    const stack = [
      'Error',
      '    at build (pg:building:3:11)',
      `    at parse (file://${repoRoot}packages/geometry/src/schema.ts:299:11)`,
      `    at runChild (${repoRoot}packages/sandbox/src/child-run.ts:159:5)`,
    ].join('\n');
    const redacted = redactHostPaths(stack, repoRoot);
    assert.ok(!redacted.includes(repoRoot.replace(/\/$/, '')), redacted);
    assert.ok(!redacted.includes('/home/alice'), redacted);
    assert.ok(redacted.includes('at build (pg:building:3:11)'), redacted);
    assert.ok(redacted.includes('at parse (<host>/packages/geometry/src/schema.ts:299:11)'), redacted);
    assert.ok(redacted.includes('at runChild (<host>/packages/sandbox/src/child-run.ts:159:5)'), redacted);
  });

  test('仓库外的 /home 用户目录只替换用户名，其他 file:// 也去掉', () => {
    const text = `读 /home/alice/.ssh/known_hosts 或 file:///home/alice/secret 或 file:///opt/pg/node`;
    const redacted = redactHostPaths(text, repoRoot);
    assert.equal(redacted, '读 /home/<user>/.ssh/known_hosts 或 <host>/home/<user>/secret 或 <host>/opt/pg/node');
  });

  test('sanitizeText 先转义控制字符再脱敏路径', () => {
    const text = `\u001b[2J file://${repoRoot}a.ts`;
    assert.equal(sanitizeText(text, repoRoot), '\\u{001B}[2J <host>/a.ts');
  });
});
