# FEATURE-SPEC v1.4.0：插件自更新 + 配置命令/本地管理页（不依赖 DSH Agent）

## 目标

把这几个操作变成插件自带能力，用户不需要通过 DSH 对话/Agent：

1. **自更新**：检查 GitHub 最新 tag → 下载 tarball → 校验 → 备份后替换插件安装目录 → 标记「待重启生效」。
2. **配置命令**：插件自带 CLI（`bin/dsh-sync.mjs`）管理 config（status / config get、set、add-peer、remove-peer、set-token、set-remap / sync / update check、apply / token gen）。
3. **本地管理页**：`GET /admin` 返回一个极简 HTML 页（中文），可查看状态、编辑配置、立即同步、检查/应用更新；后台用 `/v1/admin/*` JSON API。

## 安全边界（必须遵守）

- 管理页/管理 API **只能从本机回环访问**（`127.0.0.1` / `::1`），且仍需 `x-dsh-sync-token`；否则 403/401。
- 更新只动**插件自身安装目录**（含 package.json 且 name 匹配 `dsh-plugin-sync`）与 `dataDir/updates/`；绝不碰 `~/.dsh/storages/`、profile 的 package.json/cordis.patch.yml、用户数据。
- 更新前必须备份旧文件到 `dataDir/updates/backup-<old>-<ts>/`；写入用「临时文件 + rename」；失败可回滚。
- 下载有上限（≤20MB）与超时（30s）；tar 解包必须拒绝绝对路径、`..`、符号链接。
- 校验下载包：`package.json` 的 `name` 必须等于 `dsh-plugin-sync`，`version` 必须等于目标版本。
- 更新后不自动重启进程（插件无法安全重启宿主），返回 `restartRequired: true`；状态页/CLI 明确提示重启 DSH。若检测到 DSH 已重启并加载了新版本，清除「待重启」标记。

## 实现清单

### U1 `lib/update.js`（零依赖，node: 内置）
```js
export async function checkUpdate({ repo, currentVersion, fetchImpl?, timeoutMs = 10000 })
// GET https://api.github.com/repos/<repo>/releases/latest
// 兼容: latest 404 时回退 GET /tags 取最大 semver tag
// 返回 { current, latest, available, notesUrl, error? }
export async function applyUpdate({ repo, version, installRoot, dataDir, log, fetchImpl? })
// 1) 校验 version 合法 semver 且高于 installed? （允许强制指定，但 CLI 需 --force）
// 2) 下载 https://codeload.github.com/<repo>/tar.gz/refs/tags/v<version>（或 archive URL）
//    - 大小上限 20MB，30s 超时，流式写入 dataDir/updates/download-<version>.tgz
// 3) 安全解包到 dataDir/updates/extract-<version>/（node:zlib gunzip + 手写 tar 解析；拒绝非普通文件/绝对路径/..）
// 4) 定位顶层目录，校验 package.json name/version
// 5) 备份当前安装目录白名单文件到 backup-<old>-<ts>/
// 6) 原子替换白名单文件：index.js、lib/、hub.mjs、bin/、cordis.patch.yml、package.json、locale/、icon.svg、README.md
//    （不删除安装目录里的 .git、node_modules、数据文件）
// 7) 写 dataDir/updates/state.json = { pendingVersion, appliedAt, fromVersion, restartRequired: true }
// 返回 { applied, fromVersion, toVersion, restartRequired, backupDir, error? }
export async function readUpdateState({ dataDir })
export async function clearPending({ dataDir })   // 当运行版本 == pendingVersion 时
```
- 下载/解包/校验任何一步失败：清理临时文件，返回结构化 `{ applied:false, error }`，不改安装目录。
- 替换阶段任何一步失败：用备份回滚已替换文件，返回 error。

