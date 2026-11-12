/**
 * child 接线（SANDBOX-SPEC §5.1、§5.6）：读 stdin，把整份输入交给 child-run，写出由 child-run 负责。
 * 不含分支逻辑，只兜住接线层的宿主缺陷。
 *
 * 退出码约定（F2）：只有 `PG_PROTOCOL_ERROR`（输入不合 schema / JSON，发生在执行之前）用退出码 3，
 * 宿主据此判 protocol-error；其它在接线层逃出的异常（例如编帧失败）用非 3 码，归 crashed，不给
 * 模型看。`runChild` 已经把所有模型代码引发的异常编成 build-error 帧，正常路径不会走到这里。
 */
import { readFileSync, writeSync } from 'node:fs';

import { runChild } from './child-run.ts';

const savedProcess = process;
try {
  await runChild(readFileSync(0), {
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
