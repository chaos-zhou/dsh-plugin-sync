# 开发规格：dsh-plugin-sync（DSH 多端同步插件）

## 目标

在 `/home/user/Documents/deepseek-harness/default-workspace/dsh-plugin-sync` 实现一个 **DSH Host-only 插件（bundle）**，让两台安装 DSH 的设备同步会话/附件/工作区索引：

- **局域网直连**：双方各自监听端口，互为 peer，双向拉取/推送。
- **hub 中转**：任一台设备（或一台普通服务器）跑 `hub.mjs`，客户端把 hub 当成一个 peer。
- **零依赖**：只用 Node 内置模块，任何机器复制目录即可安装。

## 重要：已存在文件，不要修改

`package.json`、`cordis.patch.yml`、`locale/en.json`、`locale/zh.json`、`icon.svg`、`SPEC.md`。
你只写：`index.js`、`lib/*.js`（可自行拆分）、`hub.mjs`、`tests/engine.test.mjs`、`README.md`。

## Host 插件契约（已核实，必须照做）

`index.js` 必须是下面这种形式，**不得 import 任何 npm 包（包括 `@deepseek-ai/*`）**，只用 `node:*` 内置模块：

```js
export const inject = ['tools']

export function apply(ctx, config) {
  // 所有注册都用 ctx.effect，返回清理函数；插件卸载时必须停掉 interval / HTTP server / 文件句柄
}
```

- 工具注册用**原始对象**（不要 import `defineTool`）：
  ```js
  ctx.effect(() => ctx.tools.register({
    name: 'dsh_sync_status',
    description: '...',
    parameters: { /* 字段名 → { type, description }，没有参数就是 {} */ },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => (/* 可 JSON 序列化的值 */),
  }))
  ```
  注意 `parameters` 是「字段名 → 字段描述」对象（不是 JSON Schema 的 `properties` 包装）；`render` 返回 ContentBlock 数组，文本块是 `{ type: 'text', text }`。
- 不要 export `Config`；配置从 `apply(ctx, config)` 的第二个参数读，并持久化到自己的 `config.json`。
- 不 `process.exit`；所有异常必须捕获并写日志，不能抛到宿主；`cycle()` 任何一步失败都要返回带 `errors[]` 的摘要而不是 throw。
- Node >= 20（可用全局 `fetch`、`AbortController`、`node:crypto`、`node:http`）。

## 数据目录

```
dshHome   = config.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
dataDir   = path.join(dshHome, 'plugin-sync')
```

```
dataDir/config.json          # 持久化设置（首次从 row config 播种；工具可改）
dataDir/state.json           # { localHashes:{rel:sha1}, remoteHashes:{rel:sha1}, lastRun }
dataDir/staging/             # 同步镜像（结构与下面「导出规则」一致）
dataDir/store/blobs/<sha1前2位>/<sha1>   # 内容寻址存储（供 HTTP 提供/z接收）
dataDir/conflicts/           # 冲突副本
dataDir/logs/sync.log        # 追加日志，>2MB 轮转为 sync.log.1
```

staging 与 store 允许实现成「staging 即内容 + 现算 sha1」；只要 HTTP 能按 sha1 提供字节、落盘能按 rel 找到文件即可。

## 导出规则（DSH → staging）

| 数据 | 源路径 | staging 路径 |
|---|---|---|
| 会话 | `<dshHome>/sessions/<cwdDir>/<sid>/session.v4.jsonl.zstd`（或 `.zst`） | `sessions/<cwdDir>/<sid>/<同名文件>` |
| 附件 | `<dshHome>/attachments/**` | `attachments/**` |
| 摘要缓存 | `<dshHome>/storages/session_projcache/sessions/*.json` | `projcache/sessions/*.json` |
| 插件配置 | `<dshHome>/profiles/*/cordis.patch.yml` | `config/<profile>/cordis.patch.yml` |
| 工作区索引 | `<dshHome>/storages/workspace.json` | `workspace/workspace.json` |

