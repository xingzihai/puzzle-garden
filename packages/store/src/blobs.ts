/**
 * 内容寻址 blob 存储（MODEL-SPEC §7.1、§8）。
 *
 * 负责：按 sha256 把二进制落盘到 `blobs/<sha256>`、按 sha 读回；相同字节只写一次（天然去重）；
 *       sha256 路径白名单校验。
 * 不负责：事件与请求清单（run-dir.ts / request-codec.ts）。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Ref } from './events.ts';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 小写十六进制 sha256。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface BlobStore {
  /** 写入（已存在则跳过），返回引用。 */
  put(bytes: Uint8Array): Ref;
  /** 读回；不存在或 sha 非法时抛错。 */
  get(sha256: string): Uint8Array;
  has(sha256: string): boolean;
}

/** 打开（必要时创建）目录下的内容寻址存储。 */
export function createBlobStore(dir: string): BlobStore {
  mkdirSync(dir, { recursive: true });
  const pathOf = (sha256: string): string => {
    if (!SHA256_PATTERN.test(sha256))
      throw new Error(`blob sha256 必须是 64 位小写十六进制，实际是 ${JSON.stringify(sha256)}`);
    return join(dir, sha256);
  };
  return {
    put(bytes: Uint8Array): Ref {
      const sha256 = sha256Hex(bytes);
      const path = pathOf(sha256);
      if (!existsSync(path)) writeFileSync(path, bytes);
      return { sha256, bytes: bytes.length };
    },
    get(sha256: string): Uint8Array {
      const path = pathOf(sha256);
      if (!existsSync(path)) throw new Error(`blob 不存在：${sha256}`);
      return new Uint8Array(readFileSync(path));
    },
    has(sha256: string): boolean {
      const path = pathOf(sha256);
      return existsSync(path);
    },
  };
}
