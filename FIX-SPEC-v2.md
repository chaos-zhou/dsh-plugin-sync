# FIX-SPEC v2：Codex 审核阻断项修复

上一轮用 Claude Code 修复了「`global.initialized` 被丢弃」的原始事故，并通过自有测试与真实 fixture 模拟。
随后由 Codex 做只读审核，给出 **9 个 BLOCKER、4 个 NIT**（原文见下）。本轮要求：逐条修复，保持零依赖（仅 `node:` 内置）、不改无关功能、不要 git commit。

## 必须修复的 BLOCKER

### B1 未知字段子树丢失（`lib/workspace.js:152`）
现状：workspace 条目用浅合并 `{...loser, ...winner}`，本地 `extra:{keep:1}` + 远端较新 `extra:{other:2}` → `extra.keep` 丢失。
要求：
- 合并 workspace 条目时，**本地递归键集不得缩减**。
- 已知同步字段（`path`、`title`、`sessionIds`、`createdAt`、`updatedAt`）按原规则处理；未知字段对象递归合并：保留本地全部子键，远端只补充本地缺失的键。
- 写盘前增加「本地递归键集 ⊄ 结果」检查，发现缩减即拒写。

### B2 缺失/损坏信封绕过全部校验（`lib/workspace.js:90` + `lib/util.js:38`）
现状：`validateWorkspaceDoc` 对无 v2 信封的文档恒返回合法；`readJson` 把「文件不存在 / JSON 损坏 / 读取失败」都折叠为 `null`。本地不存在 + 远端 `{}` 会写出缺 `unit`、`global.initialized` 的文件。
要求：
- `readJson` 区分三态：缺失（ENOENT） / 解析失败 / 读取失败（非 ENOENT）。后两者对本地文件必须**拒写**并保留原文件。
- 新增 `validateWorkspaceDoc(doc, { requireEnvelope: true })`：无 v2 信封一律视为非法。
- 写盘后复检也必须 `requireEnvelope: true`。
- 本地缺失时：仅当远端为合法 v2 信封且完全通过校验才可创建；远端无信封/非法 → 不写。

### B3 被拒条目仍进入索引（`lib/workspace.js:188`）
现状：远端坏 workspace 被跳过，但其 id 仍进入 `global.workspaceIds`，形成悬空引用。
要求：
- `workspaceIds` 只保留「确实存在于结果 `tables.workspaces`」的 id（过滤并保持顺序）。
- `defaultWorkspaceId` 非空时必须存在于结果表与 workspaceIds 中，否则回退为本地值/空串。
- 校验函数增加「workspaceIds ⊆ 表 id」「defaultWorkspaceId 引用完整」两项检查。

### B4 普通对象字典吞掉特殊键（`lib/workspace.js:158/162`）
现状：`__proto__` 键赋值会改原型导致条目消失；`constructor`/`toString` 等被 `in` 误判为已有。
要求：
- 所有以 id 为键的字典用 `Object.create(null)` 构造；读取用 `Object.hasOwn`；输出前转回普通对象（`Object.assign({}, dict)` 或 `Object.fromEntries`）。
- 不接受远端注入的特殊键覆盖原型。
- 新增测试：本地/远端含 `__proto__`、`constructor` 键时不丢失、不污染 `Object.prototype`。

### B5 I/O 故障时备份/恢复无闭环（`lib/workspace.js:296/317`）
现状：读原始字节任意异常被当成「无本地文件」→ 允许无备份覆盖；恢复 `copyFile` 失败直接抛异常，坏文件留在原位。
要求：
- 读原始字节时：ENOENT 才算缺失；其它错误立即拒写。
- 恢复用「写临时文件 + 原子 rename + 校验字节」，失败时返回结构化错误（含备份路径），并设置模块级 `WORKSPACE_WRITE_FROZEN = <原因>`；冻结期间所有后续合并直接 `merged:false, skipped:true, error`（直到进程重启），并在日志中持续提示。

