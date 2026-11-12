/**
 * sandbox 的宿主错误类型：可预期的宿主缺陷（声明无效、协议不符、spawn 失败、内部错误）。
 * 模型代码的错误不是它；模型错误由预检诊断或执行结果表达（SANDBOX-SPEC §6）。
 */

export type SandboxErrorCode = 'invalid-declaration' | 'protocol-error' | 'spawn-failed' | 'internal';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}
