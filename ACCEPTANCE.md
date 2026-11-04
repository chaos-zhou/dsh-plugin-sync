# ACCEPTANCE —— dsh-plugin-sync v1.1.2 验收记录（PM）

日期：2026-11-04。流程：**Claude Code 写 → PM 客观门槛 → Codex 审核**（共 6 轮审核、6 轮实现迭代）。

## 1. 结论

**通过验收并已安全启用（v1.1.2）。**
宿主 `~/.dsh/storages/workspace.json` 在启用前后**字节完全一致**（sha256 `8c8d9507…`），
工作区索引以 proposal 建议文件形式输出，插件不再读写宿主工作区索引。

## 2. 事故与修复路径

| 轮次 | 实现 | Codex 审核结论 | 主要变化 |
|---|---|---|---|
| 1 | Claude Code | 9 BLOCKER | 保留 `global.initialized`/未知字段、写前校验、备份回滚 |
| 2 | Claude Code | 5 BLOCKER | 未知子树、信封、索引引用、特殊键、快照/恢复、首同步、内容校验、资源上限 |
| 3 | Codex（子代理）→ Claude Code 收尾 | 2 BLOCKER | 改宿主 `storageDomain` 事务写；真实路径边界 |
| 4 | Claude Code | 3 BLOCKER | **放弃写宿主索引**（纯 proposal）：写路径收敛、悬空别名 |
| 5 | Claude Code | 1 BLOCKER | 统一 `lib/safe-writer.js`：全部写/删/rename/日志经安全层 |
| 6 | Claude Code | **无 BLOCKER**（6 NIT） | 日志硬链接 nlink 防护、`guardedMkdir`、失败契约、安全回归扩到 14 类 |

**最终设计**：v1.1 起不写宿主工作区索引；会话/附件/摘要缓存照常自动同步；工作区合并只生成
`<dshHome>/plugin-sync/proposed/workspace.json`。所有落盘经 `safe-writer`（真实路径 + 符号链接/硬链接防护）。

## 3. PM 验收门槛（全部通过）

```text
node --check：index.js + hub.mjs + lib/*.js(10) + tests/*.mjs(6)   全通过
tests/workspace.compat.test.mjs     PASS（15 组 proposal-only）
tests/apply.compat.test.mjs         PASS
tests/engine.offline.test.mjs       PASS
tests/fixture.accept.test.mjs       PASS（真实事故 fixture：initialized 保留/递归键不缩减/宿主字节不变）
tests/security.symlink.test.mjs     PASS（14 类真实符号链接/硬链接攻击）
tests/engine.test.mjs               PASS（真实 HTTP 双节点）
```

写面自检：仓库内无对 `storages/workspace.json` 的写/删/rename/copy；无 `domain.global.set`/`table.put`；
写调用全部收敛到 `lib/safe-writer.js`。

## 4. 启用证据（2026-11-04 18:44 CST）

| 项 | 结果 |
|---|---|
| 启用方式 | `plugin_manager set_bundle` → `application: applied`，无 warning |
| `/v1/ping` | `{"ok":true,"device":"mac-desktop","role":"peer","version":"1.1.2"}` |
| 宿主 `workspace.json` sha256 | `8c8d95076260dfcb276181e6852a4244eb68eb3307b9388a0818d5b94e3d3606`（**与启用前一致**） |
| `ws-check compare` | `SAFE: 合法且未丢失任何原有键` |
| 运行模式 | `workspaceWriteMode: "proposal"`、`proposalPathSafe: true`、`proposalPending: true` |
| 首轮周期 | `exported 6 / applied 1 / merged 1 / errors []`，仅 1 条 warning（待应用建议） |
| 监听 | `127.0.0.1:8789`（token 为空 → 仅本机；配置 token 后重启才会绑 LAN） |

## 5. 遗留 NIT（不阻塞启用，计划 v1.1.3）

1. `storages` 探测 `state:'error'`（EIO 等）时未立即结构化拒绝（safe-writer:138/206）。
2. `crypto.randomBytes()` 在失败兜底之外（safe-writer:273），极端异常可能外抛。
3. `index.js` 初始化兜底 logger 的拒绝队列无人读取。
4. 硬链接「超阈值轮转」仅有直调守卫测试，缺完整 runCycle 回归；零写插桩有别名盲区。
5. README/FIX-REPORT 少数能力表述需再收窄（fstat 只覆盖追加；openat2 不适用）。

## 6. 启用后使用与回滚

- 配置（会话内让 Agent 调工具）：`dsh_sync_config` 设置 `deviceName` / `token` / `peers`（或 `hubUrl`）；
  **改 token 后需重启 DSH** 才会绑定 `0.0.0.0`。
- 局域网拓扑：两台互填 `peers: [{name, url: "http://<对端IP>:8789", token}]`；跨系统路径用 `pathRemap`。
- hub 拓扑：服务器跑 `node hub.mjs --port 8790 --token <T> --data <DIR>`，客户端填 `hubUrl`。
- 回滚：`plugin_manager set_bundle` 把 `dsh-plugin-sync` 设为 `false`；如需恢复索引：
  `cp /tmp/ws-before-enable.json ~/.dsh/storages/workspace.json`。
- 工作区索引：当前只生成建议文件，不会自动应用；如需在某台设备应用，人工核对
  `~/.dsh/plugin-sync/proposed/workspace.json` 后按需处理（后续版本等宿主事务 API 再做自动应用）。

---

# v1.2 验收记录（PM 填写）

日期：2026-11-04 开发完成；同日 Codex 审核报 4 BLOCKER + 2 NIT，v1.2.1 修复；同日复审报 1 BLOCKER + 2 NIT，v1.2.2 修复完成，待 Codex 三审与 PM 实机验收。分支 `feat/v1.2-registry-apply`，版本 `1.2.2`。

