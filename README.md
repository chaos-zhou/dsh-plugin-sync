# dsh-plugin-sync

DSH 多端同步插件：在两台（或多台）安装了 DSH 的设备之间同步**会话、附件、摘要缓存、工作区索引**，可选同步插件配置。局域网内点对点直连，或经一台 hub 服务器中转。**零依赖**，只使用 Node 内置模块（Node >= 20），复制目录即可安装。

## 安装

### 本机（第一台设备）

1. 把整个 `dsh-plugin-sync` 目录放进 DSH 的插件目录（bundle）。
2. 在 DSH 配置（`cordis.patch.yml`）里为插件填字段，至少要有：
   - `deviceName`：本设备名，如 `desktop`；
   - `token`：一个足够长的随机字符串（**必须设置**，见下文安全说明）；
   - `listenPort`：本机监听端口，默认 `8789`；
   - `dshHome`：DSH 数据目录；留空则用环境变量 `DSH_HOME`，再退回 `~/.dsh`。
3. 重启 DSH。插件会监听 HTTP 服务，并把配置播种到 `<dshHome>/plugin-sync/config.json`。

### 另一台设备

1. 同样复制插件目录并安装。
2. 填上**不同的 `deviceName`**、**相同的 `token`**，并把对方加进 `peers`：

```yaml
- insert:
    - id: dsh-plugin-sync
      config:
        deviceName: 'laptop'          # 与第一台不同
        token: '<与第一台相同的随机串>'
        listenPort: 8789
        peers:
          - name: 'desktop'
            url: 'http://192.168.1.5:8789'   # 第一台设备的局域网地址
            token: '<相同的 token>'
```

3. 重启 DSH。默认每 300 秒自动同步一轮；也可在会话里让模型调用 `dsh_sync_now` 立即同步。

两台设备互为 peer：每轮同步会导出本地数据 → 推给对方 → 拉取对方的新数据 → 落回本地，之后双方数据一致。

## 配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `deviceName` | 主机名 | 本设备在同步中的名字 |
| `role` | `peer` | 节点角色（写入 ping 响应与摘要） |
| `listenPort` | `8789` | HTTP 监听端口；`0` = 随机端口（实际端口见 `dsh_sync_status`） |
| `bindHost` | `0.0.0.0` | 监听绑定地址；**token 为空时强制 `127.0.0.1`** |
| `token` | `''` | 同步鉴权 token，所有请求头 `x-dsh-sync-token` 必须相等 |
| `peers` | `[]` | 对端列表 `{name, url, token}`；token 省略时用全局 `token` |
| `hubUrl` | `''` | hub 服务器地址；非空时 hub 作为一个额外 peer（token 用全局 `token`） |
| `intervalSec` | `300` | 自动同步间隔（秒），首轮延迟 10 秒 |
| `settleSec` | `120` | 文件“安静期”：会话/摘要缓存 mtime 距今超过该秒数才导出，避免同步正在写入的文件 |
| `dshHome` | `~/.dsh` | DSH 数据目录 |
| `pathRemap` | `[]` | 工作区路径映射 `[{from, to}]`（字符串替换），用于把远端工作区路径翻译成本机路径 |
| `applyConfig` | `false` | 是否把远端的 `config/<profile>/cordis.patch.yml` 写回本机 `profiles/<profile>/` |
| `autoApply` | `true` | 保留字段（落回行为由 apply 规则控制） |

配置持久化在 `<dshHome>/plugin-sync/config.json`；可用 `dsh_sync_config` 工具在线修改（`listenPort`/`role`/`bindHost` 变更需要重启，其余字段下一轮自动生效）。

## 三种拓扑

### 1. 局域网直连（推荐）

两台设备互为 peer（见上文安装步骤）。功能最完整：双向推拉、冲突双方各留副本。

### 2. hub 中转

在任一台设备（或一台普通服务器）上运行独立 hub，不需要 DSH：

```bash
node hub.mjs --port 8790 --token <TOKEN> --data ~/.dsh-sync-hub --bind 0.0.0.0
```

客户端把 hub 当成一个 peer：

```yaml
config:
  token: '<TOKEN>'
  hubUrl: 'http://192.168.1.9:8790'
```

hub 只做字节中转（`/v1/ping`、`/v1/index`、`/v1/blob`），不解析 DSH 数据；它在 `<data>/manifest.json` 里维护 `rel → {sha1,size,mtime}` 索引。注意：hub 是“最后写入者可见”的简单中转，两端同时修改同一会话时不会生成冲突副本，请尽量用局域网直连拓扑同步重要会话。hub 会打印本机所有可用的监听地址；SIGINT/SIGTERM 优雅关闭。

### 3. 单机自测

不配置 `peers` 和 `hubUrl` 也可以运行：插件照常导出到 `plugin-sync/staging/`、执行工作区合并与落回，只是不联网。也可以用两个不同的 `dshHome` 在同一台机器上互指 peers 来验证整套流程（仓库内 `node tests/engine.test.mjs` 就是这么测的）。

## 安全说明

- **token 必填**：除 `/v1/ping` 外所有接口都校验 `x-dsh-sync-token`。token 为空时服务**只绑定 `127.0.0.1`** 并在日志警告——局域网设备无法连入，但仍可在本机自测。
- 请生成足够长的随机 token（例如 `openssl rand -hex 24`），并只写在本机配置文件里；`dsh_sync_status` / `dsh_sync_config` 返回的 token 一律打码（前 6 位 + `******`）。
- 会话与附件可能包含敏感内容，请只在可信网络内同步；跨公网使用请自建隧道（如 WireGuard/SSH 隧道）后再指向 hub。
- 请求体上限 200MB，所有响应带 `cache-control: no-store`。

