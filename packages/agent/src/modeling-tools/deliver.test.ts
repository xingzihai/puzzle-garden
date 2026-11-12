/** 草模交付：未提交拒绝、写全文件与 model.delivery、空 note 不写文件。 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';

import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';
import { createRunDir, openRunDir } from '@pg/store/run-dir';
import type { RunWriter } from '@pg/store/run-dir';

import { deliverModel } from './deliver.ts';
import { documentHashOf, initialModelState, sha256Hex } from './session.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeStore(): RunWriter {
  const root = mkdtempSync(join(tmpdir(), 'pg-model-deliver-'));
  roots.push(root);
  return createRunDir(root, 'run');
}

function makeDocument(): ModelDocument {
  const model = createModel();
  model.box({ id: 'b', name: '块', role: 'volume', color: '#112233', size: [1, 1, 1] });
  return model.finish();
}

function submittedState(store: RunWriter, note: string): ReturnType<typeof initialModelState> {
  const document = makeDocument();
  const code = 'const x = 1;';
  return {
    ...initialModelState(),
    submitted: {
      code,
      codeHash: sha256Hex(code),
      document,
      documentHash: documentHashOf(document),
      documentRef: store.putBlob(new TextEncoder().encode(JSON.stringify(document))),
      codeVersion: 1,
      note,
    },
  };
}

it('未接受提交时交付抛错，不产出伪交付', async () => {
  const store = makeStore();
  await assert.rejects(
    deliverModel(initialModelState(), { store, turn: 1, seed: 1, versions: { modelingApi: 2, modelFormat: 2 } }),
    /尚未接受提交/,
  );
});

it('提交后写 source/model/manifest，note 非空才写 note.md 与事件 note', async () => {
  const store = makeStore();
  const state = submittedState(store, '交付说明');
  const result = await deliverModel(state, {
    store,
    turn: 1,
    seed: 9,
    versions: { modelingApi: 2, modelFormat: 3 },
  });
  assert.equal(result.codeVersion, 1);
  assert.equal(result.hash, state.submitted?.documentHash);
  const dir = join(store.dir, 'delivery');
  for (const name of ['source.ts', 'model.json', 'manifest.json', 'note.md']) {
    assert.equal(existsSync(join(dir, name)), true, `${name} 应存在`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    readonly seed: number;
    readonly modelingApi: number;
    readonly modelFormat: number;
    readonly status: string;
  };
  assert.deepEqual(
    {
      seed: manifest.seed,
      modelingApi: manifest.modelingApi,
      modelFormat: manifest.modelFormat,
      status: manifest.status,
    },
    { seed: 9, modelingApi: 2, modelFormat: 3, status: 'ok' },
  );
  const delivery = openRunDir(store.dir)
    .events()
    .filter((e) => e.type === 'model.delivery');
  assert.equal(delivery.length, 1);
  assert.notEqual(delivery[0]?.body.note, undefined);
});

it('空 note 不写 note.md，事件不带 note', async () => {
  const store = makeStore();
  const state = submittedState(store, '');
  await deliverModel(state, { store, turn: 1, seed: 1, versions: { modelingApi: 2, modelFormat: 2 } });
  assert.equal(existsSync(join(store.dir, 'delivery', 'note.md')), false);
  const delivery = openRunDir(store.dir)
    .events()
    .filter((e) => e.type === 'model.delivery');
  assert.equal(delivery[0]?.body.note, undefined);
});
