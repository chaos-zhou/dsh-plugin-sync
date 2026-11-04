# FIX-SPEC v5：统一安全写入层（safe-writer），一次堵死所有写路径的符号链接/别名绕过

## 背景（Codex 第四轮终审，3 个 BLOCKER）

v4 已做到「不写宿主工作区索引」，但其余写路径仍可被符号链接重定向到 `<dshHome>/storages/workspace.json`：

1. **peer 拉取**：`lib/engine.js:375` 直接 `atomicWrite(dest, buf)`，`safeJoin` 只有词法检查。`staging/workspace → storages` 时，远端 blob 的拉取会 rename 覆盖宿主文件（`lib/export.js:112` 默认导出入口同类）。
2. **悬空 storages 别名**：`lib/workspace.js:501` 把 `realpath(storages)` 的 ENOENT 转成 null；构造 `storages → plugin-sync/proposed`（proposed 尚不存在），随后 mkdir 让别名生效，保护目录不再解析，proposal 写等于写宿主索引。
3. **日志目标符号链接**：`lib/log.js:24` 的 `appendFile` 跟随最终链接；`plugin-sync/logs/sync.log → storages/workspace.json` 时，初始化播种日志即可追加损坏宿主 JSON（`lib/engine.js:171/198`）。

根因：写盘入口分散、只做词法校验。**必须引入统一安全写入层，并在同一处集中校验。**

## 要求

### S1 新增 `lib/safe-writer.js`

导出统一的写入原语，所有插件写盘必须经它：

- `assertSafeRoot(root, { dshHome })`：
  - `root` 必须已存在且是真实目录；从文件系统根部逐级 `lstat`，**任何一级是符号链接 → 拒绝**；
  - `realpath(root)` 不得位于 `realpath(<dshHome>/storages)` 之内；
  - `lstat(<dshHome>/storages)`：若是符号链接 → 视为危险配置，**所有写入拒绝**（含 proposal/日志/state）；若不存在则记录"缺失"，但写前再次 lstat 复核。
- `guardedWrite({ root, rel, bytes, mode? })`：
  - `rel` 必须是安全的相对路径（拒绝绝对路径、`..`、反斜杠、NUL、点段）；
  - 写前 `assertSafeRoot`；逐级创建/校验父目录（每级 `lstat`，存在则必须为非链接真实目录，新建后立即 `realpath` 复核仍在 root 内）；
  - 临时文件用 `O_CREAT|O_EXCL|O_NOFOLLOW` 创建（`wx` + `O_NOFOLLOW`），写完 `rename`（rename 不跟随目标链接，安全）；
  - 写后 `lstat(target)`：必须是普通文件、非链接，且 `realpath(dirname(target))` 仍在 root 内；
  - 任一步失败：清理临时文件，返回结构化错误（不抛到调用方之外），**该目标本轮标记为拒绝，不再重试**。
- `guardedAppend({ file, bytes })`：`O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW` 打开；ELOOP/非普通文件 → 返回错误（不追加）。日志轮转（rename/重开）同样经此层。
- `guardedRemove({ root, rel })`：只允许删除 `root` 内、`lstat` 为普通文件的路径；父级校验同 S1。
- `assertApplyTarget({ dshHome, target })`：apply 落回目标（sessions/attachments/projcache）的父级真实路径校验，禁止任何解析后落入 `storages` 或经符号链接的父级。

### S2 接入所有写路径（一个不能漏）

- `lib/engine.js`：peer 拉取落 staging、state.json 持久化、config 持久化；
- `lib/export.js`：导出到 staging（含默认导出入口）；
- `lib/workspace.js`：proposal 写入/清理；读取宿主 workspace.json 仍是只读；
- `lib/apply.js`：sessions / attachments / projcache 落回；
- `lib/log.js`：日志追加与轮转；
- `lib/store.js`：blob 写入；
- `index.js`：init 失败兜底日志（改为经 logger）；
- 任何 `atomicWrite/atomicCopy/appendFile/open/writeFile/rename/copyFile` 调用点都必须收敛到 safe-writer 或带等价校验。

### S3 测试（必须真实构造符号链接，不接受词法模拟）

新增/更新 `tests/security.symlink.test.mjs`（真实文件系统、真实 symlink）：

1. `staging/workspace → <dshHome>/storages`：完整 `runCycle()`（含 peer 拉取）后，宿主 `workspace.json` 字节不变；cycle.errors 记录拒绝；后续写入该目标不再重试。
2. `dshHome/storages` 是悬空符号链接（指向 `plugin-sync/proposed`）：初始化/合并/日志都不得创建/写入任何 alias 目标；宿主视角字节不变；错误可见。
3. `plugin-sync/logs/sync.log → storages/workspace.json`：初始化播种与空 token 警告都不得追加；宿主字节不变。
4. `staging/workspace/workspace.json` 本身是符号链接：拒绝写入/清理。
5. `storages → plugin-sync/proposed` + proposed 不存在：proposal 写被拒绝（覆盖 Codex 复现的悬空别名路径）。
6. apply 落回目标父级为符号链接（指向 storages）→ 拒绝，宿主文件不变。
7. 真实事故 fixture：proposal 输出合法、宿主字节不变、`initialized` 保留、本地递归键不缩减、sessionIds 并集。
8. HTTP 测试的宿主哨兵改为比较**初始 Buffer 原始字节**（不是解析后的对象）。

已有五个测试文件保持全绿，并按 v5 语义调整（domain 相关断言保持"提供 domain 也零写入"）。

### S4 文档更正

- `README.md`：修正与代码不一致的表述（"校验失败统一置 false 且不产生文件"、"宿主缺失即中止"等），如实说明 safe-writer 能力边界（TOCTOU 窗口、O_NOFOLLOW 只防目标链接、父目录替换在 rename 前的窗口已在写前校验但无法完全消除）。
- `FIX-REPORT.md`：逐项更正 V1-V5 结论与证据，新增 v5 章节（S1-S3 → 位置 → 测试 → 结果）。
- `package.json` 版本 `1.1.1`。

## 验收（PM 门槛）

1. `node --check` 全部改动文件；
2. 六个测试文件 `exit 0`（新增 security.symlink + 原五个）；
3. grep 自检：所有写调用点都已走 safe-writer；无对 `storages/workspace.json` 的写/rename/copy/rm；无 domain 写调用；
4. 真实符号链接攻击用例必须 PASS（真实 fs + 真实 `runCycle`，不是函数级 mock）；
5. 真实事故 fixture 验收通过；
6. 交 Codex 第五轮终审，无 BLOCKER 才允许启用。
