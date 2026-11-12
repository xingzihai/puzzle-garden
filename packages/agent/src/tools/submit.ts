/**
 * submit 的通过条件（AGENT-SPEC §4.4）。
 *
 * 负责：机械判断"当前稿版本 = 最近一次 check_code 的版本，且那次执行成功"。
 * 不负责：渲染交付、写 delivery/（runner）；不要求看过图、不要求测量为 0。
 * 本文件是纯函数：只读传入的版本状态。类型从 facts.ts 取（同为纯入口）。
 */

import type { CheckOutcome } from '@pg/agent/facts';
import type { GateOutcome } from '../gates.ts';

export interface SubmitInput {
  /** 当前稿版本；还没有代码时为 null。 */
  readonly draftVersion: number | null;
  /** 最近一次 check_code 的版本与结果；没检查过为 null。 */
  readonly lastCheck: {
    readonly version: number;
    readonly outcome: CheckOutcome;
    /** 配了 `--gates` 且执行成功时的门槛判定（AGENT-SPEC §5.1）。 */
    readonly gates?: GateOutcome;
  } | null;
  /** 本阶段是否要求先写设计文档（AGENT-SPEC §4.5）；缺省 false（两层实验的 skeleton / refine 才要求）。 */
  readonly requireDesign?: boolean;
  /** 当前设计文档内容；requireDesign 为 true 且为空串时拒绝提交。 */
  readonly design?: string;
}

export interface SubmitAccepted {
  readonly accepted: true;
  readonly text: string;
}

export interface SubmitRejected {
  readonly accepted: false;
  readonly text: string;
}

export type SubmitResult = SubmitAccepted | SubmitRejected;

const OUTCOME_TEXT: Record<Exclude<CheckOutcome, 'ok'>, string> = {
  'precheck-failed': '类型预检未通过',
  'build-error': '执行出错',
  'not-finished': '执行未完成',
};

/** 通过条件（C14 之"提交条件"）：返回是否接受与给模型看的说明。 */
export function submit(input: SubmitInput): SubmitResult {
  if (input.requireDesign === true && (input.design ?? '') === '') {
    return { accepted: false, text: '还没有设计文档，先 write_design 再 submit。' };
  }
  if (input.draftVersion === null) {
    return { accepted: false, text: '当前稿还没有代码，先 write_code。' };
  }
  const version = input.draftVersion;
  if (input.lastCheck === null) {
    return { accepted: false, text: `当前稿第 v${String(version)} 版还没检查，先 check_code。` };
  }
  if (input.lastCheck.version !== version) {
    return {
      accepted: false,
      text:
        `当前稿第 v${String(version)} 版还没检查（最近检查的是第 v${String(input.lastCheck.version)} 版），` +
        '先 check_code。',
    };
  }
  if (input.lastCheck.outcome !== 'ok') {
    return {
      accepted: false,
      text: `第 v${String(version)} 版${OUTCOME_TEXT[input.lastCheck.outcome]}，先修改并 check_code 成功后再 submit。`,
    };
  }
  const gates = input.lastCheck.gates;
  if (gates !== undefined && !gates.passed) {
    return {
      accepted: false,
      text: `第 v${String(version)} 版没过骨架门槛（${gates.failed.join('；')}），先修改并 check_code 让门槛全过后再 submit。`,
    };
  }
  return { accepted: true, text: `已提交第 v${String(version)} 版。` };
}
