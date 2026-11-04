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

---

# Claude Code 本轮（v3）

日期：2026-11-04。环境：Node.js v24.15.0，macOS 沙箱（本轮放行了本机端口监听）。

接手 `11d84a9`（Codex 因额度中断的部分实现）。逐文件审查 `index.js`、`lib/`（apply/engine/export/limits/server/store/util/workspace）、5 个测试与 README 后逐条核对 FIX-SPEC-v3 的 W1–W6 与 B7/B8/B9：**代码部分已完成且符合规格，本轮未发现需要修改的代码**；Codex 中断点在更新报告之前。本轮补齐验收执行、写入自检与本章节，未改动 `lib/` 代码，未 git commit，未触碰真实 `~/.dsh`（测试均使用 `tests/.tmp` 临时目录）。

## 逐项核对（位置 → 测试 → 结果）

测试列中工作区指 `tests/workspace.compat.test.mjs`（14 组），apply 指 `tests/apply.compat.test.mjs`（37 项），离线指 `tests/engine.offline.test.mjs`（7 组）。

| 项目 | 位置 | 测试 | 结果 |
|---|---|---|---|
| W1 移除直接文件写 | 旧文件事务（备份/恢复/rename/冻结）已从 `lib/workspace.js` 整体删除（grep 无 `WORKSPACE_WRITE_FROZEN`/`restoreWorkspaceFromBackup`/`pruneBackups` 残留）。宿主 `storages/workspace.json` 全仓库仅两处**只读**有界三态访问：`lib/workspace.js:384 readWorkspaceStatus`（proposal 参考输入，`:461`）、`lib/export.js:100`（降级导出参考）。`lib/apply.js:273` 跳过 `workspace/` 前缀；`lib/apply.js:16-41 canonicalRel/checkParents` 阻断绝对路径、点段、反斜线、NUL、父目录符号链接；`lib/util.js:30` atomicWrite 以 `wx` 独占创建临时文件防预置符号链接重定向。 | 工作区「proposal 降级原子写建议/staging，宿主从未打开写且原始字节不变」（劫持 `fsp.open/writeFile/rename/copyFile`：宿主文件仅以 `'r'` 打开、目标目录始终只有 `workspace.json`）；apply「attachments/../storages/workspace.json 不能绕过」等 4 个穿越/符号链接用例；`tests/engine.test.mjs` 结尾「domain模式从未改宿主文件哨兵A/B」。 | PASS |
| W2 宿主事务写（主路径） | `index.js:12-25` 运行时可选注入 `ctx.inject(['storageDomain'], …)`（try/catch 拿不到不抛错，dispose 清理旧句柄）；`lib/engine.js:84-91` `getWorkspaceDomain/workspaceWriteMode`。合并输入：`lib/workspace.js:400-420 snapshotWorkspaceDomain`（`global.get()` + `table('workspaces').entries()`，序列化快照隔离宿主引用并做 32MiB/引用校验）。写回 `lib/workspace.js:490-499`：仅对变化/新增条目 `table.put`（`isDeepStrictEqual` 比较），最后 `global.set`；任一 `put/set` 抛错 → `lib/workspace.js:500-501` 返回 `domainWriteFailed`+error，不回滚已成功条目、不改文件；`lib/engine.js:318-329` 收到 `domainWriteFailed` 后停止本轮后续 domain 合并（后续 peer 拉取仍进行）。写前校验 `lib/workspace.js:475-489`：输入与产物 `serializeWorkspaceDoc`（32MiB）、本地递归键集不缩减、`validateWorkspaceDoc(requireEnvelope:true)`（必需字段、workspaceIds ⊆ 表、default 引用完整）。`workspaceWriteMode` 输出在 `lib/engine.js:293,465`。 | 工作区用例1（调用顺序 `[['put','ws'],['put','new'],['set']]`、幂等轮零调用）、用例5（put 中途失败保留已成功写入、停止后续 put/global/staging）、用例6（global.set 失败不回滚）、离线「W2 domain部分put成功/后续put失败/后续peer整轮停止domain写」、离线注入生命周期、`tests/engine.test.mjs` domain 模式并集与零错误。 | PASS |
| W3 降级模式 | `lib/workspace.js:505-509`：无 domain 时合并结果 `atomicWrite` 到 `dataDir/proposed/workspace.json`（`serializeWorkspaceDoc` 已限 32MiB，超限在写入前抛错拒写），`proposalPending:true` + warnings 提示路径，**绝不写宿主文件**；`lib/engine.js:175-177,324-327,466-467` 在 `dsh_sync_status` 与每轮摘要输出 `proposalPending/proposalPath`；`lib/workspace.js:437-447,478` 既有建议经三态读取 + `requireEnvelope` 校验后并入下一轮合并（含远端输入），domain 恢复后合并成功才清除（`:504`）。README「工作区索引写入模式」说明降级行为。 | 工作区用例7（哨兵字节不变、proposal 与 staging 一致）、用例8（本地缺失仅完整合法远端可生成；domain 恢复后清除旧建议）、用例9（跨周期建议并集、坏建议拒写保留）、`tests/fixture.accept.test.mjs`（降级模式下宿主字节完全不变）、离线 proposal 生命周期。 | PASS |
| W4-B7 跨周期冲突基线 | `lib/apply.js:152-156 rememberConflict` 记录 `unresolvedConflict[rel] = {sessionId, localSha, remoteSha}`；`lib/apply.js:197-207,222-225`：存在未解决标记时任何自动覆盖禁止——远端再变更只追加冲突副本并保持标记，本地内容回写 staging；解锁条件 `lib/apply.js:158-196`：staging 哈希与本地一致**且**本轮所有配置 peer 证实同一远端版本（`observedConvergence`）才清除。`lib/engine.js:33-54 normalizeState`：state.json 缺失/坏 JSON/null/坏结构一律安全恢复为空基线；`:433` 每轮持久化到 state.json。 | `tests/engine.test.mjs testStateRecovery`：4 种 state 变体 ×「首轮冲突 → 关停重启 → 远端再变更 → 本地仍不被覆盖、标记仍在」；离线「B7 state安全恢复/冲突持久化/重启后远端再变更仍保留本地」；apply `caseNoBaseline`、`casePartialBaselineAndFresh` 等。 | PASS |
| W4-B8 坏 zstd/JSONL 不覆盖 | `lib/apply.js:62-120 checkZstdFrames`（帧魔数/描述符/块边界/窗口与声明输出上限，RFC 8878 §3.1 未完成帧防护）+ `:122-150 sessionContentError`（非空 + 魔数 + `zlib.zstdDecompressSync({maxOutputLength})` 有界解压 + fatal UTF-8 + 逐行 `JSON.parse`）；运行时无 `zstdDecompressSync` → 同类文件一律保守拒写。校验失败 `:172-181` → 冲突副本 + `declined`，绝不覆盖本地；同一坏哈希不重复产生副本。摘要缓存 `:289-293` `JSON.parse` 校验后落回真实 `storages/session_projcache/sessions/`；`applyConfig` `:268` 永不自动落回（仅 warn）。 | apply 37 项中 20+ 项 B8 用例：「带正确魔数的坏zstd帧」「帧被截断但原生可解」「缺最后块标记」「缺校验和」「合法帧后跟垃圾」「JSONL 第二行损坏/空行/空内容/UTF-8 损坏」「解压能力缺失时保守拒写」「解压输出有界」等；HTTP 传输同样走同一校验（engine.test 冲突场景）。 | PASS |
| W4-B9 容量上限 | `lib/limits.js:45-74 requestBuffer`（超时覆盖整个响应体、声明长度 + 逐块双重上限）、`:76-93 parsePeerIndex`（16MiB、100000 条、blob 元数据 200MiB）、`:13-42`（stat 后增长不可绕过）；`lib/server.js:16-50` 请求体 200MiB（413）。工作区路径：输入 `lib/workspace.js:387`（`readWorkspaceStatus` 32MiB 有界）、并集构造期 `:52-66 unionIds`（100000，不先构造再截断）、产物 `:309-381 assertWorkspaceLimits/serializeWorkspaceDoc`（条目数/数组 100000、32MiB、循环引用与非 JSON 值拒绝），domain 与 proposal 两条路径同一检查（`:475-476,484`）；拉取落盘 `lib/engine.js:383-384` 按 rel 限额、`lib/store.js:60` 索引前拒读超限。 | 工作区 B9 三组（domain 输入/产物 32MiB、数组与表 100000，超限零 put/set 或保留原建议）；离线「B9 响应体超时/逐块限额/200MB 文件/32MiB 工作区缓存与 index/16MB 解析/100000 条」「服务端真实 handler 超限」「坏 peer 跳过后续继续」；`tests/engine.test.mjs`「B9 响应体超时/200MB/16MB/100000条 + N1」与「服务端超限请求体拒收」。 | PASS |
| W5 测试 | `tests/workspace.compat.test.mjs` 已改为 mock domain/proposal 双模式 14 组；`tests/apply.compat.test.mjs` 覆盖 W4 三场景与 W1 防护共 37 项；`tests/engine.offline.test.mjs` 7 组（含注入生命周期）；`tests/fixture.accept.test.mjs` 真实事故 fixture（domain+proposal 双模式）；`tests/engine.test.mjs` 真实 HTTP 双节点（初始同步、sessionIds 并集、双端冲突、幂等零流量、宿主哨兵、state 恢复、资源边界、请求体上限）。 | 五个测试文件（见下表）全部 exit 0。 | PASS |
| W6 README | `README.md:125-142`「工作区索引写入模式」：domain/proposal 对照表、为什么不再直接写文件（与宿主并发写共用队列、回滚会覆盖宿主新数据）、状态字段与建议文件位置、合并/校验/容量规则、升级注意（未提供服务自动 proposal、逐条一致非整轮原子、旧备份不自动恢复）。 | 文档核对。 | 完成 |

