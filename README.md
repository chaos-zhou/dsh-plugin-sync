# dsh-plugin-sync

DSH 多端同步插件：在两台（或多台）安装了 DSH 的设备之间同步**会话、附件、摘要缓存、工作区索引**，可选同步插件配置。局域网内点对点直连，或经一台 hub 服务器中转。**零依赖**，只使用 Node 内置模块（Node >= 20），复制目录即可安装。

> **v1.1 行为变化**：工作区索引不再写宿主 `storages/workspace.json`，也不再使用宿主 `storageDomain` 服务——合并结果只生成建议文件，等待宿主事务 API 或人工应用。会话/附件/摘要缓存自动同步不受影响，详见「工作区索引写入模式」。
>
> **v1.1.1 安全收口**：新增统一写防护层 `lib/safe-writer.js`，插件所有落盘路径（含日志、state、blob）都经过符号链接/边界校验；`<dshHome>/storages` 本身为符号链接时判定危险配置并拒绝一切写入。详见「路径边界防护」。
>
> **v1.1.2 安全补强**：日志追加/轮转增加硬链接防护（目标 `nlink>1` 拒绝，打开后 `fstat` 复核），日志拒绝不再静默而是计入本轮 `errors[]`；目录创建收敛到 `guardedMkdir`（`plugin-sync` 或 `storages` 被符号链接劫持时初始化零创建）；safe-writer 全部内部异常转为结构化拒绝。同时如实声明防护能力边界（`O_NOFOLLOW` 只保护最后一级、校验与 `rename` 之间存在 TOCTOU 窗口），详见「路径边界防护」。
>
> **v1.2 自动应用**：宿主提供 `ctx.workspaceRegistry` / `ctx.sessionPersistence` 事务 API 时，插件在每轮 apply 之后经该 API 把合并结果**增量应用**到本机工作区/会话列表（registry 模式）——仍然**不写任何宿主 JSON 文件**；服务不可用时自动回退 v1.1.2 的 proposal 模式。详见「自动应用（registry 模式）」。

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
| 工作区索引 | 只读参考宿主 `storages/workspace.json` | `workspace/workspace.json`（无损合并；生成建议文件，registry 可用时另经宿主事务 API 自动应用） |

**从不传输**：`plugin-sync/`（自身数据）、`node_modules/`、`electron/`、`speech-to-text/`、`cache/`、`llm-deepseek/`、`.credentials.yaml`、`.anonymous-user-id`、所有 `*.lock` 文件。已知落盘统一经 `lib/safe-writer.js`（含目录创建与日志，见「路径边界防护」）：先以 `O_CREAT|O_EXCL|O_NOFOLLOW` 创建 `.tmp-<basename>.<pid>.<rand>` 临时文件，再原子 rename 到目标，对端不会读到半个文件。

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

v1.2 起有两种模式，由宿主是否提供事务 API 自动决定（`dsh_sync_status` / `dsh_sync_now` 的 `workspaceWriteMode` 字段）：

- **registry 模式**（`workspaceWriteMode: 'registry'`）：宿主提供 `ctx.workspaceRegistry` 与 `ctx.sessionPersistence` 时，每轮 apply 之后把合并结果经宿主事务 API 增量应用到本机。**插件仍不写任何宿主 JSON 文件**——所有变更都是宿主 mutation queue 内的单条持久化操作，宿主自己落盘并发 `domain/changed` 事件。
- **proposal 模式**（`workspaceWriteMode: 'proposal'`，v1.1.2 行为）：服务不可用（宿主无 inject、服务缺失方法、注入抛错、注入清理后）时自动回退；合并结果只写建议文件，等待人工应用。

两种模式下 proposal 文件都继续生成（审计与降级后备），只是 registry 模式不再提示「待人工应用」。

**注入方式（v1.2.1 修正）**：插件经 `ctx.inject(['workspaceRegistry', 'sessionPersistence'], (injectCtx) => { … engine.setServices(...) … })` 获取服务——按 Cordis 契约，服务从**回调参数**（注入后的 Context）读取；回调返回的函数由宿主用作卸载清理，清理即 `setServices(null)` **立即**回退 proposal（无需等下一轮）。服务可用性按契约方法集判定：`workspaceRegistry` 必须同时具备 `create/resolveByPath/list/archiveSession/pinSession`，`sessionPersistence` 必须具备 `stat`；空对象或残缺服务一律视为不可用。

### 自动应用（registry 模式）

实现位于 `lib/registry-apply.js`，每轮 `cycle()` 在会话/附件落回（apply）**之后**执行——这样本轮刚同步过来的会话文件有机会被宿主识别，下一轮即可 attach。

