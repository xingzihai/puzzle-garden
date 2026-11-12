import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeArchive } from '@pg/core/archive';
import { createBlockTable, parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import { hashGrid } from '@pg/core/hash';
import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';

import type { SandboxLayout } from './args.ts';
import { SandboxError } from './errors.ts';
import { encodeFrame } from './frame.ts';
import { CHILD_PROTOCOL_VERSION, REPORT_FORMAT_VERSION } from './protocol.ts';
import type { ChildReport } from './protocol.ts';
import {
  computeSandboxVersion,
  createRunner,
  detectSandbox,
  MAX_CODE_BYTES,
  sandboxVersion,
  checkAssets,
  measureAssets,
  MAX_ASSET_DOCUMENT_BYTES,
  MAX_ASSET_DOCUMENTS,
  MAX_ASSETS_TOTAL_BYTES,
} from './run.ts';
import type { RunInput, SandboxSupport, SpawnFn } from './run.ts';

const table = createBlockTable(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../assets/mc-1.20.1/block-states.json', import.meta.url)), 'utf8'),
  ) as unknown,
);

const paths: SandboxLayout = {
  repoRoot: '/repo',
  nodePath: '/usr/bin/node',
  childPath: '/repo/packages/sandbox/src/child.ts',
  blockStatesPath: '/repo/assets/mc-1.20.1/block-states.json',
};

class FakeChild extends EventEmitter {
  readonly pid = 1;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    setImmediate(() => {
      this.emit('close', null);
    });
    return true;
  }
}

function finish(child: FakeChild, code: number, stdout?: Uint8Array, stderrText?: string): void {
  if (stderrText !== undefined) child.stderr.write(stderrText);
  if (stdout !== undefined) child.stdout.write(Buffer.from(stdout));
  child.stdout.end();
  child.stderr.end();
  child.stdout.once('end', () => {
    child.emit('close', code);
  });
}

interface FakeSpawn {
  readonly spawn: SpawnFn;
  readonly starts: number;
  readonly maxActive: () => number;
}

function makeSpawn(behavior: (child: FakeChild) => void): FakeSpawn {
  let starts = 0;
  let active = 0;
  let maxActive = 0;
  const spawn: SpawnFn = () => {
    starts += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    const child = new FakeChild();
    child.once('close', () => {
      active -= 1;
    });
    behavior(child);
    return child;
  };
  return {
    spawn,
    get starts() {
      return starts;
    },
    maxActive: () => maxActive,
  };
}

function okFrame(): { frame: Uint8Array; report: ChildReport; archive: Uint8Array } {
  const grid = createGrid(table);
  grid.set(0, 0, 0, parseState(table, 'stone_bricks'), 0, 0);
  const archive = writeArchive(grid, 1);
  const report: ChildReport = {
    status: 'ok',
    hash: hashGrid(grid),
    calls: 1,
    overlaps: [],
    console: [],
    consoleTruncated: 0,
  };
  return { frame: encodeFrame(report, archive), report, archive };
}

function runner(spawn: SpawnFn, detect: () => SandboxSupport = () => ({ ok: true, bwrap: 'test' })) {
  return createRunner({ spawn, detect, table: () => table, paths });
}

