/**
 * 草模 agent 演练的真实 / 离线依赖组装（MODELING-SPEC §5、AGENT-TARGET.md）。
 *
 * 负责：读手写示例代码与种子稿、解析剧本、组装 mock 模型 client（真实 SSE 字节，不联网）、
 *   计算与记录组件版本（git 快照 + dirty diff、modelingDts、modelFormat）、生成固定演示剧本、
 *   提供 runner 用的真实墙钟（`realClock` / `realSleep`）。
 * 不负责：CLI 参数解析与接线（tools/model-agent.ts）、隔离执行（@pg/sandbox/modeling）、
 *   渲染（@pg/web/model-render）——分别由 CLI 注入。
 *
 * 这里的所有模型请求都走 `@pg/llm/mock` 的剧本 fetch，不读环境、不碰全局 fetch；
 * 真实沙箱执行与 Chrome 渲染是真实程序，但 LLM 是 mock：输出必须明确标注。
 * mock client 用自带虚拟时钟跑 SSE，**不与 runner 的时间混用**：runner 的 `clock` / `sleep`
 * 由 `realClock` / `realSleep` 提供，真实 bwrap / Chrome 的等待才会计入 `wallMs` 与事实行。
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ExternalVersions } from '@pg/agent/runner';
import { createClient } from '@pg/llm/client';
import type { ChatClient } from '@pg/llm/client';
import { ScriptSchema, createScriptedFetch, createVirtualTime } from '@pg/llm/mock';
import type { Script } from '@pg/llm/mock';
import { MODEL_DECLARATION } from '@pg/modeling/declaration';
import { MODEL_VERSION } from '@pg/modeling/schema';
import { sandboxVersion } from '@pg/sandbox/run';
import type { RunWriter } from '@pg/store/run-dir';

/**
 * 建模算法 / API 版本。MODEL_DECLARATION 变化会改 `modelingDts`；本数字只在建模语义（坐标约定、
 * box/revolve/extrude 行为）发生不兼容变化时手动加 1，与 `@pg/modeling` 的 MODEL_VERSION 分开记。
 * 决策 #113 起部件支持可选 `material`、声明新增 `material?: string`，与 modelFormat 2 同步升为 2。
 */
export const MODELING_API = 2;
/** 建模代码 UTF-8 字节上限，与 @pg/sandbox/modeling-protocol 同口径（MODELING-SPEC §4）。 */
export const MODEL_MAX_CODE_BYTES = 256 * 1024;
/** 演练 run 目录根的默认值（不入库）。 */
export const DEFAULT_DEMO_OUT = '.work/modeling-demo';
/** 演练题面：粗骨架、函数形体，不要求墙 / 座席 / 台阶。 */
export const MODEL_DEMO_TASK =
  '用函数建模代码做一个粗空间造型：一个粗基座、一个幂函数收分屋面、一个贝塞尔自由曲面壳，以及一个凸多边形体块；只做体量与主要造型。';
/** 提交说明：把"这是演练、不是真实模型能力"写进交付，避免验收时误读。 */
export const MODEL_DEMO_NOTE =
  '离线演练交付：代码由固定 mock 剧本驱动，模型代码是仓库内手写示例（benchmark/modeling/function-study.ts），不是真实 LLM 生成。';

/** 示例稿里被"弄坏"的那一行，以及修复后的原文；两处字符串都必须在代码里恰好出现一次。 */
export const DEMO_FIX = {
  fixed: 'const powerRadius = (t: number): number => 12 * (1 - t) ** 1.8;',
  broken: 'const powerRadius = (t: number): number => (12 * (1 - t) ** 1.8) / (t - t);',
} as const;

/** git 快照；diff 为未提交改动（含已跟踪文件的修改），无改动时为 null。 */
export interface GitSnapshot {
  readonly commit: string;
  readonly dirty: boolean;
  readonly diff: Uint8Array | null;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 仓库根：本文件在 tools/，上溯一层。 */
function repoRoot(): string {
  return fileURLToPath(new URL('../', import.meta.url));
}

/** `@pg/modeling` 可见声明的 hash；进 `versions.modelingDts`。 */
export function modelingDtsHash(): string {
  return sha256Hex(MODEL_DECLARATION);
}

/**
 * 读真实 git 快照：commit + `status --porcelain` 判 dirty + `git diff HEAD` 原文。
 * diff 只含已跟踪文件的修改（未跟踪文件不在 `git diff HEAD` 里，但仍会让 dirty=true）。
 */
export function gitSnapshot(cwd: string = repoRoot()): GitSnapshot {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd }).trim();
  const dirty = status !== '';
  const diff = dirty ? execFileSync('git', ['diff', 'HEAD'], { cwd, maxBuffer: 64 * 1024 * 1024 }) : null;
  return { commit, dirty, diff };
}

/** run.start 的 ExternalVersions（草模分支）：git 的 dirty diff 在这里进 blob，得到真实 Ref。 */
export function modelExternalVersions(store: RunWriter, precheck: string, git: GitSnapshot): ExternalVersions {
  return {
    git: { commit: git.commit, dirty: git.dirty, diff: git.diff === null ? null : store.putBlob(git.diff) },
    node: process.version,
    precheck,
    sandbox: sandboxVersion(),
    target: 'modeling',
    modelingApi: MODELING_API,
    modelingDts: modelingDtsHash(),
    modelFormat: MODEL_VERSION,
  };
}