**输入**：engine 传入的**合并产物**（含远端工作区、归档/置顶集合的并集，其中路径已完成 `pathRemap` 本地化）＋从 registry 实时读取的本机现状。每轮都重新读现状算差量，不缓存本地快照。

**零 mutation 条件（v1.2.1）**：只有「本轮合并成功（`merged:true`）且合并 `errors` 为空、产物通过 `validateWorkspaceDoc(requireEnvelope)`」才会调用任何 registry API；合并被拒、存在合并错误、产物校验失败时**一轮内零 create/attach/archive/pin/stat**（applier 入口还会防御性自检一次）。

**只使用这些宿主 API**：`workspaceRegistry.create / resolveByPath / archiveSession / pinSession`、`Workspace.attachSession`、`sessionPersistence.stat`。`lib/registry-apply.js` 内没有任何 fs 写调用（仓库 grep 自检佐证）；unarchive/unpin/insertBefore 等减序 API 一律不调用——**远端状态只加不减**；`setTitle` 不再调用（见下）。

| 步骤 | 行为 |
|---|---|
| 归档/置顶 | 远端 `archivedSessionIds` / `pinnedSessionIds` 逐条增量：宿主未识别（`stat` 缺失）→ warning 跳过下轮重试；归档活动中的会话（`WorkspaceActiveSessionError`）→ warning 跳过，**绝不 `stopActivity` 强停用户会话**；pin 已归档/不存在 → warning 跳过 |
| 工作区 | 路径（已本地化，不再二次映射）经 `fs.stat` 确认本地是真实目录（缺失/不是目录 → warning 跳过该工作区及其全部会话）；`resolveByPath` 未命中才 `create(path, title)`（目录复用，远端标题仅随新建传入） |
| 会话 | 远端 `sessionIds` 中本工作区尚没有的 id：宿主未识别 → warning 下轮重试；否则 `attachSession`（已存在不重复 attach） |
| 标题 | **既有 workspace 不跨设备同步重命名**（v1.2.1 起）：远端标题只在 `create` 新建时传入；已存在的 workspace 保持本地标题。原因：宿主 mutation queue 没有条件更新 API，任何「先比对再 setTitle」都与队列内排队的本地改名竞争、必然互相覆盖；等宿主提供条件更新 API 后再恢复跟随 |

**幂等与并发语义**：attach/archive/pin 都是宿主 mutation queue 内的单条持久化操作，重复调用应无害（已 attach 不重复、已归档/已置顶为 no-op）。全部已存在时一轮的增量为零（`registryApplied` 各计数为 0，仅 `workspaces` 表示「确认存在」的工作区数，其中 `created` 为本轮实际新建数）。单条失败记入 `registryWarnings[]`，下一轮自动重试，**不做整轮回滚**。

**跨系统路径映射（只映射一次）**：远端工作区路径在合并阶段用配置 `pathRemap: [{from, to}]` 做字符串替换（`lib/workspace.js` 的 `applyRemap`），例如 macOS 的 `/Users/x/proj` ↔ Linux 的 `/home/x/proj`；applier 直接使用合并产物中的路径，**绝不再做第二次映射**（v1.2 的二次映射曾把 `/a` 变成 `/a/local/local` 导致正确目录被跳过）。映射后本地不存在的工作区整条跳过（含其会话），不猜测、不创建目录。

**失败契约**：applier 自身不抛出——单条失败一律转 `registryWarnings[]`（前缀 `registry:`）并计入 `dsh_sync_status`；合并被拒、合并错误、产物校验失败这类「不能安全应用」的情况升级为本轮 `errors[]`/`warnings[]` 并零 mutation 跳过。状态字段：`registryAvailable`（本轮服务是否可用）、`registryApplied`（本轮增量 `{workspaces, created, sessions, archived, pinned}`）、`registryLastApplied`（最近一次成功应用摘要）、`registryWarnings`（最近一轮的警告）。

**安全约束不变**：不写宿主文件、全部文件写仍经 `lib/safe-writer.js`、proposal 持续生成。若需要回退到纯 proposal 行为，把插件 bundle 换回 v1.1.2 或在宿主侧停掉 registry 服务注入即可。

v1.1 历史设计（为何不直接写宿主 `storages/workspace.json`）：宿主 domain 只有 get/set/put/delete/update，没有事务/CAS/版本号 API。「快照 → 逐条 put → global.set」的读改写在 put 等待期间宿主一旦更新工作区/置顶，最后的 global.set 会用旧快照整体覆盖宿主新数据，插件侧无法安全修复，因此整条路径已移除（即使外部代码传入 domain 句柄，插件也只记 warning 并忽略）。v1.2 的 registry API 是宿主提供的队列化事务写，才重新接管应用。

