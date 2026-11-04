# HANDOFF —— dsh-plugin-sync v3 交接单

> 状态时间：2026-11-04 16:50 CST
> 角色分工：**Claude Code 写 → Lead（PM）跑验收门槛 → Codex 审核 → 无 BLOCKER 才启用插件**

## 1. 一句话现状

插件 **仍处于停用状态**（profile 的 bundles 列表里没有它、8789 无监听），真实 `~/.dsh` 未被改动；
v3（改为宿主事务写）实现正在进行，**未验证、未启用**。

## 2. 环境与安全状态（必须保持）

| 项 | 状态 |
|---|---|
| `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` | **不含** `dsh-plugin-sync`（已停用） |
| 插件 HTTP 端口 8789 | 无监听 |
| 真实 `~/.dsh/storages/workspace.json` | 已被用户修复，`python3 /tmp/ws-check.py validate` = VALID |
| 事故现场快照 | `/tmp/dsh-sync-accept/workspace.local.json`（修复版）、`workspace.staging.json`（写坏版） |

**在 Codex 审核通过之前，不要启用插件。**

## 3. Git 状态

| 分支 | 提交 | 含义 |
|---|---|---|
| `main` | `106ea0f` | 第一轮修复（Claude Code：保留 required/unknown 字段 + 校验 + 备份/回滚）。**Codex 二轮仍有 5 个 BLOCKER，未通过** |
| `wip/v3-host-domain` | `11d84a9` | Codex 部分完成的 v3（宿主 storageDomain 改造，额度中断，未验证） |
| 当前工作区 | 在 `wip/v3-host-domain` 上 | Claude Code 正在此分支继续 v3；改动未提交 |

## 4. 事故根因（已确认）

`lib/workspace.js` 的合并函数重建了 `global`，只保留 4 个字段，**丢掉了本地已有的 `global.initialized`**，并直接写回 `~/.dsh/storages/workspace.json`，导致 DSH 工作区存储校验失败、环境崩坏。
证据：坏文件与修复文件的递归键差只有 `/global/initialized`。

但仅补这一个字段不够——Codex 两轮审核发现更深问题：
- 直接写宿主文件**无法与宿主并发写协调**（提交瞬间竞态、回滚覆盖宿主更新）
- 未知嵌套字段子键会丢、`__proto__`/`constructor` 特殊键、索引悬空引用
- 备份/恢复不闭环、快照过期覆盖、首次同步无基线误覆盖
- 坏 zstd/坏 JSONL 可覆盖合法会话、无资源上限

## 5. 剩余工作

以 `FIX-SPEC-v3.md` 为准（Claude Code 正在执行）：

- **W1** 移除对 `~/.dsh/storages/workspace.json` 的一切写操作（不再有备份/回滚文件事务）
- **W2** 改用 `ctx.storageDomain.get('workspace')` 事务写（global.set + table.put），写前校验、写失败只记 error
- **W3** 拿不到 domain 时降级：只写 `<dshHome>/plugin-sync/proposed/workspace.json`，**绝不写宿主文件**，status 显示 `workspaceWriteMode: 'proposal'`
- **W4** 加固：B7 跨周期未解决冲突基线、B8 坏 zstd 有界解压+JSONL 校验（失败→冲突副本+跳过）、B9 workspace 输入/输出容量上限
- **W5** 测试：workspace（domain mock + 降级）、apply（B7/B8）、engine.offline、fixture.accept、engine（真实 HTTP）
- **W6** README：写入模式说明 + 升级注意

## 6. 流水线（恢复时照做）

### 步骤 A：Claude Code 写
```bash
cd /home/user/Documents/deepseek-harness/default-workspace/dsh-plugin-sync
git checkout wip/v3-host-domain
claude -p "$(cat /tmp/claude-v3-prompt.md)" --dangerously-skip-permissions \
  --output-format stream-json --verbose > /tmp/claude-v3.jsonl 2> /tmp/claude-v3.err
```
提示词在 `/tmp/claude-v3-prompt.md`（要求分文件落盘，避免单次超长响应被额度打断）。

### 步骤 B：PM 验收门槛（任何一条不过都不许进下一步）
```bash
cd /home/user/Documents/deepseek-harness/default-workspace/dsh-plugin-sync
for f in index.js hub.mjs lib/*.js tests/*.mjs; do node --check "$f" || exit 1; done
for t in tests/workspace.compat.test.mjs tests/apply.compat.test.mjs \
         tests/engine.offline.test.mjs tests/fixture.accept.test.mjs tests/engine.test.mjs; do
  node "$t" || exit 1
done
# 必须为 0 行：没有把写操作指向 storages/workspace.json
grep -rnE "(writeFile|rename|copyFile|createWriteStream)[^\n]*storages/workspace\.json" index.js lib/ || true
# 真实事故 fixture 验收（需按 v3 API 适配脚本）
node /tmp/accept-workspace.mjs
```

### 步骤 C：Codex 审核（只读）
```bash
CX="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
cd /home/user/Documents/deepseek-harness/default-workspace/dsh-plugin-sync
"$CX" exec -C "$PWD" --skip-git-repo-check -s read-only \
  -o /tmp/codex-review3.md "$(cat /tmp/codex-review3-prompt.md)"
```
通过标准：输出**无 [BLOCKER]**（[NIT] 可接受，记入待办）。

### 步骤 D：提交（审核通过后）
```bash
git add -A && git commit -m "feat(v3): host storage-domain workspace write, proposal fallback, apply hardening"
git checkout main && git merge --no-ff wip/v3-host-domain -m "merge v3 sync redesign"
```

### 步骤 E：安全启用（验证通过后）
1. 快照当前工作区索引：`cp ~/.dsh/storages/workspace.json /tmp/ws-before-enable.json`
2. 用 DSH 的 plugin_manager `set_bundle` 启用 `dsh-plugin-sync`（或从 Plugin Manager UI 启用）
3. 等首轮周期（10 秒 + 一轮）后校验：
   ```bash
   python3 /tmp/ws-check.py compare /tmp/ws-before-enable.json ~/.dsh/storages/workspace.json
   curl -s http://127.0.0.1:8789/v1/ping
   ```
4. 若校验失败或 DSH 出现异常：**立即停用**（`set_bundle enabled=false`），把备份复制回去：
   `cp /tmp/ws-before-enable.json ~/.dsh/storages/workspace.json`

## 7. 额度与探针

| 工具 | 现状 | 探针 |
|---|---|---|
| Codex | 16:34 后已恢复（探针 OK） | `codex exec -C <repo> --skip-git-repo-check -s read-only "只回复 OK"` |
| Claude Code (GLM) | 已恢复（探针 OK） | `claude -p "只回复 OK" --max-turns 1` |

额度再次耗尽时的处理：任务会自动停在“未验证”状态；恢复后从步骤 A 继续，不必重做已完成部分。

## 8. 交接清单

- [x] 插件停用、真实数据未动、现场快照保存
- [x] 事故根因与两轮 Codex 审核意见归档（`FIX-SPEC.md` / `FIX-SPEC-v2.md` / `FIX-SPEC-v3.md`）
- [x] WIP 分支保存 Codex 半成品（`wip/v3-host-domain`）
- [ ] Claude Code 完成 v3（进行中）
- [ ] PM 门槛全绿
- [ ] Codex 第三轮审核无 BLOCKER
- [ ] 合并提交 + 安全启用 + 启用后校验
- [ ] 更新 README 与版本号（建议 v1.1.0）
