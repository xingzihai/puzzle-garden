/**
 * 入口无高差 / 无台阶 must 的共享文本匹配器。
 *
 * 只做一件事：判断一段 must 文本是否要求 flush entry。Design 的 FloorDatum 与
 * Build / Verification 的 conformance 必须共用同一个函数，避免各自维护正则。
 */
const FLUSH_REQUIREMENT_PATTERN = /(?:齐平|无高差|无台阶|不设台阶|flush)/iu;

/** 匹配 `齐平` / `无高差` / `无台阶` / `不设台阶` / `flush`，可出现在长句中。 */
export function isFlushMustText(text: string): boolean {
  return FLUSH_REQUIREMENT_PATTERN.test(text);
}
