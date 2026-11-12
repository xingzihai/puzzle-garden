/**
 * `@huggingface/tokenizers` 0.2.0 的最小类型声明（tsconfig `paths` 指向这里；运行时仍加载真实的包）。
 *
 * 为什么手写：这个包自带的 `types/index.d.ts` 用不带扩展名的相对导入（`./core/Tokenizer`），
 * 在本仓库的 `moduleResolution: NodeNext` + `skipLibCheck: false` 下解析失败，类型全部变成 error。
 * 不为一个工具依赖关掉全仓库的 skipLibCheck，也不在调用处写 any；这里按包内
 * `types/core/Tokenizer.d.ts` 原样摘出用到的两个签名。升级这个包时核对签名；
 * 结果是否正确由 tools/tokens.test.ts 对照官方参考实现逐 token 检查。
 */

export interface Encoding {
  ids: number[];
}

export declare class Tokenizer {
  constructor(tokenizer: object, config: object);
  encode(text: string, options?: { add_special_tokens?: boolean }): Encoding;
}
