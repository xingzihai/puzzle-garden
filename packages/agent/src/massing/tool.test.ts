/** massing 纯逻辑：命名 / seed 派生 / 复用键 / 上限收紧 / 文本（SUBAGENT-LOOP-SPEC §1–§5）。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Ref } from '@pg/store/events';

import {
  MASSING_ABORTED,
  MASSING_DEFAULT_MAX_CNY,
  MASSING_DEFAULT_MAX_TURNS,
  MASSING_MIN_PARENT_WALL_MS,
  MASSING_NO_HOST,
  MASSING_REPLAY_MISSING,
  effectiveMassingMaxCny,
  effectiveMassingMaxTurns,
  formatMassingDirExists,
  formatMassingFailure,
  formatMassingHostError,
  formatMassingRejectedBudget,
  formatMassingRenderFailed,
  formatMassingReuse,
  formatMassingSuccess,
  initialMassingState,
  massingAdvice,
  massingChildSeed,
  massingDir,
  massingId,
  massingReuseKey,
  massingRunId,
  massingStopDescription,
} from './tool.ts';
import type { MassingRunRecord } from './tool.ts';

const REF: Ref = { sha256: 'a'.repeat(64), bytes: 12 };

function record(overrides: Partial<MassingRunRecord> = {}): MassingRunRecord {
  return {
    id: 'massing#1',
    ordinal: 1,
    runId: 'massing-1',
    dir: 'sub/massing-1',
    key: 'k',
    text: '草模子运行成功：massing#1（子目录 sub/massing-1）。',
    source: 'export default function build() {}\n',
    image: null,
    document: { version: 2, parts: [] },
    documentHash: 'b'.repeat(64),
    ...overrides,
  };
}

describe('命名与序号', () => {
  it('初始状态为空，序号从 1 起', () => {
    assert.deepEqual(initialMassingState(), { ordinal: 0, runs: [] });
    assert.equal(massingId(1), 'massing#1');
    assert.equal(massingId(12), 'massing#12');
    assert.equal(massingRunId(12), 'massing-12');
    assert.equal(massingDir(12), 'sub/massing-12');
  });

  it('子 seed = (父 seed + ordinal) mod 2^32', () => {
    assert.equal(massingChildSeed(7, 1), 8);
    assert.equal(massingChildSeed(2 ** 32 - 1, 1), 0);
    assert.equal(massingChildSeed(2 ** 32 - 2, 3), 1);
  });
});

describe('复用键与上限', () => {
  it('key 包含 brief / 有效 maxTurns / 有效 maxCny / 参数 seed；缺省 seed 记 default', () => {
    const a = massingReuseKey({ brief: 'x', maxTurns: 20, maxCny: 0.5 });
    assert.equal(a, `x\u000020\u00000.5\u0000default`);
    assert.notEqual(a, massingReuseKey({ brief: 'x', maxTurns: 20, maxCny: 0.5, seed: 1 }));
    assert.notEqual(a, massingReuseKey({ brief: 'y', maxTurns: 20, maxCny: 0.5 }));
    // NUL 分隔：字段挪位不会碰巧相同。
    assert.notEqual(
      massingReuseKey({ brief: 'a\u0000b', maxTurns: 20, maxCny: 0.5 }),
      massingReuseKey({ brief: 'a', maxTurns: 20, maxCny: 0.5 }),
    );
  });

  it('effMax 取参数与 host 收紧值的较小者，缺省用 0.5 / 20', () => {
    assert.equal(MASSING_DEFAULT_MAX_CNY, 0.5);
    assert.equal(MASSING_DEFAULT_MAX_TURNS, 20);
    assert.equal(effectiveMassingMaxCny(0.8), 0.5);
    assert.equal(effectiveMassingMaxCny(0.2), 0.2);
    assert.equal(effectiveMassingMaxCny(0.8, 0.3), 0.3);
    assert.equal(effectiveMassingMaxTurns(40), 20);
    assert.equal(effectiveMassingMaxTurns(8), 8);
    assert.equal(effectiveMassingMaxTurns(40, 30), 30);
  });
});

describe('文本', () => {
  it('成功文本给全 id / 子目录 / source / model / documentHash / 几何摘要与导入提示', () => {
    const text = formatMassingSuccess({
      id: 'massing#1',
      dir: 'sub/massing-1',
      source: REF,
      document: { sha256: 'c'.repeat(64), bytes: 34 },
      documentHash: 'd'.repeat(64),
      geometry: '几何摘要：1 个部件',
    });
    assert.match(text, /massing#1/);
    assert.match(text, /sub\/massing-1/);
    assert.match(text, new RegExp(REF.sha256));
    assert.match(text, new RegExp('c'.repeat(64)));
    assert.match(text, new RegExp('d'.repeat(64)));
    assert.match(text, /几何摘要：1 个部件/);
    assert.match(text, /world\.massingImport\('massing#1'/);
  });

  it('复用文本保留原文并注明同键复用', () => {
    const text = formatMassingReuse(record());
    assert.ok(text.startsWith(record().text));
    assert.match(text, /与 massing#1 同键，复用，没有重新计费/);
  });

  it('停止原因描述：max-turns / cost-budget / wall / 其它', () => {
    const limits = { maxTurns: 20, maxCny: 0.5, wallMs: 240_000 };
    assert.equal(massingStopDescription('max-turns', limits), '达到轮数上限（20 轮）');
    assert.equal(massingStopDescription('cost-budget', limits), '达到花费上限（¥0.50）');
    assert.equal(massingStopDescription('wall', limits), '达到墙钟上限（240 秒）');
    assert.equal(massingStopDescription('stuck', limits), '停止原因 stuck');
    assert.match(massingAdvice('max-turns'), /调大 maxTurns/);
    assert.match(massingAdvice('cost-budget'), /调大 maxCny/);
    assert.match(massingAdvice('stuck'), /不会中断本 run/);
  });

  it('失败文本含描述 / 轮数 / 花费 / 建议', () => {
    const text = formatMassingFailure({
      description: '达到轮数上限（20 轮）',
      turns: 20,
      costCny: 0.0123,
      advice: massingAdvice('max-turns'),
    });
    assert.match(text, /未交付/);
    assert.match(text, /20 轮/);
    assert.match(text, /¥0\.0123/);
    assert.match(text, /maxTurns/);
  });

  it('宿主异常折叠成一行并截断；空消息给占位', () => {
    const text = formatMassingHostError('boom\n detail\tx');
    assert.equal(text, '子运行宿主异常（internal-error）：boom detail x');
    assert.match(formatMassingHostError('x'.repeat(400)), /x{300}…/);
    assert.match(formatMassingHostError('   '), /（无错误信息）/);
  });

  it('拒绝 / 渲染失败 / 目录已存在文本', () => {
    const text = formatMassingRejectedBudget(0.2, 0.5);
    assert.match(text, /剩余预算 ¥0\.2000 < 需预留 ¥0\.5000/);
    assert.match(formatMassingRenderFailed('massing#1', 'unsupported'), /render-failed|合成图渲染失败（unsupported）/);
    assert.match(formatMassingDirExists('sub/massing-1'), /目录已存在（sub\/massing-1）/);
    assert.match(MASSING_NO_HOST, /没有接入草模子运行/);
    assert.match(MASSING_ABORTED, /已中止并清理/);
    assert.match(MASSING_REPLAY_MISSING, /replay-missing|回放模式/);
    assert.equal(MASSING_MIN_PARENT_WALL_MS, 60_000);
  });
});