## 0. 功能概述

宿主提供 `ctx.workspaceRegistry` / `ctx.sessionPersistence` 事务 API 时，每轮同步在 apply 之后经该 API **自动应用**工作区/会话增量（`workspaceWriteMode: 'registry'`）；服务不可用自动回退 v1.1.2 proposal 模式。插件仍然**不写任何宿主 JSON 文件**（applier 零 fs 写调用，文件写继续收敛 safe-writer）。

v1.2.2 修复（见 `FIX-SPEC-v1.2.2.md`）：

1. **BLOCKER（失败累计）**：一轮内多次合并时，先前失败的标记会被后续成功合并覆盖（peer1 坏条目 → peer2 成功 → registry 仍应用）。现在 `workspaceMergeFailed` 本轮累计、绝不清除；任一次合并失败即整轮零 registry mutation，错误保留在 `errors[]`，跳过原因写入 `registrySkippedReason`（summary 与 status 均暴露）。回归测试：「先坏后好」双 peer，registry 四类 API 总调用数为 0。
2. **NIT 1**：attach/archive/pin 各补「首项失败、次项成功」故障注入用例（错误进 warnings、次项调用发生、循环继续）。
3. **NIT 2**：README/ACCEPTANCE 明确 `registryApplied.archived/pinned` = 成功调用的 API 次数（宿主 no-op 也计数；合并失败轮次不计数）；补带 archived/pinned 的重复轮幂等测试（第二轮 archive/pin 按宿主 no-op 语义仍调用并计成功，create/attach 为 0）。

## 1. 开发侧自检（Claude Code，已实测）

| 门槛 | 结果 |
|---|---|
| `node --check`（index.js + hub.mjs + lib/*.js(12) + tests/*.mjs(7)） | 全部 exit 0 |
| `node tests/registry.test.mjs` | exit 0，12 组场景 ALL PASS（R1-R5 + v1.2.2 覆盖，纯 mock） |
| 既有 6 个测试（workspace.compat / apply.compat / engine.offline / fixture.accept / security.symlink / engine） | 全部 exit 0，ALL PASS |
| grep：registry-apply.js 无 fs 写调用 | 通过（仅 `fsp.stat` 只读） |
| grep：registry-apply.js 无 setTitle / 无 pathRemap | 通过（v1.2.1 R2/R4） |
| grep：无宿主 storages 文件写 | 通过（`storages/workspace.json` 只读） |

## 2. Codex 审核

| 轮次 | 结论 | BLOCKER/NIT |
|---|---|---|
| 第 1 轮（审 v1.2.0） | 需修复 | 4 BLOCKER + 2 NIT（注入契约用错、标题竞争、坏文档被应用、路径映射两次；测试整体短路、服务判定过松），见 `FIX-SPEC-v1.2.1.md` |
| 第 2 轮（复审 v1.2.1） | 需修复 | 1 BLOCKER + 2 NIT（合并失败标记被后续成功合并覆盖；attach/archive/pin 缺「首项失败次项继续」用例；archived/pinned 计数口径未澄清、缺重复轮幂等测试），见 `FIX-SPEC-v1.2.2.md` |
| 第 3 轮（复审 v1.2.2） | 待填写 | |

## 3. PM 实机验收（待填写）

- [ ] 重载插件（bundle 关→开），`dsh_sync_status` 显示 `workspaceWriteMode: 'registry'`、`registryAvailable: true`；
- [ ] 从对端拉来的会话出现在本机对应工作区，且宿主 `storages/workspace.json` 的变化**由宿主自身写入**（`domain/changed` / registry mutation queue），可证明非插件 safe-writer 所为（对比启用前后 sha256 与插件写面自检）；
- [ ] 幂等：连续两轮 `dsh_sync_now`，第二轮 `registryApplied` 的 created/sessions/archived/pinned 为 0；
- [ ] 降级：临时移除 registry 服务注入后，`workspaceWriteMode` 回到 `'proposal'` 且行为同 v1.1.2；
- [ ] 宿主文件 sha256 记录：启用前 ________ / 启用后 ________（应仅由宿主自身操作引起变化）。


---

# v1.3.2 验收（2026-11-04）

## 交付
- registry 模式：通过宿主 `workspaceRegistry` 事务 API 自动应用工作区索引（create/resolveByPath/attachSession/archiveSession/pinSession），**插件不写宿主索引文件**。
- 跨系统路径：`pathRemap` 只在 applier 使用路径时映射一次；本机已存在路径不映射（防反馈膨胀）；规则严格校验（绝对路径、无点段、拒绝 UNC/根规则、映射结果复验）。
- Codex 六轮复审（v1.2→v1.3.2）：最新一轮**无 BLOCKER**，仅 5 条 NIT（诊断文案/测试可移植性）。
- 7 套测试全 PASS；真实 staging（Windows 路径）+ 真实 remap + mock registry：本机路径不映射、远端映射一次、attach 6 会话、零 error。
- GitHub：main `ddb111c`、tag `v1.3.2`。

## 线上验证（Mac 端，插件已启用）
- `workspaceWriteMode: "registry"`、`registryAvailable: true`、监听 `0.0.0.0:8789`。
- 一轮 cycle：`pulled 2 / pushed 2 / applied 2 / merged 2 / errors 0`；`registryApplied.workspaces = 2`（两个工作区均解析到本机路径，跨系统映射成功）。
- 待办：宿主尚未识别新同步的 2 个会话文件 → 重启 DSH 后自动 attach（插件会给 warning 并在下一轮重试）。
- 对端需升级到 v1.3.2 才能同样自动应用工作区索引。
