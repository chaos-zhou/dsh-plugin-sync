# FIX-SPEC v4：workspace 索引改为纯 proposal（绝不写宿主），并加固路径边界

## 背景（Codex 第三轮审核结论）

W1-W4 大部分已通过；仍有两个 BLOCKER：

1. **domain 读改写无法与宿主并发安全协作**：`lib/workspace.js:459` 快照 → `:496 table.put` → `:499 domain.global.set(旧快照合并结果)`。宿主在 put 等待期间更新工作区/置顶时，global.set 会整体覆盖宿主新数据。DSH 的 `DomainImpl` 没有事务/CAS/版本号 API（契约已核对：只有 get/set/put/delete/update），**无法在插件侧实现安全的读改写**。
2. **proposal/staging 父目录符号链接可覆盖/删除宿主文件**：若 `plugin-sync/proposed`（或 staging 父级）是指向 `dshHome/storages` 的符号链接，`atomicWrite(proposalPath)` 会写入宿主目录并通过 rename 覆盖 `workspace.json`；domain 成功后 `rm(proposalPath)` 会删除宿主 `workspace.json`。

## 决策

**v1.1 不再写宿主工作区索引。** `workspaceWriteMode` 恒为 `proposal`：
- 绝不调用 `storageDomain`、绝不 `domain.global.set` / `table.put`；
- 会话、附件、摘要缓存、插件配置导出/落回逻辑保持不变；
- 工作区索引的合并结果只写 `dataDir/proposed/workspace.json`（+ staging 副本），并在状态/日志/README 中说明「需宿主事务 API 或人工处理」。

## 必须实现

### V1 移除 domain 写路径
- 删除 `index.js` 里的 `ctx.inject(['storageDomain'], ...)` 注入与句柄传递；删除 `lib/workspace.js` 中 domain 写入分支（snapshot/put/global.set/domainWriteFailed），删除相关测试中「domain 模式会写宿主」的预期。
- `mergeWorkspace()` 不再接受/使用 domain 参数（或保留参数但忽略并记 warning）。
- `workspaceWriteMode` 恒为 `'proposal'`；`proposalPending` 语义保留；每轮 cycle 摘要与 `dsh_sync_status` 输出 `proposalPath`。
- 宿主 `<dshHome>/storages/workspace.json` 在代码中只允许**只读**（有界三态读取），且读取失败/损坏时不得生成或覆盖任何宿主文件。

### V2 真实路径边界（堵符号链接/目录别名）
对以下写入/清理目标，写入前做真实路径校验：
- `dataDir/proposed/workspace.json`
- `stagingRoot/workspace/workspace.json`
- 清理 proposal 建议文件时的 `rm`
规则：
1. 写入目录必须是 `dataDir` / `stagingRoot` 的真实子目录：`realpath(dirname(target))` 必须位于 `realpath(dataDir)` / `realpath(stagingRoot)` 之内（`path.relative` 不以 `..` 开头且非绝对路径）。
2. 若目标文件已存在且是符号链接，拒绝写入/清理（`lstat().isSymbolicLink()`）。
3. 拒绝任何解析后落在 `<dshHome>/storages/` 的目标（等价于 `realpath(target)` 或 `realpath(dirname)` 位于 storages 内）。
4. 创建目录用 `mkdir(recursive)` 后立即 `realpath` 复核；不满足则报 error 并跳过写（不产生任何文件）。
5. 上述校验失败要计入 `cycle.errors`，不得静默；状态里加 `proposalPathSafe: boolean` 或等价字段。

### V3 测试补齐（针对两个 BLOCKER）
- `tests/workspace.compat.test.mjs`：
  - 删改 domain 写用例；新增「即使提供 domain 句柄，插件也不得调用 put/set，宿主数据不变」；
  - 新增符号链接攻击用例（用 `tests/.tmp` 构造）：`proposed` 指向 `storages`、`staging/workspace` 指向 `storages`、目标文件本身是符号链接 → 三种都必须拒绝写/清理并报 error，且 `storages/workspace.json` 字节不变；
  - 保留并修正既有 proposal 用例（14 组按新语义调整）。
- `tests/fixture.accept.test.mjs`：真实事故 fixture → 仅 proposal 模式；断言宿主字节不变、proposal 合法、`initialized` 保留、本地递归键不缩减、sessionIds 并集；若代码提供 domain 也只能只读。
- `tests/engine.test.mjs` / `engine.offline.test.mjs`：对应「domain 注入不再导致写宿主」的断言调整；其余（B7/B8/B9）保持通过。

### V4 文档
- README「工作区索引写入模式」改为：v1.1 只有 proposal 模式（为什么：宿主无事务 API，读改写会覆盖并发更新；路径边界防护）；会话/附件自动同步不受影响；未来接入宿主事务 API 后再启用自动应用。
- 更新 FIX-REPORT.md：更正第三轮审核后仍未封闭的项；记录 V1-V3 修复与测试。

### V5 版本
- `package.json` 版本升到 `1.1.0`；README 标注 v1.1 行为变化（相对 v1.0 不再自动应用工作区索引）。

## 验收（PM 门槛，全部满足才送 Codex 第四轮）

1. `node --check` 全部改动文件；
2. 五个测试文件 `exit 0`（含真实 HTTP）；
3. grep 自检：
   - 仓库代码不存在对 `storages/workspace.json` 的写/rename/copyFile/删除调用；
   - 不存在 `domain.global.set` / `table.put` 调用（domain 相关代码应已删除）；
4. 真实事故 fixture 验收：proposal 输出合法、宿主字节不变、本地递归键不缩减；
5. 符号链接攻击用例必须 PASS（用测试里的真实 symlink 构造，不接受词法路径模拟）；
6. 更新后的 FIX-REPORT 与代码一致。
