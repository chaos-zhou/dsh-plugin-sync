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

日期：2026-11-04 开发完成，待 Codex 审核与 PM 实机验收。分支 `feat/v1.2-registry-apply`，版本 `1.2.0`。

## 0. 功能概述

宿主提供 `ctx.workspaceRegistry` / `ctx.sessionPersistence` 事务 API 时，每轮同步在 apply 之后经该 API **自动应用**工作区/会话增量（`workspaceWriteMode: 'registry'`）；服务不可用自动回退 v1.1.2 proposal 模式。插件仍然**不写任何宿主 JSON 文件**（applier 零 fs 写调用，文件写继续收敛 safe-writer）。

## 1. 开发侧自检（Claude Code，已实测）

| 门槛 | 结果 |
|---|---|
| `node --check`（index.js + hub.mjs + lib/*.js(11) + tests/*.mjs(7)） | 全部 exit 0 |
| `node tests/registry.test.mjs` | exit 0，8 类场景 + engine/index 接入 9 组 ALL PASS（纯 mock） |
| 既有 6 个测试（workspace.compat / apply.compat / engine.offline / fixture.accept / security.symlink / engine） | 全部 exit 0，ALL PASS |
| grep：registry-apply.js 无 fs 写调用 | 通过（仅 `fsp.stat` 只读） |
| grep：无宿主 storages 文件写 | 通过（`storages/workspace.json` 仍只有 2 处只读） |

## 2. Codex 审核（待填写）

| 轮次 | 结论 | BLOCKER/NIT |
|---|---|---|

## 3. PM 实机验收（待填写）

- [ ] 重载插件（bundle 关→开），`dsh_sync_status` 显示 `workspaceWriteMode: 'registry'`、`registryAvailable: true`；
- [ ] 从对端拉来的会话出现在本机对应工作区，且宿主 `storages/workspace.json` 的变化**由宿主自身写入**（`domain/changed` / registry mutation queue），可证明非插件 safe-writer 所为（对比启用前后 sha256 与插件写面自检）；
- [ ] 幂等：连续两轮 `dsh_sync_now`，第二轮 `registryApplied` 的 created/sessions/archived/pinned/titles 为 0；
- [ ] 降级：临时移除 registry 服务注入后，`workspaceWriteMode` 回到 `'proposal'` 且行为同 v1.1.2；
- [ ] 宿主文件 sha256 记录：启用前 ________ / 启用后 ________（应仅由宿主自身操作引起变化）。
