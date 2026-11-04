// v1.2.1：registry applier —— 通过宿主 ctx.workspaceRegistry 事务 API 把「合并成功且校验
// 通过」的工作区索引产物增量应用到本机。只用宿主 API（create/resolveByPath/attachSession/
// archiveSession/pinSession、sessionPersistence.stat），绝不写任何宿主 JSON 文件（本模块
// 无任何 fs 写调用，文件写仍全部由 lib/safe-writer.js 管辖；fsp.stat 只读）。
// 输入 doc 由 engine 传入 mergeWorkspace 的产物：其中的路径已完成 pathRemap 本地化，
// 本模块绝不再做二次映射（v1.2 BLOCKER 4：/a → /a/local → /a/local/local 导致正确目录被跳过）。
// 既有 workspace 一律不 setTitle（v1.2 BLOCKER 2：标题条件在 mutation queue 外判断，
// 无条件 setTitle 会覆盖先排队的本地改名）；标题只在 create 新建时随路径传入，
// 工作区重命名不跨设备同步——等宿主提供条件更新 API。
import fsp from 'node:fs/promises'
import { validateWorkspaceDoc, MAX_WORKSPACE_IDS } from './workspace.js'

function plainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// 远端数据不可信：结构不对的条目按 warning 跳过，绝不让单条坏数据中断整轮。
function stringIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id.length > 0) : []
}

function activeSessionError(e) {
  return e?.name === 'WorkspaceActiveSessionError' || e?.constructor?.name === 'WorkspaceActiveSessionError'
}

// 注入服务契约（v1.2 NIT）：仅凭对象存在判定会放过空对象；必须同时具备全部必需方法
// 才视为可用，否则回退 proposal 模式。
const REGISTRY_METHODS = ['create', 'resolveByPath', 'list', 'archiveSession', 'pinSession']

export function registryServicesUsable(registry, sessionPersistence) {
  const hasMethods = (obj, names) => plainObject(obj) && names.every((name) => typeof obj[name] === 'function')
  return hasMethods(registry, REGISTRY_METHODS) && hasMethods(sessionPersistence, ['stat'])
}

// 幂等模型：每轮从 registry 重新读取现状算差量，不缓存本地快照；attach/archive/pin
// 都是宿主 mutation queue 内的单条持久化操作，重复调用应无害（宿主契约：已 attach 不重复、
// 已归档/已置顶为 no-op）。单条失败记 warning，下一轮自动重试，不做整轮回滚。
export async function applyRegistryIndex({
  registry,
  sessionPersistence,
  doc,
  log,
} = {}) {
  const warnings = []
  const applied = { workspaces: 0, created: 0, sessions: 0, archived: 0, pinned: 0 }
  const base = { registryApplied: applied, registryWarnings: warnings, error: null }
  if (!registryServicesUsable(registry, sessionPersistence)) {
    return { ...base, error: 'registry 不可用' }
  }
  // 防御性自检（R3）：坏文档（缺信封/缺 initialized/条目非法）在此直接返回，
  // 不调用任何 registry API。engine 侧已在调用前校验过一次，这里是最后一道闸。
  const envelopeErrors = validateWorkspaceDoc(doc, { requireEnvelope: true })
  if (envelopeErrors.length) {
    return { ...base, error: `合并产物校验失败，registry 应用跳过（零 mutation）：${envelopeErrors.join('; ')}` }
  }
  const warn = async (message) => {
    warnings.push(message)
    if (log) await log.warn(message)
  }
  try {
    const global = plainObject(doc.global) ? doc.global : {}
    const tables = plainObject(doc.tables) && plainObject(doc.tables.workspaces) ? doc.tables.workspaces : {}

    // 远端归档/置顶集合：只加不减。宿主尚未识别的会话下一轮重试；active 会话归档失败
    // 不中断（归档中的会话由用户决定，插件不强行 stop）。
    const archivedIds = [...new Set(stringIds(global.archivedSessionIds).slice(0, MAX_WORKSPACE_IDS))]
    const pinnedIds = [...new Set(stringIds(global.pinnedSessionIds).slice(0, MAX_WORKSPACE_IDS))]
    for (const id of archivedIds) {
      try {
        if (await sessionPersistence.stat(id) === undefined) {
          await warn(`registry: 会话 ${id} 未被宿主识别，跳过归档（下一轮重试）`)
          continue
        }
        await registry.archiveSession(id, { stopActivity: false })
        applied.archived++
      } catch (e) {
        await warn(`registry: 归档会话 ${id} 失败${activeSessionError(e) ? '（会话仍在活动）' : ''}：${e?.message || e}`)
      }
    }
    for (const id of pinnedIds) {
      try {
        if (await sessionPersistence.stat(id) === undefined) {
          await warn(`registry: 会话 ${id} 未被宿主识别，跳过置顶（下一轮重试）`)
          continue
        }
        await registry.pinSession(id)
        applied.pinned++
      } catch (e) {
        await warn(`registry: 置顶会话 ${id} 失败（可能已归档或不存在）：${e?.message || e}`)
      }
    }

    const entries = Object.entries(tables)
    if (entries.length > MAX_WORKSPACE_IDS) await warn(`registry: 远端工作区超过 ${MAX_WORKSPACE_IDS} 条，仅处理前 ${MAX_WORKSPACE_IDS} 条`)
    for (const [id, ws] of entries.slice(0, MAX_WORKSPACE_IDS)) {
      try {
        if (!plainObject(ws) || typeof ws.path !== 'string' || ws.path.length === 0) {
          await warn(`registry: 工作区 ${id} 缺少合法 path，跳过`)
          continue
        }
        // 输入已本地化（mergeWorkspace 产物）：直接使用，绝不再 pathRemap。
        const localPath = ws.path
        let stat
        try {
          stat = await fsp.stat(localPath)
        } catch (e) {
          await warn(`registry: 工作区目录本地不存在，跳过 ${localPath}（含 ${stringIds(ws.sessionIds).length} 个会话）：${e?.code || e?.message || e}`)
          continue
        }
        if (!stat.isDirectory()) {
          await warn(`registry: 工作区路径不是目录，跳过 ${localPath}`)
          continue
        }
        let local = await registry.resolveByPath(localPath)
        if (local === undefined) {
          local = await registry.create(localPath, typeof ws.title === 'string' && ws.title.length > 0 ? ws.title : undefined)
          applied.created++
        }
        if (local === undefined || local === null) {
          await warn(`registry: 工作区 ${localPath} 无法在宿主 registry 中定位，跳过`)
          continue
        }
        applied.workspaces++

        // 会话增量：只 attach 本工作区尚没有的 id；宿主未识别的下一轮重试。
        const localSessionIds = new Set(stringIds(local.sessionIds))
        for (const sid of [...new Set(stringIds(ws.sessionIds))]) {
          if (localSessionIds.has(sid)) continue
          try {
            if (await sessionPersistence.stat(sid) === undefined) {
              await warn(`registry: 会话 ${sid} 未被宿主识别，暂不附加到 ${localPath}（下一轮重试）`)
              continue
            }
            await local.attachSession(sid)
            applied.sessions++
          } catch (e) {
            await warn(`registry: 附加会话 ${sid} 到 ${localPath} 失败：${e?.message || e}`)
          }
        }
      } catch (e) {
        await warn(`registry: 工作区 ${id} 应用失败，跳过：${e?.message || e}`)
      }
    }
    return base
  } catch (e) {
    return { ...base, error: `registry 应用中止：${e?.message || e}` }
  }
}
