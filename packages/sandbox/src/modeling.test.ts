import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';

import { MODEL_DECLARATION } from '@pg/modeling/declaration';
import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';

import type { SandboxLayout, SandboxLimits } from './args.ts';
import { SandboxError } from './errors.ts';
import { hashModelDocument } from './modeling-protocol.ts';
import { createModelPrechecker, createModelRunner, runModelCode } from './modeling.ts';
import type { ModelRunnerDeps, ModelSpawnFn } from './modeling.ts';
import { createPrechecker } from './precheck.ts';
import type { Prechecker } from './precheck.ts';
import type { PrecheckResult } from './protocol.ts';
import type { SandboxSupport } from './run.ts';

const paths: SandboxLayout = {
  repoRoot: '/repo',
  nodePath: '/usr/bin/node',
  childPath: '/repo/packages/sandbox/src/modeling-child.ts',
  blockStatesPath: '/repo/assets/mc-1.20.1/block-states.json',
};
const limits: SandboxLimits = { maxOldSpaceMiB: 3072, addressSpaceGiB: 8 };

class FakeChild extends EventEmitter {
  readonly pid = 999999;
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

interface FakeSpawn {
  readonly spawn: ModelSpawnFn;
  readonly starts: number;
  readonly maxActive: () => number;
}

function makeSpawn(behavior: (child: FakeChild) => void): FakeSpawn {
  let starts = 0;
  let active = 0;
  let maxActive = 0;
  const spawn: ModelSpawnFn = () => {
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

/** 返回退出码（而不是 void），让 `(child) => finish(...)` 这种简写箭头不触发 no-confusing-void-expression。 */
function finish(child: FakeChild, code: number, stdoutText?: string, stderrText?: string): number {
  if (stderrText !== undefined) child.stderr.write(stderrText);
  if (stdoutText !== undefined) child.stdout.write(Buffer.from(stdoutText, 'utf8'));
  child.stdout.end();
  child.stderr.end();
  child.stdout.once('end', () => {
    child.emit('close', code);
  });
  return code;
}

function fakePrechecker(result: PrecheckResult, onClose?: () => void): Prechecker {
  return {
    check: () => Promise.resolve(result),
    version: 'test',
    close: () => {
      onClose?.();
      return Promise.resolve();
    },
  };
}

function makeDeps(over: Partial<ModelRunnerDeps> = {}): ModelRunnerDeps {
  return {
    spawn: makeSpawn(() => undefined).spawn,
    detect: (): SandboxSupport => ({ ok: true, bwrap: 'test' }),
    precheck: () => fakePrechecker({ kind: 'ok' }),
    paths,
    limits,
    ...over,
  };
}

function runnerWith(childBehavior: (child: FakeChild) => void): ReturnType<typeof createModelRunner> {
  return createModelRunner(makeDeps({ spawn: makeSpawn(childBehavior).spawn }));
}

function okReportText(): { readonly text: string; readonly document: ModelDocument; readonly documentHash: string } {
  const model = createModel();
  model.box({ id: 'b', name: '盒', role: 'volume', color: '#112233', size: [1, 1, 1] });
  const document = model.finish();
  const documentHash = hashModelDocument(document);
  return {
    text: JSON.stringify({ status: 'ok', document, documentHash, console: [], consoleTruncated: 0 }),
    document,
    documentHash,
  };
}

const FAILED: PrecheckResult = {
  kind: 'failed',
  diagnostics: [{ line: 1, column: 1, code: 'PG001', message: '不能引入模块', source: 'import x' }],
  total: 1,
};

describe('modeling 单元：输入与探测', () => {
  test('代码超过 256 KiB 返回 too-large，不探测 / 不预检 / 不启动', async () => {
    const fake = makeSpawn(() => undefined);
    let detected = 0;
    let prechecked = 0;
    const runner = createModelRunner(
      makeDeps({
        spawn: fake.spawn,
        detect: () => {
          detected += 1;
          return { ok: true, bwrap: 'test' };
        },
        precheck: () => {
          prechecked += 1;
          return fakePrechecker({ kind: 'ok' });
        },
      }),
    );
    const result = await runner.runCode('x'.repeat(300 * 1024));
    assert.equal(result.kind, 'too-large');
    assert.equal(detected, 0);
    assert.equal(prechecked, 0);
    assert.equal(fake.starts, 0);
  });

  test('无 bwrap 返回 unsupported，不启动子进程', async () => {
    const fake = makeSpawn(() => undefined);
    const runner = createModelRunner(
      makeDeps({ spawn: fake.spawn, detect: () => ({ ok: false, reason: '没有 bwrap' }) }),
    );
    const result = await runner.runCode('x');
    assert.deepEqual(result, { kind: 'unsupported', message: '没有 bwrap：没有 bwrap' });
    assert.equal(fake.starts, 0);
  });

  test('seed 越界抛 SandboxError(protocol-error)', async () => {
    const runner = createModelRunner(makeDeps());
    await assert.rejects(runner.runCode('x', { seed: -1 }), (e: unknown) => {
      return e instanceof SandboxError && e.code === 'protocol-error';
    });
  });

  test('spawn 抛错归 unsupported', async () => {
    const spawn: ModelSpawnFn = () => {
      throw new Error('ENOENT');
    };
    const result = await createModelRunner(makeDeps({ spawn })).runCode(
      'export default function build(m: Model): void { void m; }',
    );
    assert.equal(result.kind, 'unsupported');
  });
});

describe('modeling 单元：预检前置', () => {
  test('预检 failed → precheck-error，不启动子进程', async () => {
    const fake = makeSpawn(() => undefined);
    const runner = createModelRunner(makeDeps({ spawn: fake.spawn, precheck: () => fakePrechecker(FAILED) }));
    const result = await runner.runCode('x');
    if (result.kind !== 'precheck-error') throw new Error(`不是 precheck-error：${result.kind}`);
    assert.equal(result.total, 1);
    assert.equal(result.diagnostics[0]?.code, 'PG001');
    assert.equal(fake.starts, 0);
  });

  test('预检 timeout / out-of-memory 都归 precheck-error', async () => {
    const timeout = await createModelRunner(
      makeDeps({ precheck: () => fakePrechecker({ kind: 'timeout', limitMs: 10 }) }),
    ).runCode('x');
    if (timeout.kind !== 'precheck-error') throw new Error(timeout.kind);
    assert.ok(timeout.message.includes('超时'), timeout.message);

    const oom = await createModelRunner(
      makeDeps({ precheck: () => fakePrechecker({ kind: 'out-of-memory', limitMiB: 1024 }) }),
    ).runCode('x');
    if (oom.kind !== 'precheck-error') throw new Error(oom.kind);
    assert.ok(oom.message.includes('内存'), oom.message);
  });
});

describe('modeling 单元：报告与分类', () => {
  test('ok：合法报告 + hash 一致 → 返回文档与两个 hash', async () => {
    const report = okReportText();
    const result = await runnerWith((child) => finish(child, 0, report.text)).runCode('x');
    if (result.kind !== 'ok') throw new Error(`不是 ok：${JSON.stringify(result).slice(0, 300)}`);
    assert.equal(result.documentHash, report.documentHash);
    assert.deepEqual(result.document, report.document);
    assert.match(result.codeHash, /^[0-9a-f]{64}$/);
  });

  test('documentHash 被篡改 → protocol-error', async () => {
    const report = okReportText();
    const parsed = JSON.parse(report.text) as Record<string, unknown>;
    const bad = JSON.stringify({ ...parsed, documentHash: 'deadbeef' });
    await assert.rejects(runnerWith((child) => finish(child, 0, bad)).runCode('x'), (e: unknown) => {
      return e instanceof SandboxError && e.code === 'protocol-error';
    });
  });

  test('JSON 合法但报告不合 schema → protocol-error', async () => {
    await assert.rejects(runnerWith((child) => finish(child, 0, '{"status":"ok"}')).runCode('x'), (e: unknown) => {
      return e instanceof SandboxError && e.code === 'protocol-error';
    });
  });

  test('ok / build-error 都携带 child 的 console 与 consoleTruncated', async () => {
    const report = okReportText();
    const parsed = JSON.parse(report.text) as Record<string, unknown>;
    const okText = JSON.stringify({
      ...parsed,
      console: [{ level: 'log', text: 'hi' }],
      consoleTruncated: 3,
    });
    const ok = await runnerWith((child) => finish(child, 0, okText)).runCode('x');
    if (ok.kind !== 'ok') throw new Error(ok.kind);
    assert.deepEqual(ok.console, [{ level: 'log', text: 'hi' }]);
    assert.equal(ok.consoleTruncated, 3);

    const errText = JSON.stringify({
      status: 'build-error',
      error: { name: 'ModelError', message: 'm', line: 1, column: 1 },
      console: [{ level: 'warn', text: 'w' }],
      consoleTruncated: 0,
    });
    const err = await runnerWith((child) => finish(child, 0, errText)).runCode('x');
    if (err.kind !== 'build-error') throw new Error(err.kind);
    assert.deepEqual(err.console, [{ level: 'warn', text: 'w' }]);
    assert.equal(err.consoleTruncated, 0);
  });

  test('build-error 报告 → build-error，带位置', async () => {
    const text = JSON.stringify({
      status: 'build-error',
      error: { name: 'ModelError', message: '坏的 profile', line: 3, column: 5 },
      console: [{ level: 'log', text: 'hi' }],
      consoleTruncated: 0,
    });
    const result = await runnerWith((child) => finish(child, 0, text)).runCode('x');
    if (result.kind !== 'build-error') throw new Error(result.kind);
    assert.equal(result.message, '坏的 profile');
    assert.equal(result.line, 3);
  });

  test('空输出 / 非 JSON → crashed', async () => {
    assert.equal((await runnerWith((child) => finish(child, 1)).runCode('x')).kind, 'crashed');
    assert.equal((await runnerWith((child) => finish(child, 0, 'not json')).runCode('x')).kind, 'crashed');
  });

  test('合法报告但退出码非 0 → crashed', async () => {
    const report = okReportText();
    assert.equal((await runnerWith((child) => finish(child, 7, report.text)).runCode('x')).kind, 'crashed');
  });

  test('退出码 3 + PG_PROTOCOL_ERROR 前缀 → protocol-error', async () => {
    await assert.rejects(
      runnerWith((child) => finish(child, 3, undefined, 'PG_PROTOCOL_ERROR:输入不合 schema\n')).runCode('x'),
      (e: unknown) => e instanceof SandboxError && e.code === 'protocol-error',
    );
  });

  test('子进程 error 事件 → unsupported', async () => {
    const runner = runnerWith((child) => {
      setImmediate(() => child.emit('error', new Error('spawn boom')));
    });
    const result = await runner.runCode('x');
    assert.equal(result.kind, 'unsupported');
  });

  test('out-of-memory：退出码 134 / 133 + stderr 关键字', async () => {
    const heap = runnerWith((child) => finish(child, 134, undefined, 'heap out of memory'));
    assert.equal((await heap.runCode('x')).kind, 'out-of-memory');
    const fatal = runnerWith((child) => finish(child, 133, undefined, 'Fatal process out of memory'));
    assert.equal((await fatal.runCode('x')).kind, 'out-of-memory');
  });

  test('输出超过 maxOutputBytes → output-too-large 并击毙子进程', async () => {
    const runner = runnerWith((child) => finish(child, 0, 'x'.repeat(64)));
    const result = await runner.runCode('x', { maxOutputBytes: 8 });
    assert.equal(result.kind, 'output-too-large');
  });
});

describe('modeling 单元：超时 / abort / 串行', () => {
  test('超时击毙子进程并返回 timeout', async () => {
    const fake = makeSpawn(() => undefined);
    const runner = createModelRunner(makeDeps({ spawn: fake.spawn }));
    const started = Date.now();
    const result = await runner.runCode('x', { timeoutMs: 20 });
    if (result.kind !== 'timeout') throw new Error(result.kind);
    assert.ok(Date.now() - started >= 10);
  });

  test('abort 返回 aborted', async () => {
    const fake = makeSpawn(() => undefined);
    const runner = createModelRunner(makeDeps({ spawn: fake.spawn }));
    const controller = new AbortController();
    controller.abort();
    const result = await runner.runCode('x', { signal: controller.signal });
    assert.equal(result.kind, 'aborted');
  });

  test('预检进行中 abort：停掉预检线程、返回 aborted，下次重建', async () => {
    let created = 0;
    let closed = 0;
    const runner = createModelRunner(
      makeDeps({
        precheck: () => {
          created += 1;
          return {
            check: () => new Promise<PrecheckResult>(() => undefined),
            version: 'test',
            close: () => {
              closed += 1;
              return Promise.resolve();
            },
          };
        },
      }),
    );
    const controller = new AbortController();
    const pending = runner.runCode('x', { signal: controller.signal });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    controller.abort();
    const result = await pending;
    assert.equal(result.kind, 'aborted');
    assert.equal(created, 1);
    assert.equal(closed, 1);
  });

  test('传入未中止的 signal 时正常完成', async () => {
    const report = okReportText();
    const runner = runnerWith((child) => finish(child, 0, report.text));
    const controller = new AbortController();
    const result = await runner.runCode('x', { signal: controller.signal });
    assert.equal(result.kind, 'ok');
  });

  test('同一 runner 并发 3 次任一时刻只有一个子进程', async () => {
    const shared = makeSpawn((child) => {
      setTimeout(() => {
        const report = okReportText();
        finish(child, 0, report.text);
      }, 20);
    });
    const runner = createModelRunner(makeDeps({ spawn: shared.spawn }));
    const results = await Promise.all([runner.runCode('a'), runner.runCode('b'), runner.runCode('c')]);
    assert.deepEqual(
      results.map((r) => r.kind),
      ['ok', 'ok', 'ok'],
    );
    assert.equal(shared.starts, 3);
    assert.equal(shared.maxActive(), 1);
  });
});

describe('modeling 单元：close 与公开预检', () => {
  test('close 终止预检器且可重复调用', async () => {
    let closes = 0;
    const runner = createModelRunner(makeDeps({ precheck: () => fakePrechecker({ kind: 'ok' }, () => (closes += 1)) }));
    // 触发一次预检（fake spawn 永不结束，给 1ms 超时避免拖慢）。预检器在 spawn 前就已创建。
    await runner.runCode('x', { timeoutMs: 1 });
    await runner.close();
    await runner.close();
    assert.equal(closes, 1);
  });

  test('createModelPrechecker 用 Model 桥接，World 入口报 TS2304', async () => {
    const prechecker = createModelPrechecker();
    try {
      assert.deepEqual(await prechecker.check('export default function build(model: Model): void { void model; }'), {
        kind: 'ok',
      });
      const wrong = await prechecker.check('export default function build(w: World): void { void w; }');
      if (wrong.kind !== 'failed') throw new Error(`期望 failed，实际 ${wrong.kind}`);
      assert.ok(wrong.diagnostics.some((d) => d.code === 'TS2304'));
      const asyncEntry = await prechecker.check(
        'export default async function build(model: Model): Promise<void> { void model; }',
      );
      if (asyncEntry.kind !== 'failed') throw new Error('async 入口应报错');
      assert.ok(asyncEntry.diagnostics.some((d) => d.code === 'PG002'));
    } finally {
      await prechecker.close();
    }
  });

  test('类型级入口核对：参数必须能接收 Model、返回必须 void', async () => {
    const prechecker = createModelPrechecker();
    try {
      const badParam = await prechecker.check(
        'export default function build(model: number): number { return model + 1; }',
      );
      if (badParam.kind !== 'failed') throw new Error('model:number 应报错');
      const codes = badParam.diagnostics.map((d) => d.code);
      assert.ok(codes.includes('PG006'), codes.join(','));
      assert.ok(codes.includes('PG007'), codes.join(','));

      const promise = await prechecker.check(
        'export default function build(model: Model): Promise<void> { return Promise.resolve().then(() => model.box({ id: "b", name: "盒", role: "volume", color: "#112233", size: [1, 1, 1] })); }',
      );
      if (promise.kind !== 'failed') throw new Error('Promise<void> 入口应报错');
      assert.ok(promise.diagnostics.some((d) => d.code === 'PG007'));

      const inferred = await prechecker.check('export default function build(model: Model) { void model; }');
      assert.deepEqual(inferred, { kind: 'ok' });
    } finally {
      await prechecker.close();
    }
  });

  test('预检 version 随 globalsText / entry 变化', async () => {
    const modeled = createModelPrechecker();
    const world = createPrechecker(MODEL_DECLARATION);
    try {
      assert.match(modeled.version, /^[0-9a-f]{64}$/);
      assert.notEqual(modeled.version, world.version);
    } finally {
      await Promise.all([modeled.close(), world.close()]);
    }
  });

  test('runModelCode 一次性入口在超大代码时不启动任何子进程', async () => {
    const result = await runModelCode('x'.repeat(300 * 1024));
    assert.equal(result.kind, 'too-large');
  });
});