### B6 快照过期仍写回（`lib/workspace.js:238/310`）
现状：合并用最初解析的快照，写前只比较字节用于备份，未检测宿主期间修改。
要求：写盘前重新读取本地文件并与「合并输入时的原始字节」比较；不一致 → 放弃本轮写入（`merged:false, error:"本地 workspace.json 在合并期间被修改，等待下一轮"`），不得覆盖宿主的新数据。

### B7 首次同步用旧远端覆盖较新本地（`lib/apply.js:63`、`lib/engine.js:315`）
现状：无基线时远端文件 mtime 是「接收时间」，据此判新旧，直接覆盖本地，不留冲突副本。
要求：
- 无基线（state 无记录）且内容不同 → **保留本地**，远端存为冲突副本，绝不覆盖。
- `state.json` 缺失/解析失败 → 视为全部无基线（安全路径）。
- 删除「用接收时间判断内容新旧」的逻辑。

### B8 落回路径把哈希正确当成内容合法（`lib/apply.js:69/138`）
现状：损坏的 zstd/JSONL 或无效 YAML 可覆盖合法本地文件。
要求：
- 会话落回前做内容校验：文件非空 + zstd 魔数 `28 b5 2f fd`；不合法 → 存冲突副本并跳过，不覆盖本地。
- 摘要缓存落回前 `JSON.parse` 校验，失败跳过。
- `applyConfig` 风险过高：本轮改为**默认关闭且不落回**（保留导出）；若配置为 true，只记 warn「暂不支持自动落回插件配置」，避免无效 YAML 覆盖 profile。

### B9 不可信输入无资源边界（`lib/engine.js:213/220`）
要求：
- 响应体读取阶段也要受超时控制（AbortSignal 覆盖到 body 读完）。
- 硬上限：单 blob ≤ 200MB（超限拒收/拒读）、单 peer index ≤ 100000 条、单 index 响应 ≤ 16MB；超限记 error 并跳过该 peer。
- 服务端请求体同样 200MB 上限（现有则确认）。
- 数组字段合并上限：`sessionIds`/`workspaceIds` 超过 100000 条时截断并记 error（防止内存耗尽）。

## NIT（一并修）

- N1 `lib/engine.js:264/321`：合并返回的 `error/errors` 必须汇总进 cycle 的 `errors`（拒写/跳过时要 visible）。
- N2 `lib/workspace.js:305`：备份文件名加毫秒+pid+自增，避免同秒覆盖；清理规则同步。
- N3 `tests/workspace.compat.test.mjs:145`：补用例——远端独有会话、同名未知子树冲突、坏条目带索引、无信封、回滚失败、同秒备份。
- N4 `lib/workspace.js:83`：workspace 条目为 `null` 时校验必须返回错误而不是抛 TypeError；写后复检要捕获异常并进入恢复流程。

## 必须新增/更新的测试

1. `tests/workspace.compat.test.mjs`：覆盖 B1–B6、N2–N4 的每条断言（尤其：本地键集递归不缩减、无信封拒写、悬空 id 过滤、特殊键、冻结、快照过期、同秒备份）。
2. `tests/apply.compat.test.mjs`：覆盖 B7（无基线不覆盖、冲突副本产生）与 B8（坏 zstd/坏 JSON 不覆盖、applyConfig 不落回）。
3. `node tests/engine.test.mjs` 保持 ALL PASS。

## 验收标准（Lead 会复核）

- `node --check` 全部改动文件
- 三个测试文件全部通过
- 真实 fixture 模拟：`/tmp/dsh-sync-accept/workspace.local.json` + `workspace.staging.json` → 输出合法、`initialized` 保留、本地键集无缩减、sessionIds 并集
- 额外故障注入：本地文件在合并期间被改 → 拒写；本地含 `__proto__` 键 → 不丢条目
- 完成后写 `FIX-REPORT.md`：每条 BLOCKER/NIT → 修复位置 → 对应测试
