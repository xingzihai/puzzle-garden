import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import type { Config } from '@pg/config';
import type { ChatClient } from '@pg/llm/client';

import { MAX_RUN_CNY } from './agent-massing-args.ts';
import type { InteractionServerOptions, RunningInteractionServer } from './interaction-server-core.ts';
import { runInteractionServerCli } from './interaction-server.ts';
import type { LiveBudgetClient } from './live-budget.ts';

function capture(): {
  readonly out: string[];
  readonly err: string[];
  readonly io: { readonly stdout: (line: string) => void; readonly stderr: (line: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line) => {
        out.push(line);
      },
      stderr: (line) => {
        err.push(line);
      },
    },
  };
}

function neverClient(): ChatClient {
  return {
    complete: () => Promise.reject(new Error('测试不应调用底层 client')),
  };
}

function configWith(maxRunCostCny: number): Config {
  return {
    llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'not-used', model: 'deepseek-flash', timeoutMs: 1000 },
    maxRunCostCny,
    liveConfirm: true,
  };
}

interface CaptureServer {
  readonly options: InteractionServerOptions | undefined;
  readonly created: ChatClient[];
  readonly running: RunningInteractionServer;
}

async function runConfirmedLive(maxRunCostCny: number): Promise<CaptureServer> {
  const captured = capture();
  const created: ChatClient[] = [];
  let options: InteractionServerOptions | undefined;
  const server = createServer();
  const running: RunningInteractionServer = {
    server,
    port: 0,
    url: 'http://127.0.0.1:0',
    close: () => Promise.resolve(),
  };
  const code = await runInteractionServerCli(['--live'], {
    io: captured.io,
    loadConfig: () => configWith(maxRunCostCny),
    createLiveClient: () => {
      const client = neverClient();
      created.push(client);
      return client;
    },
    startServer: (startOptions) => {
      options = startOptions;
      return Promise.resolve(running);
    },
    waitForStop: () => Promise.resolve(),
  });
  assert.equal(code, 0);
  assert.deepEqual(captured.err, []);
  return { options, created, running };
}

test('live CLI：模型 run 预算只进入 buildMaxCny，不进入设计预算', async () => {
  const captured = await runConfirmedLive(2.5);
  assert.ok(captured.options !== undefined);
  assert.equal(captured.options.mode, 'live');
  assert.equal(captured.options.maxCostCny, undefined);
  assert.equal(captured.options.buildMaxCny, 2.5);

  const first = captured.options.clientFactory() as LiveBudgetClient;
  const second = captured.options.clientFactory() as LiveBudgetClient;
  assert.equal(captured.created.length, 2);
  assert.notEqual(first, second);
  assert.notEqual(first, captured.created[0]);
  assert.notEqual(second, captured.created[1]);
  assert.equal(first.spentCny, 0);
  assert.equal(second.spentCny, 0);
});

test('live CLI：maxRunCostCny = 0 时 buildMaxCny 退回硬上限，仍由包装器记审计', async () => {
  const captured = await runConfirmedLive(0);
  assert.ok(captured.options !== undefined);
  assert.equal(captured.options.maxCostCny, undefined);
  assert.equal(captured.options.buildMaxCny, MAX_RUN_CNY);
  const client = captured.options.clientFactory() as LiveBudgetClient;
  assert.equal(client.spentCny, 0);
});