## 验收命令与结果

`node --check`：`index.js` + `lib/` 全部 10 个 js + `tests/` 全部 5 个 mjs = 16 个文件，全部 exit 0。

| 命令 | 结果 | 备注 |
|---|---|---|
| `node tests/workspace.compat.test.mjs` | exit 0，14 组 ALL PASS | mock domain 事务 + proposal 降级 + 哨兵证明宿主文件只读。 |
| `node tests/apply.compat.test.mjs` | exit 0，37 项 ALL PASS | B7/B8/B9 + W1 路径防护。 |
| `node tests/engine.offline.test.mjs` | exit 0，7 组 ALL PASS | 真实文件 + 真实引擎周期 + 内存 fetch；不替代 HTTP 验收。 |
| `node tests/fixture.accept.test.mjs` | exit 0，ALL PASS | 真实事故 fixture（local `8c8d9507…`、staging `f0d548c9…`）：输出合法 v2、`initialized` 保留、本地递归键不缩减、sessionIds 并集、宿主字节不变。 |
| `node tests/engine.test.mjs` | exit 0，ALL PASS | **本轮沙箱放行监听，v2 遗留的该项验收现已通过**：真实 HTTP 双节点全流程。 |

写入自检（规格验收第 4 条）：`grep -rnE "(writeFile|rename|copyFile|appendFile|open\(|createWriteStream)" lib/ index.js` 过滤 `workspace` 无结果——仓库代码不存在以 `storages/workspace.json` 为目标的写调用；该路径仅出现在 `lib/export.js:100`、`lib/workspace.js:461` 两处只读 `readWorkspaceStatus`。测试内的写入均指向 `tests/.tmp` 临时目录，不触及真实数据。

## 遗留风险

1. `tests/engine.test.mjs` 依赖环境放行本机端口监听；换环境重跑前不能视为永久通过。
2. proposal 模式依赖宿主提供 `storageDomain` 或人工处理 `proposed/workspace.json`；建议每轮参与合并故不会丢失，但长期不接入宿主时工作区索引不会落盘到宿主。
3. 无原生 zstd 解压能力的 Node（如 20.x）会话自动落回保守拒绝（推送/拉取到 staging 不受影响）；需 Node ≥ 22.15/23.8+。
4. domain 写入是逐条一致，非整轮原子提交；中途失败下一轮从 domain 实际状态继续（README 已声明）。
5. 测试基于 FIX-SPEC-v3 的 domain 契约 mock；真实宿主 `DomainImpl` 的校验/排队语义如有出入，需真机联调验证。
6. 规格验收第 5 条「交 Codex 第三轮审核，无 BLOCKER 才允许启用」尚未执行，启用前待 PM 安排。

---

# Claude Code 本轮（v4 安全重构）

日期：2026-11-04。环境：Node.js v24.15.0，macOS（本机端口监听可用）。

依据 FIX-SPEC-v4 落实 Codex 第三轮审核的两个 BLOCKER。第三轮审核后仍未封闭的项：

1. **domain 读改写并发覆盖**：快照 → `table.put` → `global.set` 之间宿主可并发更新工作区/置顶，`global.set` 会整体覆盖宿主新数据；宿主 `DomainImpl` 无事务/CAS/版本号 API，插件侧无法安全修复。
2. **proposal/staging 目录符号链接**：`proposed`（或 staging 父级）若是指向 `dshHome/storages` 的符号链接，`atomicWrite` 会借 rename 覆盖宿主 `workspace.json`；domain 成功后的 `rm(proposalPath)` 会删除宿主文件。

v4 决策：**v1.1 起插件完全不写宿主工作区索引**，`workspaceWriteMode` 恒为 `'proposal'`，并对两个写入目标做真实路径边界校验。

## 逐项修复（位置 → 测试 → 结果）

测试列：工作区 = `tests/workspace.compat.test.mjs`（15 组），离线 = `tests/engine.offline.test.mjs`（7 组），HTTP = `tests/engine.test.mjs`，fixture = `tests/fixture.accept.test.mjs`。