describe('run 单元：注入探测与 spawn', () => {
  test('第 12 条：detect 返回不支持时返回 unsupported 且不启动子进程', async () => {
    const fake = makeSpawn(() => undefined);
    const result = await runner(fake.spawn, () => ({ ok: false, reason: '没有 bwrap' })).runCode({
      code: '',
      seed: 0,
    });
    assert.deepEqual(result, { kind: 'unsupported', reason: '没有 bwrap' });
    assert.equal(fake.starts, 0);
  });

  test('F6：代码超过 256 KiB 返回 too-large、不抛 ZodError、不启动子进程', async () => {
    const fake = makeSpawn(() => undefined);
    const code = 'x'.repeat(300 * 1024);
    const result = await runner(fake.spawn).runCode({ code, seed: 1 });
    assert.deepEqual(result, { kind: 'too-large', bytes: 300 * 1024, limit: MAX_CODE_BYTES });
    assert.equal(fake.starts, 0);
  });

  test('F6：其余不合 schema 的输入抛 SandboxError(protocol-error)，不外泄 ZodError', async () => {
    const fake = makeSpawn(() => undefined);
    await assert.rejects(
      runner(fake.spawn).runCode({ code: 'x', seed: -1 }),
      (e: unknown) => e instanceof SandboxError && e.code === 'protocol-error',
    );
    assert.equal(fake.starts, 0);
  });

  test('第 13 条：并发 3 个 runCode 任一时刻只有一个子进程存活', async () => {
    const shared = makeSpawn((child) => {
      setTimeout(() => {
        finish(child, 1);
      }, 30);
    });
    const r = runner(shared.spawn);
    const three = await Promise.all([
      r.runCode({ code: 'a', seed: 1 }),
      r.runCode({ code: 'b', seed: 2 }),
      r.runCode({ code: 'c', seed: 3 }),
    ]);
    assert.deepEqual(
      three.map((x) => x.kind),
      ['crashed', 'crashed', 'crashed'],
    );
    assert.equal(shared.starts, 3);
    assert.equal(shared.maxActive(), 1);
  });

  test('ok：合法帧 + hash 一致 → 读回网格', async () => {
    const { frame, report, archive } = okFrame();
    const fake = makeSpawn((child) => {
      finish(child, 0, frame);
    });
    const result = await runner(fake.spawn).runCode({ code: 'x', seed: 1 });
    if (result.kind !== 'ok') throw new Error(`不是 ok：${result.kind}`);
    assert.equal(result.hash, report.hash);
    assert.deepEqual([...result.archive], [...archive]);
    assert.equal(result.report.calls, 1);
    assert.equal(result.grid.size, 1);
  });

  test('build-error：报告 status=build-error', async () => {
    const report: ChildReport = {
      status: 'build-error',
      error: { name: 'Error', message: 'boom', line: 3, column: 1 },
      hash: 'x',
      calls: 0,
      overlaps: [],
      console: [],
      consoleTruncated: 0,
    };
    const fake = makeSpawn((child) => {
      finish(child, 0, encodeFrame(report, new Uint8Array(0)));
    });
    const result = await runner(fake.spawn).runCode({ code: 'x', seed: 1 });
    if (result.kind !== 'build-error') throw new Error(`不是 build-error：${result.kind}`);
    assert.equal(result.report.error?.line, 3);
  });

  test('timeout：墙钟到点 kill，结果 timeout', async () => {
    const fake = makeSpawn(() => undefined);
    const result = await runner(fake.spawn).runCode({ code: 'x', seed: 1 }, { wallMs: 20 });
    if (result.kind !== 'timeout') throw new Error(`不是 timeout：${result.kind}`);
    assert.ok(result.wallMs >= 10);
  });

  test('out-of-memory：退出码 134 + stderr 关键字', async () => {
    const fake = makeSpawn((child) => {
      finish(
        child,
        134,
        undefined,
        'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      );
    });
    assert.equal((await runner(fake.spawn).runCode({ code: 'x', seed: 1 })).kind, 'out-of-memory');

    const fake2 = makeSpawn((child) => {
      finish(child, 133, undefined, 'Fatal process out of memory');
    });
    assert.equal((await runner(fake2.spawn).runCode({ code: 'x', seed: 1 })).kind, 'out-of-memory');
  });

  test('output-too-large：存档超过 limit', async () => {
    const { frame } = okFrame();
    const fake = makeSpawn((child) => {
      finish(child, 0, frame);
    });
    const result = await runner(fake.spawn).runCode({ code: 'x', seed: 1 }, { archiveBytes: 1 });
    assert.equal(result.kind, 'output-too-large');
  });

  test('report-too-large：报告超过 limit 归 crashed，并带上报告字节数与调用条数', async () => {
    const { frame, report } = okFrame();
    const reportBytes = new TextEncoder().encode(JSON.stringify(report)).length;
    const fake = makeSpawn((child) => {
      finish(child, 0, frame);
    });
    const result = await runner(fake.spawn).runCode({ code: 'x', seed: 1 }, { reportBytes: 1 });
    assert.equal(result.kind, 'crashed');
    assert.deepEqual(result.detail, { reportBytes, limitBytes: 1, calls: 1, overlaps: 0 });
  });

  test('report-too-large：detail.overlaps 记截断前总数（含 overlapsTruncated）', async () => {
    const { report } = okFrame();
    const truncated: ChildReport = {
      ...report,
      overlaps: [{ kind: 'same-layer', winner: 1, loser: 2, cells: 1 }],
      overlapsTruncated: 9,
    };
    const fake = makeSpawn((child) => {
      finish(child, 0, encodeFrame(truncated, new Uint8Array(0)));
    });
    const result = await runner(fake.spawn).runCode({ code: 'x', seed: 1 }, { reportBytes: 1 });
    assert.equal(result.kind, 'crashed');
    assert.equal(result.detail?.overlaps, 10);
  });

  test('ok：报告带 overlapsTruncated 时成功路径原样使用', async () => {
    const { report, archive } = okFrame();
    const withTruncated: ChildReport = { ...report, overlapsTruncated: 3 };
    const fake = makeSpawn((child) => {
      finish(child, 0, encodeFrame(withTruncated, archive));
    });
    const result = await runner(fake.spawn).runCode({ code: 'x', seed: 1 });
    assert.equal(result.kind, 'ok');
    assert.equal(result.report.overlapsTruncated, 3);
  });

  test('crashed：非零退出且无帧', async () => {
    const fake = makeSpawn((child) => {
      finish(child, 1, undefined, 'boom');
    });
    assert.equal((await runner(fake.spawn).runCode({ code: 'x', seed: 1 })).kind, 'crashed');
  });

  test('protocol-error：hash 不一致 / 报告不合 schema', async () => {
    const badHash: ChildReport = {
      status: 'ok',
      hash: 'wrong',
      calls: 1,
      overlaps: [],
      console: [],
      consoleTruncated: 0,
    };
    const fake = makeSpawn((child) => {
      finish(child, 0, encodeFrame(badHash, new Uint8Array(0)));
    });
    await assert.rejects(runner(fake.spawn).runCode({ code: 'x', seed: 1 }), (e: unknown) => e instanceof SandboxError);

    const badSchema = makeSpawn((child) => {
      finish(child, 0, encodeFrame({ status: 'ok' } as unknown as ChildReport, new Uint8Array(0)));
    });
    await assert.rejects(
      runner(badSchema.spawn).runCode({ code: 'x', seed: 1 }),
      (e: unknown) => e instanceof SandboxError && e.code === 'protocol-error',
    );
  });

  test('spawn-failed：spawn 抛错映射成 SandboxError', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('ENOENT');
    };
    await assert.rejects(runner(spawn).runCode({ code: 'x', seed: 1 }), (e: unknown) => {
      return e instanceof SandboxError && e.code === 'spawn-failed';
    });
  });

  test('F5：stdin 写失败（EPIPE）不让宿主崩溃，结果按 close / 退出码分类', async () => {
    const fake = makeSpawn((child) => {
      setImmediate(() => {
        child.stdin.emit('error', new Error('EPIPE'));
        finish(child, 1, undefined, 'boom');
      });
    });
    const result = await runner(fake.spawn).runCode({ code: 'x', seed: 1 });
    assert.equal(result.kind, 'crashed');
  });

  test('F2：只有退出码 3 且 stderr 以 PG_PROTOCOL_ERROR: 开头才是 protocol-error', async () => {
    const proto = makeSpawn((child) => {
      finish(child, 3, undefined, 'PG_PROTOCOL_ERROR:child 输入不合 schema\n');
    });
    await assert.rejects(
      runner(proto.spawn).runCode({ code: 'x', seed: 1 }),
      (e: unknown) => e instanceof SandboxError && e.code === 'protocol-error',
    );

    // 退出码对但前缀不对 → crashed（不是宿主缺陷）。
    const wrongPrefix = makeSpawn((child) => {
      finish(child, 3, undefined, 'PG_CHILD_CRASH:boom\n');
    });
    assert.equal((await runner(wrongPrefix.spawn).runCode({ code: 'x', seed: 1 })).kind, 'crashed');

    // 前缀对但退出码不是 3 → crashed。
    const wrongCode = makeSpawn((child) => {
      finish(child, 4, undefined, 'PG_PROTOCOL_ERROR:boom\n');
    });
    assert.equal((await runner(wrongCode.spawn).runCode({ code: 'x', seed: 1 })).kind, 'crashed');
  });

  test('F2/F4：protocol-error 的 message 截到 200 且转义控制字符', async () => {
    const fake = makeSpawn((child) => {
      finish(child, 3, undefined, `PG_PROTOCOL_ERROR:\u001b[2J${'A'.repeat(500)}\n`);
    });
    await assert.rejects(runner(fake.spawn).runCode({ code: 'x', seed: 1 }), (e: unknown) => {
      if (!(e instanceof SandboxError)) return false;
      assert.ok(!e.message.includes('\u001b'), '不应有裸 ESC');
      assert.ok(e.message.includes('\\u{001B}'), 'ESC 应转义');
      assert.ok(e.message.length <= 250, `message 长度 ${String(e.message.length)}`);
      return true;
    });
  });

  test('detectSandbox 返回可辨识结果', () => {
    const support = detectSandbox();
    if (support.ok) assert.equal(typeof support.bwrap, 'string');
    else assert.equal(typeof support.reason, 'string');
  });
});

