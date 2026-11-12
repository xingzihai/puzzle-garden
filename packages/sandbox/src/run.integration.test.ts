/**
 * 执行端到端集成测试（SANDBOX-SPEC §10 第 6–10 条）：经产品 runCode 跑真实 bwrap 子进程。
 * 没有 bwrap 时整组 skip；本机（有 bwrap）跑的末尾断言 skip 数为 0。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';
import { writeArchive } from '@pg/core/archive';
import { createBlockTable } from '@pg/core/block-state';
import { hashGrid } from '@pg/core/hash';
import { API_VERSION, createWorld, rect } from '@pg/geometry';

import { createRunner, detectSandbox, runCode } from './run.ts';
import type { RunResult } from './run.ts';
import { REPORT_FORMAT_VERSION } from './protocol.ts';

const support = detectSandbox();
const fixturesDir = fileURLToPath(new URL('../../geometry/fixtures/', import.meta.url));
const table = createBlockTable(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../assets/mc-1.20.1/block-states.json', import.meta.url)), 'utf8'),
  ) as unknown,
);

const counter = { skipped: 0 };
function guarded(name: string, fn: () => Promise<void> | void): void {
  if (!support.ok) {
    counter.skipped += 1;
    test(name, { skip: `没有 bwrap：${support.reason}` }, () => undefined);
    return;
  }
  test(name, fn);
}

function stripImports(code: string): string {
  return code
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('import '))
    .join('\n');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function okOrThrow(result: RunResult): Extract<RunResult, { kind: 'ok' }> {
  if (result.kind !== 'ok') throw new Error(`不是 ok：${result.kind} ${JSON.stringify(result).slice(0, 300)}`);
  return result;
}

async function runOk(code: string, seed = 1): Promise<Extract<RunResult, { kind: 'ok' }>> {
  return okOrThrow(await runCode({ code, seed }));
}

/** 第 6 条期望值：AST 里每个 `w.<方法>(…)` 方法名所在行，允许一行多个方法。 */
function methodLines(source: string): Map<number, Set<string>> {
  const sf = ts.createSourceFile('building.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const map = new Map<number, Set<string>>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'w'
    ) {
      const name = node.expression.name.text;
      const line = sf.getLineAndCharacterOfPosition(node.expression.name.getStart(sf)).line + 1;
      const set = map.get(line) ?? new Set<string>();
      set.add(name);
      map.set(line, set);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

/** 宿主进程内跑 F5-B（TZ=UTC，不加 --frozen-intrinsics），取存档、hash 与真实行号序列。
 *  跑的是与 child 完全相同的"删去 import"源码：写入临时文件后动态 import，rect 挂到全局。 */
const hostCache: { value?: { readonly archive: Uint8Array; readonly hash: string; readonly lines: number[] } } = {};
async function hostF5B(): Promise<{ readonly archive: Uint8Array; readonly hash: string; readonly lines: number[] }> {
  if (hostCache.value !== undefined) return hostCache.value;
  (globalThis as unknown as Record<string, unknown>)['rect'] = rect;
  const hostPath = join(tmpdir(), 'pg-f5-host.ts');
  writeFileSync(hostPath, f5Code);
  const lines: number[] = [];
  const host = createWorld(table, {
    callSite: () => {
      const match = /pg-f5-host\.ts:(\d+):\d+/.exec(new Error().stack ?? '');
      const line = match?.[1] === undefined ? 0 : Number(match[1]);
      lines.push(line);
      return line;
    },
  });
  const mod = (await import(pathToFileURL(hostPath).href)) as unknown as {
    readonly default: (world: unknown) => void;
  };
  mod.default(host.world);
  const composition = host.compose();
  hostCache.value = { archive: writeArchive(composition.grid, API_VERSION), hash: hashGrid(composition.grid), lines };
  return hostCache.value;
}

const f5Code = stripImports(readFileSync(`${fixturesDir}/f5-tow.B.ts`, 'utf8'));

test('有 bwrap 时 skip 数为 0', () => {
  if (!support.ok) return;
  assert.equal(counter.skipped, 0);
});

guarded('第 6/10 条：F5-B 经 runCode ok，hash 与宿主一致，调用表行号与宿主执行逐条相同', async () => {
  const result = await runOk(f5Code, 1);
  const host = await hostF5B();
  assert.equal(result.hash, host.hash);
  assert.equal(sha256(result.archive), sha256(host.archive));
  const childLines = result.grid.calls().map((call) => call.line);
  assert.deepEqual(childLines, host.lines);
  assert.ok(
    host.lines.every((line) => line > 0),
    `宿主行号全为正：${host.lines.join(',')}`,
  );
  const ast = methodLines(f5Code);
  for (const call of result.grid.calls()) {
    assert.ok(ast.get(call.line)?.has(call.api), `line ${String(call.line)} 的 api ${call.api} 不在 AST 行上`);
  }
});

guarded('第 7 条：链式多行 / mirror / part / 伪装方法名取真实行号', async () => {
  const chain = [
    'export default function build(w: World): void {',
    '  const b = w',
    "    .plinth({ footprint: rect(-7, -7, 7, 7), height: 1, material: 'stone_bricks' });",
    '  void b;',
    '}',
    '',
  ].join('\n');
  assert.equal((await runOk(chain)).grid.calls().find((c) => c.api === 'plinth')?.line, 3);

  const mirror = [
    'export default function build(w: World): void {',
    "  w.mirror({ axis: 'x', at: 0 }, (): void => {",
    "    w.set(2, 0, 0, 'stone_bricks');",
    '  });',
    '}',
    '',
  ].join('\n');
  const mirrored = await runOk(mirror);
  assert.equal(mirrored.grid.calls().find((c) => c.api === 'set')?.line, 3);
  assert.equal(mirrored.grid.size, 2);

  const part = [
    'export default function build(w: World): void {',
    "  w.part('a', (): void => {",
    "    w.set(0, 0, 0, 'stone_bricks');",
    '  });',
    '}',
    '',
  ].join('\n');
  assert.equal((await runOk(part)).grid.calls().find((c) => c.api === 'set')?.line, 3);

  const disguised = [
    'export default function build(w: World): void {',
    '  const wrapper = {',
    "    'pg:building:999:1': (): void => w.set(1, 0, 0, 'stone_bricks'),",
    "  }['pg:building:999:1'];",
    '  wrapper();',
    '}',
    '',
  ].join('\n');
  assert.equal((await runOk(disguised)).grid.calls().find((c) => c.api === 'set')?.line, 3);
});

guarded('第 8 条：build 抛错带正确行号', async () => {
  const code = [
    'export default function build(w: World): void {',
    "  w.set(0, 0, 0, 'stone_bricks');",
    "  throw new Error('boom');",
    '}',
    '',
  ].join('\n');
  const result = await runCode({ code, seed: 1 });
  if (result.kind !== 'build-error') throw new Error(`不是 build-error：${result.kind}`);
  assert.equal(result.report.error!.line, 3);
  assert.equal(result.report.error!.name, 'Error');
});

guarded('覆盖样例经真 bwrap：败方已裁掉仍有镜像后状态、同格来源，summary 在截断前生成', async () => {
  const code = [
    'export default function build(w: World): void {',
    "  w.mirror({ axis: 'x', at: 0 }, (): void => {",
    "    w.set(2, 1, 0, 'oak_stairs[facing=east]', 'decoration');",
    "    w.set(2, 1, 0, 'glass', 'opening');",
    '  });',
    "  for (let x = 10; x < 310; x++) w.set(x, 1, 0, 'smooth_sandstone_slab', 'decoration');",
    "  for (let x = 10; x < 310; x++) w.set(x, 1, 0, 'nether_brick_slab', 'structure');",
    "  w.set(0, 1, 0, 'stone', 'decoration');",
    "  w.set(0, 1, 0, 'stone', 'structure');",
    "  w.set(0, 2, 0, 'stone', 'decoration');",
    "  w.set(0, 2, 0, 'air', 'opening');",
    '}',
  ].join('\n');
  const result = await runOk(code);
  assert.equal(result.report.reportFormat, REPORT_FORMAT_VERSION);
  assert.equal(result.report.overlapSummary?.crossLayer, 303);
  assert.equal(result.report.overlapSummary.sameLayer, 0);
  assert.equal(result.report.overlapSummary.lostDecor, 304);
  assert.equal(result.report.overlapSummary.groups.length, 3);
  assert.equal(result.report.overlapSummary.groupsOmitted, 1);
  const group = result.report.overlapSummary.groups[1];
  assert.deepEqual(group, {
    winner: 2,
    loser: 1,
    cells: 2,
    sample: [-2, 1, 0],
    sampleDetail: {
      expectedState: 'oak_stairs[facing=west]',
      actualState: 'glass',
      winnerSource: { api: 'set', line: 4, writeLayer: 'opening' },
      loserSource: { api: 'set', line: 3, writeLayer: 'decoration' },
    },
  });
  assert.equal(
    result.grid.calls().some((c) => c.id === 1),
    false,
  );
  assert.equal(result.report.overlaps.find((o) => o.loser === 603)?.sampleDetail?.actualState, 'stone');
  assert.equal(result.report.overlaps.find((o) => o.loser === 605)?.sampleDetail?.actualState, 'air');
  assert.equal((await runOk(code)).hash, result.hash);
  // 去掉全部败方写入，最终状态集合不变；hash 不包含报告或被盖掉的愿望。
  const visibleOnly = [
    'export default function build(w: World): void {',
    "  w.set(-2, 1, 0, 'glass', 'opening'); w.set(2, 1, 0, 'glass', 'opening');",
    "  for (let x = 10; x < 310; x++) w.set(x, 1, 0, 'nether_brick_slab', 'structure');",
    "  w.set(0, 1, 0, 'stone'); w.set(0, 2, 0, 'air', 'opening');",
    '}',
  ].join('\n');
  assert.equal((await runOk(visibleOnly)).hash, result.hash);
});

guarded('第 8 条：死循环 wallMs 1000 超时，且本次 bwrap 及其 node 后代无残留', async () => {
  const code = 'export default function build(w: World): void { while (true) { void w; } }\n';
  const processes: { readonly pid: number; readonly ppid: number; readonly argv: readonly string[] }[] = [];
  let observationError: unknown;
  const recordTree = (pid: number): void => {
    const status = readFileSync(`/proc/${String(pid)}/status`, 'utf8');
    processes.push({
      pid,
      ppid: Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]),
      argv: readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean),
    });
    const children = readFileSync(`/proc/${String(pid)}/task/${String(pid)}/children`, 'utf8').trim();
    if (children !== '') for (const child of children.split(/\s+/)) recordTree(Number(child));
  };
  const runner = createRunner({
    detect: () => support,
    table: () => table,
    paths: {
      repoRoot: fileURLToPath(new URL('../../../', import.meta.url)),
      nodePath: process.execPath,
      childPath: fileURLToPath(new URL('./child.ts', import.meta.url)),
      blockStatesPath: fileURLToPath(new URL('../../../assets/mc-1.20.1/block-states.json', import.meta.url)),
    },
    spawn: (command, args, options) => {
      const child = spawn(command, args, options);
      const kill = child.kill.bind(child);
      child.kill = (signal) => {
        // 在真实超时 kill 前沿 /proc 的父子关系记录整棵树，避免把并行套件算作泄漏。
        try {
          assert.ok(child.pid !== undefined);
          recordTree(child.pid);
        } catch (error) {
          // 观测失败留到 runCode 返回后报错，不能阻止产品原本的 kill。
          observationError = error;
        }
        return kill(signal);
      };
      return child;
    },
  });
  const result = await runner.runCode({ code, seed: 1 }, { wallMs: 1000 });
  assert.equal(result.kind, 'timeout');
  assert.equal(observationError, undefined);
  assert.equal(processes[0]?.ppid, process.pid, JSON.stringify(processes));
  assert.ok(
    processes.some(
      (p) => p.argv[0] === '/opt/pg/node' && p.argv.includes(fileURLToPath(new URL('./child.ts', import.meta.url))),
    ),
    `必须实际观察到本次沙箱 node：${JSON.stringify(processes)}`,
  );
  const remaining = (): typeof processes => processes.filter((p) => existsSync(`/proc/${String(p.pid)}`));
  // 外层 bwrap 的 close 不等待内核向 PID 命名空间后代传播死亡；沿用原测试的 300 ms 上限，
  // 只在本次 PID 尚存时让出事件循环，清完立即结束，超限照常报出残留。
  const deadline = performance.now() + 300;
  while (remaining().length > 0 && performance.now() < deadline)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    remaining().map((p) => ({ ...p, status: readFileSync(`/proc/${String(p.pid)}/status`, 'utf8') })),
    [],
    `本次沙箱仍有残留：${JSON.stringify(processes)}`,
  );
});

