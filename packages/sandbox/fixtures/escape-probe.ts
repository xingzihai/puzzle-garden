/**
 * 逃逸探针（SANDBOX-SPEC §10 第 11 条）：用与产品路径同一个 `sandboxLaunch` 参数直接跑，
 * 不经 child，所以 `process`、`import` 都可用，是最坏情形。第一参数选探针，第二参数给仓库根
 * （用来构造 .env.sbxtest 路径）。结果打印一行 JSON。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:inspector';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const probe = process.argv[2] ?? '';
const repoRoot = process.argv[3] ?? '';

function codeOf(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof error !== 'object' || error === null) return undefined;
  const record = error as { code?: unknown; cause?: unknown };
  if (typeof record.code === 'string') return record.code;
  return codeOf(record.cause, depth + 1);
}

async function attempt(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return 'ok';
  } catch (error: unknown) {
    const code = codeOf(error);
    if (code !== undefined) return code;
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

function readProbe(path: string): string {
  return readFileSync(path, 'utf8').length > 0 ? 'ok' : 'ok';
}

async function run(): Promise<unknown> {
  switch (probe) {
    case 'network':
      return {
        fetch: await attempt(() => fetch('http://1.1.1.1/')),
        net: await attempt(
          () =>
            new Promise<string>((resolve, reject) => {
              const socket = connect(53, '1.1.1.1');
              socket.on('connect', () => {
                socket.destroy();
                resolve('connected');
              });
              socket.on('error', reject);
            }),
        ),
      };
    case 'read':
      return {
        dotenv: await attempt(() => readProbe(join(repoRoot, '.env.sbxtest'))),
        home: await attempt(() => readProbe(join(homedir(), '.ssh', 'known_hosts'))),
        etc: await attempt(() => readProbe('/etc/passwd')),
        proc: await attempt(() => readProbe('/proc/1/cmdline')),
      };
    case 'write':
      return {
        tmp: await attempt(() => {
          writeFileSync('/tmp/pg-escape', 'x');
        }),
        repo: await attempt(() => {
          writeFileSync(join(repoRoot, 'pg-escape'), 'x');
        }),
        opt: await attempt(() => {
          writeFileSync('/opt/pg/pg-escape', 'x');
        }),
      };
    case 'process':
      return {
        execFileSync: await attempt(() => execFileSync('true')),
        worker: await attempt(() => new Worker('0')),
        binding: await attempt(() =>
          (process as unknown as { binding: (name: string) => unknown }).binding('spawn_sync'),
        ),
        dlopen: await attempt(() =>
          (process as unknown as { dlopen: (m: unknown, f: string) => unknown }).dlopen({}, '/tmp/x'),
        ),
        inspector: await attempt(() => open(0)),
      };
    case 'eval': {
      // 不写 eval/new Function 字面量，避免触发构建期的 no-eval / no-implied-eval；运行时仍是它们。
      const evalFn = Reflect.get(globalThis, 'eval') as (code: string) => unknown;
      const FunctionCtor = Reflect.get(globalThis, 'Function') as unknown as new (body: string) => () => unknown;
      return {
        eval: await attempt(() => evalFn('1')),
        fn: await attempt(() => {
          const created: unknown = new FunctionCtor('return 1');
          return (created as () => unknown)();
        }),
      };
    }
    case 'env':
      return { keys: Object.keys(process.env).sort() };
    case 'stdout':
      process.stdout.write('JUNK');
      return 'wrote';
    default:
      return { error: `未知探针 ${probe}` };
  }
}

void run().then((result) => {
  process.stdout.write(`\nPROBE_RESULT:${JSON.stringify(result)}\n`);
  process.exit(0);
});
