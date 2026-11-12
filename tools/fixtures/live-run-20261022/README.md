# live-run-20261022 fixture

来源：20261022-033507-build-task-48aba6（第一次真实诊断构建），v8 delivery content hash
`273b6f60c08933413dd547fef5a92efd`，codeVersion 8；`building.pgar` 的实际 sha256 是
`eceeccdf52935af56c19fd2280fa41e4c78dc70fbd1b4a8b591afa369fb31795`。为避免 `.work` 依赖，
fixture 只保留离线重放所需的 build-spec / verified-must-map / archive / conformance 证据。

| 文件                             | 说明                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `build-spec.json`                | 原会话 build-spec；sha256 见 evidence.spec.sha256                                                                      |
| `verified-must-map.json`         | 原会话确定性 planner 映射；mapping=verified                                                                            |
| `building.pgar`                  | 原交付存档（9224 bytes）                                                                                               |
| `conformance-evidence.json`      | 用当前代码从上述输入重放生成（本 fixture 的规范证据）                                                                  |
| `conformance-diff.json`          | 同上，路径固定为 `tools/fixtures/live-run-20261022/build-spec.json` / `tools/fixtures/live-run-20261022/building.pgar` |
| `conformance-evidence.live.json` | 修复前真实 run 的原始证据，仅作对照                                                                                    |
| `conformance-diff.live.json`     | 修复前真实 run 的原始 diff，仅作对照                                                                                   |
| `delivery.json`                  | 原 delivery 标识 + 由证据生成的注记；不含 `selfNote`                                                                   |
| `events.jsonl`                   | 重放所需的 check/delivery/run.end 事件；delivery 事件使用同一份生成注记 + noteSource                                    |
| `review.json`                    | 从该 run 的 evidence / run facts 生成的评审；not-satisfied / targeted-revision                                          |
| `designer-note.txt`              | 原模型自述（含错误的 5/5 PASS 声明），只作独立留档，不进入 note / delivery.json                                          |

当前重放计数：met 14 / unverified 22 / not-met 5 / waived 0；acceptEligible=false；
unattributedHardFails=0。
