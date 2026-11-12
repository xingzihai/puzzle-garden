/**
 * child 执行细节的单元测试（SANDBOX-SPEC §9，走真实 child 子进程但不经 bwrap）：
 * 行号、微任务不执行、console 截断。不 import child-run.ts，避免覆盖率统计到子进程逻辑。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readArchive } from '@pg/core/archive';
import { createBlockTable } from '@pg/core/block-state';
import { API_VERSION } from '@pg/geometry';

import { decodeFrame } from './frame.ts';
import { CHILD_PROTOCOL_VERSION, childReportSchema, REPORT_FORMAT_VERSION } from './protocol.ts';
import type { ChildReport } from './protocol.ts';

const childPath = fileURLToPath(new URL('./child.ts', import.meta.url));
const table = createBlockTable(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../assets/mc-1.20.1/block-states.json', import.meta.url)), 'utf8'),
  ) as unknown,
);

interface ChildRun {
  readonly report: ChildReport;
  readonly archive: Uint8Array;
}

function runChild(code: string, seed = 1, consoleBytes = 8192): ChildRun {
  const input = JSON.stringify({
    protocol: CHILD_PROTOCOL_VERSION,
    code,
    seed,
    apiVersion: API_VERSION,
    limits: { consoleBytes },
  });
  const result = spawnSync(process.execPath, [childPath], { input, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString('utf8').slice(0, 2000));
  const decoded = decodeFrame(result.stdout);
  if (!decoded.ok) throw new Error(`坏帧：${decoded.reason}`);
  return { report: childReportSchema.parse(decoded.report), archive: decoded.archive };
}

function entry(body: string): string {
  return `export default function build(w: World): void {\n${body}\n}\n`;
}

describe('child-run：执行细节', () => {
  test('格式2报告在存档裁剪败方前保留样例双方真实状态及行号，无覆盖也发零概览', () => {
    const empty = runChild(entry(''));
    assert.equal(empty.report.reportFormat, REPORT_FORMAT_VERSION);
    assert.deepEqual(empty.report.overlapSummary, {
      sameLayer: 0,
      crossLayer: 0,
      lostDecor: 0,
      groups: [],
      groupsOmitted: 0,
    });
    const { report, archive } = runChild(
      entry(
        [
          "  w.set(0, 1, 0, 'smooth_sandstone_slab[type=top]', 'decoration');",
          "  w.set(0, 1, 0, 'nether_brick_slab', 'structure');",
        ].join('\n'),
      ),
    );
    assert.equal(report.reportFormat, REPORT_FORMAT_VERSION);
    assert.equal(report.overlapSummary?.lostDecor, 1);
    assert.deepEqual(report.overlapSummary.groups[0], {
      winner: 2,
      loser: 1,
      cells: 1,
      sample: [0, 1, 0],
      sampleDetail: {
        expectedState: 'smooth_sandstone_slab[type=top]',
        actualState: 'nether_brick_slab',
        winnerSource: { api: 'set', line: 3, writeLayer: 'structure' },
        loserSource: { api: 'set', line: 2, writeLayer: 'decoration' },
      },
    });
    assert.deepEqual(report.overlaps[0]?.sampleDetail, report.overlapSummary.groups[0].sampleDetail);
    assert.deepEqual(
      readArchive(table, archive)
        .grid.calls()
        .map((c) => c.id),
      [2],
    );
  });
  test('链式多行调用取方法名所在行（第 3 行）', () => {
    const code = [
      'export default function build(w: World): void {',
      '  const b = w',
      "    .plinth({ footprint: rect(-7, -7, 7, 7), height: 1, material: 'stone_bricks' });",
      '  void b;',
      '}',
      '',
    ].join('\n');
    const { report, archive } = runChild(code);
    assert.equal(report.status, 'ok');
    const { grid } = readArchive(table, archive);
    const plinth = grid.calls().find((c) => c.api === 'plinth');
    assert.equal(plinth?.line, 3);
  });

  test('计算属性名伪装成 pg:building:999:1 时取真实行号', () => {
    const code = [
      'export default function build(w: World): void {',
      '  const wrapper = {',
      "    'pg:building:999:1': (): void => w.set(1, 0, 0, 'stone_bricks'),",
      "  }['pg:building:999:1'];",
      '  wrapper();',
      '}',
      '',
    ].join('\n');
    const { archive } = runChild(code);
    const { grid } = readArchive(table, archive);
    const set = grid.calls().find((c) => c.api === 'set');
    assert.equal(set?.line, 3);
  });

  test('build 返回后模型排的微任务不执行', () => {
    const code = [
      'export default function build(w: World): void {',
      "  w.set(0, 0, 0, 'stone_bricks');",
      "  Promise.resolve().then((): void => w.set(1, 0, 0, 'stone_bricks'));",
      '}',
      '',
    ].join('\n');
    const { report, archive } = runChild(code);
    assert.equal(report.status, 'ok');
    const { grid } = readArchive(table, archive);
    assert.equal(grid.size, 1);
    assert.equal(grid.get(1, 0, 0), undefined);
  });

  test('console 按字节截断并计数', () => {
    const code = [
      'export default function build(w: World): void {',
      '  for (let i = 0; i < 100; i += 1) console.log("xxxxxxxxxxxxxxxxxxxx", i);',
      '}',
      '',
    ].join('\n');
    const { report } = runChild(code, 1, 50);
    const bytes = report.console.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0);
    assert.ok(bytes <= 50, `console 共 ${String(bytes)} 字节`);
    assert.ok(report.consoleTruncated > 0);
  });

  test('build 抛错带模型代码行号', () => {
    const code = [
      'export default function build(w: World): void {',
      "  w.set(0, 0, 0, 'stone_bricks');",
      "  throw new Error('boom');",
      '}',
      '',
    ].join('\n');
    const { report } = runChild(code);
    assert.equal(report.status, 'build-error');
    assert.equal(report.error?.line, 3);
    assert.equal(report.reportFormat, REPORT_FORMAT_VERSION);
  });

  test('F2：模型抛出的怪值都归 build-error，不逼出宿主 protocol-error', () => {
    const attacks = [
      // name 是对象（报告 schema 只收 string）
      "const e = new Error('x'); Object.defineProperty(e, 'name', { value: {} }); throw e;",
      // message getter 抛错
      "const e = { name: 'E', get message(): string { throw new Error('m'); } }; throw e;",
      // stack getter 抛错
      "const e = new Error('x'); Object.defineProperty(e, 'stack', { get(): string { throw new Error('s'); } }); throw e;",
      // 无原型对象：String() 会抛
      'throw Object.create(null);',
      // Proxy 的 getPrototypeOf 抛错（instanceof 会触发）
      "throw new Proxy({}, { getPrototypeOf(): null { throw new Error('p'); } });",
    ];
    for (const body of attacks) {
      const { report } = runChild(entry(body));
      assert.equal(report.status, 'build-error', body);
      assert.equal(typeof report.error?.name, 'string', body);
      assert.equal(typeof report.error?.message, 'string', body);
    }
  });

  test('F2：跳过预检的 enum 代码（类型擦除失败）归 build-error', () => {
    const { report } = runChild(
      'enum Color { Red }\nexport default function build(w: World): void { void Color.Red; }\n',
    );
    assert.equal(report.status, 'build-error');
    assert.ok((report.error?.message ?? '').length > 0);
  });

  test('F3：5 万字符的 error.name 截到 100', () => {
    const { report } = runChild(
      entry("const e = new Error('x'); Object.defineProperty(e, 'name', { value: 'A'.repeat(50000) }); throw e;"),
    );
    assert.equal(report.status, 'build-error');
    assert.equal(report.error?.name.length, 100);
  });

  test('F4：console 文本与 error 字段里的控制字符被转义，\\n \\t 保留', () => {
    const { report } = runChild(entry("console.log('\\u001b[2J', '\\u202e', '\\r', '\\u0000', 'a\\nb\\tc');"));
    assert.equal(report.status, 'ok');
    const text = report.console[0]?.text ?? '';
    assert.ok(text.includes('\\u{001B}[2J'), text);
    assert.ok(text.includes('\\u{202E}'), text);
    assert.ok(text.includes('\\u{000D}'), text);
    assert.ok(text.includes('\\u{0000}'), text);
    assert.ok(text.includes('a\nb\tc'), text);

    const errored = runChild(entry("throw new Error('boom\\u001b[31mred\\u202e');"));
    assert.equal(errored.report.status, 'build-error');
    const message = errored.report.error?.message ?? '';
    assert.ok(message.includes('\\u{001B}'), message);
    assert.ok(message.includes('\\u{202E}'), message);
    assert.ok(!message.includes('\u001b'), message);
  });

  test('F4：console 里的宿主栈不含仓库根路径与用户名，模型帧保留', () => {
    const { report } = runChild(entry('console.log(new Error().stack);'));
    assert.equal(report.status, 'ok');
    const text = report.console[0]?.text ?? '';
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
    assert.ok(text.includes('at build (pg:building:'), text);
    assert.ok(text.includes('<host>'), text);
    assert.ok(!text.includes(repoRoot), text);
    assert.ok(!/\/home\/(?!<user>)/.test(text), text);
  });

  test('F4：geometry 抛错栈里的宿主路径也被脱敏', () => {
    const { report } = runChild(
      entry("try { w.set(1.5, 0, 0, 'stone_bricks'); } catch (e) { console.log(String((e as Error).stack)); }"),
    );
    assert.equal(report.status, 'ok');
    const text = report.console[0]?.text ?? '';
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
    assert.ok(!text.includes(repoRoot), text);
    assert.ok(!/\/home\/(?!<user>)/.test(text), text);
    assert.ok(text.includes('<host>'), text);
  });
});
