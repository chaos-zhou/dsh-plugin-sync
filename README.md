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

两台设备互为 peer：每轮同步会导出本地数据 → 推给对方 → 拉取对方的新数据 → 校验并落回；工作区写入方式及会话冲突处理见下文。

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
| `applyConfig` | `false` | 暂停配置自动落回；即使设置为 `true` 也只记警告，配置仍可导出 |
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
- 单 blob 和服务端请求体上限 200MiB，peer index 响应上限 16MiB、最多 100000 条；超限拒收并计入 cycle 的 `errors`。客户端超时覆盖整个响应体读取。所有响应带 `cache-control: no-store`。

## 同步什么、不同步什么

**同步**（从 `<dshHome>` 导出到 `plugin-sync/staging/`，再落到对端 `<dshHome>`）：

| 数据 | 源 | staging 位置 |
|---|---|---|
| 会话 | `sessions/<cwdDir>/<sid>/session.v4.jsonl.zstd(或 .zst)` | 同名路径 |
| 附件 | `attachments/**` | 同名路径 |
| 摘要缓存 | `storages/session_projcache/sessions/*.json` | `projcache/sessions/*.json` |
| 插件配置 | `profiles/*/cordis.patch.yml` | `config/<profile>/cordis.patch.yml`（保留导出，暂停自动写回） |
| 工作区索引 | 宿主 `workspace` domain；降级时只读参考 `storages/workspace.json` | `workspace/workspace.json`（无损合并，经 domain 应用或生成建议） |

**从不传输**：`plugin-sync/`（自身数据）、`node_modules/`、`electron/`、`speech-to-text/`、`cache/`、`llm-deepseek/`、`.credentials.yaml`、`.anonymous-user-id`、所有 `*.lock` 文件。所有落盘都先写 `*.tmp-<pid>` 再原子 rename，对端不会读到半个文件。

## 冲突与“同一会话只在一台继续”

工作区索引总是**合并**（workspaceIds / sessionIds 保序并集，title/path 取 `updatedAt` 较新一端），因此两台设备的会话列表会汇合成同一个全集。

但**会话内容本身不做合并**。落回规则：

- 对端有、本地没有且无未解决冲突 → 校验后复制过来；
- 无基线且内容不同（包括 `state.json` 缺失或损坏）→ 保留本地，对端存冲突副本；接收时间不参与新旧判断；
- 本地改了、对端没改 → 保留本地（下轮自动推给对方）；
- 对端改了、本地没改 → 采用对端；
- **两端都改了同一会话** → 保留本地，对端版本存入 `<dshHome>/plugin-sync/conflicts/`（文件名含路径与设备名、时间戳）并在日志 warn。
- 冲突记录保存到 `state.json` 的 `unresolvedConflict`，包含会话 id 及两侧哈希。后续周期、重启以及远端再次修改都不能自动覆盖；确认两侧内容一致后清除记录，或手工解决后清除对应记录。

会话落回前检查哈希、完整 zstd 帧，以 `node:zlib` 有界解压（输出最多 200MiB）并逐行解析 JSONL。坏帧、坏 JSONL 或运行时没有 zstd 解压能力时，都保存冲突副本、记录 error 并跳过，保留本地。Node 20 可运行插件，但通常没有原生 zstd 解压能力；会话自动落回需要提供该能力的 Node 版本。摘要缓存必须通过 JSON 解析，并落回 `storages/session_projcache/sessions/`。

因此强烈建议遵守约束：**同一个会话只在一台设备上继续**。在 A 上打开过的会话，切到 B 前先等一轮同步完成（或调 `dsh_sync_now`）。如果确实两边都写了，去 `plugin-sync/conflicts/` 找回另一边的版本，手工取舍。

## 工作区索引写入模式

第三轮修复（v1.1 方案）取消插件对宿主 `storages/workspace.json` 的直接写入。文件备份、恢复、rename 和写入冻结逻辑全部移除：插件侧文件事务无法与宿主的并发写入共用队列，回滚还可能覆盖宿主的新数据。

| 模式 | 读取与写入 | 状态 |
|---|---|---|
| `domain`（服务可用时默认） | 可选注入 `storageDomain`，通过 `ctx.storageDomain.get('workspace')` 取得已打开句柄，读取 `global.get()` 和 `table('workspaces').entries()`；只对变化/新增条目调用 `put`，最后在 global 有变化时调用 `global.set`。宿主负责排队、校验与持久化。 | `workspaceWriteMode: 'domain'` |
| `proposal`（服务或 domain 缺失） | 有界只读宿主文件作为参考，把合并结果原子写入 `<dataDir>/proposed/workspace.json`；绝不写宿主文件。会话、附件、摘要缓存仍按各自规则自动同步；工作区索引需等宿主 API 可用，或手动处理建议。 | `workspaceWriteMode: 'proposal'`、`proposalPending: true`、`proposalPath`，本轮 `warnings` 提示待应用建议 |

