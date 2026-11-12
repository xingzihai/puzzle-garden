/* eslint-disable max-lines -- runner 剧本按 §10 逐场景回归；窗口先于首稿的用例与现有共享辅助同文件。 */
/**
 * runner 的剧本测试（AGENT-SPEC §10，除需要真沙箱 / 真 Chrome 的 success 与 replay）。
 *
 * 剧本 fetch（`@pg/llm/mock`）生成真实 SSE 字节流，真 client 在其上运行；check 用假 prechecker / runCode
 * （执行成功时返回真存档，测量照常跑），view 与交付用假 render；run 目录写进临时目录。
 * 每个剧本断言停止原因与关键事件，并核对 MODEL-SPEC §10 第 4 条（事件过 schema、请求可还原、trace 一致）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '@pg/blocks/load';
import type { DiffReport } from '@pg/analysis/object-diff';
import { writeArchive } from '@pg/core/archive';
import { hashGrid } from '@pg/core/hash';
import { API_VERSION, createWorld, rect } from '@pg/geometry';
import { createClient } from '@pg/llm/client';
import { createScriptedFetch, createVirtualTime, ScriptSchema } from '@pg/llm/mock';
import type { Script } from '@pg/llm/mock';
import type { ChatRequest } from '@pg/llm/schema';
import type { RenderRequest, RenderResult } from '@pg/render/render';
import type { PrecheckResult } from '@pg/sandbox/precheck';
import type { RunResult } from '@pg/sandbox/run';
import { deriveTrace } from '@pg/store/derive';
import type { Event, RunLimits } from '@pg/store/events';
import { createRunDir, openRunDir } from '@pg/store/run-dir';

import type { PromptVariant } from './prompt/system.ts';
import { runRun } from './runner.ts';
import type { RunOutcome, RunnerDeps, RunnerInput } from './runner.ts';

const registry = loadRegistry();
const FALLBACK_ASSETS = {
  source: 'fallback',
  mcVersion: null,
  models: 0,
  coveredBlocks: 0,
  states: 0,
  textures: 0,
} as const;
const WORLD_DTS = readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');
const SCRIPTS = fileURLToPath(new URL('../fixtures/scripts/', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'pg-runner-'));
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const DEFAULT_LIMITS: RunLimits = { maxCostCny: 3.5, maxTurns: null, wallMs: 2_400_000, submitWindow: 3 };
const SHORT_DTS = 'declare interface World { set(x: number, y: number, z: number, block: string): void }\n';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

/** 真实建造一个小样本，作为假 runCode 的成功存档。 */
const BUILT = (() => {
  const host = createWorld(registry.table);
  const w = host.world;
  const base = w.plinth({ footprint: rect(-4, -4, 4, 4), height: 1, material: 'stone_bricks' });
  const hall = w.walls({ on: base, height: 4, material: 'stone_bricks' });
  w.opening({ in: hall.facade('south'), kind: 'door', width: 1, height: 3 });
  w.roof({ on: hall, kind: 'flat', material: 'stone' });
  const { grid } = host.compose();
  return { grid, archive: writeArchive(grid, API_VERSION), hash: hashGrid(grid) };
})();

function fakePrecheck(code: string): PrecheckResult {
  if (!code.includes('stone_brikcs')) return { kind: 'ok' };
  return {
    kind: 'failed',
    total: 1,
    diagnostics: [
      {
        line: 3,
        column: 31,
        code: 'TS2820',
        message: `Type '"stone_brikcs"' is not assignable to type 'Material'. Did you mean '"stone_bricks"'?`,
        source: "  w.plinth({ material: 'stone_brikcs' });",
      },
    ],
  };
}
function fakeRun(code: string): RunResult {
  const report = { hash: '', calls: 0, overlaps: [], console: [], consoleTruncated: 0 };
  if (code.includes('mullion: 0')) {
    return {
      kind: 'build-error',
      report: {
        ...report,
        status: 'build-error',
        error: { name: 'Error', message: 'opening.mullion 应 ≥ 1，实际是 0', line: 3, column: 3 },
      },
      wallMs: 5,
    };
  }
  return {
    kind: 'ok',
    grid: BUILT.grid,
    archive: BUILT.archive,
    hash: BUILT.hash,
    report: { ...report, status: 'ok', hash: BUILT.hash, calls: BUILT.grid.calls().length },
    wallMs: 9,
  };
}
function fakeRender(requests: RenderRequest[]): RunnerDeps['render'] {
  return (_archive, request) => {
    requests.push(request);
    const result: RenderResult = {
      kind: 'ok',
      images: request.views.map((view) => ({
        view,
        png: PNG,
        sha256: createHash('sha256').update(PNG).digest('hex'),
        // prettier-ignore
        camera: { position: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], left: -1, right: 1, top: 1, bottom: -1, near: 0.1, far: 9 },
        pixelsPerCell: 11,
        bbox: [0, 0, 10, 10],
        frameFill: 0.5,
      })),
      // prettier-ignore
      scene: { cells: 1, faces: 6, belowGround: 0, skipped: 0, fallbackColor: [], simplified: {}, blockedRequests: 0, officialCells: 0, assets: FALLBACK_ASSETS },
      // prettier-ignore
      version: { protocol: 1, chrome: 'c', puppeteer: 'p', three: 't', flags: [], webglRenderer: 'w', cpuModel: 'cpu', assets: FALLBACK_ASSETS },
      wallMs: 3,
    };
    return Promise.resolve(result);
  };
}
function loadScript(name: string): Script {
  return ScriptSchema.parse(JSON.parse(readFileSync(join(SCRIPTS, `${name}.json`), 'utf8')) as unknown);
}

interface Ran {
  readonly outcome: RunOutcome;
  readonly events: readonly Event[];
  readonly renders: readonly RenderRequest[];
  readonly reader: ReturnType<typeof openRunDir>;
  /** 第 n 次 llm.request 的请求体（1 起）。 */
  request(n: number): ChatRequest;
  blobText(sha256: string): string;
  of<T extends Event['type']>(type: T): Extract<Event, { type: T }>[];
}

interface RunOptions {
  readonly model?: 'gpt-6.1-sol';
  readonly worldDts?: string;
  /** 内联剧本（不读 fixtures），用于边角路径。 */
  readonly script?: Script;
  /** 把虚拟时间的 sleep 交给 runner：墙钟到点取消请求。 */
  readonly wallTimer?: boolean;
  readonly signal?: AbortSignal;
  readonly runCode?: RunnerDeps['check']['runCode'];
  /** system 提示变体（决策 #84），缺省 base。 */
  readonly variant?: PromptVariant;
  /** 种子稿：当前稿从这段代码开始（分段实验第 2 段）。 */
  readonly initialDraft?: { readonly code: string };
  /** 两层实验第 2 层：上一阶段的设计文档与渲染图（作为第三条 user 消息）。 */
  readonly initialDesign?: string;
  readonly initialDesignKind?: RunnerInput['initialDesignKind'];
  readonly initialImages?: readonly { readonly name: string; readonly png: Uint8Array }[];
  /** W11-08：生产扩展字段；v2 才启用状态卡与历史压缩。 */
  readonly promptVersion?: RunnerInput['promptVersion'];
  readonly firstRequestBudget?: RunnerInput['firstRequestBudget'];
  readonly initialBuildSheet?: string;
  readonly designAuthority?: RunnerInput['designAuthority'];
  readonly check?: Partial<RunnerDeps['check']>;
}