| 项目 | 位置与行为 | 测试 | 结果 |
|---|---|---|---|
| V1 移除 domain 写路径 | `index.js` 删除 `ctx.inject(['storageDomain'])` 注入与 `getWorkspaceDomain` 句柄传递；`lib/engine.js` 删除 `getWorkspaceDomain/workspaceWriteMode` 动态判定与 `domainWriteFailed` 停写逻辑，`workspaceWriteMode` 输出恒 `'proposal'`，`proposalPending/proposalPath` 保留并新增 `proposalPathSafe`；`lib/workspace.js` 整体删除 `snapshotWorkspaceDomain`、domain 写入分支（`table.put`/`global.set`/成功后 `rm` 建议文件）与 `domainWriteFailed` 返回值；`mergeWorkspace` 保留 `domain` 形参但忽略并记 warning；本地输入一律来自宿主文件的有界三态只读（`lib/workspace.js readWorkspaceStatus`），`lib/export.js` 删除 `workspaceDomain` 参数分支、保留只读参考。 | 工作区「提供 domain 句柄也不得写宿主：零 put/set」、离线「V1 提供domain句柄也不写宿主（零put/set/宿主字节不变/建议并集）」与「index.apply不再注入storageDomain」、离线全程 `ignoredDomainLookups === 0`、fixture「proposal-only + 提供domain零写入」、HTTP 哨兵A/B（宿主 `storages/workspace.json` 五轮同步后字节不变，建议文件 sessionIds 为并集）。 | PASS |
| V2 真实路径边界 | `lib/workspace.js guardedWrite`：`mkdir(recursive)` 后 `realpath(写入目录)` 必须位于 `realpath(dataDir)`/`realpath(stagingRoot)` 内（`path.relative` 不以 `..` 开头且非绝对）；目标文件 `lstat` 为符号链接即拒绝；写入目录或目标 `realpath` 落在 `realpath(<dshHome>/storages)` 内一律拒绝（storages 不存在时跳过该检查）；校验失败抛错 → 计入 `cycle.errors`、置 `proposalPathSafe: false`、不产生任何文件。`atomicWrite` 临时文件 `wx` 独占创建继续兜底 TOCTOU。 | 工作区三组真实符号链接攻击（`proposed` → storages、`staging/workspace` → storages、目标文件本身是符号链接，均用 `tests/.tmp` 实际 `fsp.symlink` 构造）：全部拒绝写、报 error、`storages/workspace.json` 字节不变且目录内无新增文件；离线/HTTP 全程宿主字节不变。 | PASS |
| V3 测试补齐 | 工作区测试重写为 proposal-only 15 组：删 domain 写预期（put 顺序/中途失败/global.set 失败/snapshot 上限直测），新增「提供 domain 零 put/set、宿主数据不变」与三类真实 symlink 攻击；B3/B4/B9（输入 32MiB、sessionIds/表并集 100000、产物 32MiB）改为宿主文件/建议文件输入；跨周期建议积累改为「staging 回退旧版本也不丢建议」。离线/HTTP/fixture 对应调整（见 V1 行），B7/B8/B9 既有断言保持通过。 | 五个测试文件全部 exit 0。 | PASS |
| V4 文档 | README「工作区索引写入模式」整节重写（v1.1 只有 proposal、移除 domain 的原因、guardedWrite 三条规则、`proposalPathSafe` 字段、v1.0 → v1.1 升级注意）；同步内容表、工具表、测试注释同步更新。本报告新增本章节。 | 文档核对。 | 完成 |
| V5 版本 | `package.json` `1.1.0`；README 顶部标注 v1.1 行为变化（相对 v1.0 不再自动应用工作区索引）。 | 文档核对。 | 完成 |

## 验收命令与结果

`node --check`：`index.js` + `lib/` 全部 10 个 js + `tests/` 全部 5 个 mjs = 16 个文件，全部 exit 0。

| 命令 | 结果 |
|---|---|
| `node tests/workspace.compat.test.mjs` | exit 0，15 组 ALL PASS（含 3 组真实符号链接攻击） |
| `node tests/apply.compat.test.mjs` | exit 0，37 项 ALL PASS（本轮未改动，B7/B8/B9 保持通过） |
| `node tests/engine.offline.test.mjs` | exit 0，7 组 ALL PASS |
| `node tests/fixture.accept.test.mjs` | exit 0，ALL PASS（proposal-only；宿主字节不变、`initialized` 保留、本地递归键不缩减、sessionIds 并集；提供 domain 零写入） |
| `node tests/engine.test.mjs` | exit 0，ALL PASS（真实 HTTP 双节点全流程） |

写入自检（grep，`lib/` 与 `index.js`）：

- `grep "storages/workspace.json"` 仅 2 处，均为只读 `readWorkspaceStatus` 调用（`lib/workspace.js:473`、`lib/export.js:97`），生产代码全部写调用（atomicWrite/rename/copyFile/appendFile/open/rm）目标均在本插件 `dataDir`/`staging`/store/日志或 apply 既有落回规则内，无任何调用以宿主 `storages/` 为目标；
- `grep -nE "snapshotWorkspaceDomain|storageDomain|domainWriteFailed|global\.set|table\.put|\.put\("` 仅命中 `index.js:9` 的一行说明注释（非代码）；domain 相关代码已全部删除。测试内保留的 mock domain 只用于证明「即使提供也不得写」，其 put/set 均有零调用断言。

## 遗留风险

1. 工作区索引依赖宿主提供事务 API 或人工应用 `<dataDir>/proposed/workspace.json`；建议每轮参与合并不会丢失，但长期不接入时工作区索引不落盘到宿主。
2. `guardedWrite` 的 realpath/lstat 校验与最终 rename 之间存在理论 TOCTOU 窗口；`atomicWrite` 的 `wx` 独占临时文件与 rename 目标非链接语义可缓解，但不承诺零窗口。
3. `tests/engine.test.mjs` 依赖环境放行本机端口监听；换环境重跑前不能视为永久通过。
4. 无原生 zstd 解压能力的 Node（如 20.x）会话自动落回保守拒绝（推送/拉取到 staging 不受影响）；需 Node ≥ 22.15/23.8+。
5. 规格验收第 6 条「更新后的 FIX-REPORT 与代码一致」已满足，但「交 Codex 第四轮审核」尚未执行，送审前待 PM 安排。

---

# Claude Code 本轮（v5 安全收口）

日期：2026-11-04。环境：Node.js v24.15.0，macOS（本机端口监听可用）。

依据 FIX-SPEC-v5 完成 S1–S4。背景：v4 只防护了 proposal/staging 两个工作区写入目标，其余写路径（`atomicWrite`、日志追加、blob 写入、peer 拉取落盘、apply 落回、config 播种）都不校验符号链接——攻击者把插件任一可写位置（如 `plugin-sync/logs/sync.log`、staging 会话路径）替换成指向宿主 `storages/workspace.json` 的符号链接，即可借插件的合法写入追加/覆盖宿主文件；`<dshHome>/storages` 本身被替换成符号链接时同样缺乏统一拦截。

