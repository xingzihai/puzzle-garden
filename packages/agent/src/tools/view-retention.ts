/**
 * 视角图片保留（OPTIMIZATION-ROADMAP Phase 3C）：同一立面只留最近 N 张，避免 63 张迭代图淹没上下文。
 *
 * 负责：按视角说明文字识别迭代图所属立面，保留每个立面最后 `maxPerFacade` 张；
 *   交付图（含“交付”/delivery 的 user 消息）与没有视角标签的图片（草模合成图、初始参考图）全部保留。
 * 不负责：调用 render、改 runner、裁剪消息文本或压缩图片。
 * 纯函数：不改入参，不依赖时间 / 随机数；返回新的 messages 数组。
 */

import type { ImagePart, Message, TextPart } from '@pg/llm/schema';

/** 同一立面合并计数：iso-se / iso-nw 共享 `iso`。 */
export const VIEW_FACADES = ['south', 'east', 'north', 'west', 'top', 'iso', 'interior', 'cutaway'] as const;
export type ViewFacade = (typeof VIEW_FACADES)[number];

const TOKEN_TO_FACADE: Readonly<Record<string, ViewFacade>> = {
  south: 'south',
  east: 'east',
  north: 'north',
  west: 'west',
  top: 'top',
  iso: 'iso',
  'iso-se': 'iso',
  'iso-nw': 'iso',
  interior: 'interior',
  cutaway: 'cutaway',
};

/**
 * 视角说明的宽松解析：允许 `south`、`south（南立面…）`、`"iso-se"` 等写法；
 * 排除 `top.png` / `south.jpg` 这类初始上下文里的文件名。
 */
const VIEW_TOKEN =
  /^\s*(?:[【[("'“]\s*)?(?:(?:view(?:_building)?|视角)\s*[:：]\s*)?(iso-se|iso-nw|iso|interior|cutaway|south|east|north|west|top)(?![a-z0-9_-])(?!\.(?:png|jpe?g|webp|gif)\b)/i;

/** 交付消息标记：中文“交付”或英文 delivery；命中后整条 user 消息里的图片都不裁。 */
function isDeliveryText(text: string): boolean {
  return /交付/i.test(text) || /\bdeliver(?:ed|y)?\b/i.test(text);
}

/** 从视角说明文字得到立面；不是视角说明时返回 null。 */
export function facadeOfLabel(text: string): ViewFacade | null {
  const match = VIEW_TOKEN.exec(text);
  if (match === null) return null;
  return TOKEN_TO_FACADE[(match[1] ?? '').toLowerCase()] ?? null;
}

type ContentPart = TextPart | ImagePart;

function contentParts(message: Message): readonly ContentPart[] | null {
  if (message.role !== 'user' || typeof message.content === 'string') return null;
  return message.content;
}

interface ImageRef {
  readonly message: number;
  readonly part: number;
  readonly facade: ViewFacade | null;
}

/**
 * 只保留每个立面最近 `maxPerFacade` 张迭代图。`maxPerFacade` 小于 0 按 0 处理。
 * 非视角图与交付图原样保留；除旧图外不删其他内容块。
 */
export function retainViewImages(messages: readonly Message[], maxPerFacade = 2): Message[] {
  const limit = Math.max(0, Math.floor(maxPerFacade));
  const refs: ImageRef[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    const parts = contentParts(message);
    if (parts === null) continue;
    const delivery = parts.some((part) => part.type === 'text' && isDeliveryText(part.text));
    let currentFacade: ViewFacade | null = null;
    for (const [partIndex, part] of parts.entries()) {
      if (part.type === 'text') {
        currentFacade = isDeliveryText(part.text) ? null : facadeOfLabel(part.text);
      } else if (!delivery) {
        // 连续多张图沿用最近一条视角说明；没有说明的图（初始参考图 / 草模合成图）facade=null，保留。
        refs.push({ message: messageIndex, part: partIndex, facade: currentFacade });
      }
    }
  }

  const byFacade = new Map<ViewFacade, ImageRef[]>();
  for (const ref of refs) {
    if (ref.facade === null) continue;
    const list = byFacade.get(ref.facade) ?? [];
    list.push(ref);
    byFacade.set(ref.facade, list);
  }
  const remove = new Set<string>();
  for (const list of byFacade.values()) {
    for (const ref of list.slice(0, Math.max(0, list.length - limit))) {
      remove.add(`${String(ref.message)}:${String(ref.part)}`);
    }
  }

  return messages.map((message, messageIndex) => {
    const parts = contentParts(message);
    if (parts === null) return message;
    const kept = parts.filter((_part, partIndex) => !remove.has(`${String(messageIndex)}:${String(partIndex)}`));
    if (kept.length === parts.length) return message;
    // Message schema 要求非空内容；整条消息都是被删旧图时留下空字符串，仍可序列化。
    return { role: 'user', content: kept.length === 0 ? '' : kept };
  });
}
