/**
 * view-retention.ts：每个立面只留最近 N 张、交付图与无视角标签的图不动（Phase 3C）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImagePart, Message, TextPart } from '@pg/llm/schema';

import { facadeOfLabel, retainViewImages } from './view-retention.ts';

const PREFIX = 'data:image/png;base64,';

function text(value: string): TextPart {
  return { type: 'text', text: value };
}

function image(tag: string): ImagePart {
  return { type: 'image_url', image_url: { url: `${PREFIX}${tag}` } };
}

function label(view: string): TextPart {
  return text(`${view}（测试视角，正交，1 格 ≈ 10 像素）`);
}

function user(...parts: (TextPart | ImagePart)[]): Message {
  return { role: 'user', content: parts };
}

function system(content = 'system'): Message {
  return { role: 'system', content };
}

function urls(messages: readonly Message[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'image_url') out.push(part.image_url.url.slice(PREFIX.length));
    }
  }
  return out;
}

function repeated(view: string, tags: readonly string[]): Message {
  const parts: (TextPart | ImagePart)[] = [];
  for (const tag of tags) parts.push(label(view), image(tag));
  return user(...parts);
}

describe('retainViewImages', () => {
  it('每个立面 1 / 2 张时原样保留，但返回新数组', () => {
    for (const count of [1, 2]) {
      const messages = [
        system(),
        repeated(
          'south',
          Array.from({ length: count }, (_, i) => `s${String(i + 1)}`),
        ),
        repeated(
          'east',
          Array.from({ length: count }, (_, i) => `e${String(i + 1)}`),
        ),
      ];
      const kept = retainViewImages(messages);
      assert.deepEqual(kept, messages);
      assert.notEqual(kept, messages);
      assert.deepEqual(urls(kept), urls(messages));
    }
  });

  it('每个立面 3 张时只删最旧的 1 张，保留最近 2 张', () => {
    const messages = [
      repeated('south', ['s1', 's2', 's3']),
      repeated('east', ['e1', 'e2', 'e3']),
      repeated('north', ['n1']),
    ];
    const kept = retainViewImages(messages);
    assert.deepEqual(urls(kept), ['s2', 's3', 'e2', 'e3', 'n1']);
    // 其他消息块（文本说明、system）不动。
    assert.equal(kept[0]?.role, 'user');
    assert.equal(kept[1]?.role, 'user');
    assert.equal(kept[2]?.role, 'user');
  });

  it('iso-se 与 iso-nw 合并为 iso，各自不单独占额度', () => {
    const messages = [repeated('iso-se', ['a1', 'a2']), repeated('iso-nw', ['b1'])];
    assert.deepEqual(urls(retainViewImages(messages)), ['a2', 'b1']);
    assert.deepEqual(urls(retainViewImages([repeated('iso-se', ['a1']), repeated('iso-nw', ['b1'])])), ['a1', 'b1']);
  });

  it('maxPerFacade 可改成 1 或 0', () => {
    const messages = [repeated('interior', ['i1', 'i2', 'i3']), repeated('cutaway', ['c1', 'c2', 'c3'])];
    assert.deepEqual(urls(retainViewImages(messages, 1)), ['i3', 'c3']);
    assert.deepEqual(urls(retainViewImages(messages, 0)), []);
    assert.deepEqual(urls(retainViewImages(messages, -1)), []);
  });

  it('交付图全部保留，且不占迭代视角额度', () => {
    const delivery = user(text('以下是交付图。'), image('d1'), image('d2'), image('d3'), image('d4'));
    const iterative = repeated('south', ['s1', 's2', 's3']);
    const kept = retainViewImages([system(), delivery, iterative]);
    assert.deepEqual(urls(kept), ['d1', 'd2', 'd3', 'd4', 's2', 's3']);
  });

  it('交付标记覆盖同一条消息里的视角标签', () => {
    const delivery = user(
      text('交付：DELIVERY'),
      label('south'),
      image('d1'),
      label('south'),
      image('d2'),
      label('south'),
      image('d3'),
    );
    assert.deepEqual(urls(retainViewImages([delivery])), ['d1', 'd2', 'd3']);
  });

  it('混合消息：无视角标签的图、文件名、assistant / tool 全部保留', () => {
    const messages: Message[] = [
      system(),
      user(text('"top.png"'), image('initial-top')),
      user(image('massing-composite')),
      repeated('south', ['s1', 's2', 's3']),
      {
        role: 'assistant',
        content: '看南立面',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'view_building', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '已渲染' },
      repeated('cutaway', ['c1', 'c2', 'c3']),
    ];
    const kept = retainViewImages(messages);
    assert.deepEqual(urls(kept), ['initial-top', 'massing-composite', 's2', 's3', 'c2', 'c3']);
    assert.deepEqual(kept.slice(4, 6), messages.slice(4, 6));
  });

  it('不修改入参；返回新的 messages 数组', () => {
    const messages = [system(), repeated('south', ['s1', 's2', 's3'])];
    const before = JSON.stringify(messages);
    const kept = retainViewImages(messages);
    assert.equal(JSON.stringify(messages), before);
    assert.notEqual(kept, messages);
    assert.notEqual(kept[1], messages[1]);
  });

  it('facadeOfLabel：接受常见写法，拒绝文件名', () => {
    assert.equal(facadeOfLabel('south'), 'south');
    assert.equal(facadeOfLabel('south（南立面）'), 'south');
    assert.equal(facadeOfLabel('"iso-se"'), 'iso');
    assert.equal(facadeOfLabel('[south]'), 'south');
    assert.equal(facadeOfLabel('view: iso-nw'), 'iso');
    assert.equal(facadeOfLabel('ISO-NW'), 'iso');
    assert.equal(facadeOfLabel('iso'), 'iso');
    assert.equal(facadeOfLabel('interior（室内）'), 'interior');
    assert.equal(facadeOfLabel('cutaway view'), 'cutaway');
    assert.equal(facadeOfLabel('top.png'), null);
    assert.equal(facadeOfLabel('south.jpg'), null);
    assert.equal(facadeOfLabel('一张参考图'), null);
  });
});
