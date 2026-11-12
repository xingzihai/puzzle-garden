/**
 * report-parser.ts 的单元测试：`/api/report` 响应窄化与代表路线计数。
 *
 * 用 JSON 往返模拟服务端响应；只测查看器实际读取的字段。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseReportPayload } from './report-parser.ts';

/** 经字符串往返，模拟服务端发出的纯 JSON。 */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function payloadOf(extra: Record<string, unknown> = {}): unknown {
  return asJson({
    report: { issues: [{ code: 'c', message: 'm', elementIds: ['a'] }], checkedClearances: 19, status: 'issues' },
    diff: { added: ['a'], removed: [], changed: ['b'], spacesChanged: ['s'] },
    ...extra,
  });
}

test('parseReportPayload 解析报告与差异，并读取同级 routeReports 条数', () => {
  const parsed = parseReportPayload(payloadOf({ routeReports: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] }));
  assert.equal(parsed.report.checkedClearances, 19);
  assert.equal(parsed.report.status, 'issues');
  assert.equal(parsed.report.issues[0]?.elementIds[0], 'a');
  assert.deepEqual(parsed.diff.changed, ['b']);
  assert.equal(parsed.checkedRoutes, 3);
});

test('parseReportPayload 在缺少 routeReports 时按 0 兼容旧响应', () => {
  const parsed = parseReportPayload(payloadOf());
  assert.equal(parsed.checkedRoutes, 0);
  assert.equal(parsed.report.checkedClearances, 19);
});

test('parseReportPayload 识别概念评审 review 并校验 kind / message', () => {
  const withReview = parseReportPayload(payloadOf({ review: { kind: 'concept', message: '概念草模说明' } }));
  assert.deepEqual(withReview.review, { kind: 'concept', message: '概念草模说明' });
  assert.equal(parseReportPayload(payloadOf()).review, null);
  assert.throws(
    () => parseReportPayload(payloadOf({ review: { kind: 'final', message: 'x' } })),
    /review\.kind 取值非法/,
  );
  assert.throws(() => parseReportPayload(payloadOf({ review: { kind: 'concept', message: '' } })), /review\.message/);
  assert.throws(() => parseReportPayload(payloadOf({ review: 'concept' })), /报告响应\.review 必须是对象/);
});

test('parseReportPayload 对坏样本报可读错误', () => {
  assert.throws(() => parseReportPayload(null), /报告响应 必须是对象/);
  assert.throws(
    () => parseReportPayload(payloadOf({ routeReports: 'not-an-array' })),
    /报告响应\.routeReports 必须是数组/,
  );
  const badStatus = {
    report: { issues: [], checkedClearances: 1, status: 'ok' },
    diff: { added: [], removed: [], changed: [], spacesChanged: [] },
  };
  assert.throws(() => parseReportPayload(badStatus), /status 取值非法/);
});
