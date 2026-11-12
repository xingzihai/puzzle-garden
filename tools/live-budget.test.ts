import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { costOf, reserveFor } from '@pg/llm/cost';
import type { AttemptRecord, ChatClient, CompleteOptions } from '@pg/llm/client';
import type { ChatRequest, ChatResponse, LlmFailure, Usage } from '@pg/llm/schema';
import type { Config } from '@pg/config';
import { exampleIntent, exampleRequirements, exampleScheme } from '@pg/interaction/example';

import { runDesignAgent } from './design-agent.ts';
import { createMockClient } from './design-agent-mock.ts';
import { withLiveBudget } from './live-budget.ts';

interface FakeCall {
  readonly request: ChatRequest;
  readonly opts: CompleteOptions;
}

function usageOf(promptTokens: number, completionTokens: number): Usage {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: promptTokens,
  };
}

function response(usage: Usage): ChatResponse {
  return {
    id: 'response-test',
    model: 'deepseek-flash',
    systemFingerprint: null,
    message: { role: 'assistant', content: 'ok' },
    rawArguments: [],
    finishReason: 'stop',
    usage,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

function attemptRecord(usage: Usage | null, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attempt: 1,
    outcome: 'ok',
    failure: null,
    charge: usage === null ? 'none' : 'usage',
    usage,
    delayMs: null,
    timing: { firstByteMs: null, totalMs: 0 },
    ...overrides,
  };
}

function scriptedClient(run: (call: FakeCall) => Promise<ChatResponse> | ChatResponse): {
  readonly client: ChatClient;
  readonly calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const client: ChatClient = {
    async complete(request, opts) {
      const call = { request, opts };
      calls.push(call);
      return { kind: 'ok', response: await run(call) };
    },
  };
  return { client, calls };
}

function completeOptions(onAttempt: (record: AttemptRecord) => void = () => undefined): CompleteOptions {
  return {
    signal: new AbortController().signal,
    beforeRetry: () => 'continue',
    onAttempt,
  };
}

function makeRequest(options: { readonly maxTokens?: number; readonly userText?: string } = {}): ChatRequest {
  const base: Omit<ChatRequest, 'max_tokens'> = {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: options.userText ?? 'hello' },
    ],
    tools: [],
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.maxTokens === undefined) return base;
  return { ...base, max_tokens: options.maxTokens };
}

function requestBytes(request: ChatRequest): number {
  const systemBytes = request.messages.reduce(
    (total, message) => (message.role === 'system' ? total + Buffer.byteLength(message.content, 'utf8') : total),
    0,
  );
  return (
    Buffer.byteLength(JSON.stringify(request.messages), 'utf8') +
    Buffer.byteLength(JSON.stringify(request.tools), 'utf8') +
    systemBytes
  );
}

function expectedReserve(
  request: ChatRequest,
  limitCny: number,
  spentCny = 0,
  prevPromptTokens = 0,
  first = true,
): { readonly maxTokens: number; readonly reservedCny: number } {
  const result = reserveFor({
    prevPromptTokens,
    first,
    newBytes: requestBytes(request),
    newMessages: request.messages.length,
    newImages: 0,
    spentCny,
    limitCny,
  });
  assert.ok(!('stop' in result));
  return result;
}

const RETRY_FAILURE: LlmFailure = {
  class: 'transport',
  code: 'network',
  status: null,
  retriable: true,
  message: '模拟收到 200 后断流',
};

/**
 * 模拟真实 client 的重试顺序：失败后先调用 beforeRetry，再 onAttempt 报告刚失败的 attempt。
 * 返回的 beforeRetryAttempts 记录每次被询问的下一 attempt 编号，便于断言预算在哪一步停止。
 */
