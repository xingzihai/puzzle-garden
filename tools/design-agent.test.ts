import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Config } from '@pg/config';
import { exampleRequirements, exampleScheme } from '@pg/interaction/example';

import { DESIGN_AGENT_USAGE, parseDesignAgentArgs, runDesignAgent } from './design-agent.ts';
import type { DesignAgentDeps, DesignAgentIo } from './design-agent.ts';

interface Capture {
  readonly io: DesignAgentIo;
  readonly out: string[];
  readonly err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (line) => {
        out.push(line);
      },
      stderr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-design-agent-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMock(dir: string, value: unknown): Promise<string> {
  const path = join(dir, 'mock.json');
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

test('--example 写出全部 artifacts，lint 干净，且不调用模型', async () => {
  await withTempDir(async (out) => {
    const captured = capture();
    const code = await runDesignAgent(['--example', '--out', out, '--session', 'ses-example-test'], {
      io: captured.io,
    });
    assert.equal(code, 0);
    const dir = join(out, 'ses-example-test');
    const design = await readFile(join(dir, 'design.md'), 'utf8');
    const task = await readFile(join(dir, 'build-task.md'), 'utf8');
    const spec = JSON.parse(await readFile(join(dir, 'build-spec.json'), 'utf8')) as Record<string, unknown>;
    const gates = JSON.parse(await readFile(join(dir, 'gates.json'), 'utf8')) as Record<string, unknown>;
    const meta = JSON.parse(await readFile(join(dir, 'prompt-meta.json'), 'utf8')) as Record<string, unknown>;
    assert.match(design, /# 稻田茶亭/);
    assert.match(task, /## 四、验收与自由发挥/);
    assert.equal(spec['schemeId'], 'scheme-tea');
    assert.equal(meta['schemeId'], 'scheme-tea');
    assert.equal(typeof gates['reachAll'], 'boolean');
    assert.ok(captured.out.some((line) => line.includes('设计报告摘要：稻田茶亭')));
    assert.ok(captured.err.length === 0);
    assert.equal(
      captured.out.some((line) => line.includes('不调用模型')),
      true,
    );
  });
});

test('--mock 走 generate 的校验路径并写出 artifacts', async () => {
  await withTempDir(async (dir) => {
    const scriptPath = await writeMock(dir, {
      task: '在村口做一间能坐十个人的小茶室。',
      requirements: exampleRequirements(),
      scheme: exampleScheme(),
    });
    const captured = capture();
    const code = await runDesignAgent(['--mock', scriptPath, '--out', dir, '--session', 'ses-mock-test'], {
      io: captured.io,
    });
    assert.equal(code, 0);
    const design = await readFile(join(dir, 'ses-mock-test', 'design.md'), 'utf8');
    assert.match(design, /## 室内/);
    assert.match(design, /中央长桌/);
    const intent = JSON.parse(await readFile(join(dir, 'ses-mock-test', 'design-intent.json'), 'utf8')) as {
      meta: { title: string };
    };
    assert.equal(intent.meta.title, '稻田茶亭');
    assert.ok(captured.out.some((line) => line.includes('离线 mock')));
    assert.ok(captured.out.some((line) => line.includes('design-intent.json')));
  });
});

test('--mock 的方案 lint 不通过时返回 1，且不写 artifacts', async () => {
  await withTempDir(async (dir) => {
    const scriptPath = await writeMock(dir, {
      requirements: exampleRequirements(),
      scheme: { ...exampleScheme(), interiors: [] },
    });
    const captured = capture();
    const code = await runDesignAgent(
      ['--mock', scriptPath, '--out', dir, '--session', 'ses-mock-lint', '--legacy-scheme'],
      { io: captured.io },
    );
    assert.equal(code, 1);
    assert.ok(captured.err.some((line) => line.includes('lint 未通过')));
    await assert.rejects(() => readFile(join(dir, 'ses-mock-lint', 'design.md'), 'utf8'));
  });
});

test('非法 session / 缺 task / 未确认 live 都返回 2', async () => {
  await withTempDir(async (dir) => {
    const captured = capture();
    assert.equal(await runDesignAgent(['--example', '--out', dir, '--session', '../escape'], { io: captured.io }), 2);

    const liveNoTask = await runDesignAgent(['--live', '--out', dir], { io: captured.io });
    assert.equal(liveNoTask, 2);

    const taskPath = join(dir, 'brief.md');
    await writeFile(taskPath, '设计一间小茶室。', 'utf8');
    let clientCreated = false;
    const config: Config = {
      llm: { baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'deepseek-flash', timeoutMs: 1000 },
      maxRunCostCny: 0,
      liveConfirm: false,
    };
    const deps: DesignAgentDeps = {
      io: captured.io,
      loadConfig: () => config,
      createLiveClient: () => {
        clientCreated = true;
        throw new Error('未确认时不应创建 live client');
      },
    };
    const liveUnconfirmed = await runDesignAgent(['--live', '--task', taskPath, '--out', dir], deps);
    assert.equal(liveUnconfirmed, 2);
    assert.equal(clientCreated, false);
    assert.ok(captured.err.some((line) => line.includes('PG_LIVE_CONFIRM=1')));
  });
});

test('参数解析：默认 session、help 与三个模式互斥', async () => {
  assert.equal(parseDesignAgentArgs(['--example']).sessionId, 'ses-example-tea');
  assert.equal(parseDesignAgentArgs(['--mock', 'x.json']).sessionId, 'ses-mock-tea');
  assert.equal(parseDesignAgentArgs(['--live', '--task', 'x.md']).sessionId, 'ses-live-tea');
  assert.throws(() => parseDesignAgentArgs(['--example', '--live']), /只能选一个/);
  assert.throws(() => parseDesignAgentArgs([]), /必须指定/);
  assert.throws(() => parseDesignAgentArgs(['--example', '--task', 'x.md']), /只用于 --live/);
  const captured = capture();
  assert.equal(await runDesignAgent(['--help'], { io: captured.io }), 0);
  assert.deepEqual(captured.out, [DESIGN_AGENT_USAGE]);
});

test('参数解析：--answers / --feedback / --resume / --legacy-scheme', () => {
  assert.equal(parseDesignAgentArgs(['--mock', 'x.json']).legacyScheme, false);
  assert.equal(parseDesignAgentArgs(['--mock', 'x.json', '--legacy-scheme']).legacyScheme, true);
  const parsed = parseDesignAgentArgs([
    '--live',
    '--task',
    'x.md',
    '--session',
    'ses-live-x',
    '--answers',
    '["北侧","yes"]',
    '--feedback',
    '屋檐再深一点',
    '--resume',
  ]);
  assert.deepEqual(parsed.answers, ['北侧', 'yes']);
  assert.equal(parsed.feedback, '屋檐再深一点');
  assert.equal(parsed.resume, true);

  const resumed = parseDesignAgentArgs(['--live', '--resume', '--session', 'ses-live-x']);
  assert.equal(resumed.taskPath, undefined);
  assert.equal(resumed.resume, true);

  assert.throws(() => parseDesignAgentArgs(['--live', '--resume']), /--session/);
  assert.throws(() => parseDesignAgentArgs(['--example', '--answers', '[]']), /只用于/);
  assert.throws(() => parseDesignAgentArgs(['--mock', 'x.json', '--answers', '{bad']), /合法 JSON/);
});

test('--mock --answers 走对话并写 session.json；回答不足返回 2', async () => {
  await withTempDir(async (dir) => {
    const scriptPath = await writeMock(dir, {
      task: '在村口做一间小茶室。',
      requirements: exampleRequirements(),
      scheme: exampleScheme(),
    });
    const captured = capture();
    const code = await runDesignAgent(
      ['--mock', scriptPath, '--out', dir, '--session', 'ses-mock-conversation', '--answers', '["yes"]'],
      { io: captured.io },
    );
    assert.equal(code, 0);
    const session = JSON.parse(await readFile(join(dir, 'ses-mock-conversation', 'session.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(session['stage'], 'compile');
    assert.equal(Array.isArray(session['intents']), true);
    assert.equal((session['intents'] as readonly unknown[]).length, 1);
    assert.match(await readFile(join(dir, 'ses-mock-conversation', 'design.md'), 'utf8'), /稻田茶亭/);
    await readFile(join(dir, 'ses-mock-conversation', 'design-intent.json'), 'utf8');

    const capturedShort = capture();
    const shortCode = await runDesignAgent(
      ['--mock', scriptPath, '--out', dir, '--session', 'ses-mock-short', '--answers', '[]'],
      { io: capturedShort.io },
    );
    assert.equal(shortCode, 2);
    assert.ok(capturedShort.err.some((line) => line.includes('数量不足')));
  });
});
