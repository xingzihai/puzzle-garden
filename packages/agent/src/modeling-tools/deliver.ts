/**
 * 草模交付（AGENT-TARGET.md §运行记录）：把接受提交时固定的代码与文档写成完整交付文件，再追加 model.delivery。
 *
 * 负责：source.ts / model.json / manifest.json / note.md 的写入与事件记录；snapshot 已由 session 固定，这里不再读当前稿。
 * 不负责：提交判定与快照固定（modeling-tools/session.ts）、run 目录 I/O（@pg/store/run-dir）。
 */

import type { Ref } from '@pg/store/events';
import type { RunWriter } from '@pg/store/run-dir';

import type { ModelState } from './session.ts';

const encoder = new TextEncoder();

function blob(store: RunWriter, data: string): Ref {
  return store.putBlob(encoder.encode(data));
}

export interface ModelDeliveryContext {
  readonly store: RunWriter;
  readonly turn: number;
  readonly seed: number;
  readonly versions: { readonly modelingApi: number; readonly modelFormat: number };
}

/**
 * 交付接受提交时固定的代码与文档：写 source.ts / model.json / manifest.json / note.md，再追加 model.delivery。
 * 只在 submitted=true 后调用；未提交时抛错（不静默产出伪交付）。
 */
export function deliverModel(
  state: ModelState,
  ctx: ModelDeliveryContext,
): Promise<{ readonly codeVersion: number; readonly hash: string }> {
  const snap = state.submitted;
  if (snap === null) return Promise.reject(new Error('尚未接受提交，不能交付'));
  const codeRef = blob(ctx.store, snap.code);
  const noteRef = snap.note === '' ? undefined : blob(ctx.store, snap.note);
  const manifest = {
    format: 'pg-model',
    version: 1,
    status: 'ok',
    codeVersion: snap.codeVersion,
    codeHash: snap.codeHash,
    documentHash: snap.documentHash,
    seed: ctx.seed,
    modelingApi: ctx.versions.modelingApi,
    modelFormat: ctx.versions.modelFormat,
  };
  const files: { path: string; bytes: Uint8Array }[] = [
    { path: 'source.ts', bytes: encoder.encode(snap.code) },
    { path: 'model.json', bytes: encoder.encode(`${JSON.stringify(snap.document, null, 2)}\n`) },
    { path: 'manifest.json', bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
  ];
  if (noteRef !== undefined) files.push({ path: 'note.md', bytes: encoder.encode(snap.note) });
  ctx.store.writeDelivery(files);
  ctx.store.append('model.delivery', ctx.turn, {
    code: codeRef,
    document: snap.documentRef,
    hash: snap.documentHash,
    codeVersion: snap.codeVersion,
    ...(noteRef === undefined ? {} : { note: noteRef }),
  });
  return Promise.resolve({ codeVersion: snap.codeVersion, hash: snap.documentHash });
}