/** 读种子稿：空 / 全空白或超过代码上限都报错，不静默回退（STANDARDS §4）。 */
export function readModelSeedCode(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`${path} 读不到（${error instanceof Error ? error.message : String(error)}）。`, { cause: error });
  }
  if (bytes.length > MODEL_MAX_CODE_BYTES) {
    throw new Error(
      `种子稿 ${path} 有 ${String(bytes.length)} 字节，超过代码上限 ${String(MODEL_MAX_CODE_BYTES)} 字节。`,
    );
  }
  const code = bytes.toString('utf8');
  if (code.trim() === '') throw new Error(`种子稿 ${path} 是空文件或全空白：当前稿第 1 版必须有内容。`);
  return code;
}

/** 读剧本：UTF-8 → JSON → ScriptSchema；读不到 / 非法 JSON / schema 不过都报可读错误。 */
export function readModelScript(path: string): { readonly script: Script; readonly sha256: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`剧本 ${path} 读不到（${error instanceof Error ? error.message : String(error)}）。`, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`剧本 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const parsed = ScriptSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`);
    throw new Error(`剧本 ${path} 不合 ScriptSchema：${issues.join('；')}`);
  }
  return { script: parsed.data, sha256: sha256Hex(bytes) };
}

/** 手写示例稿路径（供 model:build 或默认演练读取）。 */
export function demoCodePath(): string {
  return fileURLToPath(new URL('../benchmark/modeling/function-study.ts', import.meta.url));
}

/** 读手写示例稿（合法建模代码）。 */
export function loadDemoCode(): string {
  return readModelSeedCode(demoCodePath());
}

/**
 * 把示例稿里的一行换成运行期出错的版本（`/ (t - t)` 使采样变 NaN）。
 * 找不到或出现多次都抛错——演示剧本必须建立在确定的源码上（STANDARDS §4）。
 */
export function brokenDemoCode(goodCode: string): string {
  const occurrences = goodCode.split(DEMO_FIX.fixed).length - 1;
  if (occurrences !== 1) throw new Error(`示例稿里修复行应恰好出现 1 次，实际 ${String(occurrences)} 次`);
  return goodCode.replace(DEMO_FIX.fixed, DEMO_FIX.broken);
}

/**
 * 固定演示剧本：坏码 → 执行报错 → 局部修复 → 成功 → 看图 → 提交。
 * 每步带 `expect`，mock 剧本走偏时立即失败，而不是继续演下去。
 */
export function buildDemoScript(input: {
  readonly task: string;
  readonly goodCode: string;
  readonly note: string;
}): Script {
  const badCode = brokenDemoCode(input.goodCode);
  return ScriptSchema.parse({
    name: 'model-demo',
    task: input.task,
    steps: [
      {
        expect: { lastUserIncludes: ['函数建模'] },
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'write_code', arguments: { code: badCode } },
            { name: 'run_model', arguments: {} },
          ],
        },
      },
      {
        expect: { toolIncludes: ['执行出错'] },
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            {
              name: 'edit_code',
              arguments: { edits: [{ find: DEMO_FIX.broken, replace: DEMO_FIX.fixed }] },
            },
            { name: 'run_model', arguments: {} },
          ],
        },
      },
      {
        expect: { toolIncludes: ['执行成功'] },
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'view_model', arguments: {} }] },
      },
      {
        expect: { imageBlocks: 3 },
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [{ name: 'submit_model', arguments: { note: input.note } }],
        },
      },
    ],
  });
}

/** runId = `<UTC yyyyMMdd-HHmmss>-model-<6 位十六进制>`；每次不同，避免覆盖已有 run 目录。 */
export function modelRunId(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
  return `${stamp}-model-${randomBytes(3).toString('hex')}`;
}

/**
 * mock 模型运行时：client 内部用自带的虚拟时钟跑 mock SSE（不与 runner 的真实墙钟混用）。
 * `script` 是进 run.start 的剧本元数据（名称 + 内容 sha256，不是伪 git hash）。
 */
export interface MockModelRuntime {
  readonly client: ChatClient;
  readonly script: { readonly name: string; readonly sha256: string };
}

/** 用剧本造 mock client；seed 决定 SSE 字节切法与 callId 合成（同种子可复现）。 */
export function createMockModelRuntime(script: Script, seed: number): MockModelRuntime {
  const vt = createVirtualTime();
  const client = createClient({
    config: { baseUrl: 'https://mock.invalid', apiKey: 'mock', timeoutMs: 600_000 },
    fetch: createScriptedFetch(script, seed),
    sleep: vt.sleep,
    clock: vt.clock,
  });
  return { client, script: { name: script.name, sha256: sha256Hex(JSON.stringify(script)) } };
}

/**
 * runner 的墙钟来源必须是真实单调时间：真实 bwrap 执行与 Chrome 渲染要让 `wallMs` 与事实行
 * 计入真实耗时。mock 只影响 LLM 请求本身，不影响这段真实时间（`createMockModelRuntime` 的虚拟时钟
 * 只给 client 用）。
 */
export function realClock(): number {
  return performance.now();
}

/**
 * 可中止的真实定时器（runner / tool-stage 的墙钟截止用）：到点 resolve；signal 中止时立刻 reject
 * 并清定时器。中止是预期退出，调用方（runner / tool-stage）已按 `signal.aborted` 忽略这个 rejection。
 */
export function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('This operation was aborted', 'AbortError'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
