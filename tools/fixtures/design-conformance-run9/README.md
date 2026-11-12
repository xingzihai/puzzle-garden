# design-conformance-run9（离线 fixture）

`tools/design-conformance.test.ts` 使用的 run-9 会话 / run 证据副本。
来源：`.work/sessions/web-next/ses-web-mvgl6oe5-c58cfc62` 与
`.work/runs/20261020-112925-build-task-c9736e`（2026-10-20）。

复制后未改写字节；测试只读本目录，不依赖 `.work`、不联网、不调用模型。

## 文件

| 文件 | 用途 | sha256 |
| --- | --- | --- |
| `session/build-spec.json` | BuildSpec | `ea37e5b22c45d61c2121692a3995a9cb7cf2f318d790eefdb9204cdbca201ca6` |
| `session/build-task.md` | provenance task sha | `5d080788cbb8e49ce05dae3a97bef52abbce592f6029f00836b2614ee397bab9` |
| `session/design.md` | W11-06b 生产首请求预算：完整设计说明（7,579 token） | `344d25c40ba978be2ac3dd7e9fd606eef9b19a814afc777d69a3acc79d83d444` |
| `20261020-.../events.jsonl` | run events / delivery / check.result | `86bfc73932846433356919431b44f62130e580c082e4e370f817eb5a6e2c9dde` |
| `20261020-.../delivery/building.pgar` | run-9 archive | `80d71115bf65ce5e991d2a65082798ba5f29039e0e74f1c66ed04c34df1954d3` |
| `20261020-.../delivery/delivery.json` | delivery hash / codeVersion | `d58659abefc63c248d3c266f68c9bf4710617c86262c81d07692fb508ff6d714` |

`design-conformance.test.ts` 的临时 run 通过复制这些文件构造；不修改本目录。