| 项目 | 行为（proposal 模式 / registry 模式下的 proposal 副产物） |
|---|---|
| 读取 | 宿主 `storages/workspace.json` 只读（32MiB 有界三态读取）；解析失败/读取失败中止合并；缺失时按既有建议/远端继续合并（本地缺失时仅接受完整合法远端）。绝不写宿主文件 |
| 写入 | `<dataDir>/proposed/workspace.json` 与 `<dataDir>/staging/workspace/workspace.json`，经 `lib/safe-writer.js` 先写 `O_NOFOLLOW` 独占临时文件再原子 rename |
| 状态 | `workspaceWriteMode`、`proposalPending`、`proposalPath`、`proposalPathSafe`；proposal 模式下建议在每轮 `warnings[]` 提示，registry 模式下不再提示 |
**路径边界防护（v1.1.2，统一 safe-writer）**：插件的已知落盘路径（proposal、staging、日志、state.json、config.json、blob、目录创建、会话/附件/摘要缓存落回）都收敛到 `lib/safe-writer.js` 的统一防护层（仓库内有 grep 自检佐证，见 FIX-REPORT）：

1. **数据目录边界**：init 时 `assertSafeRoot(dataDir)` 校验插件数据目录本身不在宿主 `storages/` 内；若 `<dshHome>/storages` 本身是符号链接（含悬空），判定为危险配置，**拒绝一切写入与目录创建**（config 播种、日志、proposal、state 全部拒绝），错误计入 `errors[]`。
2. **目录创建（`guardedMkdir`）**：插件所有目录创建统一走 `guardedMkdir`——创建前校验最近已存在祖先的真实目录链（任何一级是符号链接即拒绝，包括 `plugin-sync` 本身被劫持），`storages` 为符号链接/悬空别名时拒绝创建（别名不会被初始化激活）；逐级创建后 `realpath` 复核仍在合法范围内。
3. **祖先链校验**：每次写入从文件系统根逐级 `lstat` 走到目标父目录，任何一级是符号链接即拒绝；缺失父目录逐级创建并在创建后 `realpath` 复核仍在 root 之内。
4. **目标文件校验**：目标已存在且是符号链接（含悬空）→ 拒绝；临时文件以 `O_CREAT|O_EXCL|O_NOFOLLOW` 创建；rename 之后 `lstat`+`realpath` 复核目标是普通文件且解析后仍位于 root 内。注意：`O_NOFOLLOW` 只保护**打开时的最后一级路径组件**，不防护父目录链。
5. **硬链接防护（v1.1.2）**：日志追加（`guardedAppend`）与轮转（`guardedRotate`）在操作前 `lstat` 拒绝 `nlink>1` 的目标（防止 `sync.log` 是宿主 `storages/workspace.json` 的硬链接时，追加/轮转直接修改宿主同一 inode）；打开后再次 `fstat` 复核 `nlink===1`，防「校验后、打开前」被替换为硬链接的窗口。
6. **本轮拒绝缓存**：同一轮 cycle 内被拒绝的写目标（含日志目标）不再重试（错误含「不再重试」），避免逐 peer 重复试探；直接调用（如测试）使用独立 round 键，修复文件系统后可重试。
7. **落回专属禁点**：`assertApplyTarget` 对会话/附件落回额外检查父级符号链接；摘要缓存合法写入 `storages/session_projcache/sessions/`，但父目录不得是符号链接、目标不得解析为 `storages/workspace.json`。

**失败契约与拒绝语义（如实）**：safe-writer 的任何内部异常（`realpath`/`lstat`/`stat` 的 EACCES/EIO/ELOOP 等）都捕获并转为结构化拒绝 `{ok:false, code, error}`，不向调用方抛出、不在失败后同轮重试；写后父目录 `realpath` 失败/无法确认边界时按**失败**返回（内容可能已落盘，以返回的错误为准）。被拒绝的目标（符号链接/硬链接/越界/危险配置）不会创建或修改文件，临时文件已清理；I/O 中途失败则可能留下已创建的目标或部分内容。写入失败计入本轮 `errors[]`；**日志与日志轮转被拒绝时不再静默**，同样计入 `errors[]`；**proposal 目标**被拒时置 `proposalPathSafe: false`，staging 副本被拒不影响该标志。

**残余风险（TOCTOU 窗口，如实声明）**：`lstat`/`realpath` 校验与最终 `rename`/追加之间存在理论竞态窗口——攻击者若能在校验通过后的瞬间替换中间目录或目标，防护可能被绕过；写后复核只能**发现**该窗口内的替换并报错，不能阻止或回滚宿主侧的并发改动。彻底消除需要 openat2/RESOLVE_BENEATH 级内核支持，Node 无对应 API。`tests/security.symlink.test.mjs` 用 `tests/.tmp` 里的真实符号链接/硬链接构造了 14 组攻击（staging/workspace→storages、悬空 storages 别名、sync.log→宿主 workspace.json 符号链接与硬链接、staging 根为链接、plugin-sync→storages 初始化污染、lstat/realpath 故障注入等），并断言宿主字节不变、零写系统调用。

