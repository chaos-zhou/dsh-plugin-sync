# FIX-SPEC v2 修复报告

日期：2026-11-04。环境：Node.js v24.15.0，macOS 沙箱。

B1–B9、N1–N4 的代码与测试已实现。20 组工作区测试、15 个 apply 场景、离线引擎补充验证及真实事故 fixture 模拟全部通过；13 个改动的 JS/MJS 文件语法检查通过。**真实 HTTP 双节点 `tests/engine.test.mjs` 已执行，但在首次监听 127.0.0.1 时被沙箱以 EPERM 拒绝，不能报告为 ALL PASS，仍需在允许监听端口的环境完成该项验收。**

使用三个子代理并行负责工作区实现、工作区测试、apply 实现与测试，并进行了交叉只读审查。所有修改、临时文件与故障注入均局限本仓库；事故 fixture 仅从 `/tmp/dsh-sync-accept/` 读取，并验证原始字节未变。未访问或修改 `/home/user/.dsh`，未执行 git commit，保持仅 `node:` 内置模块、ESM、无构建步骤。

## 逐项修复与验证

下表中的工作区测试均指 `tests/workspace.compat.test.mjs`，apply 测试均指 `tests/apply.compat.test.mjs`。

| 项目 | 修复位置与行为 | 对应测试 | 实测结果 |
|---|---|---|---|
| B1 未知字段子树丢失 | `lib/workspace.js:192 mergeUnknown` 递归保留本地同名值及子键，远端补缺；`:205 mergeEntry` 分离已知字段规则；`:173 collectKeyPaths` 转义路径，并在 `mergeWorkspaceFiles` 写前执行递归键子集检查，缩减即拒写。 | 工作区 `case1Lossless`：同名多层未知对象冲突、远端新增子键、已知字段更新及输入不变；`case2RemoteMissingFields`：远端独有会话；真实 fixture 测试。 | PASS，本地全部递归键保留。 |
| B2 缺失/损坏信封绕过校验 | `lib/util.js:39 readJsonStatus` 区分 missing / parse-error / read-error，成功返回同次读取的原始 bytes；`lib/workspace.js:126 validateWorkspaceDoc` 支持 `requireEnvelope:true`；`:373 mergeWorkspaceFiles` 对本地、写前与写后均强制 v2。本地缺失时仅合法完整远端可创建；本地 JSON null 也拒写。通用 `readJson` 保留 fallback 语义，工作区安全路径使用状态接口。 | 工作区 `case8LocalMissing`、`case9InvalidEnvelopeAndBytes`、`case10ReadStatesAndIoRefusal`、`case15RollbackAndPostcheckExceptions`、`case19FailedCreationCleanup`。 | PASS，无信封/损坏/读取失败时原始本地字节保留；非法远端不能新建。 |
| B3 坏条目进入索引 | `lib/workspace.js:231 mergeWorkspacesInner` 按结果表过滤索引且保持顺序；default 必须同时存在于表及索引，否则回退有效本地值/空串；`:126 validateWorkspaceDoc` 校验两种引用完整性。 | 工作区 `case4RemoteOnlyWorkspaceMissingFields`、`case11References`、`case18ArrayLimits`：坏条目带索引与 default、合法远端独有条目、截断后引用。 | PASS，无悬空 workspaceIds/default。 |
| B4 特殊键丢失/污染 | `lib/workspace.js:35 toDict` 使用无原型字典；`:43 fromDict` 用 `Object.fromEntries` 安全输出自有键；合并时使用 `Object.hasOwn` 读取 id，不将继承属性视为条目。 | 工作区 `case12SpecialKeys`：本地/远端 id 和未知子树中的 `__proto__`、`constructor`、`toString`，以及 Object.prototype 未污染。 | PASS，特殊键保留且原型未污染。 |
| B5 I/O 备份恢复无闭环 | `lib/workspace.js:351 restoreWorkspaceFromBackup` 校验备份原字节、写独立临时文件、原子 rename 并比对恢复字节；`:373 mergeWorkspaceFiles` 非 ENOENT 原始读失败拒写，备份 exclusive 创建并校验字节；`:573 freezeAndReturn` 恢复失败返回 backupPath 并冻结本模块后续写入，持续记日志。无原文件时复检失败移除新文件，移除失败同样冻结。 | 工作区 `case10ReadStatesAndIoRefusal`、`case15RollbackAndPostcheckExceptions`、`case16RollbackFailureFreezes`、`case19FailedCreationCleanup`、`case20RestoreByteMismatchFreezes`：读取故障、正常恢复、恢复 rename 失败、清理失败、恢复后字节错误及持续冻结。 | PASS，恢复成功时字节完全一致；失败结构化返回并持续拒写。 |
| B6 快照过期仍写回 | `lib/workspace.js:373 mergeWorkspaceFiles` 从输入原始字节建立快照；备份前及备份后、写入前再次读取比较。宿主新增/修改/删除或读取失败均放弃本轮。 | 工作区 `case14StaleSnapshot`：合并期间修改、缺失期间新增、备份期间修改；精确断言 error 为“本地 workspace.json 在合并期间被修改，等待下一轮”。 | PASS，宿主新数据未被覆盖。 |
| B7 首次同步覆盖本地 | `lib/apply.js:32 applySession` 缺任一侧基线且内容不同即保留本地、保存远端冲突副本并恢复 staging；完全删除接收 mtime 判胜负逻辑；`lib/engine.js:33 normalizeState` 与 `:152` 使缺失、坏 JSON、null、错误结构 state 安全恢复为空基线。 | apply `caseNoBaseline`、`casePartialBaselineAndFresh`、`caseKnownBaseline`、`caseMissingLocalValid`、`caseLocalReadError`；`tests/engine.offline.test.mjs` 真实 state 文件的缺失/损坏/null/错误结构重启周期；`tests/engine.test.mjs:92 testStateRecovery` HTTP 版。 | apply 与离线周期 PASS；HTTP 版待验收。冲突副本逐字节验证为远端输入。 |
| B8 哈希正确误判为内容合法 | `lib/apply.js:32 applySession` 对同一有界 bytes 快照校验非空、zstd 魔数及实际 sha1 后原子写入；坏会话保存冲突副本并跳过。`:101 applyAll` 对摘要缓存执行 JSON.parse，落回真实 `storages/session_projcache/` 路径；applyConfig 默认 false，true 时也只 warn“暂不支持自动落回插件配置”，保留配置导出。 | apply `caseInvalidSessions`、`caseProjcache`、`caseConfigNeverApply`；覆盖空/坏魔数/短文件/哈希不一致、本地不存在、坏 JSON 原文件不变、合法缓存正确落点、配置导出但不落回。 | 15 个 apply 场景全部 PASS。会话校验按规格最低要求检查魔数，未宣称解压后 JSONL 验证。 |
| B9 无资源边界 | `lib/limits.js:45 requestBuffer` 超时持续到 body 读完，同时检查声明长度与逐块实读；`:76 parsePeerIndex` 限 16MiB、100000 条及每 blob 200MiB。`:13 consumeFileLimited`、`:32 readFileLimited`、`:38 sha1FileLimited` 同时防止 stat 后增长绕过；`lib/engine.js` 获取/推送、`lib/store.js:20/:31/:53` 存取/索引、`lib/export.js:8` 导出、`lib/apply.js` 落回共用限制。超限 peer 进入 cycle.errors，后续 peer 继续。`lib/server.js:16 readBody` 确认并强化 200MiB 请求体上限；`lib/workspace.js:65 unionIds` 构造期间限制 sessionIds/workspaceIds 为 100000 并记录错误。索引 memo 键加入文件路径，避免同 size/mtime 错用 hash。 | 工作区 `case18ArrayLimits`；`tests/engine.offline.test.mjs`：body 停滞超时、无长度流超限、200MiB 稀疏文件拒读、stat 后增长拒读/拒哈希、缓存 blob 拒读、16MiB/100001 条/元数据超限、坏 peer 后继续下一个 peer、服务端 handler 的声明长度/逐块超限；`tests/engine.test.mjs:132 testResourceLimitsAndErrors` 与 `:236 testServerBodyLimit` HTTP 版。 | 工作区和离线补充全部 PASS；真实 HTTP 版待验收。硬上限按现有 1024 倍数口径：200MiB=209715200 bytes、16MiB=16777216 bytes。 |
| N1 合并 error/errors 不可见 | `lib/engine.js:269 recordErrors` 同时收集 error 和 errors，两次工作区合并以及 apply 后均调用，并写日志。 | `tests/engine.offline.test.mjs` 断言第一次本地 JSON 拒写、第二次远端坏 workspace 条目及 apply 坏 zstd 均进入 cycle.errors；HTTP 测试也保留对应断言。 | 离线真实引擎周期 PASS；HTTP 版待验收。 |
| N2 同秒备份覆盖 | `lib/workspace.js:323 backupStamp` 日期+毫秒+pid+补零自增序号；`:330 pruneBackups` 兼容新旧格式并保护本轮备份，最多保留 5 份；创建使用 wx 防覆盖。 | 工作区 `case6BackupAndPrune`、`case17SameMillisecondBackups`：同一毫秒连续 12 次写入，跨 9→10 序号后仍保留正确最近 5 份，每份字节与写前一致。 | PASS，无覆盖、保留顺序正确。 |
| N3 真实场景用例不足 | 扩充 `tests/workspace.compat.test.mjs` 为 20 组，并新增 apply、离线引擎、真实 fixture 测试；所有临时数据改用仓库 `tests/.tmp`。 | 工作区 case1/2 同名未知子树与远端独有会话；case4/11 坏条目带索引；case9 无信封；case16/19/20 回滚/清理故障；case17 同毫秒备份。 | 工作区 20 组全部 PASS。 |
| N4 null 条目/复检异常 | `lib/workspace.js:105 entryCoreErrors` 和 `:116 entryTimestampErrors` 对非对象先返回错误，校验不抛 TypeError；`mergeWorkspaceFiles` 写后复检捕获读取/解析/校验异常并走恢复。 | 工作区 `case13NullEntries`、`case15RollbackAndPostcheckExceptions`：本地 null 拒写、远端 null 跳过，写后无信封/null/坏 JSON/抛异常 getter/EIO 均恢复。 | PASS，原文件字节恢复且异常不逃逸。 |

