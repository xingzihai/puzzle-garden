# conformance-run9-v2（修复后证据）

2026-10-20 run-9 的同一份 BuildSpec / building.pgar，在 Phase 4A 的 as-built 误报修复后重新生成。
v1（`tools/fixtures/conformance-run9/`）保留为历史基线；v2 用于当前回归。
**目录名 v2 = run-9 证据版本，不是 expected-object schema v2。**

## 输入

- `build-spec.json`、`building.pgar`：与 v1 逐字节相同。
- `expected-objects.json`：由当前 `projectExpectedObjects` 生成，不是手写。
- `conformance-report.json`：由当前 `conformance-diff` 生成。

## 冻结结论

- summary：pass 1 / fail 4 / unverified 6 / blockingCount 4 / blocking=true。
- `wall:f1` 从 fail 变 pass：檐口压顶行不再计入墙高。
- 仍是 hard fail：`slab:f1`、`roof`、北门、南窗。
- 场地 `site@0,0,0`（14×12）只进 `notCompared`；`unknown` 6 条为 soft unverified。

## 与 v1 的关系

见 `defect-ledger.json`：每个 v1 hard fail 都标为 `artifact` 或 `true-defect`。
修复的目标是去掉误报，不是保留“5 个 hard fail”的数字。

## 再生成

```bash
node -e '
  const { writeFileSync } = require("node:fs");
  const { loadSpec } = require("./tools/conformance-diff.ts");
  const { projectExpectedObjects } = require("./tools/conformance-expect.ts");
  const { spec, sha256 } = loadSpec("tools/fixtures/conformance-run9-v2/build-spec.json");
  const projection = projectExpectedObjects(spec);
  writeFileSync(
    "tools/fixtures/conformance-run9-v2/expected-objects.json",
    `${JSON.stringify({ schemaVersion: 1, tool: "conformance-expect", specSha256: sha256, ...projection }, null, 2)}\n`,
  );
'
node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  import { loadRegistry } from "./packages/blocks/src/load.ts";
  import { buildConformanceDiffReport, loadArchive, loadSpec } from "./tools/conformance-diff.ts";
  const specPath = "tools/fixtures/conformance-run9-v2/build-spec.json";
  const archivePath = "tools/fixtures/conformance-run9-v2/building.pgar";
  const registry = loadRegistry();
  const { spec, sha256: specSha256 } = loadSpec(specPath);
  const { grid, sha256, bytes } = loadArchive(archivePath, registry);
  const report = buildConformanceDiffReport({ spec, grid, registry, specPath, specSha256, archivePath, archiveSha256: sha256, archiveBytes: bytes });
  writeFileSync("tools/fixtures/conformance-run9-v2/conformance-report.json", `${JSON.stringify(report, null, 2)}\n`);
'
```

`conformance-report.json` 的 `spec.path` / `archive.path` 保留仓库相对路径；测试只读本目录副本并重新计算。
