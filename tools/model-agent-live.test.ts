/** model-agent-live 的单元测试：题面 raw/fed、脱敏、模型与确认校验、live runtime 组装，全部离线（不读环境、不联网）。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import type { ChatClient } from '@pg/llm/client';

import {
  assertLiveModel,
  LIVE_MODEL,
  LiveConfirmError,
  readLiveTask,
  redactSecret,
  resolveLiveStartup,
  tightenCost,
} from './model-agent-live.ts';

const TASK_MD = [
  '# 函数建模 live 测试',
  '',
  '## 一、需求',
  '用函数建模做一个粗模。',
  '',
  '## 二、禁止',
  '不要墙。',
  '',
  '## 三、尺寸',
  '随意。',
  '',
  '## 四、交付',
  '提交即可。',
  '',
  '> 来源：/secret/do-not-feed.md',
  '',
  '## 五、旧工具',
  '不该喂给模型。',
  '',
  '## 六、来源',
  '/secret/path',
  '',
].join('\n');

const LLM = { baseUrl: 'https://mock.invalid/v1', apiKey: 'sk-secret', model: LIVE_MODEL, timeoutMs: 600_000 };

const neverClient: ChatClient = {
  complete: () => Promise.reject(new Error('测试不应调用 client.complete')),
};

it('readLiveTask：raw 是原文（fed 不含引用块与五六节），feedback 追加到 fed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-live-task-'));
  try {
    const path = join(dir, 'task.md');
    writeFileSync(path, TASK_MD);
    const task = readLiveTask(path, undefined);
    assert.equal(task.raw, TASK_MD, 'raw 必须是文件原文');
    assert.equal(task.source, path);
    assert.ok(task.fed.includes('用函数建模做一个粗模'), 'fed 应含正文');
    assert.equal(task.fed.includes('/secret/do-not-feed.md'), false, 'fed 不得含引用块来源');
    assert.equal(task.fed.includes('不该喂给模型'), false, 'fed 不得含第五节');
    assert.equal(task.fed.includes('/secret/path'), false, 'fed 不得含第六节');

    const withFeedback = readLiveTask(path, '屋顶再收一点');
    assert.ok(withFeedback.raw === TASK_MD, 'feedback 不改 raw');
    assert.match(withFeedback.fed, /用户反馈：屋顶再收一点/);

    assert.throws(() => readLiveTask(join(dir, 'missing.md'), undefined), /读不到/);
    assert.throws(() => readLiveTask(join(dir, 'sealed', 'x.md'), undefined), /sealed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('redactSecret 抹掉密钥，空密钥原样返回', () => {
  assert.equal(redactSecret('key=sk-secret end', 'sk-secret'), 'key=*** end');
  assert.equal(redactSecret('sk-secret sk-secret', 'sk-secret'), '*** ***');
  assert.equal(redactSecret('没有任何密钥', ''), '没有任何密钥');
});

it('assertLiveModel 只放行价格表里的模型', () => {
  assert.doesNotThrow(() => {
    assertLiveModel(LIVE_MODEL);
  });
  assert.throws(() => {
    assertLiveModel('other-model');
  }, /不在价格表/);
});

it('tightenCost 只能收紧 --max-cny', () => {
  const limits = { maxCostCny: 2, other: true };
  assert.deepEqual(tightenCost(limits, 1.5), { maxCostCny: 1.5, other: true });
  assert.equal(tightenCost(limits, 3.5), limits);
  assert.equal(tightenCost(limits, 0), limits);
  assert.equal(tightenCost(limits, undefined), limits);
});

it('resolveLiveStartup：注入 client 时直接用；envMaxCny 只在 >0 时给出；secret 是 apiKey', () => {
  const startup = resolveLiveStartup({ llm: LLM, maxRunCostCny: 3.5, liveConfirm: true, client: neverClient });
  assert.equal(startup.runtime.client, neverClient);
  assert.deepEqual(startup.runtime.config, { baseUrl: LLM.baseUrl, timeoutMs: LLM.timeoutMs });
  assert.equal(startup.runtime.envMaxCny, 3.5);
  assert.equal(startup.secret, LLM.apiKey);
  // 不含 apiKey 的公开 config，避免写进 run.start 泄漏。
  assert.equal('apiKey' in startup.runtime.config, false);

  const unlimited = resolveLiveStartup({ llm: LLM, maxRunCostCny: 0, liveConfirm: true, client: neverClient });
  assert.equal(unlimited.runtime.envMaxCny, undefined);
});

it('resolveLiveStartup：确认缺失 / 模型不在价表时在联网前失败', () => {
  assert.throws(
    () => resolveLiveStartup({ llm: LLM, maxRunCostCny: 3.5, liveConfirm: false, client: neverClient }),
    (error: unknown) => error instanceof LiveConfirmError && error.message.includes('PG_LIVE_CONFIRM=1'),
  );
  assert.throws(
    () =>
      resolveLiveStartup({
        llm: { ...LLM, model: 'other' },
        maxRunCostCny: 3.5,
        liveConfirm: true,
        client: neverClient,
      }),
    /不在价格表/,
  );
});