## 执行命令与结果

语法检查：以下每个文件均实际执行 `node --check`，13/13 exit 0。

```sh
for f in lib/apply.js lib/engine.js lib/export.js lib/server.js lib/store.js lib/util.js lib/workspace.js lib/limits.js tests/engine.test.mjs tests/workspace.compat.test.mjs tests/apply.compat.test.mjs tests/engine.offline.test.mjs tests/fixture.accept.test.mjs; do
  node --check "$f" || exit
done
```

| 命令 | 实际结果 | 验收口径 |
|---|---|---|
| `node tests/workspace.compat.test.mjs` | exit 0，20 组全部 ALL PASS | 已通过。 |
| `node tests/apply.compat.test.mjs` | exit 0，15 个场景全部 ALL PASS | 已通过。 |
| `node tests/engine.test.mjs` | exit 1，`listen EPERM: operation not permitted 127.0.0.1` | 沙箱拒绝监听端口，首次 freePort 阶段已中止。必须在允许本机端口监听的环境重跑；预期全部断言通过，最终输出 ALL PASS、exit 0。当前不能确认。 |
| `node tests/engine.offline.test.mjs` | exit 0，四组补充验证全部通过 | 使用真实临时文件、真实引擎周期和服务端 handler，fetch 返回内存响应；不替代真实 HTTP 双节点验收。 |
| `node tests/fixture.accept.test.mjs` | exit 0，ALL PASS | 读取事故真实两份文件，在仓库内隔离复制、合并、校验并清理。 |
| `git diff --check` | exit 0 | 无差异空白错误。 |