## 同步什么、不同步什么

**同步**（从 `<dshHome>` 导出到 `plugin-sync/staging/`，再落到对端 `<dshHome>`）：

| 数据 | 源 | staging 位置 |
|---|---|---|
| 会话 | `sessions/<cwdDir>/<sid>/session.v4.jsonl.zstd(或 .zst)` | 同名路径 |
| 附件 | `attachments/**` | 同名路径 |
| 摘要缓存 | `storages/session_projcache/sessions/*.json` | `projcache/sessions/*.json` |
| 插件配置 | `profiles/*/cordis.patch.yml` | `config/<profile>/cordis.patch.yml`（默认不写回，需 `applyConfig: true`） |
| 工作区索引 | `storages/workspace.json` | `workspace/workspace.json`（只做三方合并，永不整文件覆盖） |

**从不传输**：`plugin-sync/`（自身数据）、`node_modules/`、`electron/`、`speech-to-text/`、`cache/`、`llm-deepseek/`、`.credentials.yaml`、`.anonymous-user-id`、所有 `*.lock` 文件。所有落盘都先写 `*.tmp-<pid>` 再原子 rename，对端不会读到半个文件。

## 冲突与“同一会话只在一台继续”

工作区索引总是**合并**（workspaceIds / sessionIds 保序并集，title/path 取 `updatedAt` 较新一端），因此两台设备的会话列表会汇合成同一个全集。

但**会话内容本身不做合并**。落回规则：

- 对端有、本地没有 → 复制过来；
- 本地改了、对端没改 → 保留本地（下轮自动推给对方）；
- 对端改了、本地没改 → 采用对端；
- **两端都改了同一会话** → 保留本地，对端版本存入 `<dshHome>/plugin-sync/conflicts/`（文件名含路径与设备名、时间戳）并在日志 warn。

因此强烈建议遵守约束：**同一个会话只在一台设备上继续**。在 A 上打开过的会话，切到 B 前先等一轮同步完成（或调 `dsh_sync_now`）。如果确实两边都写了，去 `plugin-sync/conflicts/` 找回另一边的版本，手工取舍。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `dsh_sync_status` | 无 | 设备、监听地址/端口、peers、会话数量（local/staged）、冲突数、`lastRun`/`lastResult`/`nextRun`、是否同步中 |
| `dsh_sync_now` | 无 | 立即执行一轮同步，返回本轮摘要 `{exported, pulled, pushed, applied, conflicts, merged, errors[]}` |
| `dsh_sync_config` | `{set?}` | 无 `set` 返回当前设置（token 打码）；有 `set` 深合并写入 `config.json`，返回 `{settings, needRestart}` |

## 日志与排查

- 追加日志：`<dshHome>/plugin-sync/logs/sync.log`，超过 2MB 轮转为 `sync.log.1`。
- 单个 peer 失败不影响其他 peer，错误会进本轮摘要的 `errors[]` 并写日志；整个 cycle 的任何异常都被捕获，不会抛到宿主。
- 常见问题：
  - **连不上**：确认双方 token 一致、`listenPort` 没被防火墙拦截、`peers[].url` 用对方的局域网 IP；
  - **401**：token 不匹配（注意 hub 与客户端要用同一个 token）；
  - **文件一直不同步**：看 mtime 是否仍在新写入（`settleSec` 安静期未过）；DSH 的 flock 锁不影响同步——只看 mtime，不看锁；
  - **端口被占**：改 `listenPort`，或设为 `0` 用随机端口（在 `dsh_sync_status` 里看实际端口）。
- 状态基线在 `plugin-sync/state.json`（localHashes / remoteHashes / declined / pushed）；手工删掉它会让插件重新建立基线。

## 测试

```bash
node tests/engine.test.mjs
```

用两个临时 `dshHome` 起两个 engine（互为 peer），覆盖初始同步、工作区并集、两端同改冲突、幂等零流量四类场景，成功输出 `ALL PASS`。

## 通过 Plugin Manager 安装（推荐，不要手动改 profile 文件）

本包是标准 bundle，安装时会自动进 profile 层栈：

- 在 DSH 会话里让 Agent 执行：`plugin_manager` → `install_bundle`，`target` 填**本目录绝对路径**；
- 或命令行：`dsh plugin --profile desktop add /path/to/dsh-plugin-sync`，然后在 DSH 的「插件管理」里启用 `dsh-plugin-sync` 这一行；
- 安装后不用重启即可通过 HMR 激活；替换已安装版本时按提示重启 DSH 载入新的 JavaScript 代际。

装好后在会话里直接用三个工具：

- `dsh_sync_status`：看状态（设备、端口、peers、会话数、最近一轮结果）
- `dsh_sync_now`：立刻同步一轮
- `dsh_sync_config`：在线改配置（例如 `{"deviceName":"laptop","token":"…","peers":[{"name":"desktop","url":"http://192.168.1.10:8789","token":"…"}]}`）

## 发布到 GitHub / 插件市场

见 [docs/PUBLISHING.md](docs/PUBLISHING.md)：仓库初始化、`package.json` 需要补的字段、`npm pack` 检查、版本与 tag、市场提交前自检清单。