describe('run 单元：草模资产通道（MASSING-CONVERSION-SPEC §5.2）', () => {
  function sampleDocument(): ModelDocument {
    const model = createModel();
    model.box({ id: 'room', name: '房间', role: 'volume', color: '#123456', size: [2, 2, 2] });
    return model.finish();
  }
  function sampleAssets(document: ModelDocument): RunInput['assets'] {
    return {
      documents: [{ id: 'hall', document }],
      colorCandidates: [{ id: 'stone_bricks', rgb: 0x7a7a7a, family: 'stone' }],
    };
  }

  test('公开容量检查：空表、UTF-8 计量、份数满额可使用但不能生成，超额拒绝', () => {
    assert.deepEqual(measureAssets({ documents: [] }), { perDocument: [], total: 0 });
    assert.equal(checkAssets({ documents: [] }, true), null);
    const document = sampleDocument();
    const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
    assert.ok(bytes > JSON.stringify(document).length);
    const documents = Array.from({ length: MAX_ASSET_DOCUMENTS }, (_, i) => ({ id: `d${String(i)}`, document }));
    assert.deepEqual(measureAssets({ documents }), {
      perDocument: documents.map(() => bytes),
      total: bytes * documents.length,
    });
    assert.equal(checkAssets({ documents }), null);
    assert.equal(checkAssets({ documents }, true)?.reason, 'documents-count');
    assert.equal(checkAssets({ documents: documents.slice(1) }, true), null);
    assert.equal(checkAssets({ documents: [...documents, { id: 'extra', document }] })?.reason, 'documents-count');
  });

  test('公开容量检查：字节边界使用 <=，生成前要求总字节未满', () => {
    // 这里仅测容量层，不做 ModelDocument schema 校验；runCode 也先量大小再解析 schema。
    const document = {
      junk: '界' + 'x'.repeat(MAX_ASSET_DOCUMENT_BYTES - Buffer.byteLength('{"junk":"界"}')),
    } as unknown as ModelDocument;
    const one = { id: 'one', document };
    const two = { id: 'two', document };
    assert.equal(measureAssets({ documents: [one] }).total, MAX_ASSET_DOCUMENT_BYTES);
    assert.equal(checkAssets({ documents: [one] }, true), null);
    assert.equal(checkAssets({ documents: [one, two] }), null);
    assert.equal(checkAssets({ documents: [one, two] }, true)?.reason, 'total-bytes');
    assert.equal(
      checkAssets({ documents: [one, two, { id: 'small', document: sampleDocument() }] })?.reason,
      'total-bytes',
    );
  });

  test('assets-too-large：份数 / 单份字节 / 合计字节都在入队前返回，不启动子进程', async () => {
    const fake = makeSpawn(() => undefined);
    const r = runner(fake.spawn);
    const document = sampleDocument();
    const many: RunInput['assets'] = {
      documents: Array.from({ length: 9 }, (_, i) => ({ id: `d${String(i)}`, document })),
      colorCandidates: [],
    };
    const byCount = await r.runCode({ code: 'x', seed: 1, assets: many });
    if (byCount.kind !== 'assets-too-large') throw new Error(`不是 assets-too-large：${byCount.kind}`);
    assert.equal(byCount.reason, 'documents-count');
    assert.equal(byCount.documents, 9);
    assert.equal(byCount.limit, 8);

    const oversized: RunInput['assets'] = {
      documents: [
        {
          id: 'big',
          document: { junk: 'x'.repeat(MAX_ASSET_DOCUMENT_BYTES + 1024) } as unknown as ModelDocument,
        },
      ],
      colorCandidates: [],
    };
    const byDocument = await r.runCode({ code: 'x', seed: 1, assets: oversized });
    if (byDocument.kind !== 'assets-too-large') throw new Error(`不是 assets-too-large：${byDocument.kind}`);
    assert.equal(byDocument.reason, 'document-bytes');
    assert.equal(byDocument.limit, MAX_ASSET_DOCUMENT_BYTES);
    assert.ok(byDocument.bytes > MAX_ASSET_DOCUMENT_BYTES);

    const chunk = 'x'.repeat(11 * 1024 * 1024);
    const summed: RunInput['assets'] = {
      documents: [0, 1, 2].map((i) => ({ id: `t${String(i)}`, document: { junk: chunk } as unknown as ModelDocument })),
      colorCandidates: [],
    };
    const byTotal = await r.runCode({ code: 'x', seed: 1, assets: summed });
    if (byTotal.kind !== 'assets-too-large') throw new Error(`不是 assets-too-large：${byTotal.kind}`);
    assert.equal(byTotal.reason, 'total-bytes');
    assert.equal(byTotal.limit, MAX_ASSETS_TOTAL_BYTES);
    assert.equal(fake.starts, 0);
  });

  test('合法资产进入 schema 校验并透传到 child 输入（协议 2）', async () => {
    const { frame } = okFrame();
    const got: { value?: unknown } = {};
    const fake = makeSpawn((child) => {
      const chunks: Buffer[] = [];
      child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stdin.on('end', () => {
        got.value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      });
      finish(child, 0, frame);
    });
    const assets = sampleAssets(sampleDocument());
    const result = await runner(fake.spawn).runCode({ code: 'x', seed: 1, assets });
    assert.equal(result.kind, 'ok');
    const input = got.value as { readonly protocol: number; readonly assets: unknown };
    assert.equal(input.protocol, CHILD_PROTOCOL_VERSION);
    assert.deepEqual(input.assets, JSON.parse(JSON.stringify(assets)) as unknown);
  });

  test('assets 形状不对（documents 不是数组）→ protocol-error，不启动子进程', async () => {
    const fake = makeSpawn(() => undefined);
    await assert.rejects(
      runner(fake.spawn).runCode({
        code: 'x',
        seed: 1,
        assets: { documents: 'nope' } as unknown as RunInput['assets'],
      }),
      (e: unknown) => e instanceof SandboxError && e.code === 'protocol-error',
    );
    assert.equal(fake.starts, 0);
  });
});

