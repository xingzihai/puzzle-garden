import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decodeFrame, encodeFrame, FRAME_PROTOCOL_VERSION } from './frame.ts';
import type { ChildReport } from './protocol.ts';

const report: ChildReport = {
  status: 'ok',
  hash: 'a'.repeat(32),
  calls: 2,
  overlaps: [],
  console: [{ level: 'log', text: 'hi' }],
  consoleTruncated: 0,
};
const archive = Uint8Array.of(1, 2, 3, 4, 5);

function mutate(bytes: Uint8Array, edit: (view: DataView, out: Uint8Array) => void): Uint8Array {
  const out = Uint8Array.from(bytes);
  edit(new DataView(out.buffer), out);
  return out;
}

describe('frame：分帧编解码', () => {
  test('编解码往返：报告与存档逐字节一致', () => {
    const frame = encodeFrame(report, archive);
    assert.equal(String.fromCharCode(...frame.subarray(0, 4)), 'PGSB');
    const decoded = decodeFrame(frame);
    if (!decoded.ok) throw new Error(decoded.reason);
    assert.deepEqual(decoded.report, report);
    assert.equal(decoded.reportLength, new TextEncoder().encode(JSON.stringify(report)).length);
    assert.deepEqual([...decoded.archive], [...archive]);
    assert.equal(new DataView(frame.buffer).getUint16(4, true), FRAME_PROTOCOL_VERSION);
  });

  test('空存档也能往返（build-error 情形）', () => {
    const decoded = decodeFrame(encodeFrame({ ...report, status: 'build-error' }, new Uint8Array(0)));
    if (!decoded.ok) throw new Error(decoded.reason);
    assert.equal(decoded.archive.length, 0);
  });

  test('所有坏帧都返回 ok:false 且带原因', () => {
    const frame = encodeFrame(report, archive);
    const short = frame.subarray(0, 4);
    assert.equal(decodeFrame(short).ok, false);

    const badMagic = mutate(frame, (_view, out) => {
      out[0] = 0x00;
    });
    assert.equal(decodeFrame(badMagic).ok, false);

    const badVersion = mutate(frame, (view) => {
      view.setUint16(4, 2, true);
    });
    assert.equal(decodeFrame(badVersion).ok, false);

    const badReserved = mutate(frame, (view) => {
      view.setUint16(6, 1, true);
    });
    assert.equal(decodeFrame(badReserved).ok, false);

    const longReport = mutate(frame, (view) => {
      view.setUint32(8, 0xffff, true);
    });
    assert.equal(decodeFrame(longReport).ok, false);

    const trailing = Uint8Array.from([...frame, 9]);
    assert.equal(decodeFrame(trailing).ok, false);

    const badJson = mutatingReport();
    assert.equal(decodeFrame(badJson).ok, false);

    const badLength = mutate(frame, (view) => {
      view.setUint32(12 + new TextEncoder().encode(JSON.stringify(report)).length, 999, true);
    });
    assert.equal(decodeFrame(badLength).ok, false);
  });
});

/** 把报告区改成非法 JSON（保持长度一致，仍是 UTF-8）。 */
function mutatingReport(): Uint8Array {
  const frame = encodeFrame(report, archive);
  const out = Uint8Array.from(frame);
  out[12] = 0xff;
  out[13] = 0xfe;
  return out;
}
