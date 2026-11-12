import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, DEFAULTS, loadConfig } from './config.ts';

// 注：本文件是契约测试。config.ts 由手写校验改为 zod 实现时，这里一行未改。

const BASE = { PG_LLM_BASE_URL: 'https://api.example.com/v1/' } as const;

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  assert.fail('应抛出 ConfigError');
}

describe('loadConfig', () => {
  it('只给必填项时使用默认值，并去掉 URL 末尾斜杠', () => {
    const cfg = loadConfig(BASE);
    assert.deepEqual(cfg, {
      llm: {
        baseUrl: 'https://api.example.com/v1',
        apiKey: '',
        model: DEFAULTS.model,
        timeoutMs: DEFAULTS.timeoutMs,
      },
      maxRunCostCny: DEFAULTS.maxRunCostCny,
      promptVersion: 'v1',
      liveConfirm: false,
    });
  });

  it('PG_PROMPT_VERSION 缺省 v1，v2 可选，其他值报错', () => {
    assert.equal(loadConfig(BASE).promptVersion, 'v1');
    assert.equal(loadConfig({ ...BASE, PG_PROMPT_VERSION: 'v2' }).promptVersion, 'v2');
    assert.equal(loadConfig({ ...BASE, PG_PROMPT_VERSION: '' }).promptVersion, 'v1');
    assert.match(problemsOf({ ...BASE, PG_PROMPT_VERSION: 'v3' })[0] ?? '', /PG_PROMPT_VERSION/);
  });

  it('PG_LIVE_CONFIRM=1 才是确认；其它值报错，未设置是 false', () => {
    assert.equal(loadConfig({ ...BASE, PG_LIVE_CONFIRM: '1' }).liveConfirm, true);
    assert.equal(loadConfig(BASE).liveConfirm, false);
    assert.equal(loadConfig({ ...BASE, PG_LIVE_CONFIRM: '' }).liveConfirm, false);
    assert.match(problemsOf({ ...BASE, PG_LIVE_CONFIRM: 'yes' })[0] ?? '', /PG_LIVE_CONFIRM/);
  });

  it('读取显式设置的值', () => {
    const cfg = loadConfig({
      ...BASE,
      PG_LLM_API_KEY: 'k',
      PG_LLM_MODEL: 'm',
      PG_LLM_TIMEOUT_MS: '1000',
      PG_MAX_RUN_COST_CNY: '0',
    });
    assert.equal(cfg.llm.apiKey, 'k');
    assert.equal(cfg.llm.model, 'm');
    assert.equal(cfg.llm.timeoutMs, 1000);
    assert.equal(cfg.maxRunCostCny, 0, '0 是合法值（关闭护栏），不能被当成未设置');
  });

  it('空字符串视为未设置', () => {
    const cfg = loadConfig({ ...BASE, PG_LLM_MODEL: '  ', PG_MAX_RUN_COST_CNY: '' });
    assert.equal(cfg.llm.model, DEFAULTS.model);
    assert.equal(cfg.maxRunCostCny, DEFAULTS.maxRunCostCny);
  });

  it('非法值响亮报错，且一次列出全部问题', () => {
    const problems = problemsOf({
      PG_LLM_BASE_URL: 'ftp://x',
      PG_LLM_TIMEOUT_MS: '1.5',
      PG_MAX_RUN_COST_CNY: '-1',
    });
    assert.equal(problems.length, 3);
    assert.match(problems[0] ?? '', /PG_LLM_BASE_URL/);
    assert.match(problems[1] ?? '', /PG_LLM_TIMEOUT_MS/);
    assert.match(problems[2] ?? '', /PG_MAX_RUN_COST_CNY/);
  });

  it('缺少 base URL 报错', () => {
    assert.deepEqual(problemsOf({}), ['PG_LLM_BASE_URL 未设置']);
  });

  it('不认其他前缀（旧的 PUZZLE_GARDEN_* / V02BETA_* 不生效，也不报错）', () => {
    const cfg = loadConfig({ ...BASE, PUZZLE_GARDEN_LLM_MODEL: 'old', V02BETA_MAX_RUN_COST: '9' });
    assert.equal(cfg.llm.model, DEFAULTS.model);
    assert.equal(cfg.maxRunCostCny, DEFAULTS.maxRunCostCny);
  });

  it('拼错的 PG_ 变量报错，并列出可用的变量名', () => {
    const problems = problemsOf({ ...BASE, PG_LLM_MODLE: 'x' });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /PG_LLM_MODLE/);
    assert.match(problems[0] ?? '', /PG_LLM_MODEL/);
  });

  it('非 PG_ 前缀的变量不管', () => {
    assert.doesNotThrow(() => loadConfig({ ...BASE, PATH: '/usr/bin', HOME: '/home/x' }));
  });

  it('超时超过 setTimeout 上限时报错（Node 会把它静默改成 1ms）', () => {
    assert.match(problemsOf({ ...BASE, PG_LLM_TIMEOUT_MS: '2147483648' })[0] ?? '', /PG_LLM_TIMEOUT_MS/);
    assert.equal(loadConfig({ ...BASE, PG_LLM_TIMEOUT_MS: '2147483647' }).llm.timeoutMs, 2147483647);
  });

  it('报错信息不包含密钥', () => {
    const problems = problemsOf({ PG_LLM_BASE_URL: 'bad', PG_LLM_API_KEY: 'secret-value' });
    assert.ok(problems.every((p) => !p.includes('secret-value')));
  });
});