### U2 HTTP 管理端（`lib/server.js` + `lib/engine.js`）
新增路由（全部要求 loopback + token，否则 401/403）：
- `GET /admin` → 内联中文 HTML（无外部依赖，单文件；含状态区、配置表单、按钮：保存配置、立即同步、检查更新、应用更新；token 存 localStorage）。
- `GET /v1/admin/status` → `engine.status()` 的结果（含 updateState）。
- `GET /v1/admin/config` → 与 `dsh_sync_config` 相同（token 打码）。
- `PUT /v1/admin/config` → body 为 `{set:{...}}`，调用 `engine.updateSettings`，返回 `{settings, needRestart}`。
- `POST /v1/admin/sync` → 异步触发一轮 `runCycle`（不阻塞 HTTP），返回 `{started:true}`；若已在跑返回 `{started:false, reason:'inFlight'}`。
- `GET /v1/admin/update/check` → `checkUpdate` 结果。
- `POST /v1/admin/update/apply` → body `{version?, force?}`；默认最新版本；返回 applyUpdate 结果。
- 失败的 JSON：`{error}` + 对应状态码；所有响应 `cache-control: no-store`。

### U3 CLI `bin/dsh-sync.mjs`（可执行，`#!/usr/bin/env node`）
零依赖；自动定位：`pluginRoot = 本文件上一级目录`，`dataDir = process.env.DSH_SYNC_HOME || ~/.dsh/plugin-sync`。
通过读取 `dataDir/config.json` 获取 token/port；优先调用运行中的管理 API（`http://127.0.0.1:<port>/v1/admin/*`），服务不可用时回退为直接读写 config.json 并提示「需重载/重启生效」。
命令：
```
dsh-sync status
dsh-sync config get [key]
dsh-sync config set '<json>'            # 深合并
dsh-sync config add-peer <name> <url> [token]
dsh-sync config remove-peer <name>
dsh-sync config set-token [token]       # 省略则生成随机 token
dsh-sync config set-remap '<from>' '<to>'
dsh-sync config remove-remap <index>
dsh-sync sync
dsh-sync update check
dsh-sync update apply [--version vX.Y.Z] [--force]
dsh-sync version
dsh-sync help
```
- 输出人类可读；错误退出码非 0 并打印原因。
- 不依赖 DSH 进程是否运行；不写 `~/.dsh/storages/`。

### U4 配置项与状态
- config 新增：`repo: "chaos-zhou/dsh-plugin-sync"`、`updateCheck: false`（true 时每 24h 自动检查并在 status 显示）、`autoApplyUpdate: false`（默认不自动替换）。
- `dsh_sync_status` 增加：`installedVersion`、`update:{latest, available, pendingVersion, restartRequired, checkedAt, error}`。

### U5 测试（必须新增并通过）
1. `tests/update.test.mjs`（mock fetchImpl + 临时目录）：
   - checkUpdate：releases 正常、404 回退 tags、无更新、网络错误；
   - applyUpdate：正常替换（白名单文件更新、.git/数据文件不动）、包名/版本不匹配拒绝、tar 含 `..`/绝对路径/符号链接拒绝、下载超限拒绝、替换中途失败回滚、备份存在且可还原；
   - pending 状态写入与 clearPending。
2. `tests/admin.test.mjs`（真实 http server + 临时 dataDir/installRoot）：
   - `/admin` 返回 200 HTML（含关键中文文案）；
   - 非 loopback 来源 → 403（用伪造 remoteAddress 或绑定测试地址模拟），无 token → 401；
   - `GET/PUT /v1/admin/config`、`POST /v1/admin/sync`、`update/check`（mock fetch）、`update/apply`（mock 下载）行为；
   - 所有响应 `cache-control: no-store`。
3. CLI 冒烟（node 子进程执行 `bin/dsh-sync.mjs`）：`version`、`config get`、`config set`（临时 DSH_SYNC_HOME）、`status`；断言退出码与输出。
4. 既有 7 套测试保持全绿。

### U6 文档与版本
- README 新增「更新插件」与「配置命令 / 本地管理页」两节（含 CLI 示例、管理页安全说明、重启生效说明）。
- FIX-REPORT 增补 v1.4.0。
- `package.json` → `1.4.0`，`files` 增加 `bin/`；新增 `bin: { "dsh-sync": "bin/dsh-sync.mjs" }`。

## 验收（PM）
1. `node --check` 全部；
2. 7 套既有 + update/admin/CLI 新测试全部 exit 0；
3. grep：管理 API 全部有 loopback+token 校验；更新路径不写宿主 storages；
4. Codex 审核无 BLOCKER 后：合并 main、tag `v1.4.0`、推送 GitHub、重载插件；
5. 线上验证：`curl /v1/ping`、`curl -H token http://127.0.0.1:8789/v1/admin/status`、管理页可打开、CLI `status` 可用、`update check` 返回当前版本。
