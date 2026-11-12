/** 对话层与调用方共享的 I/O 类型；纯类型文件，避免 conversation.ts 继续膨胀。 */
import type { ClarificationQuestion } from './session.ts';

/** 对话层需要的全部 I/O；没有 confirm 时用 ask + yes/no 解析。 */
export interface ConversationIO {
  say(text: string): void;
  ask(question: string): Promise<string>;
  confirm?(question: string): Promise<boolean>;
  /** 可选：让脚本化 IO 能按 questionId 匹配预置回答；缺省退化为 ask(text)。 */
  askQuestion?(question: ClarificationQuestion): Promise<string>;
}

/** 产物路径与 store.ts 的 ArtifactPaths 结构一致；在这里声明以免纯函数入口 import 非纯文件。 */
export interface ConversationArtifactPaths {
  readonly sessionDir: string;
  readonly design: string;
  readonly task: string;
  readonly spec: string;
  readonly gates: string;
  readonly promptMeta: string;
  readonly designIntent?: string;
}
