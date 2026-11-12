/**
 * mock-http.ts 的测试：虚拟时间的推进顺序与取消，以及计划 → Response 的形状。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mulberry32 } from '@pg/core/rng';

import { createVirtualTime, placeholderChunks, planFetch, ReplayDiverged, takeBytes } from './mock-http.ts';

describe('createVirtualTime', () => {
  it('按到期顺序唤醒并拨动时钟，同时到期的按登记顺序', async () => {
    const vt = createVirtualTime(100);
    const order: string[] = [];
    const never = new AbortController().signal;
    await Promise.all([
      vt.sleep(50, never).then(() => order.push(`b@${String(vt.clock())}`)),
      vt.sleep(10, never).then(() => order.push(`a@${String(vt.clock())}`)),
      vt.sleep(50, never).then(() => order.push(`c@${String(vt.clock())}`)),
    ]);
    assert.deepEqual(order, ['a@110', 'b@150', 'c@150']);
    assert.equal(vt.pending(), 0);
  });

  it('signal 取消时 reject 并移除计时器；已取消的 signal 立即 reject', async () => {
    const vt = createVirtualTime();
    const c = new AbortController();
    const p = vt.sleep(1000, c.signal);
    assert.equal(vt.pending(), 1);
    c.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(vt.pending(), 0);
    await assert.rejects(vt.sleep(1, c.signal), { name: 'AbortError' });
    assert.equal(vt.clock(), 0, '取消的计时器不推进时钟');
  });
});

describe('planFetch', () => {
  const read = async (res: Response): Promise<number> => (await res.arrayBuffer()).byteLength;

  it('status 计划返回对应状态码与 JSON 错误体', async () => {
    const f = planFetch(() => ({ kind: 'status', status: 503 }));
    const res = await f('u', { body: '{}' });
    assert.equal(res.status, 503);
    assert.match(await res.text(), /mock HTTP 503/);
  });

  it('network-error 以 TypeError reject；计划函数抛错原样 reject；非 Error 包成 Error', async () => {
    await assert.rejects(planFetch(() => ({ kind: 'network-error' }))('u', { body: '' }), TypeError);
    await assert.rejects(
      planFetch(() => {
        throw new RangeError('计划失败');
      })('u', { body: '' }),
      RangeError,
    );
    await assert.rejects(
      planFetch(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- 测试非 Error 抛出值的包装
        throw 'oops';
      })('u', { body: '' }),
      /oops/,
    );
  });

  it('signal 已取消时直接 AbortError', async () => {
    const c = new AbortController();
    c.abort();
    await assert.rejects(planFetch(() => ({ kind: 'status', status: 200 }))('u', { body: '', signal: c.signal }), {
      name: 'AbortError',
    });
  });

  it('stream close：交出全部字节后结束', async () => {
    const chunks = placeholderChunks(mulberry32(1));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const res = await planFetch(() => ({ kind: 'stream', chunks, end: { kind: 'close' } }))('u', { body: '' });
    assert.equal(await read(res), total);
  });

  it('stream hang：读到末尾挂起，signal 取消后以 AbortError 结束', async () => {
    const c = new AbortController();
    const chunks = takeBytes(placeholderChunks(mulberry32(1)), 10);
    const res = await planFetch(() => ({ kind: 'stream', chunks, end: { kind: 'hang' } }))('u', {
      body: '',
      signal: c.signal,
    });
    const reader = res.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.equal(first.value?.length, 10);
    const next = reader.read();
    c.abort();
    await assert.rejects(next, { name: 'AbortError' });
  });

  it('hang-before-headers：取消前不返回响应头', async () => {
    const c = new AbortController();
    const p = planFetch(() => ({ kind: 'hang-before-headers' }))('u', { body: '', signal: c.signal });
    c.abort();
    await assert.rejects(p, { name: 'AbortError' });
  });

  it('hang-then-diverge：等待 afterMs 后以 ReplayDiverged 出错；期间取消则以 AbortError 结束', async () => {
    const vt = createVirtualTime();
    const end = { kind: 'hang-then-diverge', afterMs: 5000, message: '分叉' } as const;
    const res = await planFetch(() => ({ kind: 'stream', chunks: [], end }), { sleep: vt.sleep })('u', {
      body: '',
      signal: new AbortController().signal,
    });
    await assert.rejects(res.arrayBuffer(), ReplayDiverged);
    assert.equal(vt.clock(), 5000);

    const c = new AbortController();
    const res2 = await planFetch(() => ({ kind: 'stream', chunks: [], end }), { sleep: vt.sleep })('u', {
      body: '',
      signal: c.signal,
    });
    const pending = res2.arrayBuffer();
    queueMicrotask(() => {
      c.abort();
    });
    await assert.rejects(pending, { name: 'AbortError' });
  });

  it('takeBytes 跨块截取', () => {
    const out = takeBytes([Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)], 4);
    assert.deepEqual(
      out.map((c) => [...c]),
      [[1, 2, 3], [4]],
    );
  });
});