## 对 v4 章节的更正（S4）

- V2 的「`lib/workspace.js guardedWrite`」已被 v5 取代：防护逻辑迁移到统一的 `lib/safe-writer.js` 并覆盖**所有**写路径，`lib/workspace.js` 不再持有本地 guardedWrite/storagesReal 实现。v4 行文「校验失败统一置 `proposalPathSafe: false`」同步收窄：只有 proposal 目标被拒才置 false，staging 副本被拒不影响该标志。
- V5 版本号：`package.json` 现为 **1.1.1**。

## 逐项修复（位置 → 测试 → 结果）

测试列：安全 = `tests/security.symlink.test.mjs`（7 组），工作区 = `tests/workspace.compat.test.mjs`（15 组），apply = `tests/apply.compat.test.mjs`，离线 = `tests/engine.offline.test.mjs`，fixture = `tests/fixture.accept.test.mjs`，HTTP = `tests/engine.test.mjs`。

| 项目 | 位置与行为 | 测试 | 结果 |
|---|---|---|---|
| S1 统一写防护层 | 新增 `lib/safe-writer.js`：`isSafeRel`（:36，拒绝对路径/盘符/反斜线/NUL/点段）、`assertSafeRoot`（:110，init 时校验数据目录边界；`storages` 为符号链接含悬空 → 危险配置，后续一切写入拒绝）、`guardedWrite`（:228，从文件系统根逐级 `lstat` 祖先链拒任何符号链接祖先；逐级 `mkdir`+realpath 复核；目标已存在为链接即拒；临时文件 `.tmp-<basename>.<pid>.<rand>` 以 `O_CREAT\|O_EXCL\|O_NOFOLLOW` 独占创建再 rename；写后 `lstat`+`realpath` 复核为普通文件且仍在 root 内）、`guardedAppend/guardedRotate`（:304/:338，日志追加与 2MiB 轮转，`O_APPEND\|O_NOFOLLOW` 打开后 `fstat` 复核）、`guardedRemove`（:362，目标 lstat 优先，ENOENT 幂等）、`assertApplyTarget`（:411，落回专属：父级符号链接、父目录 realpath 为 storages、目标解析为 `storages/workspace.json` 均拒绝）。失败统一返回结构化 `{ok:false, code, error}` 不抛出，并按 round 键记入 `rejectedTargets` WeakMap（:20/:58/:140）——同轮内被拒目标不再重试（错误含「不再重试」），直接调用（测试）用独立 round 可修复后重试。 | 安全 7 组（攻击 1/2/4/5/6 直接覆盖）+ 工作区既有 3 组真实符号链接攻击保持通过。 | PASS |
| S2 全写路径接入 | `lib/util.js:29 atomicWrite` 改经 guardedWrite（hub.mjs 等无 dshHome 调用方自动降级为结构校验）；`lib/config.js:61/:67` 播种与 saveConfig（播种失败不再阻塞启动，记 `seedError` 警告）；`lib/log.js:16-18` 追加+轮转；`lib/store.js:23` blob 写入；`lib/export.js:23/:121` staging 导出与工作区副本；`lib/workspace.js:467/:474` proposal 与 staging（round 透传，proposal 被拒置 `proposalPathSafe:false`）；`lib/apply.js:25/:30` 落回（`assertApplyTarget` + guardedWrite，round 透传）；`lib/engine.js:164` init 边界校验、`:384` peer 拉取落盘、`:430` state.json（拒写计入 errors 不中断）；`index.js` init 失败兜底日志改经 safe-writer logger。原 `atomicCopy` 删除（无调用方）。 | 安全 7 组 + 六测试全绿（所有既有写行为不变）。 | PASS |
| S3 安全测试 | 新增 `tests/security.symlink.test.mjs`：7 类真实符号链接攻击——①staging/workspace→storages + 完整双 peer runCycle（哨兵字节、错误含「拒绝写入/符号链接/不再重试」、第二轮 fsp 写系统调用插桩为零）②悬空 storages→proposed（init/config/logs/state 全拒、alias 零创建、`state.json 持久化失败` 可见）③`logs/sync.log`→宿主 workspace.json + 空 token（播种日志/警告零追加、链接保留、无 sync.log.1）④staging workspace.json 本身是文件链接（拒写、不清理链接）⑤悬空 storages 别名直接 mergeWorkspace（Codex 事故复现：merged:false、proposalPathSafe:false）⑥附件落回父级是链接（父目录拒绝、宿主字节不变）⑦真实事故 fixture。HTTP 哨兵改为原始 Buffer 比较（`tests/engine.test.mjs`）。 | 本文件 7 组 ALL PASS；其余五测试保持通过。 | PASS |
| S4 文档 | README：v1.1.1 说明、「路径边界防护」整节重写为统一 safe-writer 五条规则（边界/祖先链/目标与 O_NOFOLLOW/round 拒绝缓存/落回禁点）、修正「宿主缺失即中止」（实际：缺失时按既有建议/远端合并）、测试表新增 security.symlink。FIX-REPORT：本章节 + v4 更正。`package.json` 1.1.1。 | 文档核对。 | 完成 |

## 验收命令与结果（实测）

`node --check`：`index.js` + 改动的 9 个 `lib/*.js`（safe-writer/util/config/log/store/export/workspace/apply/engine）+ 改动的 2 个 `tests/*.mjs`（engine/security.symlink）= 12 个文件，全部 exit 0。

| 命令 | 结果 |
|---|---|
| `node tests/workspace.compat.test.mjs` | exit 0，15 组 ALL PASS（含 3 组真实符号链接攻击，round 独立可重试语义兼容） |
| `node tests/apply.compat.test.mjs` | exit 0，ALL PASS（projcache 合法落回 `storages/session_projcache/` 经 assertApplyTarget 放行） |
| `node tests/engine.offline.test.mjs` | exit 0，ALL PASS |
| `node tests/fixture.accept.test.mjs` | exit 0，ALL PASS |
| `node tests/engine.test.mjs` | exit 0，ALL PASS（HTTP 哨兵改为原始 Buffer 比较） |
| `node tests/security.symlink.test.mjs` | exit 0，7 组 ALL PASS |

写入自检（grep，`lib/` 与 `index.js`，实测）：

- 写调用点收敛：`writeFile/rename/copyFile/appendFile/createWriteStream/写模式 open/rm/unlink` 在 safe-writer.js 之外仅命中 `lib/limits.js:14 fsp.open(file, 'r')`（只读）；目录创建（`ensureDir` 的 mkdir）不写内容，且其后内容写入均经 guardedWrite 的祖先链校验；
- `storages/workspace.json` 无写/删/rename/copy：仅 `lib/export.js:106`、`lib/workspace.js:437` 两处只读 `readWorkspaceStatus`，其余命中为 safe-writer 的拒绝判定与注释；
- domain 写调用：仅 `index.js:9` 一行说明注释，代码零命中。

## 遗留风险

