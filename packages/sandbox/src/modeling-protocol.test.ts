import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';

import {
  DEFAULT_MODEL_MAX_OUTPUT_BYTES,
  DEFAULT_MODEL_TIMEOUT_MS,
  MAX_MODEL_CODE_BYTES,
  MODEL_CHILD_PROTOCOL_VERSION,
  hashModelCode,
  hashModelDocument,
  modelChildInputSchema,
  modelChildReportSchema,
} from './modeling-protocol.ts';

function sampleDocument(): ModelDocument {
  const model = createModel();
  model.box({ id: 'base', name: '基座', role: 'volume', color: '#aabbcc', size: [2, 1, 3] });
  return model.finish();
}

describe('modeling-protocol：常量与 hash', () => {
  test('默认值与上限是规格写死的数（MODELING-SPEC §4）', () => {
    assert.equal(DEFAULT_MODEL_TIMEOUT_MS, 5000);
    assert.equal(DEFAULT_MODEL_MAX_OUTPUT_BYTES, 16 * 1024 * 1024);
    assert.equal(MAX_MODEL_CODE_BYTES, 256 * 1024);
    assert.equal(MODEL_CHILD_PROTOCOL_VERSION, 1);
  });

  test('hashModelCode 是稳定 sha256，内容不同则不同', () => {
    assert.match(hashModelCode('x'), /^[0-9a-f]{64}$/);
    assert.equal(hashModelCode('x'), hashModelCode('x'));
    assert.notEqual(hashModelCode('x'), hashModelCode('y'));
  });

  test('hashModelDocument 同文档同 hash，改顶点则不同', () => {
    const a = sampleDocument();
    const b = sampleDocument();
    assert.equal(hashModelDocument(a), hashModelDocument(b));
    const model = createModel();
    model.box({ id: 'base', name: '基座', role: 'volume', color: '#aabbcc', size: [2, 1, 4] });
    assert.notEqual(hashModelDocument(a), hashModelDocument(model.finish()));
  });
});

describe('modeling-protocol：输入 schema', () => {
  test('合法输入通过', () => {
    const parsed = modelChildInputSchema.safeParse({
      protocol: MODEL_CHILD_PROTOCOL_VERSION,
      code: 'x',
      seed: 0,
      limits: { consoleBytes: 100 },
    });
    assert.equal(parsed.success, true);
  });

  test('超长代码被 refine 拒绝（覆盖子进程里的同一校验）', () => {
    const parsed = modelChildInputSchema.safeParse({
      protocol: MODEL_CHILD_PROTOCOL_VERSION,
      code: 'x'.repeat(MAX_MODEL_CODE_BYTES + 1),
      seed: 1,
      limits: { consoleBytes: 100 },
    });
    assert.equal(parsed.success, false);
  });

  test('字段缺失 / 协议版本错 / 多余键被拒', () => {
    assert.equal(modelChildInputSchema.safeParse({ code: 'x', seed: 1, limits: { consoleBytes: 1 } }).success, false);
    assert.equal(
      modelChildInputSchema.safeParse({
        protocol: 2,
        code: 'x',
        seed: 1,
        limits: { consoleBytes: 1 },
      }).success,
      false,
    );
    assert.equal(
      modelChildInputSchema.safeParse({
        protocol: 1,
        code: 'x',
        seed: 1,
        limits: { consoleBytes: 1 },
        extra: true,
      }).success,
      false,
    );
  });
});

describe('modeling-protocol：报告 schema', () => {
  test('ok 报告带合法文档与 hash 时通过', () => {
    const document = sampleDocument();
    const parsed = modelChildReportSchema.safeParse({
      status: 'ok',
      document,
      documentHash: hashModelDocument(document),
      console: [],
      consoleTruncated: 0,
    });
    assert.equal(parsed.success, true);
  });

  test('ok 报告里的文档仍受 ModelDocument 复验（坏网格被拒）', () => {
    const parsed = modelChildReportSchema.safeParse({
      status: 'ok',
      document: { version: 1, parts: [{ id: 'a' }] },
      documentHash: 'x',
      console: [],
      consoleTruncated: 0,
    });
    assert.equal(parsed.success, false);
  });

  test('build-error 报告通过，未知 status 被拒', () => {
    const errorReport = modelChildReportSchema.safeParse({
      status: 'build-error',
      error: { name: 'ModelError', message: 'boom', line: 2, column: 3 },
      console: [{ level: 'log', text: 'x' }],
      consoleTruncated: 0,
    });
    assert.equal(errorReport.success, true);
    assert.equal(modelChildReportSchema.safeParse({ status: 'timeout' }).success, false);
  });
});
