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
