/**
 * DeepSeek V4 token 计数（评分卡指标 8，决策 #65）。读 assets/deepseek-v4/ 的官方 tokenizer，只做离线计数，不联网。
 *
 * 计数：只编码文本，不加 BOS / EOS。是否将文本放进提示词由调用方决定；不估算接口包装与计费。
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Tokenizer } from '@huggingface/tokenizers';
import { z } from 'zod';

const DIR = fileURLToPath(new URL('../assets/deepseek-v4/', import.meta.url));

export interface TokenCounter {
  readonly count: (text: string) => number;
  readonly encode: (text: string) => readonly number[];
  /** 官方压缩包的 sha256；评分卡写出它，换版本的结果不混算（DESIGN §3.6）。 */
  readonly version: string;
}

export function loadTokenCounter(): TokenCounter {
  const source = z
    .object({
      zipSha256: z.string().length(64),
      files: z.record(z.string(), z.object({ sha256: z.string().length(64), bytes: z.number().int().nonnegative() })),
    })
    .loose()
    .parse(JSON.parse(readFileSync(`${DIR}source.json`, 'utf8')));
  function readVerified(name: string): unknown {
    const expected = source.files[name];
    if (expected === undefined) throw new Error(`source.json 缺少 ${name} 的 sha256`);
    const bytes = readFileSync(`${DIR}${name}`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected.sha256 || bytes.length !== expected.bytes) {
      throw new Error(`${name} 内容与 source.json 不符：sha256 ${actual}，字节数 ${String(bytes.length)}`);
    }
    return JSON.parse(bytes.toString('utf8'));
  }
  const json = readVerified('tokenizer.json');
  const config = readVerified('tokenizer_config.json');
  // 库按自己的 JSON 结构读取这两份文件；它们经导入脚本校验过 sha256，与官方逐字节相同。
  const object = z.record(z.string(), z.unknown());
  const tok = new Tokenizer(object.parse(json), object.parse(config));
  const encode = (text: string): readonly number[] => tok.encode(text, { add_special_tokens: false }).ids;
  return { encode, count: (text) => encode(text).length, version: source.zipSha256.slice(0, 12) };
}