`tests/engine.test.mjs` 保留原初始同步、工作区 sessionIds 并集、双端冲突、幂等零流量断言；fixture 升级为完整 v2 工作区和真实 zstd raw-block frame，补上 state 安全恢复、资源边界与错误可见测试，未通过跳过断言来伪造 ALL PASS。

## 真实事故 fixture

命令：`node tests/fixture.accept.test.mjs`。

- local：`/tmp/dsh-sync-accept/workspace.local.json`，SHA-256 `8c8d95076260dfcb276181e6852a4244eb68eb3307b9388a0818d5b94e3d3606`。
- staging：`/tmp/dsh-sync-accept/workspace.staging.json`，SHA-256 `f0d548c99d0b9928e0a83636456c2045425cc6733ee6262fb9e1ac650664f180`。
- 输出合法 v2，`global.initialized` 保留、本地递归键集无缩减、每个原有 workspace 的 sessionIds 为本地/远端保序并集，全部 PASS；两份原始 fixture 字节未变。
- 快照过期和特殊键故障注入由工作区 case14 / case12 使用独立真实临时文件验证，全部 PASS。

README 已同步严格信封、引用校验、备份与冻结、快照保护、首次冲突保护、内容校验、配置暂停自动落回及资源上限说明。尚未解除的验收项仅为真实 HTTP 引擎测试的沙箱限制；本次未重新启用插件或修改任何真实 DSH 数据。
