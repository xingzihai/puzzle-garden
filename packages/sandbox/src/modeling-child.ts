/**
 * modeling-child 接线（MODELING-SPEC §4）：读 stdin，把整份输入交给 modeling-child-run，写出由它负责。
 * 不含分支逻辑，只兜住接线层的宿主缺陷。与体素 child.ts 同一份退出码约定。
 *
 * 退出码约定：只有 `PG_PROTOCOL_ERROR`（输入不合 schema / JSON，发生在执行之前）用退出码 3，
 * 宿主据此判 protocol-error；其它在接线层逃出的异常用非 3 码，归 crashed，不给模型看。
 * `runModelChild` 已把模型代码引发的异常编成 build-error 报告，正常路径不会走到这里。
 */
import { readFileSync, writeSync } from 'node:fs';

import { runModelChild } from './modeling-child-run.ts';

const savedProcess = process;
try {
  await runModelChild(readFileSync(0), {
    write: (bytes: Uint8Array): void => {
      writeSync(1, bytes);
    },
    exit: (code: number): void => {
      savedProcess.exit(code);
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('PG_PROTOCOL_ERROR')) {
    writeSync(2, `PG_PROTOCOL_ERROR:${message}\n`);
    savedProcess.exit(3);
  } else {
    writeSync(2, `PG_CHILD_CRASH:${message}\n`);
    savedProcess.exit(4);
  }
}
