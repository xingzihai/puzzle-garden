/**
 * reference 工具单测（W11-03）：只读本地生成文档，不跑模型、不联网。
 * 覆盖 api / block 正常查询、大小写、未知、空 query、路径式 query、截断与确定性。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { V2_L3_SECTION } from '../prompt/build-playbook.ts';
import {
  BLOCK_REFERENCE_CATEGORIES,
  MAX_API_REFERENCE_CHARS,
  MAX_BLOCK_REFERENCE_CHARS,
  REFERENCE_DISCLAIMER,
  reference,
} from './reference.ts';

describe('reference(api)', () => {
  it('walls / opening / roof 返回局部声明、用法与固定提示', () => {
    for (const query of ['walls', 'opening', 'roof']) {
      const result = reference({ scope: 'api', query });
      assert.equal(result.status, 'ok', query);
      assert.ok(result.text.includes(`API · ${query}`), query);
      assert.ok(result.text.includes(`${query}Options`), query);
      assert.ok(result.text.includes('用法：'), query);
      assert.ok(result.text.includes(REFERENCE_DISCLAIMER), query);
    }
    const walls = reference({ scope: 'api', query: 'walls' });
    assert.ok(walls.text.includes('外墙'), '应使用 generated 文档的中文说明');
    assert.ok(walls.text.includes('offline-pass'), '应带生成状态');
  });

  it('大小写不敏感，且结果确定', () => {
    const lower = reference({ scope: 'api', query: 'walls' });
    const upper = reference({ scope: 'api', query: 'WALLS' });
    assert.equal(upper.status, 'ok');
    assert.match(upper.text, /API · walls/);
    assert.deepEqual(reference({ scope: 'api', query: 'opening' }), reference({ scope: 'api', query: 'opening' }));
    assert.equal(reference({ scope: 'api', query: 'WALLS' }).text, lower.text);
  });

  it('超长声明截断到 2500 字符并标注“已截断”', () => {
    const result = reference({ scope: 'api', query: 'walls' });
    assert.equal(result.status, 'ok');
    assert.ok(result.text.length <= MAX_API_REFERENCE_CHARS, `${String(result.text.length)} > 上限`);
    assert.ok(result.text.includes('已截断'));
    assert.ok(result.text.endsWith(REFERENCE_DISCLAIMER));
  });

  it('未知符号列出最接近的 3 个候选', () => {
    const result = reference({ scope: 'api', query: 'walss' });
    assert.equal(result.status, 'not-found');
    assert.match(result.text, /候选：/);
    const line = result.text.split('\n').find((item) => item.startsWith('候选：')) ?? '';
    assert.equal(line.slice(3).split('、').length, 3);
    assert.ok(line.includes('walls'));
  });
});

describe('reference(block)', () => {
  it('中文类别与精确 id 都返回方块条目与组合用法', () => {
    const stairs = reference({ scope: 'block', query: '楼梯' });
    assert.equal(stairs.status, 'ok');
    assert.ok(stairs.text.includes('oak_stairs'));
    assert.ok(stairs.text.includes('组合用法'));

    const exact = reference({ scope: 'block', query: 'oak_stairs' });
    assert.equal(exact.status, 'ok');
    assert.match(exact.text, /Block · oak_stairs/);
    assert.ok(exact.text.includes('facing'));
    assert.ok(exact.text.length <= MAX_BLOCK_REFERENCE_CHARS);
  });

  it('大小写不敏感、最多 1500 字符且截断有标注', () => {
    const upper = reference({ scope: 'block', query: 'OAK_STAIRS' });
    assert.equal(upper.status, 'ok');
    assert.match(upper.text, /Block · oak_stairs/);
    const broad = reference({ scope: 'block', query: 'stairs' });
    assert.equal(broad.status, 'ok');
    assert.ok(broad.text.length <= MAX_BLOCK_REFERENCE_CHARS);
    assert.ok(broad.text.includes('已截断'));
    assert.ok(broad.text.endsWith(REFERENCE_DISCLAIMER));
  });

  it('未知方块列出候选', () => {
    const result = reference({ scope: 'block', query: 'not_a_block_xyz' });
    assert.equal(result.status, 'not-found');
    assert.match(result.text, /候选：/);
  });

  it('prompt L3 列出的 10 个类别全部返回非空条目', () => {
    assert.equal(BLOCK_REFERENCE_CATEGORIES.length, 10);
    for (const category of BLOCK_REFERENCE_CATEGORIES) {
      assert.ok(V2_L3_SECTION.includes(category), `prompt L3 缺少类别：${category}`);
      const result = reference({ scope: 'block', query: category });
      assert.equal(result.status, 'ok', category);
      assert.match(result.text, new RegExp(`Block · 类别：${category}`), category);
      assert.doesNotMatch(result.text, /未找到/, category);
      assert.match(result.text, /方块：/, category);
      assert.ok(result.text.length <= MAX_BLOCK_REFERENCE_CHARS, category);
    }
  });
});

describe('reference 边界', () => {
  it('未知 scope 返回可行动错误', () => {
    const result = reference({ scope: 'example', query: 'walls' });
    assert.equal(result.status, 'invalid-args');
    assert.match(result.text, /未知 scope/);
    assert.match(result.text, /可用：api/);
  });

  it('空 query / 纯空白 / 非字符串都拒绝', () => {
    assert.equal(reference({ scope: 'api', query: '' }).status, 'invalid-args');
    assert.match(reference({ scope: 'api', query: '   ' }).text, /不能为空/);
    assert.equal(reference({ scope: 'api', query: 1 as unknown as string }).status, 'invalid-args');
  });

  it('路径式 / 控制字符 query 不读文件', () => {
    for (const query of ['../../etc/passwd', 'docs/MC-BLOCK-CAPABILITIES.md', 'walls\nroot:', '..\\..\\secret']) {
      const result = reference({ scope: 'api', query });
      assert.equal(result.status, 'invalid-args', query);
      assert.match(result.text, /没有读取任何文件/);
      assert.ok(!result.text.includes('root:x:'));
      assert.ok(!result.text.includes('| id '));
    }
  });

  it('超长 query 拒绝，不把整段文档塞进匹配', () => {
    const result = reference({ scope: 'block', query: 'x'.repeat(121) });
    assert.equal(result.status, 'invalid-args');
    assert.match(result.text, /过长/);
  });

  it('所有结果都带固定提示且长度受限', () => {
    for (const [scope, query, limit] of [
      ['api', 'walls', MAX_API_REFERENCE_CHARS],
      ['api', 'not-a-symbol', MAX_API_REFERENCE_CHARS],
      ['block', '楼梯', MAX_BLOCK_REFERENCE_CHARS],
      ['block', 'not_a_block_xyz', MAX_BLOCK_REFERENCE_CHARS],
    ] as const) {
      const result = reference({ scope, query });
      assert.ok(result.text.includes(REFERENCE_DISCLAIMER), `${scope}/${query}`);
      assert.ok(result.text.length <= limit, `${scope}/${query}: ${String(result.text.length)} > ${String(limit)}`);
    }
  });
});
