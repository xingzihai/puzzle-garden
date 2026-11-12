/** read_massing：行号 / 闭区间 / 400 行上限 / 未知 id（SUBAGENT-LOOP-SPEC §5.3）。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MassingRunRecord } from '../massing/tool.ts';
import { MAX_READ_MASSING_LINES, readMassing } from './read-massing.ts';

function record(source: string): MassingRunRecord {
  return {
    id: 'massing#1',
    ordinal: 1,
    runId: 'massing-1',
    dir: 'sub/massing-1',
    key: 'k',
    text: 'ok',
    source,
    image: null,
    document: { version: 2, parts: [] },
    documentHash: 'b'.repeat(64),
  };
}

const CODE = 'line1\nline2\nline3\n';

describe('readMassing', () => {
  it('未知 id：列出可用引用；没有成功子运行时给提示', () => {
    const empty = readMassing([], 'massing#1');
    assert.equal(empty.status, 'unknown-id');
    assert.match(empty.text, /还没有成功的草模子运行/);
    const withRuns = readMassing([record(CODE)], 'massing#2');
    assert.equal(withRuns.status, 'unknown-id');
    assert.match(withRuns.text, /可用引用：massing#1/);
  });

  it('全文：行号从 1 起，不把末尾换行算成额外一行', () => {
    const r = readMassing([record(CODE)], 'massing#1');
    assert.equal(r.status, 'ok');
    assert.match(r.text, /massing#1，共 3 行，显示 1–3：/);
    assert.match(r.text, /1\| line1/);
    assert.match(r.text, /3\| line3/);
  });

  it('from / to 是闭区间；越界与非法值给出明确文本', () => {
    const runs = [record(CODE)];
    assert.match(readMassing(runs, 'massing#1', 2, 2).text, /2\| line2/);
    assert.doesNotMatch(readMassing(runs, 'massing#1', 2, 2).text, /1\| /);
    assert.match(readMassing(runs, 'massing#1', 4).text, /from=4 超出范围/);
    assert.match(readMassing(runs, 'massing#1', 2, 1).text, /小于 from/);
    assert.match(readMassing(runs, 'massing#1', 0).text, /from 应是 ≥ 1/);
    assert.match(readMassing(runs, 'massing#1', undefined, 0).text, /to 应是 ≥ 1/);
  });

  it('一次最多 400 行，超出截断并注明', () => {
    const long = Array.from({ length: 500 }, (_, i) => `l${String(i + 1)}`).join('\n');
    const r = readMassing([record(long)], 'massing#1');
    assert.equal(MAX_READ_MASSING_LINES, 400);
    assert.match(r.text, /显示 1–400，共 500 行/);
    assert.match(r.text, /已截断/);
    assert.match(r.text, /400\| l400/);
    assert.doesNotMatch(r.text, /\b401\| /);
  });

  it('空源码给出 0 行提示', () => {
    assert.match(readMassing([record('')], 'massing#1').text, /源码为空，共 0 行/);
  });
});
