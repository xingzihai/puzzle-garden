/**
 * 请求内容组装（AGENT-SPEC §3.2、§4.5）：待发送消息的字节/图片计数与两层实验的初始上下文消息。
 *
 * 负责：累加新增消息的文本字节与图片数（图片另按 1024 / 张计，MODEL-SPEC §4.3）；
 *   把设计文档与带短名的图片拼成第三条 user 消息，区分种子骨架与空稿参考材料。
 * 不负责：主循环、护栏、请求体（runner.ts）；渲染与存档（tools/view.ts）。
 */

import type { ImagePart, Message, TextPart } from '@pg/llm/schema';

const encoder = new TextEncoder();

/** 新增消息的文本字节与图片数（图片另按 1024 / 张计，MODEL-SPEC §4.3）。 */
export function newContent(messages: readonly Message[]): { readonly bytes: number; readonly images: number } {
  let bytes = 0;
  let images = 0;
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content !== 'string') {
      for (const p of m.content) {
        if (p.type === 'image_url') images += 1;
        else bytes += encoder.encode(p.text).length;
      }
    } else {
      bytes += encoder.encode(JSON.stringify(m)).length;
    }
  }
  return { bytes, images };
}

/** 初始上下文消息的内容与本轮带入的图片计数（base64 字符数，口径同 view.imageBytes）。 */
export interface InitialContext {
  readonly content: string | (TextPart | ImagePart)[];
  readonly imageBytes: number;
  readonly images: number;
}

/**
 * 拼两条消息：上一条原题之后，把上一阶段交付的设计文档与骨架渲染图作为第三条 user 消息。
 * `design` 有值时加文档段；图片逐张加 JSON 短名与 data URL，计入图片预算。空稿不声称已有交付物。
 */
export function initialContextMessage(
  design: string | undefined,
  images: readonly { readonly name: string; readonly png: Uint8Array }[],
  options: {
    readonly hasInitialDraft?: boolean;
    /** 设计阶段派生的 BuildSheet markdown；fixed 权威时作为机器合同，不是参考材料。 */
    readonly buildSheet?: string;
    readonly designAuthority?: 'free' | 'fixed';
  } = {},
): InitialContext {
  const hasDraft = options.hasInitialDraft ?? true;
  const fixed = options.designAuthority === 'fixed';
  if (fixed) {
    const contract =
      options.buildSheet === undefined || options.buildSheet.trim() === ''
        ? ''
        : `【已确认施工合同（BuildSheet，机器真相）】\n${options.buildSheet}\n\n`;
    const designPart =
      design === undefined || design === '' ? '' : `【已确认设计说明 / 摘要（意图、风格、未量化偏好）】\n${design}\n\n`;
    const authority =
      '【权威与冲突】BuildSheet 管数字、对象、must id；design 管意图、风格、未量化偏好；题面显式要求优先。数字冲突以 BuildSheet 为准并记录；意图冲突报告，不静默改。\n\n';
    const tail = images.length === 0 ? '' : '以下是骨架的渲染图。';
    const current = hasDraft
      ? '【当前稿】当前稿已替换为上一阶段交付的骨架代码（read_code 可见）；原题见上一条消息。'
      : '【当前稿】当前稿为空；按上面的施工合同从零开始建造。';
    const text = `${contract}${authority}${designPart}${current}${tail}`;
    if (images.length === 0) return { content: text, imageBytes: 0, images: 0 };
    const parts: (TextPart | ImagePart)[] = [{ type: 'text', text }];
    let imageBytes = 0;
    for (const im of images) {
      const base64 = Buffer.from(im.png).toString('base64');
      parts.push({ type: 'text', text: JSON.stringify(im.name) });
      parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } });
      imageBytes += base64.length;
    }
    return { content: parts, imageBytes, images: images.length };
  }
  const designPart =
    design === undefined || design === ''
      ? ''
      : `${hasDraft ? '【上一阶段交付的骨架设计文档】' : '【参考设计文档】'}\n${design}\n\n`;
  const tail = images.length === 0 ? '' : '下面是骨架的渲染图。';
  const reference = images.length > 0 ? '以下为局部参考图' : designPart === '' ? '' : '以上为参考设计文档';
  const text = hasDraft
    ? `${designPart}【当前稿】当前稿已替换为上一阶段交付的骨架代码（read_code 可见）；原题见上一条消息。${tail}`
    : `${designPart}【参考材料】当前稿为空；${reference === '' ? '' : `${reference}，不是当前稿或上一阶段交付物。`}原题见上一条消息。`;
  if (images.length === 0) return { content: text, imageBytes: 0, images: 0 };
  const parts: (TextPart | ImagePart)[] = [{ type: 'text', text }];
  let imageBytes = 0;
  for (const im of images) {
    const base64 = Buffer.from(im.png).toString('base64');
    parts.push({ type: 'text', text: JSON.stringify(im.name) });
    parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } });
    imageBytes += base64.length;
  }
  return { content: parts, imageBytes, images: images.length };
}