guarded('第 8 条：堆炸弹 maxOldSpaceMiB 256 → out-of-memory', async () => {
  const code =
    'export default function build(w: World): void {\n' +
    '  const a: number[][] = [];\n' +
    '  for (;;) a.push(new Array(1000000).fill(0));\n' +
    '}\n';
  const result = await runCode({ code, seed: 1 }, { maxOldSpaceMiB: 256, wallMs: 60000 });
  assert.equal(result.kind, 'out-of-memory', JSON.stringify(result).slice(0, 300));
});

guarded('第 8 条：new ArrayBuffer(10e9) → build-error RangeError', async () => {
  const code = 'export default function build(w: World): void { new ArrayBuffer(10e9); void w; }\n';
  const result = await runCode({ code, seed: 1 });
  if (result.kind !== 'build-error') throw new Error(`不是 build-error：${result.kind}`);
  assert.equal(result.report.error?.name, 'RangeError');
});

guarded('第 8 条：输出炸弹 archiveBytes 1 MiB → output-too-large', async () => {
  const code =
    'export default function build(w: World): void {\n' +
    "  for (let i = 0; i < 200000; i += 1) w.set(i % 200, 0, Math.floor(i / 200), 'stone_bricks');\n" +
    '}\n';
  const result = await runCode({ code, seed: 1 }, { archiveBytes: 1024 * 1024, wallMs: 30000 });
  assert.equal(result.kind, 'output-too-large', JSON.stringify(result).slice(0, 300));
});