`dataDir` 为 `<dshHome>/plugin-sync`。`dsh_sync_status` 及同步摘要都展示写入模式和建议状态；建议持续保留，待 domain 成功应用后清除。任一 `put/set` 抛错，错误进入 `cycle.errors`，本轮停止后续 domain 写，已成功的单条写入保留，不回滚。

两种模式使用相同规则：

- **无损合并**：保留本地递归键集、`global.initialized` 和未知字段；未知对象同名值保留本地，远端只补缺；`__proto__`、`constructor` 等键按自有键安全处理。`workspaceIds` / `sessionIds` 保序并集，title/path 按 `updatedAt` 选择。
- **写前校验**：完整 v2 信封、必需字段、`workspaceIds` 属于结果表以及 default 引用完整。远端坏条目跳过并记录 error，对应索引过滤；缺失字段可由合法本地补齐。本地缺失时仅接受完整合法远端。解析失败、I/O 故障、版本不符或合并结果非法均拒写。
- **容量边界**：每个工作区输入与合并产物最多 32MiB；workspace 表、workspaceIds 和各 sessionIds 数组最多 100000 条。输入或结果超限都报错并拒写，包含 domain 和 proposal 路径，不再截断后写入。

升级后先查看 `dsh_sync_status` 确认模式。旧宿主若未提供服务会进入 proposal；无需手工赋予插件宿主文件写权限。宿主事务是逐条一致的，不承诺整轮合并原子提交；中途失败后下一轮从实际 domain 状态继续。旧版插件产生的备份不会被新代码自动恢复或清理。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `dsh_sync_status` | 无 | 设备、监听地址/端口、peers、会话数量、写入模式、建议状态/路径、冲突数、最近一轮结果及下次运行时间 |
| `dsh_sync_now` | 无 | 立即同步，返回计数、`workspaceWriteMode`、`proposalPending` / `proposalPath`、`errors[]` 和 `warnings[]` |
| `dsh_sync_config` | `{set?}` | 无 `set` 返回当前设置（token 打码）；有 `set` 深合并写入 `config.json`，返回 `{settings, needRestart}` |

## 日志与排查

- 追加日志：`<dshHome>/plugin-sync/logs/sync.log`，超过 2MB 轮转为 `sync.log.1`。
- 单个 peer 失败不影响其他 peer，错误会进本轮摘要的 `errors[]` 并写日志；整个 cycle 的任何异常都被捕获，不会抛到宿主。
- 常见问题：
  - **连不上**：确认双方 token 一致、`listenPort` 没被防火墙拦截、`peers[].url` 用对方的局域网 IP；
  - **401**：token 不匹配（注意 hub 与客户端要用同一个 token）；
  - **文件一直不同步**：看 mtime 是否仍在新写入（`settleSec` 安静期未过）；DSH 的 flock 锁不影响同步——只看 mtime，不看锁；
  - **端口被占**：改 `listenPort`，或设为 `0` 用随机端口（在 `dsh_sync_status` 里看实际端口）。
- 状态基线在 `plugin-sync/state.json`（localHashes / remoteHashes / declined / unresolvedConflict / pushed）。先处理 `conflicts/` 的副本再清除对应冲突记录；删掉整个 state 会丢失基线，下次内容不同仍会走无基线冲突保护。

## 测试

```bash
node tests/engine.test.mjs        # 端到端同步：初始同步、工作区并集、冲突、幂等零流量
node tests/workspace.compat.test.mjs  # mock domain事务、无损合并、校验/容量拒写、proposal只读宿主
node tests/apply.compat.test.mjs      # 跨周期冲突保护、坏zstd/JSONL、缓存校验、配置拒绝自动落回
node tests/engine.offline.test.mjs    # 沙箱补充：真实文件与周期，内存 fetch 响应，不能代替 HTTP 验收
node tests/fixture.accept.test.mjs    # 读取 /tmp/dsh-sync-accept 两份事故 fixture，在仓库临时目录合并
```

各测试成功均输出 `ALL PASS`；HTTP 测试需要允许本机端口监听。

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
