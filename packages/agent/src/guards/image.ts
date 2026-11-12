/**
 * 图片预算护栏（AGENT-SPEC §6.2）：累计 base64 字节 > 32 MB 警告并拒绝后续 view_building；
 * > 40 MB 停止（官方请求体上限 48 MiB）。
 *
 * `viewAllowed` 供 runner 在 view_building 前查询；本文件纯函数，不自己发警告，只返回动作。
 */

import type { Guard, GuardAction, GuardState } from '@pg/agent/guards/types';

/** 软上限：超过后拒绝新的 view_building（AGENT-SPEC §6.2）。 */
export const IMAGE_BYTES_SOFT = 32 * 1024 * 1024;
/** 硬上限：超过后停止 run（官方请求体 48 MiB 的余量）。 */
export const IMAGE_BYTES_HARD = 40 * 1024 * 1024;

const MB = 1024 * 1024;

/** 是否还允许调用 view_building。 */
export function viewAllowed(imageBytes: number, soft = IMAGE_BYTES_SOFT): boolean {
  return imageBytes <= soft;
}

function warnText(imageBytes: number, soft: number): string {
  return (
    `累计图片 ${String(Math.round(imageBytes / MB))} MB，超过 ${String(soft / MB)} MB：` +
    '后续 view_building 将被拒绝。'
  );
}

function beforeRequest(state: GuardState): GuardAction {
  return state.imageBytes > state.imageBytesHard ? { stop: 'image-budget' } : 'continue';
}

function afterTurn(state: GuardState): GuardAction {
  if (state.imageBytes > state.imageBytesHard) return { stop: 'image-budget' };
  if (state.imageBytes > state.imageBytesSoft) return { warn: warnText(state.imageBytes, state.imageBytesSoft) };
  return 'continue';
}

export const imageGuard: Guard = {
  name: 'image',
  beforeRequest,
  afterTurn,
};