async function runScript(name: string, limits: RunLimits = DEFAULT_LIMITS, options: RunOptions = {}): Promise<Ran> {
  const script = options.script ?? loadScript(name);
  const vt = createVirtualTime();
  const client = createClient({
    config: { baseUrl: 'https://mock.invalid', apiKey: 'test-key', timeoutMs: 600_000 },
    fetch: createScriptedFetch(script, 11),
    sleep: vt.sleep,
    clock: vt.clock,
  });
  const renders: RenderRequest[] = [];
  const store = createRunDir(ROOT, `run-${name}`);
  const outcome = await runRun(
    {
      task: { raw: script.task, fed: script.task, source: null },
      ...(options.model === undefined ? {} : { model: options.model }),
      seed: 1,
      limits,
      mode: 'script',
      variant: options.variant ?? 'base',
      ...(options.promptVersion === undefined ? {} : { promptVersion: options.promptVersion }),
      ...(options.firstRequestBudget === undefined ? {} : { firstRequestBudget: options.firstRequestBudget }),
      ...(options.designAuthority === undefined ? {} : { designAuthority: options.designAuthority }),
      ...(options.initialDraft === undefined ? {} : { initialDraft: options.initialDraft }),
      ...(options.initialDesign === undefined ? {} : { initialDesign: options.initialDesign }),
      ...(options.initialDesignKind === undefined ? {} : { initialDesignKind: options.initialDesignKind }),
      ...(options.initialBuildSheet === undefined ? {} : { initialBuildSheet: options.initialBuildSheet }),
      ...(options.initialImages === undefined ? {} : { initialImages: options.initialImages }),
      script: { name: script.name, sha256: 'a'.repeat(64) },
      config: null,
    },
    {
      client,
      check: {
        prechecker: { check: (code) => Promise.resolve(fakePrecheck(code)) },
        runCode: options.runCode ?? ((input) => Promise.resolve(fakeRun(input.code))),
        registry,
        ...options.check,
      },
      render: fakeRender(renders),
      store,
      clock: vt.clock,
      ...(options.wallTimer === true ? { sleep: vt.sleep } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      versions: {
        git: { commit: 'test', dirty: false, diff: null },
        node: process.version,
        worldApi: API_VERSION,
        worldDts: 'b'.repeat(64),
        precheck: 'p',
        sandbox: 's',
        archiveFormat: 1,
        analysis: 'a',
      },
      worldDts: options.worldDts ?? WORLD_DTS,
      countTokens: (text) => Math.ceil(text.length / 2),
    },
  );
  const reader = openRunDir(outcome.dir);
  const events = reader.events();
  const requests = events.filter((e) => e.type === 'llm.request');
  return {
    outcome,
    events,
    renders,
    reader,
    request: (n) => {
      const event = requests[n - 1];
      assert.ok(event !== undefined, `没有第 ${String(n)} 次请求`);
      return JSON.parse(new TextDecoder().decode(reader.request(event.seq))) as ChatRequest;
    },
    blobText: (sha) => new TextDecoder().decode(reader.blob(sha)),
    of: <T extends Event['type']>(type: T) => events.filter((e): e is Extract<Event, { type: T }> => e.type === type),
  };
}

/** MODEL-SPEC §10 第 4 条 + 每轮消息序（AGENT-SPEC §3.2）。 */
function assertRecord(ran: Ran): void {
  const { events, reader } = ran;
  assert.equal(events[0]?.type, 'run.start');
  assert.equal(events.at(-1)?.type, 'run.end');
  for (const e of events.filter((x) => x.type === 'llm.request')) {
    const sha = createHash('sha256').update(reader.request(e.seq)).digest('hex');
    assert.equal(sha, e.body.requestSha, `seq ${String(e.seq)} 的请求还原后 sha256 不一致`);
  }
  const trace = JSON.parse(readFileSync(join(reader.dir, 'trace.json'), 'utf8')) as unknown;
  assert.deepEqual(trace, JSON.parse(JSON.stringify(deriveTrace(events))) as unknown);
  // turn.start 都带 elapsedMs，且每轮恰好一个
  const turns = ran.of('turn.start');
  assert.deepEqual(
    turns.map((t) => t.turn),
    turns.map((_t, i) => i + 1),
  );
  // 每个请求里：tool 之间不插 user；每个 assistant 之后、下一个 assistant 之前恰好一条 user（事实行）
  const last = ran.request(ran.of('llm.request').length);
  const roles = last.messages.map((m) => m.role).join(',');
  assert.ok(!roles.includes('tool,user,tool'), roles);
  assert.match(roles, /^system,user(,user)?(,assistant(,tool)*,user)*$/);
}
function stopOf(ran: Ran): string | null {
  const end = ran.of('run.end')[0];
  assert.ok(end !== undefined);
  return end.body.stopReason;
}

function toolResults(ran: Ran): { name: string; status: string; text: string }[] {
  return ran
    .of('tool.result')
    .map((e) => ({ name: e.body.name, status: e.body.status, text: ran.blobText(e.body.text.sha256) }));
}

function assertDelivered(ran: Ran, codeVersion: number): void {
  assert.equal(stopOf(ran), null);
  assert.deepEqual(ran.outcome.delivery, { codeVersion, hash: BUILT.hash });
  const delivery = ran.of('delivery')[0];
  assert.ok(delivery !== undefined);
  assert.equal(delivery.body.codeVersion, codeVersion);
  assert.equal(delivery.body.hash, BUILT.hash);
  assert.equal(delivery.body.renders.length, 6);
  const dir = join(ran.reader.dir, 'delivery');
  assert.ok(existsSync(join(dir, 'building.ts')));
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'building.pgar'))), BUILT.archive);
  assert.equal(readdirSync(join(dir, 'render')).length, 6);
  assert.deepEqual(ran.renders.at(-1)?.views, ['iso-se', 'south', 'east', 'north', 'west', 'top']);
  const code = ran.of('code.version').find((e) => e.body.version === codeVersion);
  assert.ok(code !== undefined);
  assert.equal(readFileSync(join(dir, 'building.ts'), 'utf8'), ran.blobText(code.body.code.sha256));
}