guarded('第 8 条：console 刷 100 万条 → ok 且总量 ≤ 8192、有截断', async () => {
  const code =
    'export default function build(w: World): void {\n' +
    "  for (let i = 0; i < 1000000; i += 1) console.log('x', i);\n" +
    '}\n';
  const result = await runOk(code, 1);
  const bytes = result.report.console.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0);
  assert.ok(bytes <= 8192, `console 共 ${String(bytes)} 字节`);
  assert.ok(result.report.consoleTruncated > 0);
});

guarded('第 8 条：模型排的微任务写格不生效', async () => {
  const code = [
    'export default function build(w: World): void {',
    "  w.set(0, 0, 0, 'stone_bricks');",
    "  Promise.resolve().then((): void => w.set(1, 0, 0, 'stone_bricks'));",
    '}',
    '',
  ].join('\n');
  const result = await runOk(code);
  assert.equal(result.grid.size, 1);
  assert.equal(result.grid.get(1, 0, 0), undefined);
});

guarded('第 8 条：绕过预检给冻结全局赋值 → build-error', async () => {
  const cases = [
    'export default function build(w: World): void { globalThis.Math = 1; void w; }\n',
    'export default function build(w: World): void { Array.prototype.push = (): number => 0; void w; }\n',
    'export default function build(w: World): void { Error.stackTraceLimit = 0; void w; }\n',
  ];
  for (const code of cases) {
    const result = await runCode({ code, seed: 1 });
    assert.equal(result.kind, 'build-error', code);
  }
});

