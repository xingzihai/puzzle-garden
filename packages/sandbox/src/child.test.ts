/**
 * child.ts 的单元测试（SANDBOX-SPEC §5.1、§9）：以子进程（不经 bwrap）跑一次 F5-B，断言帧合法。
 * 这条测试不依赖 bwrap，能进 npm test；覆盖率统计不到子进程，所以 child.ts 保持接线程度。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readArchive } from '@pg/core/archive';
import { createBlockTable } from '@pg/core/block-state';
import { API_VERSION } from '@pg/geometry';
import { createModel } from '@pg/modeling/model';

import { decodeFrame } from './frame.ts';
import { CHILD_PROTOCOL_VERSION, childReportSchema } from './protocol.ts';

const childPath = fileURLToPath(new URL('./child.ts', import.meta.url));
const fixturesDir = fileURLToPath(new URL('../../geometry/fixtures/', import.meta.url));
const table = createBlockTable(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../assets/mc-1.20.1/block-states.json', import.meta.url)), 'utf8'),
  ) as unknown,
);

function runChild(code: string, seed = 1, consoleBytes = 8192): { stdout: Buffer; status: number | null } {
  const input = JSON.stringify({
    protocol: CHILD_PROTOCOL_VERSION,
    code,
    seed,
    apiVersion: API_VERSION,
    limits: { consoleBytes },
  });
  const result = spawnSync(process.execPath, [childPath], { input, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString('utf8').slice(0, 2000));
  return { stdout: result.stdout, status: result.status };
}

function stripImports(code: string): string {
  return code
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('import '))
    .join('\n');
}

/** 一份带显式 material 的小文档：solid 盒 4×3×4 = 48 格。 */
function hallDocument(): unknown {
  const model = createModel();
  model.box({
    id: 'room',
    name: '房间',
    role: 'volume',
    color: '#7a7a7a',
    material: 'deepslate_tiles',
    size: [4, 3, 4],
  });
  return model.finish();
}

function rawChild(input: unknown): {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
} {
  const result = spawnSync(process.execPath, [childPath], {
    input: JSON.stringify(input),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('child.ts 跑一次 F5-B，帧合法且网格非空', () => {
  const code = stripImports(readFileSync(`${fixturesDir}/f5-tow.B.ts`, 'utf8'));
  const { stdout } = runChild(code);
  const decoded = decodeFrame(stdout);
  if (!decoded.ok) throw new Error(`坏帧：${decoded.reason}`);
  const report = childReportSchema.parse(decoded.report);
  assert.equal(report.status, 'ok');
  assert.ok(report.calls > 0);
  const { grid } = readArchive(table, decoded.archive);
  assert.ok(grid.size > 0);
  assert.equal(grid.size, 4079);
});

test('资产通道：stdin 注入文档后 massingImport 写格（不经 bwrap）', () => {
  const code = [
    'export default function build(w: World): void {',
    "  const h = w.massingImport('hall');",
    '  console.log(String(h.counts.cells), String(h.parts[0]?.cellCount));',
    '}',
    '',
  ].join('\n');
  const result = rawChild({
    protocol: CHILD_PROTOCOL_VERSION,
    code,
    seed: 1,
    apiVersion: API_VERSION,
    limits: { consoleBytes: 8192 },
    assets: {
      documents: [{ id: 'hall', document: hallDocument() }],
      colorCandidates: [{ id: 'stone_bricks', rgb: 0x7a7a7a, family: 'stone' }],
    },
  });
  assert.equal(result.status, 0, result.stderr.toString('utf8').slice(0, 500));
  const decoded = decodeFrame(result.stdout);
  if (!decoded.ok) throw new Error(`坏帧：${decoded.reason}`);
  const report = childReportSchema.parse(decoded.report);
  assert.equal(report.status, 'ok');
  assert.equal(report.console[0]?.text, '48 48');
  const { grid } = readArchive(table, decoded.archive);
  assert.equal(grid.size, 48);
  assert.equal(grid.get(0, 1, 0)?.state.name, 'deepslate_tiles');
  assert.equal(grid.calls().find((c) => c.api === 'massingImport')?.line, 2);
});

test('documents 非空但 colorCandidates 为空 → protocol-error（退出码 3）', () => {
  const input = {
    protocol: CHILD_PROTOCOL_VERSION,
    code: 'export default function build(w: World): void { void w; }\n',
    seed: 1,
    apiVersion: API_VERSION,
    limits: { consoleBytes: 8192 },
    assets: { documents: [{ id: 'hall', document: hallDocument() }], colorCandidates: [] },
  };
  const result = rawChild(input);
  assert.equal(result.status, 3);
  assert.ok(result.stderr.toString('utf8').startsWith('PG_PROTOCOL_ERROR:'));
  assert.ok(result.stdout.length === 0, '不写帧');
});
