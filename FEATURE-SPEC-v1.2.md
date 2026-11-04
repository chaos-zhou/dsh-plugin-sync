# FEATURE-SPEC v1.2：通过宿主 workspaceRegistry 事务 API 自动应用工作区索引

## 目标

把 v1.1.2 的「proposal 只写建议、不自动应用」升级为：**通过宿主 `ctx.workspaceRegistry` 的持久化 mutation queue 自动应用远端工作区/会话**，让两台设备的会话列表真正互通，同时**继续不直接写任何宿主 JSON 文件**。

## 已核实的宿主 API（运行中 Host 契约）

```ts
ctx.workspaceRegistry: {
  create(path: string, title?: string): Promise<Workspace>       // 目录必须已存在且是目录；canonical realpath；已存在则复用
  resolveByPath(path: string): Promise<Workspace | undefined>    // 只查找，不创建
  list(): Workspace[]
  get(id): Workspace | undefined
  insertBefore(id, beforeId?): Promise<readonly WorkspaceId[]>   // 排序用，本版本不用
  archiveSession(sessionId, { stopActivity?: boolean }): Promise<void>
  unarchiveSession(sessionId): Promise<void>
  pinSession(sessionId): Promise<void>
  unpinSession(sessionId): Promise<void>
}

interface Workspace {
  id; path; title; createdAt; updatedAt; sessionIds
  setTitle(title: string): Promise<void>
  attachSession(sessionId: SessionId): Promise<void>
  insertSessionBefore(sessionId, beforeSessionId?): Promise<void>
  detachSession(sessionId): Promise<void>
  status(): Promise<'ok' | 'missing-dir'>
}

ctx.sessionPersistence: {
  stat(id): Promise<Snapshot | undefined>   // 宿主是否已识别该会话
  list(): Promise<Snapshot[]>
}
```

事件：每次 domain 写入成功后宿主自己发出 `domain/changed`，UI 会自动刷新——插件无需推送。

## 设计（registry applier）

新增 `lib/registry-apply.js`，在每轮 `cycle()` 的 apply 之后执行（workspace 写入模式：`'registry' | 'proposal'`）。

### 输入
与现在相同：staging 里的远端 workspace 文档（`staging/workspace/workspace.json`）与本地现有工作区（改为从 registry 读取，而不是读文件）。proposal 文件仍继续生成（审计/降级用），但不再作为主路径。

### 步骤（全部使用宿主 API，不写文件）

1. `registry` 不可用 → 回退 proposal 模式（状态 `workspaceWriteMode:'proposal'`，行为同 v1.1.2）。
2. 合并远端 `global.archivedSessionIds / pinnedSessionIds`：对远端集合中的每个 id 做**增量应用**（只加不减）：
   - `sessionPersistence.stat(id)` 不存在 → 记 warning 跳过（宿主尚未识别，下一轮重试）；
   - `archiveSession(id)`：捕获 `WorkspaceActiveSessionError`（会话正在跑）→ warning 跳过；
   - `pinSession(id)`：已归档/不存在 → warning 跳过。
3. 对远端每个 workspace：
   - `path` 先过 `pathRemap`；`fs.stat` 确认本地是目录（不是 → warning 跳过该 workspace，全部会话不处理）；
   - `registry.resolveByPath(path)`；无则 `registry.create(path, title)`（复用目录，不重命名）；
   - 对远端 `sessionIds` 中**本地尚无**的 id：
     - `sessionPersistence.stat(id)` 不存在 → warning 跳过；
     - `workspace.attachSession(id)`（幂等；已存在时不重复 attach）；
   - 标题：仅当 `remote.title` 非空、与本地不同、且**本地 title 等于本地目录 basename**（即从未被本地改过名）时 `workspace.setTitle(remote.title)`；否则保留本地标题（避免两端改名互相覆盖/震荡）。
4. 所有单条失败捕获为 warning/error，不中断整轮；汇总到 `cycle` 结果：`registryApplied: {workspaces, sessions, archived, pinned, titles}`、`registryWarnings[]`。
5. 状态新增：`workspaceWriteMode: 'registry'|'proposal'`、`registryAvailable`、`registryLastApplied`、`registryWarnings`。
6. 保留所有 v1.1 安全约束：不写宿主文件、safe-writer 管所有文件写、proposal 仍生成。

### 幂等与并发
- attach/archive/pin/setTitle 都是宿主 mutation queue 内的单条持久化操作；重复调用应无害（attach 已存在不重复、archive 已归档为 no-op、pin 已 pin 为 no-op、title 规则单调）。
- 每轮从 registry 重新读取现状再算差量，不缓存本地快照。
- 单条失败下轮重试，不做整轮回滚。

## 测试（PM 门槛）

新增 `tests/registry.test.mjs`（纯 mock，不碰真实宿主）：
1. 远端两个 workspace、若干会话：resolveByPath 命中/未命中 → create 只在未命中时调用；attachSession 只对本地缺失的会话调用。
2. 幂等：全部已存在时零 attach/create/setTitle。
3. sessionPersistence.stat 缺失的会话 → 不 attach，warning 记录。
4. 本地目录不存在 → 跳过该 workspace，不 create、不 attach。
5. archive/pin 增量：远端只加不减；active 会话 archive 抛错 → warning 不中断。
6. 标题规则：本地 title==basename 且远端不同 → setTitle；本地已改名 → 不覆盖；两端同名 → 不调用。
7. registry 不可用 → 回退 proposal 模式，状态正确。
8. 所有异常被捕获 → cycle 不 throw、errors/warnings 可见。

保持既有六个测试文件全绿（workspace/apply/engine.offline/fixture/security.symlink/engine）。

## 版本与文档

- `package.json` → `1.2.0`
- README 增加「自动应用（registry 模式）」：原理、幂等语义、跨系统路径映射、缺目录跳过、标题规则、降级行为
- FIX-REPORT 增补 v1.2 章节
- `ACCEPTANCE.md` 追加 v1.2 验收（PM 稍后填写）

## 验收（PM）

1. `node --check` 全部；
2. 七个测试文件 exit 0；
3. grep：无宿主文件写；registry applier 不含 fs 写；
4. 交 Codex 审核，无 BLOCKER 后：重载插件（bundle 关→开，无需重启 DSH），观察 `dsh_sync_status` 显示 `workspaceWriteMode:'registry'`，并验证从对端拉来的会话出现在本机工作区（宿主文件由宿主自己更新）；
5. 宿主文件若发生变化，必须能证明是由宿主（domain/changed/registry 写入）而非插件 safe-writer 造成。
