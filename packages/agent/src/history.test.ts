/**
 * W11-08 历史压缩纯函数测试：50 轮 token 下降、最近 8 轮原文、旧 check digest、
 * BuildSheet 保留、tool call / result 配对完整、最近 check 钉住。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Message } from '@pg/llm/schema';

import { compactHistory, HISTORY_KEEP_TURNS } from './history.ts';

const BUILD_SHEET = `# BuildSheet — history fixture

## Musts（2）

- \`must-wall\` [task] (verified) → wall-1
- \`must-free\` [task] (none) → 未链接（unverified）

## 冲突

- **conflict-datum**（contract-number）
  - expected: y0
  - actual: y1
  - resolution: record
`;

function checkText(n: number, marker = ''): string {
  return [
    `第 v${String(n)} 版：执行成功，${String(100 + n)} 格，包围盒 (0,0,0)–(8,8,8)，调用 ${String(n)} 次。`,
    `未验证 / 未关闭对象（仅报告）：blocking ${String(n % 3)}；FAIL wall-${String(n)}（blocking）。`,
    marker,
    ...Array.from({ length: 30 }, (_, i) => `上下文行 ${String(i)}：${'细节'.repeat(40)}`),
  ].join('\n');
}

function turn(
  n: number,
  options: { readonly check?: boolean; readonly view?: boolean; readonly marker?: string } = {},
): Message[] {
  const calls = [
    ...(options.check === false ? [] : [{ id: `call-check-${String(n)}`, name: 'check_code' }]),
    ...(options.view === true ? [{ id: `call-view-${String(n)}`, name: 'view_building' }] : []),
    { id: `call-plan-${String(n)}`, name: 'plan' },
  ];
  return [
    {
      role: 'assistant',
      content: `第 ${String(n)} 轮的计划说明 ${'说明'.repeat(20)}`,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify({ n }) },
      })),
    },
    ...calls.map((call) => ({
      role: 'tool' as const,
      tool_call_id: call.id,
      content:
        call.name === 'check_code'
          ? checkText(n, options.marker)
          : call.name === 'view_building'
            ? `已渲染第 v${String(n)} 版 2 张：iso-se、south。`
            : `计划：阶段 roof；项 1。`,
    })),
    {
      role: 'user',
      content: `[第 ${String(n + 1)} 轮｜已花 ¥0.10 / 上限 ¥3.50｜墙钟 1 分 / 40 分]\n当前稿第 v${String(n)} 版。`,
    },
  ];
}

function base(): Message[] {
  return [
    { role: 'system', content: 'SYSTEM-STABLE-PREFIX' },
    { role: 'user', content: '# 题面\nbuild a small house' },
    { role: 'user', content: BUILD_SHEET },
  ];
}

function assertToolPairing(messages: readonly Message[]): void {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        assert.ok(!calls.has(call.id), `tool call id 重复：${call.id}`);
        calls.add(call.id);
      }
    }
    if (message.role === 'tool') {
      assert.ok(calls.has(message.tool_call_id), `tool result 没有对应 call：${message.tool_call_id}`);
    }
  }
}

describe('compactHistory', () => {
  it('50 轮：token 显著下降、最近 8 轮完整、旧 check 有 digest、BuildSheet 未丢、配对完整', () => {
    const messages = base();
    const turns: Message[][] = [];
    for (let n = 1; n <= 50; n += 1) {
      const built = turn(n, { view: n % 7 === 0, marker: n === 1 ? 'TURN1-ONLY-MARKER' : '' });
      turns.push(built);
      messages.push(...built);
    }
    const before = JSON.stringify(messages).length;
    const compact = compactHistory(messages);
    const after = JSON.stringify(compact).length;
    const recent = turns.slice(-HISTORY_KEEP_TURNS).flat();

    assert.ok(compact.length < messages.length, '压缩后消息数应减少');
    assert.ok(after < before * 0.45, `压缩后字节应显著下降：${String(before)} → ${String(after)}`);
    assert.deepEqual(compact.slice(-recent.length), recent, `最近 ${String(HISTORY_KEEP_TURNS)} 轮必须逐字节保留`);
    const digest = compact.find(
      (message): message is Extract<Message, { role: 'user' }> & { content: string } =>
        message.role === 'user' && typeof message.content === 'string' && message.content.includes('[历史摘要'),
    );
    assert.ok(digest !== undefined, '旧轮应有历史摘要');
    assert.ok(digest.content.includes('check:'), '旧 check 应有 digest');
    assert.ok(digest.content.includes('blocking='), '旧 check digest 应保留 blocking');
    assert.ok(digest.content.includes('第 1 轮'), '旧轮编号应保留');
    assert.ok(!digest.content.includes('TURN1-ONLY-MARKER'), '旧 check 正文不应整段保留');
    assert.ok(
      compact.some((message) => message.role === 'user' && message.content === BUILD_SHEET),
      'BuildSheet 原文不能丢',
    );
    assertToolPairing(compact);
  });

  it('最近一次 check 与最近一次 view 即使在窗口外也钉住原文', () => {
    const messages = base();
    for (let n = 1; n <= 20; n += 1) {
      messages.push(
        ...turn(n, {
          check: n === 5,
          view: n === 6,
          marker: n === 5 ? 'LATEST-CHECK-UNIQUE' : n === 6 ? 'LATEST-VIEW-UNIQUE' : '',
        }),
      );
    }
    const compact = compactHistory(messages);
    const text = JSON.stringify(compact);
    assert.ok(text.includes('LATEST-CHECK-UNIQUE'), '最近一次 check 不能被压掉');
    assert.ok(text.includes('LATEST-VIEW-UNIQUE') || text.includes('已渲染第 v6 版'), '最近一次 view 所在轮应钉住');
    assertToolPairing(compact);
  });

  it('轮数 ≤ 8 时原样返回，不改变请求形状', () => {
    const messages = base();
    for (let n = 1; n <= 8; n += 1) messages.push(...turn(n));
    assert.equal(compactHistory(messages), messages);
  });
});
