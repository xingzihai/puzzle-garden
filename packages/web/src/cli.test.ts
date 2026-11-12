/**
 * cli.ts 的单元测试：参数解析、注入式运行流程、信号等待，以及直接执行的 `--help`。
 *
 * 运行流程用假 io，不真正启动服务；直接执行测试 spawn 子进程跑 `--help`，它会自行退出。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';

import { createDefaultIo, createSignalWaiter, parseCliArgs, runCli } from './cli.ts';
import type { CliIo, SignalSource } from './cli.ts';

const execFileAsync = promisify(execFile);

class FakeSignals implements SignalSource {
  readonly listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown {
    this.listeners.set(event, listener);
    return this;
  }
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown {
    if (this.listeners.get(event) === listener) this.listeners.delete(event);
    return this;
  }
  emit(event: 'SIGINT' | 'SIGTERM'): void {
    this.listeners.get(event)?.();
  }
}

interface FakeIo {
  readonly io: CliIo;
  readonly stdout: string[];
  readonly stderr: string[];
  started(): number;
  isClosed(): boolean;
  lastOptions(): { readonly port: number; readonly model?: ModelDocument } | undefined;
}

function modelJson(): string {
  const model = createModel();
  model.box({ id: 'part-box', name: '盒', role: 'volume', color: '#8899aa', size: [2, 3, 4] });
  return JSON.stringify(model.finish());
}

function fakeIo(argv: readonly string[], files: Readonly<Record<string, string>> = {}): FakeIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let starts = 0;
  let closed = false;
  let options: { readonly port: number; readonly model?: ModelDocument } | undefined;
  const io: CliIo = {
    argv,
    stdout: (line) => {
      stdout.push(line);
    },
    stderr: (line) => {
      stderr.push(line);
    },
    startServer: (next) => {
      starts += 1;
      options = next;
      return Promise.resolve({
        url: 'http://127.0.0.1:4173',
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      });
    },
    waitForShutdown: () => Promise.resolve('SIGINT'),
    readText: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
  };
  return { io, stdout, stderr, started: () => starts, isClosed: () => closed, lastOptions: () => options };
}

test('parseCliArgs 默认端口 4173，支持 --port、--model 与 help', () => {
  assert.deepEqual(parseCliArgs([]), { kind: 'run', port: 4173 });
  assert.deepEqual(parseCliArgs(['--port', '0']), { kind: 'run', port: 0 });
  assert.deepEqual(parseCliArgs(['--port', '5000']), { kind: 'run', port: 5000 });
  assert.deepEqual(parseCliArgs(['--model', 'm.json']), { kind: 'run', port: 4173, modelPath: 'm.json' });
  assert.deepEqual(parseCliArgs(['--model', 'a.json', '--port', '5001']), {
    kind: 'run',
    port: 5001,
    modelPath: 'a.json',
  });
  assert.deepEqual(parseCliArgs(['--help']), { kind: 'help' });
  assert.deepEqual(parseCliArgs(['-h']), { kind: 'help' });
});

test('parseCliArgs 对非法参数返回可读错误', () => {
  for (const argv of [
    ['--port'],
    ['--port', 'abc'],
    ['--port', '1.5'],
    ['--port', '-1'],
    ['--port', '70000'],
    ['--port', '12x'],
    ['--nope'],
    ['--model'],
    ['--model', ''],
    ['--model', 'a.json', '--model', 'b.json'],
  ]) {
    const result = parseCliArgs(argv);
    assert.equal(result.kind, 'error', argv.join(' '));
    assert.ok(result.message.length > 0);
  }
});

test('createSignalWaiter 收到第一个信号后解析并移除监听', async () => {
  const signals = new FakeSignals();
  const waiter = createSignalWaiter(signals);
  assert.equal(signals.listeners.size, 2);
  signals.emit('SIGINT');
  assert.equal(await waiter, 'SIGINT');
  assert.equal(signals.listeners.size, 0);
});

test('createSignalWaiter 也响应 SIGTERM', async () => {
  const signals = new FakeSignals();
  const waiter = createSignalWaiter(signals);
  signals.emit('SIGTERM');
  assert.equal(await waiter, 'SIGTERM');
  assert.equal(signals.listeners.size, 0);
});

test('runCli --help 打印用法且不启动服务', async () => {
  const fake = fakeIo(['--help']);
  assert.equal(await runCli(fake.io), 0);
  assert.equal(fake.started(), 0);
  assert.ok(fake.stdout.join('\n').includes('--port'));
});

test('runCli 参数错误返回码 2 且写 stderr', async () => {
  const fake = fakeIo(['--port', 'abc']);
  assert.equal(await runCli(fake.io), 2);
  assert.equal(fake.started(), 0);
  assert.ok(fake.stderr.join('\n').includes('非法'));
});

test('runCli 启动后打印 URL，收到信号后优雅关闭', async () => {
  const fake = fakeIo(['--port', '0']);
  assert.equal(await runCli(fake.io), 0);
  assert.equal(fake.started(), 1);
  const out = fake.stdout.join('\n');
  assert.ok(out.includes('http://127.0.0.1:4173'));
  assert.ok(out.includes('Ctrl-C'));
  assert.ok(fake.isClosed());
});

test('runCli --model 读取并校验后把模型传给服务', async () => {
  const fake = fakeIo(['--model', 'm.json'], { 'm.json': modelJson() });
  assert.equal(await runCli(fake.io), 0);
  assert.equal(fake.started(), 1);
  const options = fake.lastOptions();
  assert.ok(options !== undefined);
  assert.equal(options.port, 4173);
  const model = options.model;
  assert.ok(model !== undefined);
  assert.equal(model.version, 2);
  assert.deepEqual(
    model.parts.map((part) => part.id),
    ['part-box'],
  );
  assert.ok(fake.stdout.join('\n').includes('函数草模'));
  assert.ok(fake.isClosed());
});

test('runCli 对不存在 / 非法 JSON / 不合 schema 的模型文件响亮退出', async () => {
  const cases: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
    ['missing.json', {}],
    ['bad.json', { 'bad.json': '{ not json' }],
    ['wrong.json', { 'wrong.json': JSON.stringify({ version: 3, parts: [] }) }],
  ];
  for (const [path, files] of cases) {
    const fake = fakeIo(['--model', path], files);
    assert.equal(await runCli(fake.io), 2, path);
    assert.equal(fake.started(), 0, path);
    assert.ok(fake.stderr.join('\n').includes(path), path);
  }
});

test('createDefaultIo 组装真实 I/O 但不启动服务', () => {
  const io = createDefaultIo();
  assert.equal(typeof io.startServer, 'function');
  assert.equal(typeof io.waitForShutdown, 'function');
  assert.equal(typeof io.stdout, 'function');
  assert.equal(typeof io.readText, 'function');
});

test('cli.ts 直接执行 --help 退出码 0 并打印用法', async () => {
  const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const result = await execFileAsync(process.execPath, [cliPath, '--help']);
  assert.ok(result.stdout.includes('--port'));
});
