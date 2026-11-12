/**
 * @pg/render 的公开错误类型（RENDER-SPEC §4.1）。
 *
 * 负责：调用方的程序错误（请求参数不合法）抛 RenderError。
 * 运行期失败（timeout / crashed / unsupported / too-large / empty）按 §4.1 用 RenderResult 返回，不抛。
 */

export type RenderErrorCode = 'invalid-request';

export class RenderError extends Error {
  readonly code: RenderErrorCode;

  constructor(code: RenderErrorCode, message: string) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}