describe('sandboxVersion（SANDBOX-SPEC §8.3）', () => {
  test('computeSandboxVersion 包含输入协议、bwrap、node 与报告格式版本', () => {
    const expected = createHash('sha256')
      .update(
        `${String(CHILD_PROTOCOL_VERSION)}\u0000bubblewrap 0.11.0\u0000v24.19.0\u0000${String(REPORT_FORMAT_VERSION)}`,
        'utf8',
      )
      .digest('hex');
    assert.equal(computeSandboxVersion(CHILD_PROTOCOL_VERSION, 'bubblewrap 0.11.0', 'v24.19.0'), expected);
    // 任一项不同则版本不同。
    assert.notEqual(computeSandboxVersion(CHILD_PROTOCOL_VERSION + 1, 'bubblewrap 0.11.0', 'v24.19.0'), expected);
    assert.notEqual(computeSandboxVersion(CHILD_PROTOCOL_VERSION, 'bubblewrap 0.10.0', 'v24.19.0'), expected);
    assert.notEqual(computeSandboxVersion(CHILD_PROTOCOL_VERSION, 'bubblewrap 0.11.0', 'v24.18.0'), expected);
    assert.notEqual(computeSandboxVersion(CHILD_PROTOCOL_VERSION, 'bubblewrap 0.11.0', 'v24.19.0', 1), expected);
  });

  test('sandboxVersion 是 64 位十六进制且可复现', () => {
    const version = sandboxVersion();
    assert.match(version, /^[0-9a-f]{64}$/);
    assert.equal(sandboxVersion(), version);
  });

  test('run 入口转出 MAX_CODE_BYTES（AGENT-SPEC §4.1）', () => {
    assert.equal(MAX_CODE_BYTES, 256 * 1024);
  });
});
