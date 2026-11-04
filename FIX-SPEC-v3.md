# FIX-SPEC v3：改用宿主存储事务，彻底移除直接写 workspace.json

## 背景与 PM 决策

Codex 第二轮审核仍报 5 个 BLOCKER，全部围绕「插件直接写 `~/.dsh/storages/workspace.json`」无法与宿主并发写安全协作：提交瞬间竞态、回滚覆盖宿主更新、跨周期冲突基线、坏 zstd、产物无容量上限。

**决策：v1.1 起，插件不再直接读写 `~/.dsh/storages/workspace.json`。** 改为通过 DSH 宿主进程内服务 `ctx.storageDomain` 已打开的 `workspace` domain 读写（与宿主同一队列、同一校验），并在拿不到该服务时降级为「只生成建议文件」，**任何情况下都不直接改宿主文件**。

已核实的 API 契约（来自运行中 Host 的 Service 契约）：

```ts
ctx.storageDomain.get(name: string): DomainImpl | undefined
interface Domain<S> {
  name: string
  global: { get(): G; set(value: G): Promise<void> }
  table<N>(name): {
    get(key): V | undefined
    entries(): IterableIterator<[K, V]>
    keys(): IterableIterator<K>
    size: number
    put(key: K, value: V): Promise<void>
    delete(key): Promise<boolean>
    update(key, fn: (cur: V) => V): Promise<V>
  }
}
```

说明：`get()` 是宿主提供的「已打开 domain」句柄（工作区 domain 由 `@deepseek-ai/dsh-workspace` 打开，name 预期为 `workspace`）。写操作在宿主进程内执行，随宿主持久化与校验，不再有文件级竞态。

## 必须实现

### W1 移除直接文件写
- 删除/停用对 `<dshHome>/storages/workspace.json` 的一切**写**操作（含备份、恢复、rename、冻结这套文件事务逻辑）。
- 若代码里仍要读宿主文件（仅用于降级模式生成建议时参考），必须经有界三态读取，且**永不写回**。

### W2 宿主事务写（主路径）
- `index.js` 增加可选注入：`export const inject = ['tools']` 改为在 `apply` 内 `ctx.inject(['storageDomain'], (dctx) => { ... })`（拿不到也不得抛错）。
- 通过 `dctx.storageDomain.get('workspace')` 取句柄；不存在则进入 W3 降级模式。
- 合并输入：`domain.global.get()` + `domain.table('workspaces').entries()` 作为「本地」；staging 里的远端 workspace 作为「远端」；复用现有无损合并/校验逻辑（B1/B3/B4 语义保留）。
- 写回顺序：逐条 `table.put(id, value)`（只写有变化/新增的条目，值必须通过现有必需字段校验）；最后 `global.set(mergedGlobal)`。任何 `put/set` 抛错 → 记 `cycle.errors`、停止本轮后续 domain 写（已成功的保留，宿主保证单条一致），**不回滚、不直接改文件**。
- 写前校验合并结果（必需字段、workspaceIds ⊆ 表 id、defaultWorkspaceId 引用完整、条目数/序列化长度上限 32MiB）；不通过则不写 domain，报 error。
- 状态里输出 `workspaceWriteMode: 'domain' | 'proposal'`。

### W3 降级模式（拿不到 storageDomain 或 domain 不存在）
- **绝不写宿主文件**；把合并结果写到 `dataDir/proposed/workspace.json`（原子写、≤32MiB、超限报错不写）。
- 把「存在待应用的工作区合并建议」写入 `cycle.errors` 或独立 warning，并在 `dsh_sync_status` 中展示 `proposalPending: true` 与路径。
- README 说明：降级模式下会话/附件仍自动同步，工作区索引需宿主 API 可用或手动处理。

### W4 保留并加固传输/落回安全（上一轮 B7/B8/B9）
- **B7 跨周期冲突基线**：无基线冲突处理后，在 `state.json` 记录 `unresolvedConflict`（会话 id + 两侧哈希）；存在未解决冲突时，任何自动覆盖都禁止，直到两侧内容一致或冲突被清除。测试必须覆盖「首轮冲突→下一轮远端再变更→本地仍不被覆盖」。
- **B8 坏 zstd 帧**：落回前用 `node:zlib` 的 zstd 解压（若可用）做有界解压（限制输出字节）+ 逐行 JSON 解析校验；解压/校验失败 → 保存冲突副本、跳过、记 error，**绝不覆盖本地**。若运行时没有 zstd 解压能力，则同类文件一律冲突副本+跳过（保守）。
- **B9 容量上限**：workspace 合并输入与输出都做有界读取/序列化检查（≤32MiB、workspace/sessionIds 条目上限沿用 100000）；超限报 error 且不写（domain 与 proposal 两条路径都覆盖）。

### W5 测试
- 更新 `tests/workspace.compat.test.mjs`：文件事务相关用例改为「domain 句柄 mock」用例；
  - mock domain：正常合并写 put/global.set、坏合并不写、超限不写、put 抛错只记 error 不回滚文件、workspaceWriteMode 判定。
  - 降级模式：domain 缺失时只写 `proposed/workspace.json`，宿主 workspace.json 字节不变（用临时目录模拟，确认从未被打开写）。
- 更新 `tests/apply.compat.test.mjs`：新增 W4 的三个场景（跨周期未解决冲突、坏 zstd 帧、坏 JSONL）。
- 新增/保留 `tests/engine.offline.test.mjs`、`tests/fixture.accept.test.mjs`（真实事故 fixture 合并输出必须含 initialized、本地递归键不缩减；降级模式不得改宿主文件）。
- `tests/engine.test.mjs` 真实 HTTP 双节点测试必须能通过（允许监听时）。

### W6 README
- 增加「工作区索引写入模式」章节：domain 模式（默认，经宿主事务）/ proposal 降级模式（绝不写宿主文件）/ 为什么不再直接写文件 / 状态与建议文件位置 / 升级注意。

## 验收（PM 门槛）

1. `node --check` 全部改动文件；
2. 5 个测试文件全部 `exit 0`（engine.test 需要监听端口）；
3. 真实事故 fixture：合并输出含 `initialized`、本地递归键不缩减、sessionIds 并集；降级模式下宿主 `workspace.json` 字节完全不变；
4. `rg` 检查：仓库代码中不存在对 `storages/workspace.json` 的写调用（writeFile/rename/copyFile 目标为该路径）；只允许读或完全不读；
5. 交 Codex 审核（第三轮）：无 BLOCKER 才允许启用。

## 交付

- 修改 `index.js`、`lib/engine.js`、`lib/workspace.js`（重构）、`lib/apply.js`、相关测试与 README；新增 `lib/domain-workspace.js`（可选）。
- 更新 `FIX-REPORT.md`：W1-W6 → 修复位置 → 测试 → 结果。
- 不要 git commit；不要碰真实 `~/.dsh`。
