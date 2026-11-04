// v1.2：registry applier —— 通过宿主 ctx.workspaceRegistry 事务 API 把 staging 里合并后的
// 工作区索引增量应用到本机。只用宿主 API（create/resolveByPath/attachSession/archiveSession/
// pinSession/setTitle、sessionPersistence.stat），绝不写任何宿主 JSON 文件（本模块无任何
// fs 写调用，文件写仍全部由 lib/safe-writer.js 管辖）。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { readWorkspaceStatus, applyRemap, MAX_WORKSPACE_IDS } from './workspace.js'

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

// 幂等模型：每轮从 registry 重新读取现状算差量，不缓存本地快照；attach/archive/pin/setTitle
// 都是宿主 mutation queue 内的单条持久化操作，重复调用应无害（宿主契约：已 attach 不重复、
// 已归档/已置顶为 no-op）。单条失败记 warning，下一轮自动重试，不做整轮回滚。
export async function applyRegistryIndex({
  registry,
  sessionPersistence,
  stagingRoot,
  pathRemap,
  log,
} = {}) {
  const warnings = []
  const applied = { workspaces: 0, created: 0, sessions: 0, archived: 0, pinned: 0, titles: 0 }
  const base = { registryApplied: applied, registryWarnings: warnings, error: null }
  if (!plainObject(registry) || !plainObject(sessionPersistence)) {
    return { ...base, error: 'registry 不可用' }
  }
  const warn = async (message) => {
    warnings.push(message)
    if (log) await log.warn(message)
  }
  try {
    const staged = await readWorkspaceStatus(path.join(stagingRoot, 'workspace', 'workspace.json'))
    if (staged.state === 'missing') return base
    if (staged.state !== 'ok') {
      return { ...base, error: `staging workspace.json 读取失败，registry 应用跳过：${staged.error?.message || staged.error}` }
    }
    const doc = staged.value
    if (plainObject(doc.unit) && (doc.unit.name !== 'workspace' || doc.unit.version !== 2)) {
      return { ...base, error: `staging workspace.json 信封无效（unit.name=${JSON.stringify(doc.unit?.name)}），registry 应用跳过` }
    }
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
        const localPath = applyRemap(ws.path, pathRemap)
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

        // 标题规则：本地标题从未被改过（仍等于目录 basename）且远端标题不同才跟随远端，
        // 避免两端改名互相覆盖/震荡。以 registry 返回的 canonical path 计算 basename。
        const remoteTitle = typeof ws.title === 'string' ? ws.title : ''
        const localTitle = typeof local.title === 'string' ? local.title : ''
        if (remoteTitle.length > 0 && remoteTitle !== localTitle && localTitle.length > 0
          && localTitle === path.basename(typeof local.path === 'string' && local.path.length > 0 ? local.path : localPath)) {
          try {
            await local.setTitle(remoteTitle)
            applied.titles++
          } catch (e) {
            await warn(`registry: 工作区 ${localPath} 设置标题失败：${e?.message || e}`)
          }
        }

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
