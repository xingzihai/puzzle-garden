/**
 * massing 测试的共享夹具（SUBAGENT-LOOP-SPEC §8 的 mock 剧本）。
 *
 * 负责：假 execute / render / renderContact 与两个剧本 client 的组装、父 runner 依赖、直接调用
 *   `runMassingTool` 的测试上下文、临时目录清理；不放断言。
 * 不负责：测试用例本身（massing/host.test.ts 与 massing/host-edges.test.ts）。
 * 放 fixtures/ 而非 src/：这是测试夹具，不属于产品代码（与 packages/geometry/fixtures 同例）。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRegistry } from '@pg/blocks/load';
import type { ChatClient } from '@pg/llm/client';
import { createClient } from '@pg/llm/client';
import { createScriptedFetch, createVirtualTime, ScriptSchema } from '@pg/llm/mock';
import type { VirtualTime } from '@pg/llm/mock';
import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';
import type { ModelExecution } from '@pg/sandbox/modeling';
import type { Event, RunLimits } from '@pg/store/events';
import { createRunDir, openRunDir } from '@pg/store/run-dir';

import type { MassingHostDeps, MassingToolHost } from '../src/massing/host.ts';
import type { ExternalVersions, RunnerDeps, RunnerInput } from '../src/runner.ts';
import { runRun } from '../src/runner.ts';
import type { TargetBudget } from '../src/target.ts';
import { initialToolState } from '../src/turn-tools.ts';
import type { ToolContext } from '../src/turn-tools.ts';

export const REGISTRY = loadRegistry();
export const TASK = { raw: '摆一个粗体量', fed: '摆一个粗体量', source: null };
export const SHORT_WORLD = 'declare const x: 1;\n';
export const CHILD_CODE =
  'export default function build(model: Model): void {\n' +
  '  model.box({ id: "b", name: "块", role: "volume", color: "#112233", size: [2, 2, 2] });\n' +
  '}\n';
/** 假的 contact PNG 字节；单测不解析画幅，尺寸由 web 集成测试把关。 */
export const CONTACT_PNG = Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]);

export function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeDocument(): ModelDocument {
  const model = createModel();
  model.box({ id: 'b', name: '块', role: 'volume', color: '#112233', size: [2, 2, 2] });
  return model.finish();
}

export const DOC = makeDocument();
export const DOC_HASH = sha(JSON.stringify(DOC));

export const CHILD_VERSIONS: ExternalVersions = {
  git: { commit: 'child', dirty: false, diff: null },
  node: '24',
  precheck: 'mp',
  sandbox: 'ms',
  target: 'modeling',
  modelingApi: 2,
  modelingDts: 'd',
  modelFormat: 2,
};
export const PARENT_VERSIONS: ExternalVersions = {
  git: { commit: 'parent', dirty: false, diff: null },
  node: '24',
  precheck: 'p',
  sandbox: 's',
  worldApi: 8,
  worldDts: sha('dts'),
  archiveFormat: 1,
  analysis: 'a',
};
export const PARENT_LIMITS: RunLimits = { maxCostCny: 3.5, maxTurns: 4, wallMs: 2_400_000, submitWindow: 2 };

export function okExecution(code: string): ModelExecution {
  return { kind: 'ok', document: DOC, codeHash: sha(code), documentHash: DOC_HASH, console: [], consoleTruncated: 0 };
}

export function call(name: string, args: unknown): { name: string; arguments: unknown } {
  return { name, arguments: args };
}

export function messageStep(toolCalls: readonly { name: string; arguments: unknown }[], expect?: unknown): unknown {
  return {
    ...(expect === undefined ? {} : { expect }),
    reply: { kind: 'message', content: null, toolCalls },
  };
}

export function clientFor(script: unknown): { readonly client: ChatClient; readonly vt: VirtualTime } {
  const parsed = ScriptSchema.parse(script);
  const vt = createVirtualTime();
  const client = createClient({
    config: { baseUrl: 'https://mock.invalid', apiKey: 'mock', timeoutMs: 600_000 },
    fetch: createScriptedFetch(parsed, 7),
    sleep: vt.sleep,
    clock: vt.clock,
  });
  return { client, vt };
}