1. **TOCTOU 边界（如实声明）**：`lstat` 祖先链校验、目标校验与最终 `rename` 之间存在理论竞态窗口——攻击者若能在校验通过后、rename 落盘前的瞬间替换中间目录或目标，防护可能被绕过。缓解：临时文件 `O_NOFOLLOW|O_EXCL`、rename 目标非链接语义、写后 `lstat`+`realpath` 复核可**检测**父目录被替换并报错（已写入内容需人工处理），但不承诺零窗口；彻底消除需 openat2/RESOLVE_BENEATH 级内核支持，Node 无该 API。
2. storages 边界的判定基于 `lstat(<dshHome>/storages)` 与 root 级校验；init 之后 storages 才被替换为符号链接的场景由逐次写入的 storagesDangerous 检查兜底，但两次检查之间仍有窗口。
3. `tests/engine.test.mjs` 依赖环境放行本机端口监听；换环境重跑前不能视为永久通过。
4. 无原生 zstd 解压能力的 Node（如 20.x）会话自动落回保守拒绝（推送/拉取到 staging 不受影响）；需 Node ≥ 22.15/23.8+。
5. proposal 依赖宿主事务 API 或人工应用；`rejectedTargets` 为进程内 WeakMap，重启后同轮语义重置（属预期，round 本就以 cycle 为界）。
6. 「交 Codex 第五轮审核」尚未执行，送审前待 PM 安排。

---

# Claude Code 本轮（v6 硬链接与失败契约收口）

日期：2026-11-04。环境：Node.js v24.15.0，macOS（本机端口监听可用）。

依据 FIX-SPEC-v6 完成 H1–H5（Codex 第五轮终审：仅剩 1 个 BLOCKER「日志硬链接可破坏宿主索引」+ 4 条 NIT）。版本 `1.1.2`。

## 对 v5 章节两处过强结论的更正（S4）

1. **「失败统一返回结构化错误不抛出」不符**：v5 的 `assertSafeRoot`/`ensureParentsUnderRoot`/`ensureExistingDirChain` 内部的 `realpath` 调用可能直接抛出（EACCES/EIO 等）绕过拒绝登记；`guardedWrite` 写后父目录 `realpath` 失败被转成 `null` 后**仍返回成功**；`assertApplyTarget` 的两处 `realpath().catch(() => null)` 在解析失败时静默放行。v6 已全部修复（见 H2）。
2. **「无任何调用以宿主 `storages/` 为目标」过强**：apply 摘要缓存落回 `storages/session_projcache/sessions/` 是合法写入目标（由 `assertApplyTarget` 管辖禁点）。准确表述应为：**无任何写调用以宿主 `storages/workspace.json` 为目标**——该路径全仓库仅 `lib/workspace.js` 与 `lib/export.js` 两处只读 `readWorkspaceStatus`。

## 逐项修复（位置 → 测试 → 结果）

测试列：安全 = `tests/security.symlink.test.mjs`（14 组），其余五个测试文件含义与 v5 相同。

| 项目 | 位置与行为 | 测试 | 结果 |
|---|---|---|---|
| H1 硬链接防护 | `lib/safe-writer.js guardedAppend`：追加前 `lstat` 拒绝 `nlink>1`（code `hardlink`）；`O_WRONLY\|O_APPEND\|O_CREAT\|O_NOFOLLOW` 打开后 `handle.stat()`（fstat）复核 `nlink===1` 且为普通文件，不满足立即关闭并拒绝（防 TOCTOU）。`guardedRotate`：源文件 `nlink>1` 拒绝轮转（不得对多链接文件 rename）；轮转目标 `file+suffix` 若存在且为符号链接/硬链接/非普通文件同样拒绝。两者均接入 round 拒绝缓存（同轮不再重试）与整体 try/catch（内部异常转结构化拒绝）。`lib/log.js`：拒绝不再静默——记入 `logger.rejected`（去重、封顶 50 条，缓存型 `rejected` 消息不重复记录），`lib/engine.js runCycle` 每轮 `newRound()` 重置缓存、结束时 `drainRejected()` 并入 `cycle.errors[]`。 | 安全攻击11（真实 `fsp.link(宿主workspace.json → plugin-sync/logs/sync.log)` + 完整 init+runCycle：宿主原始字节不变、`nlink` 保持 2、`cycle.errors` 含「拒绝追加/硬链接」）；攻击12（源超过 2MiB 轮转阈值 + `nlink=2`：轮转拒绝、不产生 `sync.log.1`；轮转目标为硬链接同样拒绝）；攻击13（monkeypatch `fsp.lstat` 谎报 `nlink=1`：打开后 fstat 复核仍拒绝，宿主字节不变）；攻击3 更新（sync.log 符号链接时拒绝信息现在**可见**于 `cycle.errors`）。 | PASS |
| H2 失败契约 | `lib/safe-writer.js`：`assertRealDirChain` 末尾 `realpath`、`ensureParentsUnderRoot` 新建目录 `realpath`、`ensureExistingDirChain` 逐级 `realpath` 全部 try/catch 转结构化拒绝；`guardedWrite` 写后父目录 `realpath` **失败即返回失败**（不再转 null 后当成功）；`assertApplyTarget` 两处 `realpath` 改为「ENOENT 跳过（父级由 guardedWrite 创建并复核）、其余错误一律结构化拒绝」；`guardedAppend`/`guardedRotate`/新增 `guardedMkdir` 整体 try/catch 兜底（任何内部异常不抛出到调用方）。拒绝登记统一：同轮同一目标只拒绝一次、记录首次原因（`cachedRejection` 措辞改为通用的「拒绝操作」）。 | 安全「故障注入」组：①目标 `lstat` 注入 EACCES → `guardedWrite`/`guardedAppend` 返回 `{ok:false, code:'io'}` 不抛出、零文件产生；②root `realpath` 注入 EACCES → `assertSafeRoot` 结构化拒绝；③rename 后注入父目录 `realpath` 失败 → `guardedWrite` 返回失败（错误含「写后复核」，无临时文件残留）；④`assertApplyTarget` 父目录 `realpath` 故障 → 结构化拒绝。 | PASS |
| H3 目录创建入安全层 | 新增 `lib/safe-writer.js guardedMkdir(dir, {dshHome, round})`：复用 `ensureExistingDirChain`（最近已存在祖先的真实目录链校验、`storages` 符号链接即危险配置拒绝、逐级创建后 `realpath` 复核、新建目录落入 storages 拒绝），接入 round 缓存。替换全部未防护 `mkdir(recursive)`：`lib/engine.js init`（staging/store/blobs/conflicts/logs 四个目录串行 `guardedMkdir`，失败记 `插件目录创建被拒绝` 且不再抛出）；`lib/export.js:53`（stagingRoot，失败抛结构化错误中止导出）；`lib/store.js:31`（blobsDir，失败抛出）；`lib/util.js ensureDir` 收窄为仅 hub.mjs 独立工具使用并加注释。 | 安全攻击8（`plugin-sync` → 宿主 `storages` 符号链接：`assertNoWritesTo` 包裹 init 证明零写系统调用——**初始化不再先在宿主目录创建目录**，宿主字节与目录清单不变）；攻击9（悬空 `storages → plugin-sync/logs`：init 后 `plugin-sync` 与 `logs` 均不存在，别名未被激活）；攻击2 补强（危险配置下 logs 目录现在**根本不创建**，比 v5 更严格）。 | PASS |
| H4 测试补齐 | `tests/security.symlink.test.mjs` 从 7 组扩到 14 组：攻击8 plugin-sync→storages 初始化污染、攻击9 悬空 storages→logs、攻击10 staging 根本身是符号链接（root 链接，init+runCycle 拒绝、dataDir 合法写入不受牵连）、攻击11 真实硬链接完整周期、攻击12 硬链接轮转（直调守卫）、攻击13 fstat 复核（lstat 欺骗注入）、故障注入组（lstat/realpath EACCES 四个子场景）；attack5 补 `finally` 清理（删符号链接与临时目录）；attack2/attack3 断言随 v6 行为更新（logs 目录零创建、日志拒绝入 errors）。六个测试文件保持全绿。 | 全部 14 组 + 既有五测试文件。 | PASS |
| H5 文档收窄 | README：「路径边界防护」整节重写——删除「不再有绕过路径」「不跟随任何链接」等绝对表述；新增第 4 条如实声明 `O_NOFOLLOW` 只保护最后一级组件；新增「失败契约与拒绝语义」段（内部异常全部转结构化拒绝、写后复核失败按失败返回、被拒目标零文件、日志拒绝入 errors）与「残余风险」段（校验与 rename 之间的 TOCTOU 窗口只能发现不能阻止/回滚，需 openat2 级支持）；攻击数 7→14。测试表、日志排查节同步更新。本报告本章节即更正与 v6 记录。`package.json` 1.1.2。 | 文档核对。 | 完成 |