- 会话/摘要缓存只在**文件 mtime 距现在 > settleSec（默认 120 秒）**时复制；**不要看 `*.lock`**（DSH 会长期持有 flock，锁在但文件已安静时必须照常同步）。
- 所有写入用「写 `xxx.tmp-<pid>` 再 `rename`」，避免对端读到半个文件。
- 不复制：`plugin-sync/` 自身、`node_modules`、`electron/`、`speech-to-text/`、`cache/`、`llm-deepseek/`、`.credentials.yaml`、`.anonymous-user-id`、`*.lock`。

## 工作区合并规则

`workspace.json` 结构：`{unit, global:{workspaceIds, archivedSessionIds, pinnedSessionIds, defaultWorkspaceId}, tables:{workspaces:{id:{path,title,sessionIds,createdAt,updatedAt}}}}`

- `workspaceIds` 保序并集（本地顺序在前，补上远端独有的）；workspace 表里出现但不在列表里的 id 也补进去。
- 每个 workspace 的 `sessionIds` 保序并集；`archivedSessionIds`、`pinnedSessionIds` 并集。
- 同一 workspace：`title`/`path` 取 `updatedAt` 较新的一端；`createdAt` 取最早；`updatedAt` 取最晚。
- 远端 workspace 的 `path` 先过 `pathRemap`（`[{from,to}]`，字符串替换）。
- 合并结果**同时**写回本地 `<dshHome>/storages/workspace.json` 与 `staging/workspace/workspace.json`。
- 任一侧缺这个文件时以另一侧为准（做一份默认空结构兜底）。

## 落回规则（staging → DSH）

- 会话：staging 有、本地无 → 复制；sha1 不同时按 `state.json` 的基线判断：
  - 只有远端变 → 覆盖本地；
  - 只有本地变 → 保留本地（下轮 export 自然推上去）；
  - 两端都变 → **保留本地**，远端版本存 `conflicts/<rel 路径把 / 换成 __>.conflict-<deviceName>-<时间戳>`，日志 warn；
  - 本地文件 mtime 距今 < settleSec → 本轮跳过；
  - 首次同步（两侧都没有基线）：远端 mtime 更新则采用远端，否则保留本地并存冲突副本。
- 附件/摘要缓存：本地不存在或远端更新则复制。
- 工作区：只走合并，不覆盖。
- `applyConfig`（默认 false）为 true 时才把 `staging/config/<profile>/cordis.patch.yml` 写回 `profiles/<profile>/`。

## HTTP 协议（node:http）

服务端（每个节点都启，包括 hub）：

- 监听 `config.listenPort`（默认 8789；`0` = 随机端口，启动后把实际端口写进 status）。
- 绑定地址：`config.bindHost`（默认 `0.0.0.0`），但 **token 为空时强制只绑 `127.0.0.1`** 并在日志警告。
- 鉴权：除 `/v1/ping` 外都要求请求头 `x-dsh-sync-token` 与 token 相等，否则 401。
- 端点：
  - `GET /v1/ping` → `{ok:true, device, role, version}`（免鉴权）
  - `GET /v1/index` → `{version:1, device, updatedAt, files:{rel:{sha1,size,mtime}}}`
  - `GET /v1/blob/<sha1>` → 字节流（`application/octet-stream`）
  - `PUT /v1/blob/<sha1>`，可选头 `x-dsh-sync-path: <rel>` → 校验 body 的 sha1 与路径一致后存入 store；不一致 400
  - 未知路径 404；JSON 错误 `{error}`。
- 所有响应加 `cache-control: no-store`；请求体上限 200MB。

客户端一轮 `cycle()`：

