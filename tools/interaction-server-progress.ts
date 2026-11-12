/**
 * 网页会话的内存进度：把生成层事件压成扁平 UI 事件、保留最近 N 条、维护 SSE 订阅者。
 *
 * 负责：序号、时间戳、文本截断、thinking/content 临时缓冲、订阅者数量诊断。
 * 不负责：HTTP / SSE 响应（interaction-server-core.ts）、会话状态与文件写入（interaction-server-session.ts）。
 * 所有事件只存在内存；thinking / content 不进入 session.json 或 artifacts。
 */
import type { InteractionProgressEvent } from '@pg/interaction/generate-intent';

export type WebProgressKind = 'stage' | 'thinking' | 'content' | 'tool' | 'patch' | 'file' | 'question' | 'error';
export type WebProgressStatus = 'start' | 'delta' | 'done' | 'error';

/** 发给浏览器的扁平事件：只保留展示所需字段，不透传模型原始响应 / arguments / reasoning_content。 */
export interface WebProgressEvent {
  readonly seq: number;
  readonly at: number;
  readonly kind: WebProgressKind;
  readonly stage: string;
  readonly status?: WebProgressStatus;
  readonly detail?: string;
  readonly text?: string;
  readonly name?: string;
  readonly index?: number;
  readonly path?: string;
  readonly op?: 'replace' | 'add' | 'remove';
  readonly bytes?: number;
  readonly id?: string;
}

export type WebProgressDraft = Omit<WebProgressEvent, 'seq' | 'at'>;
export type WebProgressListener = (event: WebProgressEvent) => void;

export const MAX_PROGRESS_EVENTS = 200;
const MAX_PROGRESS_TEXT = 4_000;
const MAX_PROGRESS_DETAIL = 500;

function limitText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function oneLine(text: string, max = MAX_PROGRESS_DETAIL): string {
  return limitText(text.replace(/\s+/g, ' ').trim(), max);
}

/** 把生成层进度映射成页面事件；thinking / content 只是临时文本，不落盘。 */
export function mapProgress(event: InteractionProgressEvent): WebProgressDraft | null {
  switch (event.kind) {
    case 'stage':
      return {
        kind: 'stage',
        stage: event.stage,
        status: event.status,
        ...(event.detail === undefined ? {} : { detail: oneLine(event.detail) }),
      };
    case 'thinking':
      return event.text.trim() === ''
        ? null
        : { kind: 'thinking', stage: event.stage, text: limitText(event.text, MAX_PROGRESS_TEXT) };
    case 'content':
      return event.text === ''
        ? null
        : { kind: 'content', stage: event.stage, text: limitText(event.text, MAX_PROGRESS_TEXT) };
    case 'tool':
      return {
        kind: 'tool',
        stage: event.stage,
        name: oneLine(event.name, 120),
        status: event.status,
        ...(event.index === undefined ? {} : { index: event.index }),
      };
    case 'patch':
      return { kind: 'patch', stage: event.stage, path: oneLine(event.path, 300), op: event.op };
    case 'file':
      return {
        kind: 'file',
        stage: event.stage,
        status: event.status,
        path: oneLine(event.path, 300),
        ...(event.bytes === undefined ? {} : { bytes: event.bytes }),
      };
    case 'question':
      return { kind: 'question', stage: event.stage, id: oneLine(event.id, 80), text: limitText(event.text, 2_000) };
  }
}

/** 单会话进度环：最近 200 条 + 订阅者；取消订阅幂等。 */
export class SessionProgress {
  private seq = 0;
  private readonly events: WebProgressEvent[] = [];
  private readonly subscribers = new Set<WebProgressListener>();
  private readonly onChange: ((count: number) => void) | undefined;

  constructor(onChange?: (count: number) => void) {
    this.onChange = onChange;
  }

  get latestSeq(): number {
    return this.seq;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** 从旧到新；afterSeq 为空时返回最近全部事件，用于首次连接 / 无 Last-Event-ID 的重连。 */
  since(afterSeq: number | null = null): readonly WebProgressEvent[] {
    return this.events.filter((event) => afterSeq === null || event.seq > afterSeq).map((event) => ({ ...event }));
  }

  emit(draft: WebProgressDraft): void {
    const event: WebProgressEvent = {
      seq: this.seq + 1,
      at: Date.now(),
      ...draft,
    };
    this.seq = event.seq;
    this.events.push(event);
    if (this.events.length > MAX_PROGRESS_EVENTS) {
      this.events.splice(0, this.events.length - MAX_PROGRESS_EVENTS);
    }
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // 单个浏览器连接写失败不能影响设计任务；订阅者自己负责清理。
      }
    }
  }

  emitInteraction(event: InteractionProgressEvent): void {
    const mapped = mapProgress(event);
    if (mapped !== null) this.emit(mapped);
  }

  subscribe(listener: WebProgressListener): () => void {
    this.subscribers.add(listener);
    this.notifyCount();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.subscribers.delete(listener)) this.notifyCount();
    };
  }

  private notifyCount(): void {
    try {
      this.onChange?.(this.subscribers.size);
    } catch {
      // 诊断回调不应影响 SSE 连接。
    }
  }
}