## 验收命令与结果（实测）

`node --check`：本轮改动的 6 个 `lib/*.js`（safe-writer/log/engine/store/export/util）+ `tests/security.symlink.test.mjs`，连同 `index.js` 与其余全部 `lib/*.js`、`hub.mjs` 共 14 个文件，全部 exit 0。

| 命令 | 结果 |
|---|---|
| `node tests/workspace.compat.test.mjs` | exit 0，15 组 ALL PASS |
| `node tests/apply.compat.test.mjs` | exit 0，ALL PASS |
| `node tests/engine.offline.test.mjs` | exit 0，ALL PASS |
| `node tests/fixture.accept.test.mjs` | exit 0，ALL PASS |
| `node tests/security.symlink.test.mjs` | exit 0，14 组 ALL PASS（含硬链接/root链接/目录污染/故障注入新用例） |
| `node tests/engine.test.mjs` | exit 0，ALL PASS（真实 HTTP 双节点全流程） |

写入自检（grep，`lib/` 与 `index.js`，实测）：

- 写/删/rename/copy/append/写模式 open 调用点全部位于 `lib/safe-writer.js` 内，唯一例外 `lib/limits.js:14 fsp.open(file, 'r')` 为只读；
- `mkdir` 调用点仅剩 `lib/safe-writer.js` 内部两处（均在逐级校验后执行、创建后 `realpath` 复核）与 `lib/util.js:23 ensureDir`（仅 `hub.mjs` 独立工具使用，其数据目录与插件无关）；
- `storages/workspace.json` 仅 2 处只读 `readWorkspaceStatus`（`lib/workspace.js:437`、`lib/export.js:108`），无任何写/删/rename/copy 以其为目标。

## 遗留风险（如实声明）

1. **TOCTOU 窗口（无法在本仓库内彻底消除）**：`lstat`/`realpath` 校验与最终 `rename`/追加之间仍有理论竞态；硬链接防护的「校验后、打开前」窗口由打开后 `fstat` 复核兜底，但「fstat 后、write 前」的极端窗口仍存在。写后复核只能发现、不能回滚宿主侧并发改动；彻底消除需 openat2/RESOLVE_BENEATH 级内核支持，Node 无对应 API。
2. `tests/engine.test.mjs` 依赖环境放行本机端口监听；换环境重跑前不能视为永久通过。
3. 无原生 zstd 解压能力的 Node（如 20.x）会话自动落回保守拒绝；需 Node ≥ 22.15/23.8+。
4. proposal 依赖宿主事务 API 或人工应用；`rejectedTargets` 为进程内 WeakMap，重启后同轮语义重置（round 本就以 cycle 为界，属预期）。
5. v6 起危险配置下初始化不再创建 `plugin-sync` 子目录（fail-closed，比 v5 更严格）；修复文件系统后需重启插件或等待下一轮目录守卫重试（round 以 cycle 为界，日志目标下一轮自动恢复尝试）。
6. 「交 Codex 第六轮终审，无 BLOCKER 才允许启用」尚未执行，送审前待 PM 安排。

# Claude Code 本轮（v1.2 registry 事务应用）

日期：2026-11-04。环境：Node.js v24.15.0，macOS（本机端口监听可用）。依据 `FEATURE-SPEC-v1.2.md`。版本 `1.2.0`。分支 `feat/v1.2-registry-apply`。

## 设计与实现

新增 `lib/registry-apply.js`（registry applier）：每轮 `cycle()` 在 `applyAll` 之后执行，把 staging 里合并后的 `workspace/workspace.json` 经**宿主 `ctx.workspaceRegistry` 事务 API** 增量应用到本机。**本模块零 fs 写调用**——只读（`fsp.stat` 确认工作区目录存在、`readWorkspaceStatus` 有界读 staging 文档），全部变更都是宿主 mutation queue 内的单条持久化操作（`create`/`resolveByPath`/`attachSession`/`archiveSession`/`pinSession`/`setTitle`/`sessionPersistence.stat`），宿主自行落盘并发 `domain/changed`。unarchive/unpin/insertBefore/insertSessionBefore/detachSession 等减序或排序 API 一律不调用——远端状态**只加不减**。

