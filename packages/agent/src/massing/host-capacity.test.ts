/** 资产容量的离线回归：真实子循环配假模型/执行器，检查预留、登记、复用与失败结算。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';
import { ModelDocument } from '@pg/modeling/schema';
import { checkAssets, MAX_ASSET_DOCUMENT_BYTES, MAX_ASSET_DOCUMENTS } from '@pg/sandbox/run';
import { openRunDir } from '@pg/store/run-dir';
import {
  DOC,
  cleanupRoots,
  directBudget,
  directContext,
  directHost,
  directStore,
  firstOf,
  initialToolState,
  okExecution,
  sha,
  subrunsOf,
} from '../../fixtures/massing-harness.ts';
import { runMassingTool } from './host.ts';

afterEach(cleanupRoots);
const request = { brief: '容量回归', maxTurns: 8, maxCny: 0.4 };

/** 构造合法的大网格，UTF-8 JSON 精确到字节；不借助非法字段撑大文档。 */
function sizedDocument(bytes: number): ModelDocument {
  const part = firstOf(DOC.parts);
  const positions = Array.from({ length: 199997 }, () => [
    1.123456789012345, 2.123456789012345, 3.123456789012345,
  ]).flat();
  positions.push(0, 0, 0, 4, 0, 0, 0, 4, 0);
  const triangle = [199997, 199998, 199999];
  const base = {
    ...part,
    positions,
    indices: triangle,
    bounds: { min: [0, 0, 0] as const, max: [4, 4, 3.123456789012345] as const },
  };
  const document = { version: 2 as const, parts: [base] };
  const extra = bytes - Buffer.byteLength(JSON.stringify(document));
  const stride = JSON.stringify(triangle).length - 1;
  assert.ok(extra >= 0);
  const result = ModelDocument.parse({
    ...document,
    parts: [
      {
        ...base,
        name: base.name + 'a'.repeat(extra % stride),
        indices: Array.from({ length: 1 + Math.floor(extra / stride) }, () => triangle).flat(),
      },
    ],
  });
  assert.equal(Buffer.byteLength(JSON.stringify(result)), bytes);
  return result;
}

it('seed + registered 满额：新键不预留、不请求、不建目录；同键仍复用', async () => {
  const store = directStore();
  const state = initialToolState();
  const budget = directBudget();
  const seeds = Array.from({ length: MAX_ASSET_DOCUMENTS - 1 }, (_, i) => ({ id: `s${String(i)}`, document: DOC }));
  const host = directHost({ seedDocuments: seeds });
  const ctx = directContext(store, budget, { massing: host });
  assert.equal((await runMassingTool(request, 'first', state, ctx)).status, 'ok');
  assert.equal(state.massingDocuments.length, 1);
  assert.equal(checkAssets({ documents: [...seeds, ...state.massingDocuments] }), null);
  const spent = budget.spent;
  budget.reserveSubrun = () => assert.fail('满额或复用不得预留');
  host.client.complete = () => assert.fail('满额或复用不得请求模型');
  const rejected = await runMassingTool({ ...request, brief: '新键' }, 'second', state, ctx);
  assert.equal(rejected.status, 'rejected-assets');
  assert.match(rejected.text, /未启动.*documents-count/);
  const reused = await runMassingTool(request, 'reuse', state, ctx);
  assert.equal(reused.status, 'ok');
  assert.match(reused.text, /同键，复用/);
  assert.equal(state.massing.ordinal, 1);
  assert.equal(state.massing.runs.length, 1);
  assert.equal(state.massingDocuments.length, 1);
  assert.equal(existsSync(join(store.dir, 'sub', 'massing-2')), false);
  assert.equal(budget.spent, spent);
  assert.equal(budget.reserved, 0);
});

it('seed + registered 总字节已满：不预留、不调用模型，旧文档仍有效', async () => {
  const document = sizedDocument(MAX_ASSET_DOCUMENT_BYTES);
  const store = directStore();
  const state = initialToolState();
  state.massingDocuments.push({ id: 'old', document });
  const budget = directBudget();
  budget.reserveSubrun = () => assert.fail('总字节已满不得预留');
  const host = directHost({ seedDocuments: [{ id: 'seed', document }] });
  host.client.complete = () => assert.fail('总字节已满不得请求');
  const result = await runMassingTool(request, 'full', state, directContext(store, budget, { massing: host }));
  assert.equal(result.status, 'rejected-assets');
  assert.match(result.text, /total-bytes/);
  assert.equal(existsSync(join(store.dir, 'sub')), false);
  assert.equal(state.massing.ordinal, 0);
  assert.equal(checkAssets({ documents: [...(host.deps.seedDocuments ?? []), ...state.massingDocuments] }), null);
});

for (const reason of ['document-bytes', 'total-bytes'] as const) {
  it(`子交付 ${reason} 超额：不登记、不渲染合成图，记录失败并结算实际费用，旧会话可继续`, async () => {
    const store = directStore();
    const state = initialToolState();
    const budget = directBudget();
    const large = sizedDocument(MAX_ASSET_DOCUMENT_BYTES + (reason === 'document-bytes' ? 1 : 0));
    const seeds = reason === 'document-bytes' ? [] : [{ id: 'seed', document: large }];
    // 先登记一个可复用成功结果；失败后它和种子仍能通过 sandbox 资产检查。
    assert.equal(
      (
        await runMassingTool(
          request,
          'old',
          state,
          directContext(store, budget, {
            massing: directHost({ seedDocuments: seeds }),
          }),
        )
      ).status,
      'ok',
    );
    const oldDocuments = [...state.massingDocuments];
    const oldRuns = [...state.massing.runs];
    const before = budget.spent;
    const host = directHost({
      seedDocuments: seeds,
      execute: (code) =>
        Promise.resolve({ ...okExecution(code), document: large, documentHash: sha(JSON.stringify(large)) }),
      renderContact: () => assert.fail('超额文档不得渲染合成图'),
    });
    const result = await runMassingTool(
      { ...request, brief: '大文档' },
      'large',
      state,
      directContext(store, budget, { massing: host }),
    );
    assert.equal(result.status, 'failed');
    assert.match(result.text, new RegExp(`未登记.*${reason}.*已花费`));
    assert.deepEqual(state.massingDocuments, oldDocuments);
    assert.deepEqual(state.massing.runs, oldRuns);
    assert.equal(checkAssets({ documents: [...seeds, ...state.massingDocuments] }), null);
    const event = firstOf(subrunsOf(openRunDir(store.dir).events()).slice(1)).body;
    const childEnd = openRunDir(join(store.dir, 'sub', 'massing-2'))
      .events()
      .find((e) => e.type === 'run.end');
    assert.ok(childEnd);
    assert.equal(childEnd.body.stopReason, null);
    assert.equal(event.status, 'failed');
    assert.equal(event.reason, 'assets-too-large');
    assert.equal(event.costCny, childEnd.body.totals.costCny);
    assert.ok(event.costCny > 0 && event.costCny < request.maxCny);
    assert.equal(event.turns, childEnd.body.totals.turns);
    assert.equal(event.document, undefined);
    assert.equal(event.code, undefined);
    assert.equal(event.image, undefined);
    assert.equal(Math.round((budget.spent - before) * 1e8), Math.round(event.costCny * 1e8));
    assert.equal(budget.reserved, 0);
    assert.equal(
      (await runMassingTool(request, 'reuse-old', state, directContext(store, budget, { massing: host }))).status,
      'ok',
    );
  });
}
