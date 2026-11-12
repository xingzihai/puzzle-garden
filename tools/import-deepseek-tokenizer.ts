/**
 * 一次性导入脚本：DeepSeek V4 官方 tokenizer（指标 8 的 token 计数用，决策 #65）。
 *
 * 为什么需要：API 说明每次请求都要付 token，评分卡指标 8 要报真实 token 数，不能用字符数估算。
 * deepseek-flash 是 DeepSeek-V4.1-Flash（官方定价页），官方 tokenizer 页只提供这一个 V4 tokenizer。
 *
 * 本脚本不联网。先手动下载官方压缩包（官方文档 https://api-docs.deepseek.com/quick_start/token_usage 的链接）：
 *   curl -L -o deepseek_v4_tokenizer.zip https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip
 * 再运行：node tools/import-deepseek-tokenizer.ts <压缩包路径>
 *
 * 输出 assets/deepseek-v4/：tokenizer.json 与 tokenizer_config.json 与压缩包里逐字节相同（计数库要原格式），
 * 来源、压缩包与各文件的 sha256 写在 source.json。压缩包里的 Python 示例脚本不导入。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 2026-10-02 下载的官方压缩包。换版本时改这里，并记决策（评分按版本分开统计，DESIGN §3.6）。 */
export const EXPECTED_ZIP_SHA256 = 'e7310d1dafe0a86d8a5629fe78a7c763760f651db9b8682718a1781dcd6fe495';
const SOURCE_URL = 'https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip';
const FILES = ['tokenizer.json', 'tokenizer_config.json'] as const;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function main(): void {
  const zip = process.argv[2];
  if (zip === undefined)
    throw new Error('用法：node tools/import-deepseek-tokenizer.ts <deepseek_v4_tokenizer.zip 路径>');
  const zipBytes = readFileSync(zip);
  const zipHash = sha256(zipBytes);
  if (zipHash !== EXPECTED_ZIP_SHA256) {
    throw new Error(
      `压缩包 sha256 ${zipHash} 与登记的 ${EXPECTED_ZIP_SHA256} 不符：官方可能更新了 tokenizer。` +
        '确认是新版本后改 EXPECTED_ZIP_SHA256 并记决策；不要静默导入',
    );
  }
  const work = mkdtempSync(join(tmpdir(), 'pg-tokenizer-'));
  try {
    // 参数数组调用，不拼 shell 字符串（STANDARDS §7）
    execFileSync('unzip', ['-q', '-o', zip, '-d', work], { stdio: 'inherit' });
    const root = fileURLToPath(new URL('..', import.meta.url));
    const outDir = join(root, 'assets/deepseek-v4');
    mkdirSync(outDir, { recursive: true });
    const files: Record<string, { sha256: string; bytes: number }> = {};
    for (const name of FILES) {
      const bytes = readFileSync(join(work, 'deepseek_v4_tokenizer', name));
      writeFileSync(join(outDir, name), bytes);
      files[name] = { sha256: sha256(bytes), bytes: bytes.length };
    }
    const source = {
      $comment: '由 tools/import-deepseek-tokenizer.ts 生成，勿手改。',
      model: 'deepseek-flash（DeepSeek-V4.1-Flash，官方定价页 2026-10-02）',
      url: SOURCE_URL,
      docs: 'https://api-docs.deepseek.com/quick_start/token_usage',
      downloaded: '2026-10-02',
      zipSha256: zipHash,
      files,
    };
    writeFileSync(join(outDir, 'source.json'), `${JSON.stringify(source, null, 1)}\n`);
    console.log(`导入 ${FILES.join('、')} → ${relative(root, outDir)}/`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