| 项 | 位置与行为 |
|---|---|
| 注入 | `index.js apply`：`ctx.inject(['workspaceRegistry','sessionPersistence'], collect)`，兼容返回值/回调/数组/对象四种形态、同步与 Promise；宿主无 inject、服务缺失、注入抛错一律解析为 `null` 绝不上抛，经 `createEngine({ services })` 传入引擎。引擎 `resolveServices` 每轮解析（失败不缓存、下轮重试），拿到双服务才进入 registry 模式 |
| 增量应用 | 归档/置顶集合逐条：`stat` 缺失 → warning 跳过（下轮重试）；`archiveSession` 捕获 `WorkspaceActiveSessionError`（按 `name`/`constructor.name` 识别）→ warning，**不调 `stopActivity` 强停用户会话**；pin 已归档/不存在 → warning。工作区逐个：path 过 `pathRemap`（复用 `lib/workspace.js` 新导出的 `applyRemap`，与 proposal 合并同一实现）→ `fsp.stat` 确认本地真实目录（缺失/非目录 → warning 跳过该工作区及全部会话，不创建目录）→ `resolveByPath` 未命中才 `create(path, title)`。会话：本工作区 `sessionIds` 缺失且 `stat` 存在才 `attachSession`。标题：仅当远端标题非空、与本地不同、且本地标题==registry 返回的 canonical path 的 basename（未被本地改名）时 `setTitle`；单调收敛不震荡 |
| 幂等 | 每轮从 registry 重读现状算差量，不缓存快照；重复调用依赖宿主 no-op 语义（attach 不重复、archive/pin no-op、标题规则单调）；单条失败下轮重试，不做整轮回滚 |
| 失败契约 | applier 自身不抛出：单条失败全部转 `registryWarnings[]`（前缀 `registry:`）；仅 staging 读取失败/信封无效升级为本轮 `errors[]`；engine 外层再兜 try/catch |
| 状态 | cycle 结果与 `dsh_sync_status`/`dsh_sync_now` 新增 `workspaceWriteMode: 'registry'|'proposal'`、`registryAvailable`、`registryApplied: {workspaces, created, sessions, archived, pinned, titles}`、`registryWarnings[]`、`registryLastApplied`（最近一次成功应用摘要，进程内存活） |
| 降级 | registry/sessionPersistence 任一不可用 → 整轮保持 v1.1.2 proposal 行为（含「待人工应用」warning）；registry 模式下 proposal 文件仍每轮生成（审计/降级后备），`mergeWorkspace` 新增 `proposalNotice:false` 只是不再提示，其余合并/写入路径一字未动 |
| 安全 | v1.1 全部约束不变：不写宿主文件、所有文件写仍收敛 safe-writer、`storages/workspace.json` 仍只读 |

既有测试唯一改动：`tests/engine.offline.test.mjs` 入口生命周期断言由「零 inject 调用」更新为「只注入 `['workspaceRegistry','sessionPersistence']`，不再注入 storageDomain」——v1.1 该断言的本意（不注入 storageDomain、宿主文件只读）由新断言继续保证，且该场景 mock 宿主返回 undefined 时插件仍降级 proposal、宿主字节不变。

## 验收命令与结果（实测）

`node --check`：`index.js`、`lib/engine.js`、`lib/registry-apply.js`、`lib/workspace.js`、`tests/registry.test.mjs` 及其余全部 `lib/*.js`、`hub.mjs`、6 个既有测试，全部 exit 0。

| 命令 | 结果 |
|---|---|
| `node tests/registry.test.mjs` | exit 0，8 类场景 + engine/index 接入共 9 组 ALL PASS（纯 mock，不碰真实宿主） |
| `node tests/workspace.compat.test.mjs` | exit 0，15 组 ALL PASS |
| `node tests/apply.compat.test.mjs` | exit 0，ALL PASS |
| `node tests/engine.offline.test.mjs` | exit 0，ALL PASS |
| `node tests/fixture.accept.test.mjs` | exit 0，ALL PASS |
| `node tests/security.symlink.test.mjs` | exit 0，14 组 ALL PASS |
| `node tests/engine.test.mjs` | exit 0，ALL PASS（真实 HTTP 双节点） |

grep 自检（实测）：

- `lib/registry-apply.js` 无任何 fs 写调用：仅 `node:fs/promises` 的 `fsp.stat`（只读）与 `readWorkspaceStatus`（只读）；
- 全仓库仍无对宿主 `storages/workspace.json` 的写/删/rename/copy；写调用全部收敛 `lib/safe-writer.js`；
- 新增宿主 API 调用面仅限规格清单：`create`/`resolveByPath`/`archiveSession`/`pinSession`/`attachSession`/`setTitle`/`sessionPersistence.stat`（`list` 未使用）。

## 遗留风险（如实声明）

1. **宿主 no-op 语义依赖契约**：attach/archive/pin/setTitle 的幂等依赖宿主「重复调用无害」的承诺；若宿主实现会对已归档会话重复 archive 抛错或重复 attach 报错，会表现为每轮固定 `registryWarnings[]`（不影响其他条目，也不破坏数据），需按宿主实际行为调整。
2. **stat 与宿主识别的时差**：本轮刚落回的会话文件，宿主可能尚未被 `sessionPersistence.stat` 识别 → 该会话本轮跳过、下一轮自动重试；会话在工作区出现可能比文件落回晚一轮，属预期。
3. **`archiveSession(id, { stopActivity: false })`**：明确不代用户停止活动会话；active 会话会每轮产生一条 warning 直至其结束或被用户归档。
4. **registryLastApplied 仅进程内存活**：插件重载后为 `null`，下一轮成功应用后重建；不影响正确性（现状每轮从 registry 重读）。
5. **未做跨工作区移动**：会话已在本地其他工作区时，本版本仍会 attach 到远端声明的工作区（不 detach 原工作区）；「会话搬家」场景未在规格内，两列表可能同时含该会话。
6. **交 Codex 审核与 PM 实机验证（`workspaceWriteMode:'registry'` 观察宿主自行落盘）尚未执行**，见 ACCEPTANCE.md v1.2 章节。

# Claude Code 本轮（v1.2.1 registry applier 修复：4 BLOCKER + 2 NIT）

日期：2026-11-04。环境：Node.js v24.15.0，macOS。依据 `FIX-SPEC-v1.2.1.md`（Codex 对 v1.2 的审核结论）。版本 `1.2.1`。分支 `feat/v1.2-registry-apply`。

## 修复对照

| 项 | v1.2 问题 | v1.2.1 修复 |
|---|---|---|
| BLOCKER 1 注入契约 | `index.js` 把 `ctx.inject(deps, cb)` 的回调参数当服务数组解析，服务齐全也永远降级 proposal | 回调改为 `(injectCtx) => { engine.setServices(injectCtx 的两服务); return () => engine.setServices(null) }`（index.js:14-27）；新增 `engine.setServices` 运行时**原子替换**服务句柄，置空/不满足契约**立即**把 `registryAvailable=false`、`workspaceWriteMode` 回 `'proposal'`（无需等下一轮）。移除旧的 promise 句柄解析（`opts.services` 四形态兼容层整体删除） |
| NIT 1 服务判定 | engine 仅凭两个 object 判定可用，空对象也显示 registry 模式 | 新导出 `registryServicesUsable`（lib/registry-apply.js）：`workspaceRegistry` 必须同时具备 `create/resolveByPath/list/archiveSession/pinSession` 函数、`sessionPersistence` 必须具备 `stat` 函数，否则不可用；`setServices` 与每轮 `runCycle` 都用它重判 |
| BLOCKER 2 标题竞争 | 标题条件在 mutation queue 外判断，随后无条件 `setTitle`，覆盖先排队的本地改名 | **applier 完全不再调用 `setTitle`**；远端标题仅在 `registry.create(path, title)` 新建时传入，既有 workspace 保持本地标题。`registryApplied` 移除恒零的 `titles` 计数。工作区重命名不跨设备同步（等宿主提供条件更新 API），已写入 README |
| BLOCKER 3 坏文档被应用 | 缺 `unit` 的文档绕过 applier 校验；合并拒绝也不阻止 registry mutation | engine 双重门禁（lib/engine.js runCycle）：①仅「`merged:true` 且本轮合并 `errors` 为空」的 `mergeWorkspace` 产物才允许应用；②应用前 `validateWorkspaceDoc(doc, { requireEnvelope: true })`，失败记 error 零 mutation。applier 入口再防御性自检一次，失败直接返回、不调用任何 registry API（连 `stat` 都不调） |
| BLOCKER 4 路径映射两次 | staging 已由 `mergeWorkspace` 映射过，applier 再映射 → `/a → /a/local → /a/local/local` | `registry-apply.js` 删除 `applyRemap`/`pathRemap`，输入改为 engine 直接传 merge 产物（路径已本地化，注释注明）。回归测试的 `pathRemap` 故意取 `to = from + '/local'`（二次映射必产生 `/local/local` 与目录不存在警告），断言 `resolveByPath` 收到的就是映射一次后的最终路径且警告为零 |
| NIT 2 测试短路 | `tests/registry.test.mjs` 同时开全部故障，前置 stat/resolve 错误掩盖 create/attach/setTitle/archive/pin 分支 | 重写为**逐 API 故障注入**（6 子例）：resolveByPath / create / stat / attachSession / archiveSession / pinSession 各自单独注入，各断言 ①错误进 warnings；②后续条目继续处理；③其它 API 调用次数符合预期（证明未被整体短路） |

