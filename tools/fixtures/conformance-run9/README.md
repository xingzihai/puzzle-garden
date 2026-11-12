# conformance-run9（v1 历史证据）

2026-10-20 run-9 的离线 conformance 证据，保留为 false-positive 修复前的历史基线；
当前分类器的回归见 `tools/fixtures/conformance-run9-v2/` 与 `tools/conformance-run9-v2.test.ts`。
这些文件是**冻结的字节**：报告里的 sha256 直接指向它们，不要格式化或改写。

## 来源

- BuildSpec：`.work/sessions/web-next/ses-web-mvgl6oe5-c58cfc62/build-spec.json`
  （scheme `scheme-draft` revision 2，单层 f1，14×12 场地内 10×8 主体）
- 交付存档：`.work/runs/20261020-112925-build-task-c9736e/delivery/building.pgar`
- 原始报告：`.work/conf-next-03-run9.json`（`conformance-diff` 输出）

复制后逐字节未改。`conformance-report.json` 中的 `spec.path` / `archive.path` 保留当时的绝对 `.work` 路径，仅作溯源；测试从不读取这些路径，只读本目录的副本并重新计算。

## 文件与 sha256

| 文件 | 字节 | sha256 |
| --- | ---: | --- |
| `build-spec.json` | 19905 | `ea37e5b22c45d61c2121692a3995a9cb7cf2f318d790eefdb9204cdbca201ca6` |
| `building.pgar` | 37604 | `80d71115bf65ce5e991d2a65082798ba5f29039e0e74f1c66ed04c34df1954d3` |
| `conformance-report.json` | 33823 | `7b396e0adaedd449bdd283f7276786f54dc97ae8d5da106c4d9b442bd4c43b56` |
| `expected-objects.json` | 1989 | `1eb61ea372d903a22eabdea1a94cc9d9b786ef165ceba8b7a15d688c14319d41` |

`building.pgar` 只有 37 KB，因此直接入库；无需用 sha256 + 再生成说明代替二进制。

## 冻结结论

- 5 个 hard fail：`wall:f1`、`slab:f1`、`roof`、`opening:op-entry-north`（北门）、
  `opening:op-south-window`（南窗）；`summary.blocking=true`。
- 6 个 soft unverified：6 个 `unknown@…` 实际对象（无规则可匹配）。
- 场地 `site@0,0,0`（14×1×12，即 14×12 footprint）只出现在 `notCompared`，不参与 hard 比较。
- `summary`：pass 0 / fail 5 / missing 0 / extra 0 / unverified 6 / blockingCount 5。

## 再生成

`expected-objects.json` 必须由现有 `projectExpectedObjects` 代码路径生成，不要手写：

```bash
node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const { loadSpec } = require("./tools/conformance-diff.ts");
  const { projectExpectedObjects } = require("./tools/conformance-expect.ts");
  const { spec, sha256 } = loadSpec("tools/fixtures/conformance-run9/build-spec.json");
  const projection = projectExpectedObjects(spec);
  writeFileSync(
    "tools/fixtures/conformance-run9/expected-objects.json",
    `${JSON.stringify({ schemaVersion: 1, tool: "conformance-expect", specSha256: sha256, ...projection }, null, 2)}\n`,
  );
'
```

v1 报告是修复前的历史字节；当前分类器不会逐字节重放它（`wall:f1` 会变 pass）。
需要当前回归时用 v2：

```bash
node tools/conformance-diff.ts \
  --spec tools/fixtures/conformance-run9-v2/build-spec.json \
  --archive tools/fixtures/conformance-run9-v2/building.pgar
```

v1 测试只校验输入 sha256、历史报告结构与失败面，不依赖 `.work`、不联网、不构建。
