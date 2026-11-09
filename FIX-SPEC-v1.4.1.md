# FIX-SPEC v1.4.1：v1.4.0 安全加固（Codex 审核 7 BLOCKER + 3 NIT）

适用分支 `feat/v1.4.0-selfservice`。目标：逐条修掉 Codex v1.4.0 审核发现的问题，不改变功能目标。

## B1 备份目录必须独占且写入走 safe-writer
`lib/update.js`：
- 备份目录名加随机后缀（`crypto.randomBytes`），用 `fsp.mkdir(dir, { recursive:false, mode:0o700 })` 独占创建；EEXIST 视为失败。
- 备份文件写改用 `guardedWrite({ root: backupDir, rel, bytes, mode, dshHome })`，不得裸 `writeFile`（防预置符号链接跟随到宿主文件）。
- 备份失败 → 在替换前中止（零副作用）。新增测试：备份目录预置为符号链接/重名时拒绝且宿主文件字节不变。

## B2 回滚登记时序、权限、失败可恢复
- 替换前先计算 planned `replaced/added` 列表，**先登记再写**（`guardedWrite` 在 rename 后的复核阶段报错时也能回滚当前文件）。
- 备份/回滚保留原文件 mode（`stat.mode & 0o7777`），回滚恢复 0o755 等执行位。
- 回滚失败时返回 `backupDir`（非 null）并在 error 中列出问题，便于人工恢复。
- 测试：注入「rename 后复核失败」场景，断言文件回到旧内容、mode 保留；新增文件被清理；pending 不写。

## B3 更新互斥 + CLI 超时语义
- `lib/update.js` 增加跨进程锁：`dataDir/updates/.lock`，`fsp.open(lock, 'wx')` 独占创建，finally 删除；锁存在时返回 `{applied:false,error:'已有更新在进行'}`。
- 引擎自动更新与管理端/CLI 手动更新共用该锁。
- `bin/dsh-sync.mjs`：只有**连接建立前**失败（ECONNREFUSED）才回退离线模式；请求已发出后超时/断连必须报「结果未知，请检查状态后重试」，禁止自动离线重试。
- 测试：双次并发 apply（一个成功、一个被锁拒绝）；慢响应超时不触发离线更新。

## B4 解压上限 + 元数据条目计数
- `zlib.gunzipSync(bytes, { maxOutputLength: MAX_TAR_TOTAL_BYTES + 1 })`，超限捕获为明确错误（gzip 炸弹）。
- `parseTar` 对所有 tar 头（含 `L/x/g/K` 元数据头）计数，超过 `MAX_TAR_ENTRIES` 拒绝。
- 测试：小 gzip 解压 >64MiB 拒绝且零副作用；大量元数据头触发条目上限。

## B5 管理端鉴权强化
`lib/server.js`：
- token 只接受 `x-dsh-sync-token` 头；**不接受 query token**。
- token 比较用 `crypto.timingSafeEqual`（先 sha256，长度无关）。
- 所有管理路由先校验 `Host` 为本机回环（`127.0.0.1`/`localhost`/`[::1]`）。
- 非 GET 管理请求：要求 `content-type` 以 `application/json` 开头；若带 `Origin`，其 host 必须是回环，否则 403（防跨站表单 CSRF）。
- `GET /admin` 静态页本身不要求 token（仅回环），`/v1/admin/*` 仍要求 token。
- 测试：query token 拒绝、跨站 Origin 拒绝、text/plain POST 拒绝、恶意 Host 拒绝、无 token 401。

## B6 打码 token 不得回写
- `lib/config.js` 增加 `looksMasked(v)` 与 `sanitizeConfigSet(set)`：`token`、`peers[].token` 为打码串/空串时从 set 移除（表示“不修改”）。
- `engine.updateSettings`、admin PUT、CLI `config set` 全部经过 sanitize。
- `lib/admin-html.js`：页面加载后保存配置不得把打码 token 写成真实值；token 修改走显式输入（留空=不修改）。新增端到端测试：加载→只改 intervalSec→保存→token/peers token 保持原值（服务仍 200）。

## B7 凭据统一脱敏
- `maskToken`：短 token（≤12）整体打码，不保留字符；长 token 最多保留前 4 位。
- `publicSettings` 必须同时打码 `peers[].token`。
- CLI `status`、`config get`、管理端 status/config 的输出一律打码；stderr/stdout 不得出现完整 token。
- 测试：CLI stdout、admin API 响应断言不包含完整 token（短 token 亦不包含）。

## NIT
- N1 `bin/dsh-sync.mjs update apply` 不带 `--version`：先 checkUpdate，取 latest 再 apply（无更新则提示已最新）。
- N2 同 B5 timingSafeEqual。
- N3 `checkUpdate` 返回 `latestTag`（保留原始 tag，可能无 `v` 前缀）；`applyUpdate` 接受 `tag` 参数，下载 URL 用 `tag`（缺省 `v${version}`），测试无 v 前缀 tag 可正常下载。

## 验收（PM）
1. `node --check` 全部；
2. 既有 10 套 + 新增/修改用例全绿；
3. 真实 tarball 端到端（临时目录）仍成功；
4. 不引入宿主文件写、不写 profile；`grep` 确认管理路由有 Host/Origin/Content-Type/token 校验；
5. 更新 FIX-REPORT 增补 v1.4.1 安全修复章节。
