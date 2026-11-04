# FIX-SPEC v6：最后一处 BLOCKER（日志硬链接）+ 4 条 NIT 收口

## 背景（Codex 第五轮终审）

仅剩 1 个 BLOCKER：

**日志硬链接可破坏宿主索引**：`lib/safe-writer.js:310/318/326` 的 `guardedAppend` 只检查普通文件与 `O_NOFOLLOW`。若 `plugin-sync/logs/sync.log` 是 `<dshHome>/storages/workspace.json` 的**硬链接**（`nlink=2`），且未达轮转阈值，`lib/log.js:16` 会放行 `appendFile`，直接修改宿主同一 inode → 宿主 JSON 被追加损坏。Codex 已用进程内替身调用真实 logger 复现（本轮未实盘）。

4 条 NIT：

1. **S1 失败契约不完整**：`safe-writer.js:86/160/205` 的 `realpath` 异常可能直接抛出，绕过 `:235-236` 的拒绝登记；`:293-296` 写后父目录解析失败被转成 `null`，最终仍返回成功。
2. **S2 目录创建未走安全层**：`lib/engine.js:156` 在校验前调用未防护的 `util.js:22 mkdir(recursive)`（`export.js:53`、`store.js:31` 同类）。`plugin-sync → storages` 会先在宿主目录创建目录；悬空 `storages → plugin-sync/logs` 会被初始化激活。
3. **S3 覆盖不足**：缺硬链接、root 链接、初始化目录污染、realpath 故障用例；attack5 缺 `finally` 清理。
4. **S4 文档承诺偏强**：README `:141-149` 仍称"不再有绕过路径/不跟随任何链接/拒绝路径不产生任何文件"，未披露 TOCTOU；日志拒绝被 `log.js:17/19` 静默吞掉、未全部进入 `errors[]`；`FIX-REPORT.md:176` 的失败统一返回承诺与行为不符。

## 必须实现

### H1 硬链接防护（BLOCKER）
- `guardedAppend` 追加前：`lstat` 目标；若存在且 `st.nlink > 1` → **拒绝**（返回结构化错误，登记到拒绝集合，不再重试）。
- 打开后再 `fstat` 复核 `nlink === 1`；不满足立即关闭并拒绝（防 TOCTOU）。
- `guardedRotate` 同样：轮转目标/源若为多硬链接 → 拒绝轮转并报错；不得对多链接文件 rename。
- 日志层 `lib/log.js`：拒绝要进入 `errors[]`（至少通过 `logger.rejected` 收集并在 cycle 汇总），不得静默吞掉。
- 新增真实用例：`fsp.link(<dshHome>/storages/workspace.json, plugin-sync/logs/sync.log)` 后执行初始化 + `runCycle()`（完整周期），断言宿主 `workspace.json` **原始字节不变**、`errors` 含日志拒绝、`nlink` 未变；另测轮转阈值触发时同样拒绝。

### H2 safe-writer 失败契约
- `assertSafeRoot` / `guardedWrite` / `guardedAppend` / `guardedRemove` / `assertApplyTarget`：**任何内部异常（含 realpath/lstat/stat 的 EACCES/EIO/ELOOP）都必须被捕获并转成结构化拒绝**（`{ok:false, error, rejected:true}` 或等价），不得抛出到调用方，不得在失败后同轮重试。
- 写后父目录 `realpath` 失败/无法确认边界 → 返回**失败**（不能当成功）。
- 拒绝登记统一：同轮同一目标只拒绝一次、记录原因；测试断言。

### H3 目录创建进入安全层
- 新增 `guardedMkdir({ root, rel, dshHome })`（或等价）：创建前检查 root 与祖先链（无符号链接、不落入 storages、`storages` 若为符号链接则拒绝）；逐级创建后 `realpath` 复核；失败结构化拒绝。
- 替换所有未防护 `mkdir(recursive)`：`lib/engine.js:156`、`lib/export.js:53`、`lib/store.js:31`，以及 `lib/util.js:22` 在插件写路径上的调用。
- 新增用例：`plugin-sync` 为指向 `storages` 的符号链接（或 `storages → plugin-sync/logs` 悬空）时，初始化不得在宿主目录创建任何文件/目录；宿主字节与目录清单不变。

### H4 测试补齐
- 硬链接（H1）、root 为符号链接、初始化目录污染（H3）、realpath/lstat 故障注入（H2，用 monkeypatch 或权限/替换实现）。
- attack5 加 `finally` 清理（删 symlink/临时目录、恢复权限）。
- 保持六个既有测试全绿；新增用例纳入 `tests/security.symlink.test.mjs`。

### H5 文档收窄（如实）
- README：删除"不再有绕过路径/不跟随任何链接"等绝对表述；写明：`O_NOFOLLOW` 只防最后一级目标链接；父目录在 `realpath` 校验与 `rename` 之间仍有 TOCTOU 窗口（写后检查只能发现、不能回滚宿主并发写入）；拒绝的目标本轮不再重试；日志/日志轮转拒绝同样计入 `errors[]`。
- FIX-REPORT：更正"失败统一返回"与"无任何调用以宿主 storages 为目标"等过强结论，补 v6 章节（H1-H5 → 位置 → 测试 → 结果）。
- 版本 `1.1.2`。

## 验收（PM 门槛）

1. `node --check` 全部；
2. 六个测试文件 `exit 0`（含新增硬链接/root链接/目录污染/故障注入用例）；
3. 真实硬链接攻击用例 PASS：宿主原始字节不变、错误可见；
4. grep：写/删/rename/copy/mkdir 全部经 safe-writer 或等价校验；
5. 真实事故 fixture 仍 PASS；
6. 交 Codex 第六轮终审，无 BLOCKER 才允许启用。
