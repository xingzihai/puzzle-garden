/**
 * 性能基准入口：`npm run bench`。
 *
 * 规则（docs/STANDARDS.md §8）：单元测试里不写计时断言；性能只在这里测。
 * 每个包可以提供 `src/**\/*.bench.ts`，默认导出 `Bench[]`（类型见 @pg/core/bench）。结果带机器信息与负载，
 * 写到 .work/bench/<时间>.json，便于前后对照。基准不进 `npm run check`。
 *
 * 用法：node tools/bench.ts [名称过滤]
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Bench } from '@pg/core/bench';

interface Result {
  readonly name: string;
  readonly file: string;
  readonly iterations: number;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

function listBenchFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (name === 'node_modules') continue;
    if (statSync(full).isDirectory()) out.push(...listBenchFiles(full));
    else if (name.endsWith('.bench.ts')) out.push(full);
  }
  return out;
}

function isBenchList(value: unknown): value is Bench[] {
  return (
    Array.isArray(value) &&
    value.every(
      (b: unknown) =>
        typeof b === 'object' &&
        b !== null &&
        typeof (b as { name?: unknown }).name === 'string' &&
        typeof (b as { run?: unknown }).run === 'function',
    )
  );
}

async function measure(bench: Bench): Promise<{ times: number[]; sink: unknown[] }> {
  const sink: unknown[] = [];
  for (let i = 0; i < (bench.warmup ?? 3); i += 1) sink.push(await bench.run());
  const times: number[] = [];
  for (let i = 0; i < (bench.iterations ?? 10); i += 1) {
    const t0 = performance.now();
    sink.push(await bench.run());
    times.push(performance.now() - t0);
  }
  return { times, sink };
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const filter = process.argv[2];
  const files = listBenchFiles(join(root, 'packages'));
  const results: Result[] = [];

  for (const file of files) {
    const mod: unknown = await import(pathToFileURL(file).href);
    const list = (mod as { default?: unknown }).default;
    if (!isBenchList(list)) throw new Error(`${relative(root, file)} 的默认导出必须是 Bench[]`);
    for (const bench of list) {
      if (filter !== undefined && !bench.name.includes(filter)) continue;
      const { times, sink } = await measure(bench);
      const sorted = [...times].sort((a, b) => a - b);
      const result: Result = {
        name: bench.name,
        file: relative(root, file),
        iterations: times.length,
        medianMs: sorted[Math.floor(sorted.length / 2)] ?? Number.NaN,
        minMs: sorted[0] ?? Number.NaN,
        maxMs: sorted[sorted.length - 1] ?? Number.NaN,
      };
      results.push(result);
      console.log(
        `${bench.name.padEnd(40)} 中位 ${result.medianMs.toFixed(2)}ms  [${result.minMs.toFixed(2)}, ${result.maxMs.toFixed(2)}]  (${String(sink.length)} 次)`,
      );
    }
  }

  if (results.length === 0) {
    console.log('没有找到基准（packages/*/src/**/*.bench.ts）');
    return;
  }
  const machine = {
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memGb: Math.round(totalmem() / 1024 ** 3),
    // 计时结果变差时先看负载，再下"性能回归"结论（v02:docs/LESSONS.md §11.8）
    loadavg: loadavg(),
  };
  const outDir = join(root, '.work/bench');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, `${JSON.stringify({ machine, results }, null, 2)}\n`);
  console.log(`\n负载 ${machine.loadavg.map((n) => n.toFixed(2)).join(' / ')} · 结果 → ${relative(root, out)}`);
}

await main();
