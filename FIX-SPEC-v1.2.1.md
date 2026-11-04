# FIX-SPEC v1.2.1：registry applier 的 4 个 BLOCKER + 2 条 NIT

## 背景（Codex 对 v1.2 的审核结论）

v1.2 的 registry applier 方向正确，但实现有 4 个 BLOCKER：

1. **注入回调契约用错（index.js:16）**：Cordis `ctx.inject(deps, cb)` 的回调是 `(ctx, config)`，返回 Fiber；当前代码把回调参数当服务数组，导致**服务齐全也永远降级 proposal**。
2. **标题竞争（registry-apply.js:118）**：标题条件在 mutation queue 外判断，随后无条件 `setTitle`，会覆盖先排队的本地改名。
3. **坏文档仍被应用（registry-apply.js:49 / engine.js:468）**：缺少 `unit` 的文档绕过 applier 校验；合并拒绝也不阻止 registry mutation，仍执行 create/attach。
4. **路径映射执行两次（registry-apply.js:92）**：staging 已由 `mergeWorkspace` 映射过，applier 再映射 → `/a → /a/local → /a/local/local`，正确目录被跳过。

NIT：
- `tests/registry.test.mjs:341` 同时开启全部故障，前置 stat/resolve 错误掩盖了 create/attach/setTitle/archive/pin 的异常分支；需逐个 API 注入故障。
- `engine.js:131` 仅凭两个 object 判定服务可用，空对象也会显示 registry 模式；需校验必需方法。

## 必须实现

### R1 修正注入（BLOCKER 1）
- `index.js` 改为：
  ```js
  ctx.inject(['workspaceRegistry', 'sessionPersistence'], (injectCtx) => {
    const registry = injectCtx.workspaceRegistry
    const persistence = injectCtx.sessionPersistence
    engine.setServices({ workspaceRegistry: registry, sessionPersistence: persistence })
    return () => engine.setServices(null)
  })
  ```
  （若 `ctx.inject` 同步返回 Fiber，忽略返回值；服务从回调 Context 读取。）
- `engine.setServices` 支持运行时更新（原子替换），并在服务失效时把 `workspaceWriteMode` 恢复为 `proposal`、`registryAvailable=false`。
- 新增入口级测试：mock `ctx.inject(deps, cb)` 以 `(fakeCtx, undefined)` 调用回调 → `registryAvailable === true`、`workspaceWriteMode === 'registry'`；不注入时回退 proposal。
- 服务可用性判定：`workspaceRegistry` 必须同时具备 `create/resolveByPath/list/archiveSession/pinSession` 函数，`sessionPersistence` 必须具备 `stat` 函数；否则视为不可用（NIT 1）。

### R2 标题（BLOCKER 2）
- **既有 workspace 不再调用 `setTitle`**（无队列内条件更新，必然有竞争）。
- 仅当 `registry.create(path, title)` 新建时传入远端 title；已存在的 workspace 保持本地标题。
- README/状态中说明：工作区重命名不跨设备同步（等宿主提供条件更新 API）。
- 测试：既有 workspace 时 `setTitle` 调用次数为 0；新建时 create 收到 title。

### R3 只应用「合并成功且校验通过」的产物（BLOCKER 3）
- engine 在调用 applier 前：
  - 合并失败/被拒（`merged:false` 或 errors 非空）→ **零 registry mutation**；
  - 对将要应用的文档执行 `validateWorkspaceDoc(doc, { requireEnvelope: true })`，失败 → 零 mutation，记录 error。
- applier 内部再自检一次（防御性），校验失败直接返回，不调用任何 registry API。
- 测试：坏文档（缺 unit/缺 initialized/条目非法）→ create/attach/archive/pin 调用次数全为 0；合法文档正常应用。

### R4 路径映射只做一次（BLOCKER 4）
- `registry-apply.js` **不再做 pathRemap**；输入路径视为已本地化（由 mergeWorkspace 输出）。
- engine 向 applier 传 merge 产物 + 明确注释「已本地化」。
- 测试：engine 完整链路（pathRemap 配置非空）→ 只映射一次；断言 registry.resolveByPath 收到的路径是映射后的最终路径，无重复后缀。

### R5 测试补强（NIT 1）
- `tests/registry.test.mjs` 改为**逐 API 故障注入**：resolveByPath 抛错、create 抛错、stat 抛错、attachSession 抛错、archiveSession 抛错、pinSession 抛错，各自断言：
  - 错误进入 warnings/errors；
  - 后续条目继续处理；
  - 其它 API 的调用次数符合预期（证明不是被前置错误整体短路）。
- 覆盖 R1/R2/R3/R4 的新用例。

### R6 版本与文档
- `package.json` → `1.2.1`；README/FIX-REPORT 更新（注入方式、标题不同步、映射一次、零 mutation 条件）。

## 验收（PM）

1. `node --check` 全部；
2. 七个测试文件 exit 0（含新增逐 API 故障用例）；
3. grep：applier 无 fs 写；无 `setTitle` 调用（既有 workspace）；
4. 交 Codex 复审，无 BLOCKER 后：提交、重载插件、验证 `workspaceWriteMode:'registry'` 且从对端同步的会话出现在本机工作区（由宿主自己持久化）。
