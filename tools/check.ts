/**
 * 统一门禁：`npm run check`。按顺序跑每一项，显示耗时，任一失败则退出码 1。
 * 只跑离线检查；任何会联网、花钱、启动浏览器或依赖 bwrap 的东西都不允许进这里。
 * 退出码是唯一的通过依据（不要用 grep 输出文字判断结果）。
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface Step {
  readonly name: string;
  readonly script: string;
}

const STEPS: readonly Step[] = [
  { name: '格式检查', script: 'format:check' },
  { name: '类型检查', script: 'typecheck' },
  { name: '规范检查', script: 'lint' },
  { name: '依赖声明', script: 'check:deps' },
  { name: '资产校验', script: 'check:assets' },
  { name: '测试配对', script: 'check:tests' },
  { name: '单元测试与覆盖率', script: 'test:coverage' },
  { name: '工具测试', script: 'test:tools' },
];

const TIMEOUT_MS = 10 * 60 * 1000;

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const started = performance.now();
  const failed: string[] = [];

  for (const step of STEPS) {
    console.log(`\n=== ${step.name} ===`);
    const t0 = performance.now();
    const result = spawnSync('npm', ['run', '--silent', step.script], {
      cwd: root,
      stdio: 'inherit',
      timeout: TIMEOUT_MS,
    });
    const seconds = ((performance.now() - t0) / 1000).toFixed(1);
    const ok = result.status === 0 && result.error === undefined;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${step.name} (${seconds}s)`);
    if (!ok) failed.push(step.name);
  }

  const total = ((performance.now() - started) / 1000).toFixed(1);
  if (failed.length > 0) {
    console.error(`\n未通过：${failed.join('、')} · 共 ${String(STEPS.length)} 项 · ${total}s`);
    process.exitCode = 1;
  } else {
    console.log(`\n全部通过 · ${String(STEPS.length)} 项 · ${total}s`);
  }
}

main();