describe('runner 剧本（AGENT-SPEC §10）', () => {
  it('variant：缺省 base，craft 记进 run.start.versions 且 system 含范例（决策 #84）', async () => {
    const inline = (name: string): Script => ({ ...loadScript('no-tool'), name });
    const base = await runScript('variant-base', undefined, { script: inline('variant-base') });
    const baseStart = base.of('run.start')[0];
    assert.ok(baseStart !== undefined);
    assert.equal(baseStart.body.versions.promptVariant, 'base');
    const baseSys = base.of('prompt.system')[0];
    assert.ok(baseSys !== undefined);
    assert.ok(!base.blobText(baseSys.body.system.sha256).includes('## 范例代码'));

    const craft = await runScript('variant-craft', undefined, {
      script: inline('variant-craft'),
      variant: 'craft',
    });
    const craftStart = craft.of('run.start')[0];
    assert.ok(craftStart !== undefined);
    assert.equal(craftStart.body.versions.promptVariant, 'craft');
    const craftSys = craft.of('prompt.system')[0];
    assert.ok(craftSys !== undefined);
    assert.ok(craft.blobText(craftSys.body.system.sha256).includes('## 范例代码'));
  });

  it('两层第 2 层：initialDesign + 两张 initialImages 进第 3 条消息；图片计入 imageBytes / images', async () => {
    const script = inline('two-layer', [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'write_code', arguments: { code: 'export default function build(w: World): void {}\n' } },
            { name: 'check_code', arguments: {} },
          ],
        },
      },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'submit', arguments: { note: '好' } }] } },
    ]);
    const png1 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const png2 = Uint8Array.from([1, 2, 3]);
    const ran = await runScript('two-layer', DEFAULT_LIMITS, {
      script,
      initialDesign: '# 骨架设计文档\n- 任务目标：教堂',
      initialImages: [
        { name: 'iso-se.png', png: png1 },
        { name: 'top.png', png: png2 },
      ],
    });
    const messages = ran.request(1).messages;
    assert.equal(messages.length, 3);
    const third = messages[2];
    if (third?.role !== 'user' || typeof third.content === 'string') {
      throw new Error('第三条消息应为含文本与图片块的 user 消息');
    }
    const parts = third.content;
    const first = parts[0];
    assert.ok(first?.type === 'text');
    assert.ok(first.text.includes('# 骨架设计文档'));
    assert.ok(first.text.includes('【参考材料】当前稿为空'));
    assert.ok(!first.text.includes('已替换'));
    assert.deepEqual(parts[1], { type: 'text', text: '"iso-se.png"' });
    assert.deepEqual(parts[3], { type: 'text', text: '"top.png"' });
    assert.equal(parts.filter((p) => p.type === 'image_url').length, 2);
    const expectedBytes = Buffer.from(png1).toString('base64').length + Buffer.from(png2).toString('base64').length;
    assert.equal(ran.of('llm.request')[0]?.body.imageBytes, expectedBytes);
    assert.equal(ran.of('llm.request')[0]?.body.images, 2);
    assertDelivered(ran, 1);
  });

  it('v2 设计源回读：read_design 标注只读摘要来源；write_design 后源与自写注记仍分开', async () => {
    const source = '# 设计摘要：溪边茶亭\n- 概念：单层木构茶亭\n- 风格：乡土朴素';
    const note = '# 施工注记\n- 先做石基座，再做墙';
    const script = inline('v2-design-source', [
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_design', arguments: {} }] } },
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [{ name: 'write_design', arguments: { content: note } }],
        },
      },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_design', arguments: {} }] } },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_code', arguments: {} }] } },
    ]);
    const ran = await runScript(
      'v2-design-source',
      { ...DEFAULT_LIMITS, maxTurns: 4 },
      {
        script,
        variant: 'craft-small',
        designAuthority: 'fixed',
        promptVersion: 'v2',
        initialDesign: source,
        initialDesignKind: 'digest',
      },
    );
    const reads = toolResults(ran).filter((r) => r.name === 'read_design');
    assert.equal(reads.length, 2);
    const first = reads[0]?.text ?? '';
    assert.match(first, /【已确认设计源（只读；确定性摘要，完整 design\.md 未随 run 传入）】/);
    assert.ok(first.includes(source), 'read_design 必须能读到已确认设计源');
    assert.match(first, /完整 design 未随 run 传入，如需细节看 BuildSheet \/ 题面/);
    assert.match(first, /本 run 尚未写设计注记/);
    assert.ok(!first.includes('还没有设计文档'), '有设计源时不得谎称没有设计文档');

    const second = reads[1]?.text ?? '';
    assert.ok(second.includes(source), 'write_design 后源设计仍可读');
    assert.match(second, /【本 run 的 write_design 注记（可整体替换；不是设计源）】/);
    assert.ok(second.includes(note), 'read_design 应同时返回 agent 自写注记');
    assert.ok(
      second.indexOf('【已确认设计源') < second.indexOf('【本 run 的 write_design 注记'),
      '源设计与自写注记必须分开标注',
    );
    assertRecord(ran);
  });

  it('种子稿：当前稿从 seed 起（第 1 版、via seed），不写代码即可 check + submit 交付；eventsSchema=3', async () => {
    const seed = 'export default function build(w: World): void {}\n';
    const script = inline('seed-draft', [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'check_code', arguments: {} },
            { name: 'submit', arguments: { note: '完成' } },
          ],
        },
      },
    ]);
    const ran = await runScript('seed-draft', DEFAULT_LIMITS, {
      script,
      initialDraft: { code: seed },
      initialDesign: '设计',
      initialImages: [{ name: 'south', png: PNG }],
    });
    const third = ran.request(1).messages[2];
    assert.ok(third?.role === 'user' && Array.isArray(third.content));
    const notice = third.content[0];
    assert.ok(notice?.type === 'text');
    assert.match(notice.text, /当前稿已替换为上一阶段交付的骨架代码/);
    assert.match(notice.text, /上一阶段交付的骨架设计文档/);
    assertRecord(ran);
    const version = ran.of('code.version')[0];
    assert.ok(version !== undefined);
    assert.equal(version.body.version, 1);
    assert.equal(version.body.via, 'seed');
    assert.equal(version.body.lines, 1);
    assert.equal(ran.blobText(version.body.code.sha256), seed);
    assert.equal(ran.of('run.start')[0]?.body.versions.eventsSchema, 3);
    assertDelivered(ran, 1);
  });

  it('空白种子稿加四图：首请求如实称空稿，短名和图片成对', async () => {
    const names = ['roof-good south', 'roof-gap south', 'joinery-good south', 'joinery-gap south'];
    const script = inline(
      'empty-seed-images',
      Array.from({ length: 3 }, () => ({
        reply: { kind: 'message' as const, content: '离线模拟' },
      })),
    );
    const ran = await runScript('empty-seed-images', DEFAULT_LIMITS, {
      script,
      initialDraft: { code: ' \n' },
      initialImages: names.map((name) => ({ name, png: PNG })),
    });
    const third = ran.request(1).messages[2];
    assert.ok(third?.role === 'user' && Array.isArray(third.content));
    assert.equal(third.content.length, 9);
    assert.doesNotMatch(JSON.stringify(third.content), /骨架|已替换/);
    assert.match(JSON.stringify(third.content[0]), /当前稿为空/);
    for (const [i, name] of names.entries()) {
      assert.deepEqual(third.content[i * 2 + 1], { type: 'text', text: JSON.stringify(name) });
      assert.equal(third.content[i * 2 + 2]?.type, 'image_url');
    }
    assert.equal(stopOf(ran), 'no-tool');
  });

  it('precheck-fix：第 2 次请求的 tool 消息含 TS2820 与 stone_bricks；交付', async () => {
    const ran = await runScript('precheck-fix');
    assertRecord(ran);
    const tools = ran.request(2).messages.filter((m) => m.role === 'tool');
    assert.ok(tools.some((m) => m.content.includes('TS2820') && m.content.includes('stone_bricks')));
    const checks = ran.of('check.result');
    assert.equal(checks[0]?.body.precheck.kind, 'failed');
    assert.equal(checks[0].body.run, null);
    assert.equal(checks[1]?.body.run?.kind, 'ok');
    assertDelivered(ran, 2);
  });

  it('build-error-fix：工具结果含"执行出错"与行号、无测量段；交付', async () => {
    const ran = await runScript('build-error-fix');
    assertRecord(ran);
    const failed = toolResults(ran).find((r) => r.status === 'build-error');
    assert.ok(failed !== undefined);
    assert.match(failed.text, /执行出错 building\.ts:3:3 Error：/);
    assert.ok(!failed.text.includes('测量（事实'));
    assert.equal(ran.of('check.result')[0]?.body.run?.kind, 'build-error');
    assertDelivered(ran, 2);
  });

  it('edit-miss：出现 0 次、最接近行、归一也不匹配；版本号未变；status = edit-not-found', async () => {
    const ran = await runScript('edit-miss');
    assertRecord(ran);
    const miss = toolResults(ran).find((r) => r.name === 'edit_code' && r.status !== 'ok');
    assert.ok(miss !== undefined);
    assert.equal(miss.status, 'edit-not-found');
    assert.match(miss.text, /出现 0 次（按空白归一后也没有唯一匹配）/);
    assert.match(miss.text, /最接近的一行（第 3 行）/);
    // 失败的编辑不产生新版本：v1（write）→ v2（第 4 步的编辑）
    assert.deepEqual(
      ran.of('code.version').map((e) => [e.body.version, e.body.via, e.turn]),
      [
        [1, 'write_code', 1],
        [2, 'edit_code', 4],
      ],
    );
    assertDelivered(ran, 2);
  });

  it('submit-unchecked：第一次 submit 被拒；第二次通过，同轮 read_code 回"已提交，未执行"；交付第 1 版', async () => {
    const ran = await runScript('submit-unchecked');
    assertRecord(ran);
    const submits = ran.of('submit');
    assert.deepEqual(
      submits.map((s) => [s.turn, s.body.accepted]),
      [
        [1, false],
        [3, true],
      ],
    );
    assert.match(submits[0]?.body.reason ?? '', /还没检查/);
    const read = toolResults(ran).at(-1);
    assert.deepEqual(read, { name: 'read_code', status: 'skipped-submitted', text: '已提交，未执行' });
    assertDelivered(ran, 1);
  });

  it('over-budget：某次请求前 cost-budget；累计花费 ≤ ¥0.10；无 delivery/', async () => {
    // 真 world.d.ts 约 35 KB：¥0.10 时首次请求的预留就压到 max_tokens < 2000，一次都发不出去。
    // 这里注入一段短声明，让上限在若干次请求之后才触顶（测的是"某次请求前停下"）。
    const ran = await runScript('over-budget', { ...DEFAULT_LIMITS, maxCostCny: 0.1 }, { worldDts: SHORT_DTS });
    assertRecord(ran);
    assert.equal(stopOf(ran), 'cost-budget');
    assert.ok(ran.of('llm.request').length >= 1, '至少发出一次请求');
    assert.ok(
      ran.outcome.costCny !== null && ran.outcome.costCny <= 0.1 + 1e-12,
      `花费 ${String(ran.outcome.costCny)}`,
    );
    const turns = ran.of('turn.start');
    assert.equal(ran.of('llm.request').length, turns.length - 1, '停在最后一轮的请求之前');
    assert.equal(ran.of('guard').at(-1)?.body.name, 'cost');
    assert.ok(!existsSync(join(ran.reader.dir, 'delivery')));
    assert.equal(ran.of('delivery').length, 0);
  });

  it('window：第 5 轮请求的事实行含"进入提交窗口"；窗口内 edit_code 可用、view_building 被拒；第 6 轮后 max-turns', async () => {
    const ran = await runScript('window', { ...DEFAULT_LIMITS, maxTurns: 6, submitWindow: 2 });
    assertRecord(ran);
    assert.equal(stopOf(ran), 'max-turns');
    const lastUser = ran.request(5).messages.at(-1);
    assert.ok(lastUser?.role === 'user' && typeof lastUser.content === 'string');
    assert.match(lastUser.content, /进入提交窗口：剩余 2 轮，只能使用 read_code、edit_code、check_code、submit。/);
    assert.ok(!JSON.stringify(ran.request(4).messages.at(-1)).includes('提交窗口'));
    const turn5 = ran.of('tool.result').filter((e) => e.turn === 5);
    assert.deepEqual(
      turn5.map((e) => [e.body.name, e.body.status]),
      [
        ['edit_code', 'ok'],
        ['view_building', 'window-blocked'],
        ['check_code', 'ok'],
      ],
    );
    assert.equal(ran.of('turn.start').length, 7);
    assert.equal(ran.of('llm.request').length, 6);
    assert.deepEqual(
      ran.of('guard').map((g) => [g.body.name, g.body.action]),
      [
        ['turns', 'window'],
        ['turns', 'stop'],
      ],
    );
    assert.equal(ran.of('delivery').length, 0);
    assert.ok(ran.of('run.end')[0]?.body.lastArchive !== undefined, 'lastArchive 指向最后一次成功检查');
  });

  it('首稿冒烟：墙钟窗口从第 1 轮起生效，v0 的 write_code 可用，编辑到 v2 后交付', async () => {
    const code = 'export default function build(w: World): void {\n  const N = 0;\n  w.walls({ height: 6 });\n}\n';
    const script = inline('window-v0-wall', [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'read_design', arguments: {} },
            { name: 'plan', arguments: { action: 'read' } },
          ],
        },
      },
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [{ name: 'write_design', arguments: { content: '# 设计\n\n- 一个小亭\n' } }],
        },
      },
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'write_code', arguments: { code } },
            { name: 'check_code', arguments: {} },
          ],
        },
      },
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            {
              name: 'edit_code',
              arguments: { edits: [{ find: 'const N = 0;', replace: 'const N = 1;' }] },
            },
            { name: 'check_code', arguments: {} },
          ],
        },
      },
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [{ name: 'submit', arguments: { note: '完成' } }],
        },
      },
    ]);
    // WALL_WINDOW_MS 为 180_000：墙钟上限 100_000 时第 1 轮请求前就已经在窗口内。
    const ran = await runScript('window-v0-wall', { ...DEFAULT_LIMITS, wallMs: 100_000 }, { script });
    assertRecord(ran);
    const entered = ran.of('guard').filter((g) => g.body.name === 'wall-window' && g.body.action === 'window');
    assert.equal(entered.length, 1);
    assert.equal(entered[0]?.turn, 1);
    assert.deepEqual(
      ran
        .of('tool.result')
        .filter((e) => e.turn === 3)
        .map((e) => [e.body.name, e.body.status]),
      [
        ['write_code', 'ok'],
        ['check_code', 'ok'],
      ],
    );
    assert.deepEqual(
      ran.of('code.version').map((e) => [e.body.version, e.body.via, e.turn]),
      [
        [1, 'write_code', 3],
        [2, 'edit_code', 4],
      ],
    );
    assert.ok(!toolResults(ran).some((r) => r.status === 'window-blocked'), '窗口内 v0 不应出现 window-blocked');
    assertDelivered(ran, 2);
  });

  it('fc7468 回归：费用窗口在首稿前进入，请求 3 明示 v0 例外，write_code 不被拒，交付 v2', async () => {
    // 第 2 轮的断流按预留全额记，重试成功后触发费用窗口（fc7468 的失败路径）。
    const ran = await runScript('window-v0', { ...DEFAULT_LIMITS, maxCostCny: 1.0 });
    assertRecord(ran);
    const entered = ran.of('guard').find((g) => g.body.name === 'cost-window' && g.body.action === 'window');
    assert.ok(entered !== undefined, '应出现 cost-window 的 window 事件');
    assert.equal(entered.turn, 2);
    assert.deepEqual(
      ran
        .of('llm.attempt')
        .filter((a) => a.turn === 2)
        .map((a) => [a.body.outcome, a.body.charge]),
      [
        ['retry', 'reserve'],
        ['ok', 'usage'],
      ],
    );
    const lastUser = ran.request(3).messages.at(-1);
    assert.ok(lastUser?.role === 'user' && typeof lastUser.content === 'string');
    assert.match(lastUser.content, /进入提交窗口/);
    assert.match(lastUser.content, /先 write_code 建立初稿/);
    assert.deepEqual(
      ran
        .of('tool.result')
        .filter((e) => e.turn === 3)
        .map((e) => [e.body.name, e.body.status]),
      [
        ['write_code', 'ok'],
        ['check_code', 'ok'],
      ],
    );
    assert.deepEqual(
      ran.of('code.version').map((e) => [e.body.version, e.body.via, e.turn]),
      [
        [1, 'write_code', 3],
        [2, 'edit_code', 4],
      ],
    );
    assert.ok(!toolResults(ran).some((r) => r.status === 'window-blocked'), '窗口内 v0 不应出现 window-blocked');
    assertDelivered(ran, 2);
  });

  it('no-tool：连续 3 次只回文字 → no-tool', async () => {
    const ran = await runScript('no-tool');
    assertRecord(ran);
    assert.equal(stopOf(ran), 'no-tool');
    assert.equal(ran.of('llm.request').length, 3);
    assert.equal(ran.of('tool.call').length, 0);
  });

  it('llm-failure：503 × 4，client 重试 4 次、各次记 ¥0；llm-error，failure.code = http_5xx', async () => {
    const ran = await runScript('llm-failure');
    assertRecord(ran);
    assert.equal(stopOf(ran), 'llm-error');
    const attempts = ran.of('llm.attempt');
    assert.deepEqual(
      attempts.map((a) => [a.body.attempt, a.body.outcome, a.body.charge, a.body.settledCny]),
      [
        [1, 'retry', 'none', 0],
        [2, 'retry', 'none', 0],
        [3, 'retry', 'none', 0],
        [4, 'final-failure', 'none', 0],
      ],
    );
    const end = ran.of('run.end')[0];
    // 规格写作 http_503；@pg/llm 的错误归一按 MODEL-SPEC §5.2 表把 5xx 归为 http_5xx，status 留 503
    assert.equal(end?.body.failure?.code, 'http_5xx');
    assert.equal(end.body.failure.status, 503);
    assert.equal(ran.outcome.costCny, 0);
  });

  it('stream-drop：断流的尝试按预留全额记；重试成功后交付', async () => {
    const ran = await runScript('stream-drop');
    assertRecord(ran);
    const request1 = ran.of('llm.request')[0];
    const attempts = ran.of('llm.attempt').filter((a) => a.turn === 1);
    assert.equal(attempts[0]?.body.outcome, 'retry');
    assert.equal(attempts[0].body.charge, 'reserve');
    assert.equal(attempts[0].body.failure?.code, 'network');
    assert.equal(attempts[0].body.settledCny, request1?.body.reserve.cny);
    assert.equal(attempts[1]?.body.outcome, 'ok');
    // 断流的重试消耗剧本第 2 步，所以只有 3 次请求；看图后的第 3 次请求末尾 user 有 2 个图片块（剧本 expect 也核对）
    assert.equal(ran.of('llm.request').length, 3);
    const lastUser = ran.request(3).messages.at(-1);
    assert.ok(lastUser?.role === 'user' && Array.isArray(lastUser.content));
    assert.equal(lastUser.content.filter((p) => p.type === 'image_url').length, 2);
    assert.equal(ran.of('versions.render').length, 1);
    assertDelivered(ran, 1);
  });

  it('degenerate：请求被取消；追加截断 assistant（无 tool_calls）与带提醒的事实行；连续第 2 次 degenerate-loop', async () => {
    const ran = await runScript('degenerate');
    assertRecord(ran);
    assert.equal(stopOf(ran), 'degenerate-loop');
    const responses = ran.of('llm.response');
    assert.deepEqual(
      responses.map((r) => r.body.outcome),
      ['aborted-by-caller', 'aborted-by-caller'],
    );
    const attempts = ran.of('llm.attempt');
    assert.deepEqual(
      attempts.map((a) => [a.body.outcome, a.body.charge]),
      [
        ['aborted-by-caller', 'reserve'],
        ['aborted-by-caller', 'reserve'],
      ],
    );
    const messages = ran.request(2).messages;
    const assistant = messages.at(-2);
    assert.ok(assistant?.role === 'assistant');
    assert.equal(assistant.tool_calls, undefined);
    assert.ok(assistant.content !== null);
    assert.ok(assistant.content.endsWith('…（输出重复，已中止）'));
    assert.ok(assistant.content.startsWith('开始。'));
    const facts = messages.at(-1);
    assert.ok(facts?.role === 'user' && typeof facts.content === 'string');
    assert.ok(facts.content.startsWith('上一轮输出出现大段重复，已被中止。请直接调用工具，不要重复输出。'));
  });

  it('truncated-args：追加的 assistant 里参数为 "{}"，原文在 blob；tool 消息写"没有执行"', async () => {
    const ran = await runScript('truncated-args');
    assertRecord(ran);
    const response = ran.of('llm.response')[0];
    assert.ok(response?.body.outcome === 'ok');
    assert.equal(response.body.finishReason, 'length');
    assert.ok(response.body.rawArguments !== undefined);
    assert.match(ran.blobText(response.body.rawArguments.sha256), /export default function build\(w/);
    const assistant = ran.request(2).messages.find((m) => m.role === 'assistant');
    assert.ok(assistant?.role === 'assistant');
    assert.equal(assistant.tool_calls?.[0]?.function.arguments, '{}');
    assert.equal(ran.of('tool.call')[0]?.body.parse, 'invalid-json');
    assert.deepEqual(toolResults(ran)[0], {
      name: 'write_code',
      status: 'invalid-json',
      text: '参数不是合法 JSON（可能被输出上限截断），没有执行。',
    });
    assert.equal(ran.of('code.version')[0]?.turn, 2, '截断的调用没有产生版本');
    assertDelivered(ran, 1);
  });
});

