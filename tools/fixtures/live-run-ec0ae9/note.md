# 交付注记（conformance 证据自动生成）

> 本注记只从 conformance 报告与 must-clause 证据取数；设计者自述不参与判定，其原文不转载到本注记。

## 构建标识

- codeVersion：13
- hash：1c2586d36f44ee15765e18ac5dae85e7
- runId：20261022-061757-build-task-ec0ae9

## Conformance 报告

- 状态：可用
- report.summary：pass=3 fail=1 missing=0 extra=0 unverified=3
- blockingCount=2
- blocking=true
- 报告条目：共 7 条；hard fail/missing/unverified 2 条

### 报告阻断项

- `expected:slab:f1`（expectedId=slab:f1，status=fail，severity=hard）：slab mismatch: bounds
- `expected:opening:op-entry-north`（expectedId=opening:op-entry-north，status=unverified，severity=hard）：opening checks unverified: door.threshold.op-entry-north

## 必须项证据

- 状态：可用
- evidence.summary：met=12 notMet=12 waived=0 unverified=17
- acceptEligible=false

### 未满足必须项（not-met）

- `req-single-storey`：clause-hard-fail
- `req-no-partitions`：clause-hard-fail
- `req-no-glass-door`：clause-hard-fail
- `req-no-outdoor-zone`：clause-hard-fail
- `req-long-table`：clause-hard-fail
- `req-bench-north`：clause-hard-fail
- `req-bench-south`：clause-hard-fail
- `req-seats-10`：clause-hard-fail
- `req-stone-base`：clause-hard-fail
- `req-wood-wall-column`：clause-hard-fail
- `constraint-con-single-storey`：clause-hard-fail
- `constraint-con-material-selection`：clause-hard-fail

## hard fail 归因

### 未归因 hard fail

- 无

### 已归因 hard fail

- `check:material:structure` -> `req-wood-wall-column`、`constraint-con-material-selection`：structural material does not match the design
- `check:material:wall` -> `req-wood-wall-column`、`constraint-con-material-selection`：exterior wall material does not match the design

### 无必须项覆盖的全局阻断

- `furniture:f-light-ridge-e: no must covers this expected furniture; build it exactly or waive it in design`
- `furniture:f-light-ridge-w: no must covers this expected furniture; build it exactly or waive it in design`

## 验收结论

- 判定值：blockingCount=2；blocking=true；acceptEligible=false。
- 判定来源：conformance 报告与 must-clause 证据；设计者自述不参与判定。
- 不可接受：conformance 报告存在阻断（blockingCount=2；blocking=true），必须项 acceptEligible=false；不能接受当前结果。