guarded('第 9 条：确定性（Math.random / Date 写法固定、同种子同存档、异种子异 hash）', async () => {
  const code = [
    'export default function build(w: World): void {',
    '  console.log(',
    '    String(new Date()),',
    '    new Date().toISOString(),',
    '    String(Date.now()),',
    '    new Date(2000, 0, 1).toISOString(),',
    '    String(Date()),',
    '  );',
    '  const n = Math.floor(Math.random() * 8);',
    "  w.set(n, 0, 0, 'stone_bricks');",
    '}',
    '',
  ].join('\n');
  const a = await runOk(code, 7);
  const b = await runOk(code, 7);
  const c = await runOk(code, 8);
  assert.equal(sha256(a.archive), sha256(b.archive));
  assert.notEqual(a.hash, c.hash);
  const text = a.report.console.map((entry) => entry.text).join('\n');
  assert.ok(text.includes('2000-01-01T00:00:00.000Z'), text);
  assert.ok(text.includes('946684800000'), text);
  assert.ok(text.includes('Sat Jan 01 2000'), text);
});

guarded('第 10 条：F5-B 沙箱内与宿主内（TZ=UTC）存档 sha256 相同', async () => {
  const result = await runOk(f5Code, 1);
  const host = await hostF5B();
  assert.equal(sha256(result.archive), sha256(host.archive));
});

guarded('F1：Date 后门与 performance 不泄露真实时间，同种子两次一致', async () => {
  const code = [
    'declare const performance: { now(): number };',
    'export default function build(w: World): void {',
    '  const RealDate = Date.prototype.constructor as unknown as { now(): number };',
    '  console.log(String(RealDate.now()), String(performance.now()));',
    "  w.set(RealDate.now() === 946684800000 && performance.now() === 0 ? 0 : 1, 0, 0, 'stone_bricks');",
    '}',
    '',
  ].join('\n');
  const a = await runOk(code, 7);
  const b = await runOk(code, 7);
  assert.equal(a.report.console[0]?.text, '946684800000 0');
  assert.equal(sha256(a.archive), sha256(b.archive));
  assert.equal(a.grid.get(1, 0, 0), undefined);
});
