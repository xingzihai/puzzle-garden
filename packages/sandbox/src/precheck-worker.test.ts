import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { workerResponseSchema } from './protocol.ts';

const declaration = readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');

const goodCode = `export default function build(w: World): void {
  w.plinth({ footprint: rect(-7, -7, 7, 7), height: 1, material: 'stone_bricks' });
}
`;

function request(worker: Worker, id: number, code: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      // 第一帧是 worker 的就绪消息（F7）；跳过它，等带 id 的响应。
      if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ready') return;
      worker.off('message', onMessage);
      worker.off('error', onError);
      resolve(message);
    };
    const onError = (error: Error): void => {
      worker.off('message', onMessage);
      reject(error);
    };
    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.postMessage({ id, code });
  });
}

test('precheck-worker 返回预检结果', async () => {
  const worker = new Worker(new URL('./precheck-worker.ts', import.meta.url), {
    workerData: { declaration },
  });
  try {
    const good = workerResponseSchema.parse(await request(worker, 1, goodCode));
    assert.equal(good.ok, true);
    assert.deepEqual(good.result, { kind: 'ok' });

    const bad = workerResponseSchema.parse(
      await request(worker, 2, 'export default function build(w: World): void { w.rial({}); }'),
    );
    assert.equal(bad.ok, true);
    assert.equal(bad.result.kind, 'failed');
  } finally {
    await worker.terminate();
  }
});

test('precheck-worker 对无效声明返回 invalid-declaration', async () => {
  const worker = new Worker(new URL('./precheck-worker.ts', import.meta.url), {
    workerData: { declaration: 'declare const x: number;\nexport { x };' },
  });
  try {
    const bad = workerResponseSchema.parse(await request(worker, 1, goodCode));
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'invalid-declaration');
  } finally {
    await worker.terminate();
  }
});