合并规则（与写入模式无关，始终适用）：

- **无损合并**：保留本地递归键集、`global.initialized` 和未知字段；未知对象同名值保留本地，远端只补缺；`__proto__`、`constructor` 等键按自有键安全处理。`workspaceIds` / `sessionIds` 保序并集，title/path 按 `updatedAt` 选择。
- **写前校验**：完整 v2 信封、必需字段、`workspaceIds` 属于结果表以及 default 引用完整。远端坏条目跳过并记录 error，对应索引过滤；缺失字段可由合法本地补齐。本地缺失时仅接受完整合法远端。解析失败、I/O 故障、版本不符或合并结果非法均拒写。
- **容量边界**：每个工作区输入与合并产物最多 32MiB；workspace 表、workspaceIds 和各 sessionIds 数组最多 100000 条。输入或结果超限都报错并拒写，不再截断后写入。

升级注意（v1.0 → v1.1 → v1.2）：v1.1 起不再直接写宿主工作区索引文件，无需手工赋予插件宿主文件写权限；v1.2 在宿主提供 `workspaceRegistry`/`sessionPersistence` 事务 API 时恢复**自动应用**（经宿主 API、不落插件文件写）。建议文件每轮参与合并故不会丢失。旧版插件产生的宿主文件备份不会被新代码自动恢复或清理。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `dsh_sync_status` | 无 | 设备、监听地址/端口、peers、会话数量、写入模式（`workspaceWriteMode` / `registryAvailable` / `registryLastApplied` / `registryWarnings`）、建议状态/路径/路径安全（`proposalPathSafe`）、冲突数、最近一轮结果及下次运行时间 |
| `dsh_sync_now` | 无 | 立即同步，返回计数、`workspaceWriteMode`、`registryApplied` / `registryWarnings`、`proposalPending` / `proposalPath` / `proposalPathSafe`、`errors[]` 和 `warnings[]` |
| `dsh_sync_config` | `{set?}` | 无 `set` 返回当前设置（token 打码）；有 `set` 深合并写入 `config.json`，返回 `{settings, needRestart}` |

## 日志与排查

- 追加日志：`<dshHome>/plugin-sync/logs/sync.log`，超过 2MB 轮转为 `sync.log.1`。日志文件本身被符号链接/硬链接劫持、或 `storages` 为危险配置时，追加与轮转被 safe-writer 拒绝，拒绝信息计入本轮 `errors[]`（不再静默）。
- 单个 peer 失败不影响其他 peer，错误会进本轮摘要的 `errors[]` 并写日志；整个 cycle 的任何异常都被捕获，不会抛到宿主。
- 常见问题：
  - **连不上**：确认双方 token 一致、`listenPort` 没被防火墙拦截、`peers[].url` 用对方的局域网 IP；
  - **401**：token 不匹配（注意 hub 与客户端要用同一个 token）；
  - **文件一直不同步**：看 mtime 是否仍在新写入（`settleSec` 安静期未过）；DSH 的 flock 锁不影响同步——只看 mtime，不看锁；
  - **端口被占**：改 `listenPort`，或设为 `0` 用随机端口（在 `dsh_sync_status` 里看实际端口）。
- 状态基线在 `plugin-sync/state.json`（localHashes / remoteHashes / declined / unresolvedConflict / pushed）。先处理 `conflicts/` 的副本再清除对应冲突记录；删掉整个 state 会丢失基线，下次内容不同仍会走无基线冲突保护。

## 测试

```bash
node tests/engine.test.mjs        # 端到端同步：初始同步、工作区建议并集、冲突、幂等零流量
node tests/workspace.compat.test.mjs  # 无损合并、校验/容量拒写、真实符号链接攻击、宿主只读
node tests/apply.compat.test.mjs      # 跨周期冲突保护、坏zstd/JSONL、缓存校验、配置拒绝自动落回
node tests/engine.offline.test.mjs    # 沙箱补充：真实文件与周期，内存 fetch 响应，不能代替 HTTP 验收
node tests/fixture.accept.test.mjs    # 读取 /tmp/dsh-sync-accept 两份事故 fixture，在仓库临时目录合并
node tests/security.symlink.test.mjs  # 14 组攻击：符号链接/硬链接/目录污染/故障注入，宿主字节不变、零写系统调用
node tests/registry.test.mjs          # v1.2 registry 应用：8 类场景（命中/幂等/stat缺失/缺目录/archive-pin/标题/降级/异常）+ engine/index 接入，纯 mock
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