const ROOTS: string[] = [];

/** 每个测试文件在自己的 afterEach 里调用，删掉本次用过的临时 run 目录。 */
export function cleanupRoots(): void {
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** 断言语义的取首元素：测试夹具专用（产品代码不这样取）。 */
export function firstOf<T>(values: readonly T[]): T {
  const first = values[0];
  if (first === undefined) throw new Error('测试夹具期望非空数组');
  return first;
}

export const CHILD_STEPS = [
  messageStep([call('write_code', { code: CHILD_CODE })]),
  messageStep([call('run_model', {})]),
  messageStep([call('view_model', {})]),
  messageStep([call('submit_model', { note: '粗体量' })]),
];

export interface HarnessOptions {
  /** 父剧本步骤（ScriptStep 形状）。 */
  readonly parentSteps: readonly unknown[];
  /** 子剧本步骤；缺省用标准的 write_code → run_model → view_model → submit_model 四步。 */
  readonly childSteps?: readonly unknown[];
  readonly limits?: RunLimits;
  /** `null` 表示不接线 host；缺省用标准假依赖。 */
  readonly massing?: MassingHostDeps | null;
  readonly execute?: (code: string) => Promise<ModelExecution>;
  readonly renderContact?: MassingHostDeps['renderContact'];
  readonly controller?: AbortController;
}

export interface HarnessResult {
  readonly root: string;
  readonly dir: string;
  readonly outcome: Awaited<ReturnType<typeof runRun>>;
  readonly events: readonly Event[];
  readonly childDir: string;
  readonly childEvents: readonly Event[] | null;
}

/** 跑一次父 runner：体素 target + 假 check/render，子运行走注入的假依赖。 */
export async function runHarness(options: HarnessOptions): Promise<HarnessResult> {
  const root = mkdtempSync(join(tmpdir(), 'pg-massing-host-'));
  ROOTS.push(root);
  const parent = clientFor({ name: 'parent', task: TASK.fed, steps: options.parentSteps });
  const child = clientFor({ name: 'child', task: '子运行', steps: options.childSteps ?? CHILD_STEPS });
  const massing: MassingHostDeps | undefined =
    options.massing === null
      ? undefined
      : {
          client: child.client,
          execute: options.execute ?? ((code) => Promise.resolve(okExecution(code))),
          render: () =>
            Promise.resolve([
              { name: 'overall', png: Uint8Array.from([1, 2, 3]) },
              { name: 'top', png: Uint8Array.from([4, 5, 6]) },
              { name: 'side', png: Uint8Array.from([7, 8, 9]) },
            ]),
          renderContact: options.renderContact ?? (() => Promise.resolve({ name: 'contact', png: CONTACT_PNG })),
          versions: () => CHILD_VERSIONS,
          modeling: { modelingApi: 2, modelFormat: 2 },
          ...(options.massing ?? {}),
        };
  const store = createRunDir(root, 'parent-run');
  const deps: RunnerDeps = {
    client: parent.client,
    store,
    check: {
      prechecker: { check: () => Promise.reject(new Error('mock 脚本不该调用 check_code')) },
      runCode: () => Promise.reject(new Error('mock 脚本不该调用 check_code')),
      registry: REGISTRY,
    },
    render: () => Promise.reject(new Error('mock 脚本不该渲染体素')),
    worldDts: SHORT_WORLD,
    clock: parent.vt.clock,
    versions: PARENT_VERSIONS,
    countTokens: (text) => text.length,
    ...(massing === undefined ? {} : { massing }),
  };
  const input: RunnerInput = {
    task: TASK,
    seed: 7,
    limits: options.limits ?? PARENT_LIMITS,
    mode: 'script',
    variant: 'base',
    config: null,
  };
  const outcome = await runRun(input, {
    ...deps,
    ...(options.controller === undefined ? {} : { signal: options.controller.signal }),
  });
  const reader = openRunDir(outcome.dir);
  const events = reader.events();
  const childDir = join(outcome.dir, 'sub', 'massing-1');
  return {
    root,
    dir: outcome.dir,
    outcome,
    events,
    childDir,
    childEvents: existsSync(childDir) ? openRunDir(childDir).events() : null,
  };
}

/** 从父 run 目录读 tool.result 文本（blob 在同一个 store）。 */
export function textOf(dir: string, events: readonly Event[], name: string): readonly string[] {
  const reader = openRunDir(dir);
  return events
    .filter((event): event is Extract<Event, { type: 'tool.result' }> => event.type === 'tool.result')
    .filter((event) => event.body.name === name)
    .map((event) => new TextDecoder().decode(reader.blob(event.body.text.sha256)));
}

export function subrunsOf(events: readonly Event[]): Extract<Event, { type: 'subrun.result' }>[] {
  return events.filter((event): event is Extract<Event, { type: 'subrun.result' }> => event.type === 'subrun.result');
}

// ───────────── 直接调用 runMassingTool 的边界夹具 ─────────────

export interface DirectBudget extends TargetBudget {
  spent: number;
  reserved: number;
}

export function directBudget(limit = 3.5): DirectBudget {
  const budget: DirectBudget = {
    imageBytes: 0,
    images: 0,
    inWindow: false,
    spent: 0,
    reserved: 0,
    remainingCny: () => limit - budget.spent - budget.reserved,
    reserveSubrun: (cny) => {
      if (budget.spent + budget.reserved + cny > limit) return false;
      budget.reserved += cny;
      return true;
    },
    settleSubrun: (reservedCny, actualCny) => {
      if (actualCny > reservedCny + 1e-6) throw new Error('父预算不变量破坏');
      budget.reserved = Math.max(0, budget.reserved - reservedCny);
      budget.spent += actualCny;
    },
  };
  return budget;
}

/** 直接调用用的 host：默认一套假依赖，可覆盖 deps 与模式。 */
export function directHost(
  overrides: Partial<MassingHostDeps> = {},
  mode: MassingToolHost['mode'] = 'script',
): MassingToolHost {
  const child = clientFor({ name: 'child-direct', task: '子', steps: CHILD_STEPS });
  return {
    deps: {
      client: child.client,
      execute: (code) => Promise.resolve(okExecution(code)),
      render: () =>
        Promise.resolve([
          { name: 'overall', png: Uint8Array.from([1, 2, 3]) },
          { name: 'top', png: Uint8Array.from([4, 5, 6]) },
          { name: 'side', png: Uint8Array.from([7, 8, 9]) },
        ]),
      renderContact: () => Promise.resolve({ name: 'contact', png: CONTACT_PNG }),
      versions: () => CHILD_VERSIONS,
      modeling: { modelingApi: 2, modelFormat: 2 },
      ...overrides,
    },
    client: child.client,
    clock: () => 0,
    countTokens: (text) => text.length,
    mode,
    config: null,
  };
}

export function directContext(
  store: ReturnType<typeof createRunDir>,
  budget: TargetBudget,
  extras: {
    readonly signal?: AbortSignal;
    readonly remainingWallMs?: () => number;
    readonly massing?: MassingToolHost;
  } = {},
): ToolContext {
  return {
    store,
    turn: 1,
    seed: 7,
    clock: () => 0,
    check: {
      prechecker: { check: () => Promise.reject(new Error('不该预检')) },
      runCode: () => Promise.reject(new Error('不该执行体素')),
      registry: REGISTRY,
      clock: () => 0,
    },
    render: () => Promise.reject(new Error('不该渲染体素')),
    cache: { get: () => undefined, set: () => undefined },
    requireDesign: false,
    budget,
    remainingWallMs: extras.remainingWallMs ?? (() => 2_400_000),
    ...(extras.signal === undefined ? {} : { signal: extras.signal }),
    ...(extras.massing === undefined ? {} : { massing: extras.massing }),
  };
}

export function directStore(): ReturnType<typeof createRunDir> {
  const root = mkdtempSync(join(tmpdir(), 'pg-massing-direct-'));
  ROOTS.push(root);
  return createRunDir(root, 'direct-run');
}

export { initialToolState };
export type { Event };