function failingRetryClient(options: {
  readonly maxAttempts: number;
  readonly charge: AttemptRecord['charge'];
  readonly usage?: Usage;
}): { readonly client: ChatClient; readonly beforeRetryAttempts: number[] } {
  const beforeRetryAttempts: number[] = [];
  const client: ChatClient = {
    complete(_request, opts) {
      for (let attempt = 1; ; attempt += 1) {
        const base = {
          attempt,
          failure: RETRY_FAILURE,
          charge: options.charge,
          usage: options.usage ?? null,
          timing: { firstByteMs: null, totalMs: attempt },
        };
        if (attempt >= options.maxAttempts) {
          opts.onAttempt({ ...base, outcome: 'final-failure', delayMs: null });
          return Promise.resolve({ kind: 'failed' as const, failure: RETRY_FAILURE });
        }
        beforeRetryAttempts.push(attempt + 1);
        if (opts.beforeRetry({ attempt: attempt + 1, failure: RETRY_FAILURE, delayMs: 1000 }) === 'stop') {
          opts.onAttempt({ ...base, outcome: 'stopped-by-guard', delayMs: null });
          return Promise.resolve({ kind: 'failed' as const, failure: RETRY_FAILURE });
        }
        opts.onAttempt({ ...base, outcome: 'retry', delayMs: 1000 });
      }
    },
  };
  return { client, beforeRetryAttempts };
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-live-budget-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('正常调用：返回底层结果并累计 usage 花费', async () => {
  await withTempDir(async (auditDir) => {
    const usage = usageOf(1000, 100);
    const scripted = scriptedClient((call) => {
      call.opts.onAttempt(attemptRecord(usage));
      return response(usage);
    });
    const client = withLiveBudget(scripted.client, {
      maxCny: 3.5,
      label: 'ses-normal',
      auditDir,
      now: () => new Date('2026-10-20T00:00:00.000Z'),
    });

    let attempts = 0;
    const outcome = await client.complete(
      makeRequest(),
      completeOptions((record) => {
        attempts += 1;
        assert.deepEqual(record.usage, usage);
      }),
    );

    assert.equal(outcome.kind, 'ok');
    assert.equal(scripted.calls.length, 1);
    assert.equal(attempts, 1);
    assert.ok(Math.abs(client.spentCny - costOf(usage)) < 1e-12);
  });
});

test('预算耗尽：第二次请求不调用底层，返回 budget-exceeded', async () => {
  await withTempDir(async (auditDir) => {
    const firstUsage = usageOf(60_000, 0);
    const scripted = scriptedClient((call) => {
      call.opts.onAttempt(attemptRecord(firstUsage));
      return response(firstUsage);
    });
    const client = withLiveBudget(scripted.client, { maxCny: 0.025, label: 'ses-depleted', auditDir });

    const first = await client.complete(makeRequest(), completeOptions());
    assert.equal(first.kind, 'ok');
    assert.equal(scripted.calls.length, 1);

    const second = await client.complete(makeRequest(), completeOptions());
    assert.equal(second.kind, 'failed');
    assert.equal(second.failure.code, 'budget-exceeded');
    assert.equal(second.failure.class, 'cancelled');
    assert.equal(second.failure.retriable, false);
    assert.match(second.failure.message, /预算不足/);
    assert.equal(scripted.calls.length, 1);
    assert.ok(Math.abs(client.spentCny - costOf(firstUsage)) < 1e-12);

    const lines = (await readFile(join(auditDir, 'ses-depleted.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
  });
});

test('max_tokens 收敛：取原值与预留上限的较小值，缺省时使用预留上限', async () => {
  await withTempDir(async (auditDir) => {
    const scripted = scriptedClient((call) => response(usageOf(call.request.messages.length, 1)));
    const request = makeRequest({ maxTokens: 20_000, userText: 'x'.repeat(20_000) });
    const expected = reserveFor({
      prevPromptTokens: 0,
      first: true,
      newBytes: requestBytes(request),
      newMessages: request.messages.length,
      newImages: 0,
      spentCny: 0,
      limitCny: 0.1,
    });
    assert.ok(!('stop' in expected));

    const client = withLiveBudget(scripted.client, { maxCny: 0.1, label: 'ses-tokens', auditDir });
    await client.complete(request, completeOptions());
    const captured = scripted.calls[0]?.request;
    assert.ok(captured !== undefined);
    assert.equal(captured.max_tokens, expected.maxTokens);
    assert.ok(captured.max_tokens < 20_000);
    assert.ok(captured.max_tokens >= 2000);

    const undefinedScripted = scriptedClient(() => response(usageOf(10, 1)));
    const undefinedClient = withLiveBudget(undefinedScripted.client, {
      maxCny: 3.5,
      label: 'ses-tokens-default',
      auditDir,
    });
    await undefinedClient.complete(makeRequest(), completeOptions());
    assert.equal(undefinedScripted.calls[0]?.request.max_tokens, 40_000);
  });
});

test('重试：每次尝试的 usage 都累计，失败 attempt 的 usage 也计入', async () => {
  await withTempDir(async (auditDir) => {
    const retryUsage = usageOf(1000, 100);
    const finalUsage = usageOf(1200, 200);
    const scripted = scriptedClient((call) => {
      call.opts.onAttempt(attemptRecord(retryUsage, { attempt: 1, outcome: 'retry', delayMs: 1000 }));
      call.opts.onAttempt(attemptRecord(finalUsage, { attempt: 2 }));
      return response(finalUsage);
    });
    const client = withLiveBudget(scripted.client, { maxCny: 3.5, label: 'ses-retry', auditDir });

    const outcome = await client.complete(makeRequest(), completeOptions());
    assert.equal(outcome.kind, 'ok');
    const expected = costOf(retryUsage) + costOf(finalUsage);
    assert.ok(Math.abs(client.spentCny - expected) < 1e-12);
    assert.ok(Math.abs(costOf(retryUsage) - 0.0028) < 1e-12);
    assert.ok(Math.abs(expected - 0.0068) < 1e-12);

    const lines = (await readFile(join(auditDir, 'ses-retry.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
  });
});

test('审计 JSONL：固定字段、固定时间、安全文件名，reserve 按预留金额结算，不写 prompt / 密钥', async () => {
  await withTempDir(async (auditDir) => {
    const usage = usageOf(321, 45);
    const request = makeRequest({ userText: 'SECRET_PROMPT sk-live-secret' });
    const reservedCny = expectedReserve(request, 3.5).reservedCny;
    const scripted = scriptedClient((call) => {
      call.opts.onAttempt(attemptRecord(usage, { attempt: 3, outcome: 'final-failure', charge: 'reserve' }));
      return response(usage);
    });
    const client = withLiveBudget(scripted.client, {
      maxCny: 3.5,
      label: 'ses/a b',
      auditDir,
      now: () => new Date('2026-10-20T01:02:03.000Z'),
    });

    await client.complete(request, completeOptions());

    const path = join(auditDir, 'ses_a_b.jsonl');
    const text = await readFile(path, 'utf8');
    assert.equal(text.includes('SECRET_PROMPT'), false);
    assert.equal(text.includes('sk-live-secret'), false);
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ['attempt', 'charge', 'costCny', 'label', 'outcome', 'ts', 'usage']);
    assert.equal(parsed['ts'], '2026-10-20T01:02:03.000Z');
    assert.equal(parsed['label'], 'ses/a b');
    assert.equal(parsed['attempt'], 3);
    assert.equal(parsed['outcome'], 'final-failure');
    assert.equal(parsed['charge'], 'reserve');
    assert.deepEqual(parsed['usage'], usage);
    assert.ok(Math.abs((parsed['costCny'] as number) - reservedCny) < 1e-12);
    assert.ok(Math.abs(client.spentCny - reservedCny) < 1e-12);
  });
});

test('maxCny = 0：关闭硬护栏，但不改 max_tokens 且仍累计审计', async () => {
  await withTempDir(async (auditDir) => {
    const usage = usageOf(200_000, 1000);
    const scripted = scriptedClient((call) => {
      assert.equal(call.request.max_tokens, 393_216);
      call.opts.onAttempt(attemptRecord(usage));
      return response(usage);
    });
    const client = withLiveBudget(scripted.client, { maxCny: 0, label: 'ses-unlimited', auditDir });

    const outcome = await client.complete(
      makeRequest({ maxTokens: 393_216, userText: 'y'.repeat(300_000) }),
      completeOptions(),
    );

    assert.equal(outcome.kind, 'ok');
    assert.equal(scripted.calls.length, 1);
    assert.ok(client.spentCny > 0);
    const line = JSON.parse((await readFile(join(auditDir, 'ses-unlimited.jsonl'), 'utf8')).trim()) as {
      costCny: number;
    };
    assert.ok(line.costCny > 0);
  });
});

test('reserve attempt：按本次 complete 的 reserveFor 预留金额结算', async () => {
  await withTempDir(async (auditDir) => {
    const request = makeRequest();
    const reservedCny = expectedReserve(request, 0.05).reservedCny;
    const retrying = failingRetryClient({ maxAttempts: 1, charge: 'reserve' });
    const client = withLiveBudget(retrying.client, { maxCny: 0.05, label: 'ses-reserve', auditDir });

    const outcome = await client.complete(request, completeOptions());
    assert.equal(outcome.kind, 'failed');
    assert.ok(client.spentCny > 0);
    assert.ok(Math.abs(client.spentCny - reservedCny) < 1e-12);

    const line = JSON.parse((await readFile(join(auditDir, 'ses-reserve.jsonl'), 'utf8')).trim()) as {
      charge: string;
      costCny: number;
    };
    assert.equal(line.charge, 'reserve');
    assert.ok(Math.abs(line.costCny - reservedCny) < 1e-12);
  });
});

test('重试预算：maxCny = 0.05 时 4 次 attempt 被拦在第一次重试，花费不超过上限', async () => {
  await withTempDir(async (auditDir) => {
    const request = makeRequest();
    const reservedCny = expectedReserve(request, 0.05).reservedCny;
    const retrying = failingRetryClient({ maxAttempts: 4, charge: 'reserve' });
    const client = withLiveBudget(retrying.client, { maxCny: 0.05, label: 'ses-retry-budget', auditDir });

    const outcome = await client.complete(request, completeOptions());
    assert.equal(outcome.kind, 'failed');
    assert.deepEqual(retrying.beforeRetryAttempts, [2]);
    assert.ok(client.spentCny <= 0.05 + 1e-12);
    assert.ok(client.spentCny < 0.2);
    assert.ok(Math.abs(client.spentCny - reservedCny) < 1e-12);

    const lines = (await readFile(join(auditDir, 'ses-retry-budget.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0] ?? '') as { outcome: string; charge: string; costCny: number };
    assert.equal(line.outcome, 'stopped-by-guard');
    assert.equal(line.charge, 'reserve');
    assert.ok(Math.abs(line.costCny - reservedCny) < 1e-12);
  });
});

test('失败 attempt 没有 usage 时按预留金额计费，不中断后续请求', async () => {
  await withTempDir(async (auditDir) => {
    const request = makeRequest();
    const reservedCny = expectedReserve(request, 3.5).reservedCny;
    const finalUsage = usageOf(10, 1);
    const scripted = scriptedClient((call) => {
      call.opts.onAttempt(attemptRecord(null, { attempt: 1, outcome: 'retry', charge: 'reserve', delayMs: 1000 }));
      call.opts.onAttempt(attemptRecord(finalUsage, { attempt: 2 }));
      return response(finalUsage);
    });
    const client = withLiveBudget(scripted.client, { maxCny: 3.5, label: 'ses-no-usage', auditDir });

    const outcome = await client.complete(request, completeOptions());
    assert.equal(outcome.kind, 'ok');
    assert.ok(Math.abs(client.spentCny - (reservedCny + costOf(finalUsage))) < 1e-12);

    const lines = (await readFile(join(auditDir, 'ses-no-usage.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0] ?? '') as { charge: string; costCny: number };
    assert.equal(first.charge, 'reserve');
    assert.ok(Math.abs(first.costCny - reservedCny) < 1e-12);
    const second = JSON.parse(lines[1] ?? '') as { charge: string; costCny: number };
    assert.equal(second.charge, 'usage');
    assert.ok(Math.abs(second.costCny - costOf(finalUsage)) < 1e-12);
  });
});

test("charge = 'none'：未计费的 attempt 记 0，但审计保留记录", async () => {
  await withTempDir(async (auditDir) => {
    const finalUsage = usageOf(10, 1);
    const scripted = scriptedClient((call) => {
      call.opts.onAttempt(attemptRecord(null, { attempt: 1, outcome: 'retry', charge: 'none', delayMs: 1000 }));
      call.opts.onAttempt(attemptRecord(finalUsage, { attempt: 2 }));
      return response(finalUsage);
    });
    const client = withLiveBudget(scripted.client, { maxCny: 3.5, label: 'ses-none', auditDir });

    const outcome = await client.complete(makeRequest(), completeOptions());
    assert.equal(outcome.kind, 'ok');
    assert.ok(Math.abs(client.spentCny - costOf(finalUsage)) < 1e-12);

    const lines = (await readFile(join(auditDir, 'ses-none.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0] ?? '') as { charge: string; costCny: number };
    assert.equal(first.charge, 'none');
    assert.equal(first.costCny, 0);
  });
});

test('maxCny = 0：不拦截 reserve 重试，审计仍按每次预留金额记数', async () => {
  await withTempDir(async (auditDir) => {
    const request = makeRequest();
    const reservedCny = expectedReserve(request, Number.POSITIVE_INFINITY).reservedCny;
    const retrying = failingRetryClient({ maxAttempts: 4, charge: 'reserve' });
    const client = withLiveBudget(retrying.client, { maxCny: 0, label: 'ses-unlimited-retry', auditDir });

    const outcome = await client.complete(request, completeOptions());
    assert.equal(outcome.kind, 'failed');
    assert.deepEqual(retrying.beforeRetryAttempts, [2, 3, 4]);
    assert.ok(Math.abs(client.spentCny - reservedCny * 4) < 1e-12);

    const lines = (await readFile(join(auditDir, 'ses-unlimited-retry.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 4);
    for (const text of lines) {
      const line = JSON.parse(text) as { charge: string; costCny: number };
      assert.equal(line.charge, 'reserve');
      assert.ok(Math.abs(line.costCny - reservedCny) < 1e-12);
      assert.ok(line.costCny > 0);
    }
  });
});

test('design-agent live：包装 client，但不把模型 run 预算写进设计提示词', async () => {
  await withTempDir(async (dir) => {
    const script = {
      task: '在村口做一间小茶室。',
      requirements: exampleRequirements(),
      intent: exampleIntent(),
      scheme: exampleScheme(),
    };
    const mock = createMockClient(script);
    const requests: ChatRequest[] = [];
    const recording: ChatClient = {
      complete(request, opts) {
        requests.push(request);
        return mock.complete(request, opts);
      },
    };
    const config: Config = {
      llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'not-used', model: 'deepseek-flash', timeoutMs: 1000 },
      maxRunCostCny: 3.5,
      liveConfirm: true,
    };
    const taskPath = join(dir, 'brief.md');
    await writeFile(taskPath, '设计一间小茶室。', 'utf8');
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDesignAgent(
      ['--live', '--task', taskPath, '--out', dir, '--session', 'ses-live-budget', '--answers', '["yes"]'],
      {
        io: {
          stdout: (line) => {
            out.push(line);
          },
          stderr: (line) => {
            err.push(line);
          },
        },
        loadConfig: () => config,
        createLiveClient: () => recording,
      },
    );

    assert.equal(code, 0, err.join('\n'));
    assert.ok(requests.length > 0);
    const promptText = requests
      .flatMap((request) =>
        request.messages.map((message) => (typeof message.content === 'string' ? message.content : '')),
      )
      .join('\n');
    assert.doesNotMatch(promptText, /人民币预算上限/);
    assert.match(promptText, /未提供人民币上限/);

    // 同一条 live 路径下，maxRunCostCny 仍由 withLiveBudget 硬守卫：极小预算在请求发出前直接拒绝。
    const blockedRequests: ChatRequest[] = [];
    const blocked: ChatClient = {
      complete(request, opts) {
        blockedRequests.push(request);
        return mock.complete(request, opts);
      },
    };
    const blockedErr: string[] = [];
    const blockedCode = await runDesignAgent(
      ['--live', '--task', taskPath, '--out', dir, '--session', 'ses-live-budget-tight', '--answers', '["yes"]'],
      {
        io: {
          stdout: () => undefined,
          stderr: (line) => {
            blockedErr.push(line);
          },
        },
        loadConfig: () => ({ ...config, maxRunCostCny: 0.000001 }),
        createLiveClient: () => blocked,
      },
    );

    assert.equal(blockedCode, 1);
    assert.equal(blockedRequests.length, 0);
    assert.match(blockedErr.join('\n'), /预算不足/);
  });
});