/** 内联剧本：边角路径不值得单独入库成 fixtures。 */
function inline(name: string, steps: Script['steps']): Script {
  return ScriptSchema.parse({ name, task: '# 边角\n', steps });
}

const WRITE = { name: 'write_code', arguments: { code: 'export default function build(w: World): void {}\n' } };

describe('runner 边角路径', () => {
  it('墙钟：进行中的请求挂起时经 signal 取消，stop wall；断流按预留记', async () => {
    const script = inline('wall-stall', [{ reply: { kind: 'stall', afterBytes: 40 } }]);
    const ran = await runScript('wall-stall', { ...DEFAULT_LIMITS, wallMs: 60_000 }, { script, wallTimer: true });
    assertRecord(ran);
    assert.equal(stopOf(ran), 'wall');
    const attempt = ran.of('llm.attempt')[0];
    assert.equal(attempt?.body.charge, 'reserve');
    assert.equal(attempt.body.failure?.code, 'cancelled');
  });

  it('墙钟：429 退避（5 s / 15 s / 45 s）期间到点 → 取消等待，stop wall', async () => {
    const script = inline('wall-backoff', [{ reply: { kind: 'http-error', status: 429, times: 4 } }]);
    const ran = await runScript('wall-backoff', { ...DEFAULT_LIMITS, wallMs: 60_000 }, { script, wallTimer: true });
    assertRecord(ran);
    assert.equal(stopOf(ran), 'wall');
    assert.deepEqual(
      ran.of('llm.attempt').map((a) => a.body.outcome),
      ['retry', 'retry', 'retry'],
    );
    assert.equal(ran.of('run.end')[0]?.body.failure, undefined);
  });

  it('花费：断流按预留全额记后，重试前预留超限 → stopped-by-guard，stop cost-budget', async () => {
    const script = inline('retry-budget', [
      { reply: { kind: 'drop', afterBytes: 30 } },
      { reply: { kind: 'message', content: '好' } },
    ]);
    const ran = await runScript(
      'retry-budget',
      { ...DEFAULT_LIMITS, maxCostCny: 0.1 },
      { script, worldDts: SHORT_DTS },
    );
    assertRecord(ran);
    assert.equal(stopOf(ran), 'cost-budget');
    assert.deepEqual(
      ran.of('llm.attempt').map((a) => [a.body.outcome, a.body.charge]),
      [['stopped-by-guard', 'reserve']],
    );
    assert.ok(ran.outcome.costCny !== null && ran.outcome.costCny <= 0.1 + 1e-12);
  });

  it('花费：连续断流重试，每次全额记预留，总花费始终不超过上限', async () => {
    // 首跑前检查提出的反例：断流后按原预留重发同一请求体，第二次断流不能把总花费推过上限。
    for (const limit of [0.1, 0.15, 0.2, 0.3]) {
      const script = inline(`retry-chain-${String(limit)}`, [
        { reply: { kind: 'drop', afterBytes: 30 } },
        { reply: { kind: 'drop', afterBytes: 30 } },
        { reply: { kind: 'drop', afterBytes: 30 } },
        { reply: { kind: 'message', content: '好' } },
      ]);
      const ran = await runScript(
        `retry-chain-${String(limit)}`,
        { ...DEFAULT_LIMITS, maxCostCny: limit },
        { script, worldDts: SHORT_DTS },
      );
      assertRecord(ran);
      const settled = ran.of('llm.attempt').reduce((sum, a) => {
        assert.ok(a.body.settledCny !== null);
        return sum + a.body.settledCny;
      }, 0);
      assert.ok(settled <= limit + 1e-12, `上限 ${String(limit)}：结算合计 ${String(settled)}`);
      assert.ok(ran.outcome.costCny !== null && ran.outcome.costCny <= limit + 1e-12);
    }
  });

  it('外部取消（Ctrl-C）→ stop cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const script = inline('cancel', [{ reply: { kind: 'message', content: '好' } }]);
    const ran = await runScript('cancel', DEFAULT_LIMITS, { script, signal: controller.signal });
    assertRecord(ran);
    assert.equal(stopOf(ran), 'cancelled');
  });

  it('卡死：同名同参数同结果第 3 次提醒（事实行）、第 5 次 stop stuck', async () => {
    const read = {
      reply: { kind: 'message' as const, content: null, toolCalls: [{ name: 'read_code', arguments: {} }] },
    };
    const script = inline('stuck', [
      { reply: { kind: 'message', content: null, toolCalls: [WRITE] } },
      read,
      read,
      read,
      { ...read, expect: { lastUserIncludes: ['同一工具已连续 3 次'] } },
      read,
    ]);
    const ran = await runScript('stuck', DEFAULT_LIMITS, { script });
    assertRecord(ran);
    assert.equal(stopOf(ran), 'stuck');
    assert.deepEqual(
      ran.of('guard').map((g) => [g.body.name, g.body.action, g.body.value]),
      [
        ['stuck', 'warn', 3],
        ['stuck', 'warn', 4],
        ['stuck', 'stop', 5],
      ],
    );
  });

  it('宿主缺陷（没有 bwrap）→ stop sandbox-unsupported', async () => {
    const script = inline('unsupported', [
      { reply: { kind: 'message', content: null, toolCalls: [WRITE, { name: 'check_code', arguments: {} }] } },
    ]);
    const ran = await runScript('unsupported', DEFAULT_LIMITS, {
      script,
      runCode: () => Promise.resolve({ kind: 'unsupported', reason: '没有 bwrap' }),
    });
    assertRecord(ran);
    assert.equal(stopOf(ran), 'sandbox-unsupported');
  });

  it('不可预期的异常：照样写 run.end internal-error 与 trace，再抛出', async () => {
    const script = inline('throws', [
      { reply: { kind: 'message', content: null, toolCalls: [WRITE, { name: 'check_code', arguments: {} }] } },
    ]);
    await assert.rejects(
      runScript('throws', DEFAULT_LIMITS, { script, runCode: () => Promise.reject(new Error('意外')) }),
      /意外/,
    );
    const events = openRunDir(join(ROOT, 'run-throws')).events();
    const end = events.at(-1);
    assert.ok(end?.type === 'run.end');
    assert.equal(end.body.stopReason, 'internal-error');
    assert.ok(existsSync(join(ROOT, 'run-throws', 'trace.json')));
  });

  it('limit = 0 关闭花费护栏：照常请求与结算', async () => {
    const script = inline('free', [
      { reply: { kind: 'message', content: '想' } },
      { reply: { kind: 'message', content: '想' } },
      { reply: { kind: 'message', content: '想' } },
    ]);
    const ran = await runScript('free', { ...DEFAULT_LIMITS, maxCostCny: 0 }, { script });
    assertRecord(ran);
    assert.equal(stopOf(ran), 'no-tool');
    assert.ok(ran.outcome.costCny !== null && ran.outcome.costCny > 0);
    assert.equal(ran.of('llm.request')[0]?.body.reserve.maxTokens, 40_000);
  });

  it('GPT 特许请求与记录：low、无输出上限、不套DeepSeek费用、事实行明示未计费', async () => {
    const script = inline('sol-unmetered', [
      { reply: { kind: 'message', content: '开始' } },
      { reply: { kind: 'message', content: '继续' } },
      { reply: { kind: 'message', content: '结束' } },
    ]);
    const ran = await runScript(
      'sol-unmetered',
      { ...DEFAULT_LIMITS, maxCostCny: 0 },
      { script, model: 'gpt-6.1-sol' },
    );
    assert.equal(ran.outcome.costCny, null);
    assert.equal(ran.request(1).model, 'gpt-6.1-sol');
    assert.equal(ran.request(1).reasoning_effort, 'low');
    assert.equal(ran.request(1).max_tokens, undefined);
    assert.equal(ran.of('run.start')[0]?.body.accounting, 'unmetered');
    assert.ok(ran.of('llm.attempt').every((a) => a.body.charge === 'unmetered' && a.body.settledCny === null));
    assert.ok(ran.of('llm.response').every((r) => r.body.outcome !== 'ok' || r.body.cny === null));
    assert.match(ran.blobText(ran.of('facts')[0]!.body.text.sha256), /未计费，无金额限制/);
    assert.equal(deriveTrace(ran.events).totals.costCny, null);
    assert.equal(deriveTrace(ran.events.filter((e) => e.type !== 'run.end')).totals.costCny, null);
    await assert.rejects(runScript('sol-invalid', DEFAULT_LIMITS, { script, model: 'gpt-6.1-sol' }), /关闭金额限制/);
  });

  it('W11-08 v2 生产 facts 路径：状态卡含对象 / 家具 / must / plan / 冲突，unknown 不伪造', async () => {
    const buildSheet = `# BuildSheet — state card fixture

## Musts（2）

- \`must-wall\` [task] (verified) → wall-1
- \`must-free\` [task] (none) → 未链接（unverified）

## 冲突

- **conflict-datum**（contract-number）
  - mustIds: must-wall
  - expected: y0
  - actual: y1
  - resolution: record
`;
    const report = {
      schemaVersion: 1,
      measurement: {
        unit: 'voxel-cell',
        boundsConvention: 'half-open [min,max)',
        positionToleranceCells: 0,
        pitchToleranceDegrees: 2,
      },
      items: [
        {
          id: 'expected:wall-1',
          kind: 'wall',
          expectedId: 'wall-1',
          actualId: 'wall-union',
          status: 'pass',
          severity: 'hard',
          expected: { bounds: [0, 0, 0, 8, 5, 8] },
          actual: { bounds: [0, 0, 0, 8, 5, 8] },
          delta: {},
          evidence: [],
          reason: null,
        },
        {
          id: 'expected:roof-1',
          kind: 'roof',
          expectedId: 'roof-1',
          actualId: 'roof-1',
          status: 'fail',
          severity: 'hard',
          expected: { bounds: [0, 5, 0, 8, 7, 8], form: 'gable', pitchDegrees: 30, eaveY: 5, ridgeY: 7 },
          actual: { bounds: [0, 5, 0, 8, 6, 8], form: 'flat', pitchDegrees: 0, eaveY: 5, ridgeY: 6 },
          delta: { pitchDegrees: { expected: 30, actual: 0, delta: -30 } },
          evidence: [],
          reason: 'pitch mismatch',
        },
      ],
      summary: {
        pass: 2,
        fail: 1,
        missing: 0,
        extra: 0,
        unverified: 0,
        blockingCount: 1,
        blocking: true,
        fullyVerified: false,
      },
      notCompared: { site: 0, furniture: 0, unknown: 0, total: 0, ids: { site: [], furniture: [], unknown: [] } },
      context: { openings: [] },
      notes: [],
    } as unknown as DiffReport;
    const sketch = inline('v2-state-card', [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            WRITE,
            { name: 'check_code', arguments: {} },
            {
              name: 'plan',
              arguments: {
                action: 'update',
                phase: 'roof',
                items: [
                  { id: 'must-wall', status: 'verified', evidence: 'wall-1 PASS' },
                  { id: 'must-free', status: 'todo' },
                ],
              },
            },
          ],
        },
      },
      {
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'submit', arguments: { note: '完成' } }] },
      },
    ]);
    const ran = await runScript('v2-state-card', DEFAULT_LIMITS, {
      script: sketch,
      variant: 'craft-small',
      designAuthority: 'fixed',
      promptVersion: 'v2',
      initialBuildSheet: buildSheet,
      check: {
        conformanceReportOf: () => report,
        expectedFurniture: [
          {
            id: 'table-1',
            kind: 'furniture',
            bounds: { min: [1, 1, 1], max: [2, 2, 2] },
            materialBlock: null,
            furnitureKind: 'table',
            seatCapacity: null,
            unverifiedReason: null,
          },
        ],
      },
    });
    const facts = ran.request(2).messages.at(-1);
    assert.ok(facts?.role === 'user' && typeof facts.content === 'string');
    const card = facts.content;
    for (const text of [
      '[状态卡 v1]',
      'phase=roof',
      'draft=v1',
      'check=v1:ok',
      'view=none',
      'objects pass=2 fail=1 missing=0 unverified=0 extra=0',
      'furniture pass=0 fail=0 missing=1',
      'must evidence=1 unverified=0 not_linked=1 total=2 conflicts=1',
      'conflict-datum',
      'plan self-report=1/2 verified（不是证据）',
      'budget turn=2',
      'next=1) furniture 1 missing：先补 table-1  2) view 未看：提交前看一次  3) check roof-1：先 probe/read 再 edit',
    ]) {
      assert.ok(card.includes(text), `状态卡缺少：${text}`);
    }
    assert.ok(!card.includes('must evidence=2'), 'plan verified 不能冒充 must 证据');
    assert.ok(!card.includes('furniture unknown'), '有家具核对文本时应显示计数');
    assertRecord(ran);
  });

  it('W11-21 v2 状态卡：同一 diff 连续两次注入 probe/read 提示；不同 diff 不注入', async () => {
    const reportOf = (id: string): DiffReport =>
      ({
        schemaVersion: 1,
        items: [
          {
            id: 'expected:wall-1',
            kind: 'wall',
            expectedId: 'wall-1',
            actualId: 'wall-1',
            status: 'pass',
            severity: 'hard',
            expected: {},
            actual: {},
            delta: {},
            evidence: [],
            reason: null,
          },
          {
            id: `expected:${id}`,
            kind: id.startsWith('slab') ? 'slab' : 'wall',
            expectedId: id,
            actualId: id,
            status: 'fail',
            severity: 'hard',
            expected: {},
            actual: {},
            delta: {},
            evidence: [],
            reason: 'fixture fail',
          },
        ],
        summary: {
          pass: 1,
          fail: 1,
          missing: 0,
          extra: 0,
          unverified: 0,
          blockingCount: 1,
          blocking: true,
          fullyVerified: false,
        },
        notCompared: { site: 0, furniture: 0, unknown: 0, total: 0, ids: { site: [], furniture: [], unknown: [] } },
        context: { openings: [] },
        notes: [],
      }) as unknown as DiffReport;
    const script = inline('v2-repeat-error', [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [WRITE, { name: 'check_code', arguments: {} }],
        },
      },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'check_code', arguments: {} }] } },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_code', arguments: {} }] } },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_code', arguments: {} }] } },
    ]);
    const run = async (name: string, ids: readonly [string, string]): Promise<Ran> => {
      let calls = 0;
      return runScript(
        name,
        { ...DEFAULT_LIMITS, maxTurns: 4 },
        {
          script,
          variant: 'craft-small',
          designAuthority: 'fixed',
          promptVersion: 'v2',
          check: { conformanceReportOf: () => reportOf(ids[Math.min(calls++, 1)] ?? ids[1]) },
        },
      );
    };

    const same = await run('v2-repeat-same', ['wall:f1', 'wall:f1']);
    const first = same.of('facts')[0];
    const second = same.of('facts')[1];
    assert.ok(first !== undefined && second !== undefined);
    assert.ok(!same.blobText(first.body.text.sha256).includes('同一错误已连续'), '第一次失败只记录，不提示连续错误');
    const repeatedCard = same.blobText(second.body.text.sha256);
    assert.match(repeatedCard, /同一错误已连续 2 次：先 probe\/read\/reference，不要继续 edit 同一处/);
    assert.ok(repeatedCard.includes('（wall:f1）'));

    const different = await run('v2-repeat-diff', ['wall:f1', 'slab:f1']);
    const changed = different.of('facts')[1];
    assert.ok(changed !== undefined);
    assert.ok(
      !different.blobText(changed.body.text.sha256).includes('同一错误已连续'),
      '不同 diff 不应触发连续错误提示',
    );
    assertRecord(different);
  });

  it('W11-12 v2 状态卡：canonical 空报告 / 抛错都按 fallback，objects 与 must evidence 为 unknown', async () => {
    const buildSheet =
      '# BuildSheet — empty report fixture\n\n## Musts（2）\n\n- `must-wall` [task] (verified) → wall-1\n- `must-free` [task] (none) → 未链接（unverified）\n\n## 冲突\n\n- 无未解决冲突。\n';
    const empty = {
      schemaVersion: 1,
      items: [],
      summary: { pass: 0, fail: 0, missing: 0, extra: 0, unverified: 0 },
    } as unknown as DiffReport;
    const expectedObjects = [
      {
        id: 'wall:f1',
        kind: 'wall',
        bounds: { min: [-4, 2, -3], max: [5, 5, 4] },
        unverifiedReason: null,
      },
    ] as unknown as NonNullable<RunnerDeps['check']['expectedObjects']>;
    const script = inline('v2-empty-report', [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [WRITE, { name: 'check_code', arguments: {} }],
        },
      },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_code', arguments: {} }] } },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_code', arguments: {} }] } },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_code', arguments: {} }] } },
    ]);

    for (const [name, fn] of [
      ['empty', () => empty],
      [
        'throw',
        () => {
          throw new Error('shadow provider down');
        },
      ],
    ] as const) {
      const ran = await runScript(
        `v2-report-${name}`,
        { ...DEFAULT_LIMITS, maxTurns: 4 },
        {
          script,
          variant: 'craft-small',
          designAuthority: 'fixed',
          promptVersion: 'v2',
          initialBuildSheet: buildSheet,
          check: { expectedObjects, conformanceReportOf: fn },
        },
      );
      const facts = ran.of('facts')[0];
      assert.ok(facts !== undefined);
      const card = ran.blobText(facts.body.text.sha256);
      assert.ok(card.includes('objects unknown'), `${name}：空 / 失败报告不能显示对象计数`);
      assert.ok(card.includes('must evidence=unknown total=2'), `${name}：must 证据应为 unknown`);
      assert.ok(!card.includes('objects pass=0'), `${name}：unknown 不能伪装成 0`);
      const check = toolResults(ran).find((r) => r.name === 'check_code');
      assert.match(check?.text ?? '', /\[fallback\]/, `${name}：check 文本应显式标记 fallback`);
    }
  });

  it('W11-12 v2 状态卡：同版本重检拿不到 canonical 报告时不复用旧报告', async () => {
    const buildSheet =
      '# BuildSheet — stale report fixture\n\n## Musts（2）\n\n- `must-wall` [task] (verified) → wall-1\n- `must-free` [task] (none) → 未链接（unverified）\n\n## 冲突\n\n- 无未解决冲突。\n';
    const report = {
      schemaVersion: 1,
      items: [
        {
          id: 'expected:wall-f1',
          kind: 'wall',
          expectedId: 'wall:f1',
          actualId: 'wall:f1',
          status: 'pass',
          severity: 'hard',
          expected: {},
          actual: {},
          delta: {},
          evidence: [],
          reason: null,
        },
      ],
      summary: { pass: 1, fail: 0, missing: 0, extra: 0, unverified: 0 },
    } as unknown as DiffReport;
    let calls = 0;
    const script = inline('v2-stale-report', [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [WRITE, { name: 'check_code', arguments: {} }],
        },
      },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'check_code', arguments: {} }] } },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_code', arguments: {} }] } },
      { reply: { kind: 'message', content: null, toolCalls: [{ name: 'read_code', arguments: {} }] } },
    ]);
    const ran = await runScript(
      'v2-stale-report',
      { ...DEFAULT_LIMITS, maxTurns: 4 },
      {
        script,
        variant: 'craft-small',
        designAuthority: 'fixed',
        promptVersion: 'v2',
        initialBuildSheet: buildSheet,
        check: {
          conformanceReportOf: () => {
            calls += 1;
            return calls === 1 ? report : undefined;
          },
        },
      },
    );
    assert.equal(calls, 2, '两次 check 都应调用 canonical provider');
    const facts = ran.of('facts').at(-1);
    assert.ok(facts !== undefined);
    const card = ran.blobText(facts.body.text.sha256);
    assert.ok(card.includes('objects unknown'), '第二次 check 没有报告时不得复用第一次的 canonical 计数');
    assert.ok(!card.includes('objects pass=1'), '旧报告不能串到同一版本的下一次 check');
    assert.ok(card.includes('must evidence=unknown total=2'), 'must 证据也必须回 unknown');
  });

  it('W11-18 v2 默认保留完整历史：24 轮相邻请求前缀稳定（LCP ≥90%）且 prompt <60k', async () => {
    const seed = Array.from(
      { length: 2000 },
      (_, i) => `// filler ${String(i + 1)}${i === 10 ? ' DEEP-MARKER-TURN1' : ''}`,
    ).join('\n');
    const steps = Array.from({ length: 24 }, (_, i) => ({
      reply: {
        kind: 'message' as const,
        content: `TURN${String(i + 1)}-ASSISTANT`,
        toolCalls: [{ name: 'read_code', arguments: { from: i * 50 + 1, to: i * 50 + 50 } }],
      },
    }));
    const script = inline('v2-full-history', steps);
    const buildSheet =
      '# BuildSheet — history runner fixture\n\n## Musts（1）\n\n- `must-wall` [task] (verified) → wall-1\n\n## 冲突\n\n- 无未解决冲突。\n';
    const ran = await runScript(
      'v2-full-history',
      { ...DEFAULT_LIMITS, maxTurns: 24 },
      {
        script,
        variant: 'craft-small',
        designAuthority: 'fixed',
        promptVersion: 'v2',
        initialDraft: { code: seed },
        initialBuildSheet: buildSheet,
      },
    );
    assert.equal(stopOf(ran), 'max-turns');
    const requests = Array.from({ length: 24 }, (_, i) => ran.request(i + 1));
    const last = requests.at(-1);
    assert.ok(last !== undefined);
    const lastText = JSON.stringify(last.messages);
    assert.ok(!lastText.includes('[历史摘要'), 'v2 默认不应再压出历史摘要');
    assert.ok(lastText.includes('DEEP-MARKER-TURN1'), '第 1 轮 read_code 原文应完整保留');
    assert.ok(lastText.includes('TURN1-ASSISTANT'), '第 1 轮 assistant 原文应完整保留');
    assert.ok(
      last.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('## Musts（1）') &&
          message.content.includes('must-wall') &&
          message.content.includes('无未解决冲突'),
      ),
      'BuildSheet / must / 冲突不能丢',
    );

    // 严格前缀：后一次请求只追加本轮内容，不改写前一次请求的任何消息。
    // 这正是修复 W11-17 的滑动 digest 所要求的缓存不变量。
    for (let n = 2; n <= requests.length; n += 1) {
      const prev = requests[n - 2]?.messages ?? [];
      const current = requests[n - 1]?.messages ?? [];
      assert.deepEqual(current.slice(0, prev.length), prev, `第 ${String(n)} 次请求改写了前一次请求的前缀`);
    }

    // cache 代理：相邻请求保留的上一请求前缀字节单调增长；从第 10 轮起，
    // 后一次请求中与前一次共享的消息占比 ≥90%（前几轮是冷启动，占比随轮次自然上升）。
    let previousSharedBytes = 0;
    for (let n = 2; n <= requests.length; n += 1) {
      const prev = requests[n - 2];
      const current = requests[n - 1];
      assert.ok(prev !== undefined && current !== undefined);
      const sharedBytes = prev.messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
      if (n >= 10) {
        assert.ok(
          prev.messages.length * 10 >= current.messages.length * 9,
          `第 ${String(n)} 次请求 LCP ${String(prev.messages.length)}/${String(current.messages.length)} 低于 90%`,
        );
        assert.ok(
          sharedBytes > previousSharedBytes,
          `第 ${String(n)} 次请求的共享前缀字节未增长：${String(sharedBytes)} ≤ ${String(previousSharedBytes)}`,
        );
      }
      previousSharedBytes = sharedBytes;
    }

    // 离线口径与 runner 测试注入的 countTokens 一致（chars / 2）；不是 live usage。
    const promptChars = JSON.stringify(last.messages).length + JSON.stringify(last.tools).length;
    const approxTokens = Math.ceil(promptChars / 2);
    assert.ok(approxTokens < 60_000, `24 轮 prompt 估算 ${String(approxTokens)} token，应低于 60k`);
  });

  it('W11-12 v2 首请求硬上限：超限在写 run.start / 发请求前抛可行动错误', async () => {
    const script = inline('v2-budget-cap', [{ reply: { kind: 'message', content: '不应发送' } }]);
    await assert.rejects(
      runScript('v2-budget-cap', DEFAULT_LIMITS, {
        script,
        promptVersion: 'v2',
        firstRequestBudget: { maxTokens: 10, countTokens: (text) => Math.ceil(text.length / 2) },
      }),
      /首请求估算 \d+ token，超过生产硬上限 10；.*PG_PROMPT_VERSION=v1/,
    );
  });

  it('W11-08 v1 仍发送完整历史：不启用状态卡与 8 轮压缩', async () => {
    const seed = Array.from(
      { length: 5000 },
      (_, i) => `// filler ${String(i + 1)}${i === 10 ? ' V1-DEEP-MARKER' : ''}`,
    ).join('\n');
    const steps = Array.from({ length: 10 }, (_, i) => ({
      reply: {
        kind: 'message' as const,
        content: `V1-TURN${String(i + 1)}`,
        toolCalls: [{ name: 'read_code', arguments: { from: i * 400 + 1, to: i * 400 + 400 } }],
      },
    }));
    const script = inline('v1-history', steps);
    const ran = await runScript(
      'v1-history',
      { ...DEFAULT_LIMITS, maxTurns: 10 },
      {
        script,
        initialDraft: { code: seed },
      },
    );
    assert.equal(stopOf(ran), 'max-turns');
    const last = ran.request(10).messages;
    assert.equal(last.length, 2 + 9 * 3, 'v1 不压缩；第 10 次请求含前 9 轮 assistant / tool / user');
    assert.ok(JSON.stringify(last).includes('V1-DEEP-MARKER'));
    assert.ok(!JSON.stringify(last).includes('[历史摘要'));
    const lastMessage = last.at(-1);
    assert.ok(lastMessage?.role === 'user' && typeof lastMessage.content === 'string');
    assert.match(lastMessage.content, /^\[第 10 轮/);
  });
});