1. 防重入（内存标记 + 若上一轮未完成直接返回 `{skipped:true}`）。
2. export（导出规则）。
3. 工作区合并（本地 ↔ staging）。
4. 对每个 peer（`config.peers: [{name,url,token}]`；`config.hubUrl` 非空时也当作一个 peer，token 用 `config.token`）：
   - `GET /v1/index`；
   - 拉：远端有、staging 没有对应 sha1 → `GET /v1/blob/<sha1>` → 原子写入 `staging/<rel>`；
   - 推：staging 有、远端 index 没有该 sha1 → `PUT /v1/blob/<sha1>` 带 `x-dsh-sync-path`；
   - 若拉到的文件包含 `workspace/workspace.json` → 合并（写回本地+staging）。
   - 单个 peer 失败只记入 `errors[]`，不影响其他 peer。
5. apply（落回规则）。
6. 写 state.json，返回摘要：
   `{device, role, peers:[name...], exported, pulled, pushed, applied, conflicts, merged, errors:[...], at}`

## 定时

- `apply` 里注册 interval（`config.intervalSec`，默认 300），首轮延迟 10 秒；上一轮未结束则跳过本轮。
- status 里含 `lastRun`、`lastResult`、`nextRun`（估算）。

## 工具（3 个）

1. `dsh_sync_status`：无参数。返回 `{device, role, dshHome, dataDir, listenHost, listenPort, token: '******'（前 6 位+省略）, peers, hubUrl, intervalSec, settleSec, sessions:{local,staged}, conflicts, lastRun, lastResult, inFlight}`。
2. `dsh_sync_now`：无参数。同步执行一轮 `cycle()`，返回本轮摘要。
3. `dsh_sync_config`：参数 `{ set?: object }`。无 `set` → 返回当前设置（token 打码）；有 `set` → 深合并写入 `config.json`，返回 `{settings（token 打码）, needRestart}`；`listenPort`/`role`/`bindHost` 变化时 `needRestart:true`（其余字段下一轮自动生效）。

## hub.mjs（独立服务器，不需要 DSH）

```
node hub.mjs --port 8790 --token <TOKEN> --data <DIR> [--bind 0.0.0.0]
```

- 复用 `lib/` 的 store 与 HTTP 服务端；只提供 `/v1/ping`、`/v1/index`、`/v1/blob` GET/PUT，**不做 DSH 数据导入导出**。
- hub 维护 `dataDir/manifest.json`：`{rel: {sha1,size,mtime}}`，从 `x-dsh-sync-path` 头记录；无该头时只存 blob 不进 index。
- SIGINT/SIGTERM 优雅关闭。
- 打印本机可用的监听地址与 token 提示。

## 测试（必须自己跑通）

`tests/engine.test.mjs`，直接 `node tests/engine.test.mjs` 可执行（用 `node:assert`，失败退出码非 0，成功打印 `ALL PASS`）：

1. 两个临时 dshHome + 两个 dataDir，起两个 engine（端口用空闲端口，例如 18091/18092），互为 peer。
2. A 里放一个已安静会话文件 + 一个附件 + workspace.json；A/B 各跑一次 cycle → B 的 dshHome 出现该会话，workspace 的 sessionIds 为并集。
3. 冲突：两端都改同一会话 → 本地版本保留，`conflicts/` 出现对端副本。
4. 幂等：再各跑一轮，`pulled/pushed` 为 0，本地文件 sha1 不变。
5. 结束关闭 server、清理临时目录。

## README.md（中文）

- 安装（本机与另一台设备）、配置字段表、三种拓扑（局域网直连 / hub 中转 / 单机自测）、安全说明（token 必填、token 为空只绑 127.0.0.1）、日志与排查、不传的内容清单、与「同一会话只在一台继续」的约束。

## 代码要求

- 纯 ESM、零依赖、无 TypeScript、无构建步骤；每个文件 `node --check <file>` 通过。
- 只写本目录内的文件，不要写系统目录或其他仓库。
- 完成后：`node tests/engine.test.mjs`，并把测试输出贴进最终回复；若失败请修到通过。
