# 紧急修复规格：workspace.json 兼容性（v1.0.1）

## 事故与根因（已取证）

启用 `dsh-plugin-sync` 后，DSH 环境崩坏，用户手动修复了 `~/.dsh/storages/workspace.json` 并停用了插件。

根因在 `lib/workspace.js` 的 `mergeWorkspaces()`：返回值里用**新构造的 `global` 对象**替换了原对象，只保留 4 个键：

```js
global: {
  workspaceIds, archivedSessionIds, pinnedSessionIds, defaultWorkspaceId,
}
```

漏掉了本地已有的 `global.initialized`（以及任何未来新增/未知字段）。`mergeWorkspaceFiles()` 随后把这份结果直接写回 `~/.dsh/storages/workspace.json`。

现场证据（`/tmp/dsh-sync-accept/`）：

- `workspace.local.json`（用户修复后的合法文件，sha256 `8c8d9507…`）
- `workspace.staging.json`（插件写坏的那份，sha256 `f0d548c9…`）
- 递归键对比：`local 有而 staging 没有 = ['/global/initialized']`，反向为空

## 修复目标（必须全部满足）

1. **无损原则**：合并结果必须包含本地文件的**全部键**（递归 key 子集校验）。本地 `workspace.json` 里存在的任何键，合并后的文件必须有同名键；禁止用新对象替换 `global` / `tables` / workspace 条目。未知字段（未来 DSH 版本新增的）一律原样保留。
2. **写盘前校验**（先校验，后写入）：
   - 顶层：`unit.name === 'workspace'`、`unit.version` 为数字；`global` 为对象；`tables.workspaces` 为对象
   - `global`：`initialized` 为 boolean、`workspaceIds` 为数组、`archivedSessionIds` 为数组、`pinnedSessionIds` 为数组、`defaultWorkspaceId` 为 string（允许空串）
   - 每个 workspace：`path` string、`title` string、`sessionIds` 为字符串数组、`createdAt` string、`updatedAt` string
   - 校验失败 → **不写任何文件**，保持本地文件字节不变，返回 `{merged:false, error}`，写 error 日志并计入 cycle 的 `errors`
3. **远端是不可信输入**：staging 里可能是对端或旧版本写坏的文件（当前这份就缺 `initialized`）。远端不合法时不得合并进本地；但本地合法时必须正常合并，并在输出中补齐所有必需字段。
4. **备份与回滚**：写本地前，在 `storages/` 同目录写 `workspace.json.bak-<YYYYMMDD-HHMMSS>`（最多保留 5 个）；写入后重新读回并再次校验，失败则用备份恢复原文件并报错。
5. **版本守卫**：`unit.version` 不是数字或 `!== 2` 时，拒绝合并（日志 warn，返回 skipped），绝不改写文件。
6. **本地文件缺失**：仅当远端通过校验才可写入本地；否则不写（禁止创建空的/残缺的 workspace.json）。
7. **零依赖**：只用 `node:` 内置模块；不改无关逻辑；不改其它数据文件（state.json/staging 的会话部分不受影响）。
8. **幂等**：同一输入连续合并两次，输出完全相同。

## 必须新增并通过的测试

新增 `tests/workspace.compat.test.mjs`（`node tests/workspace.compat.test.mjs` 退出码 0 = 通过），覆盖：

1. **回归**：local 含 `global.initialized` + 自定义未知键（如 `global.customFlag`、workspace 的 `extra`）→ 合并后这些键全部保留，`initialized` 仍为 boolean。
2. **远端缺字段**：远端缺 `initialized`，且本地文件合法 → 合并成功，输出含 `initialized`，远端 `sessionIds` 并入。
3. **本地非法则拒写**：本地缺 `initialized`（或类型错误）→ `merged:false`，本地文件哈希不变、不存在备份/新写入。
4. **远端独有 workspace 缺必需字段**（如缺 `title`/`createdAt`）→ 跳过并报 error，不写坏文件。
5. **版本守卫**：`unit.version = 3` → 跳过，不写。
6. **备份**：成功写入后同目录存在 `.bak-*` 且内容等于写前原文件。
7. **幂等**：连续两次合并输出相同。
8. 既有 `node tests/engine.test.mjs` 必须保持 ALL PASS。

## 验收（Lead 会独立复核）

- `node --check` 每个改动文件
- 跑两个测试文件
- 用真实两份文件模拟：`/tmp/dsh-sync-accept/workspace.local.json`（合法，修复版）+ `/tmp/dsh-sync-accept/workspace.staging.json`（坏的那份）→ 输出必须包含 `/global/initialized`、保留本地全部键、远端/本地 `sessionIds` 并集
- 以上全部通过后才允许重新启用插件

## README 增补

加一段「工作区索引兼容性」：写盘前校验、未知字段保留、备份与回滚、版本守卫、以及“远端数据视为不可信输入”的说明。