测试文件重写为 10 组场景：正常路径+R2 标题、幂等、applier 防御自检（4 类坏文档零 mutation，含缺 unit/缺 initialized/条目非法/null）、缺目录跳过、archive/pin 增量、逐 API 故障注入（6 子例）、R4 单次映射（engine 全链路）、R3 engine 门禁（merged:false 与 errors 非空两条路径）、R1 入口注入契约（mock `(injectCtx, undefined)` 回调 → registry 模式；清理 → 立即 proposal；无 inject/抛错/缺方法/空对象 → proposal）、engine 正常路径+幂等+`registryLastApplied` 形状+stat 抛错引擎级可见。

## 验收命令与结果（实测）

`node --check`：`index.js`、`hub.mjs`、`lib/*.js`(12)、`tests/*.mjs`(7) 全部 exit 0。

| 命令 | 结果 |
|---|---|
| `node tests/registry.test.mjs` | exit 0，10 组场景 ALL PASS（纯 mock，不碰真实宿主） |
| `node tests/workspace.compat.test.mjs` | exit 0，ALL PASS |
| `node tests/apply.compat.test.mjs` | exit 0，ALL PASS |
| `node tests/engine.offline.test.mjs` | exit 0，ALL PASS |
| `node tests/fixture.accept.test.mjs` | exit 0，ALL PASS |
| `node tests/security.symlink.test.mjs` | exit 0，ALL PASS |
| `node tests/engine.test.mjs` | exit 0，ALL PASS（真实 HTTP 双节点） |

grep 自检（实测）：

- `lib/registry-apply.js` 无任何 fs 写调用：仅 `node:fs/promises` 的 `fsp.stat`（只读）；
- 全仓库仍无对宿主 `storages/workspace.json` 的写/删/rename/copy；写调用全部收敛 `lib/safe-writer.js`；
- `lib/registry-apply.js` 无 `setTitle`、无 `applyRemap`；宿主 API 调用面：`create`/`resolveByPath`/`archiveSession`/`pinSession`/`attachSession`/`sessionPersistence.stat`。

## 遗留风险（如实声明）

1. **合并错误即跳过整轮 registry 应用**：远端偶发坏条目会让该轮 `errors` 非空 → 本轮零 mutation（下轮重试）。这是 R3 的保守设计：宁可晚一轮应用，也不应用未经完整校验的产物。若远端持续发坏数据，registry 应用会持续跳过（proposal 文件仍生成，不影响合并本身）。
2. **工作区重命名不再跨设备同步**：两端各自保留本地标题；远端标题只影响新建工作区。属 R2 的有意取舍（宿主无条件更新 API）。
3. **宿主 no-op 语义依赖契约**：attach/archive/pin 的幂等仍依赖宿主「重复调用无害」承诺（v1.2 遗留，不变）。
4. **stat 与宿主识别的时差 / archiveSession 不强停 / registryLastApplied 进程内存活 / 未做跨工作区移动**：均沿袭 v1.2，见上一节。
5. **交 Codex 复审与 PM 实机验证尚未执行**：重载插件后需观察 `workspaceWriteMode:'registry'` 且对端会话出现在本机工作区（宿主自行落盘），见 ACCEPTANCE.md。


---

# v1.3.0：pathRemap 收敛为「应用时映射一次」

## 背景
v1.2.3-v1.2.5 尝试在合并阶段映射派生文档，被 Codex 连续指出：单规则可幂等但整组规则链式叠加、字符串边界（尾斜线/./..）可绕过、派生文档自愈会误删合法条目。

## 方案
合并阶段完全不映射；`mergeWorkspace` 保留远端原始路径到 proposal/staging。`lib/workspace.js` 新增 `normalizeRemapRules`（绝对路径、无点段、去重）与 `mapPathOnce`（规则按顺序组合、单次应用）；`lib/registry-apply.js` 在使用 `ws.path` 前调用一次，非法规则则整组禁用并跳过该工作区；`lib/engine.js` 把 `settings.pathRemap` 传给 applier 而不是 merge。

## 验证
- registry.test.mjs 新增：applier 映射两轮稳定、合并阶段保留原路径、非法规则零 mutation、链式规则单次应用稳定。
- 全 seven suites exit 0。


---

# v1.3.1：修复 v1.3.0 的宿主反馈膨胀与规则前置问题

Codex 审核 v1.3.0 指出：
1. 合并基底含宿主本机条目，applier 再映射本机路径 → `/a→/a/local` 逐轮膨胀并重复 attach。
2. 非法 pathRemap 规则在 archive/pin 之后才校验 → 仍产生 mutation。
3. 空规则时未校验 `ws.path`（`.`、相对路径、UNC 可进入宿主）。
4. 路径规范化改变语义（UNC、POSIX 中的反斜杠、根 `/`、`C:/`）。

修复：
- applier 先做规则校验（非法 → 整轮零 mutation）；每个工作区先做 `isSafeAbsolutePath`；路径本机存在 → 直接使用不映射，不存在才映射一次。
- `normalizeRemapRules`/`isSafeAbsolutePath`/`mapPathOnce` 严格化：仅 POSIX/盘符绝对路径，拒绝 UNC 与点段，保留根，盘符大写归一，POSIX 路径不转换反斜杠。
- 测试新增：反馈循环三轮不映射、非法规则零 archive/pin、`.` 路径零 mutation、UNC 拒绝、盘符大小写不敏感。
- PM 真实数据验证：本机 path 不映射、远端 Windows path 映射一次、attach 6 会话、零 error。
