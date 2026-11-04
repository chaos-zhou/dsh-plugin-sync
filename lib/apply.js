import fsp from 'node:fs/promises'
import path from 'node:path'
import { sha1File, atomicCopy, ensureDir, safeJoin, isQuiet } from './util.js'

function conflictName(rel, deviceName, now) {
  const ts = new Date(now).toISOString().replace(/[:]/g, '-')
  const dev = (deviceName || 'device').replace(/[^\w.-]+/g, '_')
  return `${rel.split('/').join('__')}.conflict-${dev}-${ts}`
}

async function copyIn(src, localPath) {
  await ensureDir(path.dirname(localPath))
  await atomicCopy(src, localPath)
}

async function fileSha(file) {
  try {
    return await sha1File(file)
  } catch {
    return null
  }
}

// 会话落回决策。返回动作后的 {localSha}；写入 declined / 冲突副本 / staging 恢复。
async function applySession(ctx, rel, info) {
  const { dshHome, stagingRoot, settings, state, log, deviceName, now, out, gatedRels } = ctx
  const settleSec = settings.settleSec ?? 120
  const stagingFile = safeJoin(stagingRoot, rel)
  const localFile = safeJoin(dshHome, rel)
  if (!stagingFile || !localFile) return
  const localSha = await fileSha(localFile)

  if (localSha === info.sha1) {
    // staging 与本地一致；若这是本轮被门控跳过的分歧（远端另有版本），保留旧基线，
    // 让真正的「两端都变」判定留给下一轮看到远端版本时发生
    if (!gatedRels?.has(rel)) {
      out.localHashes[rel] = localSha
      out.remoteHashes[rel] = info.sha1
    }
    return
  }

  if (localSha === null) {
    await copyIn(stagingFile, localFile)
    out.applied.push(rel)
    out.localHashes[rel] = info.sha1
    out.remoteHashes[rel] = info.sha1
    return
  }

  const localStat = await fsp.stat(localFile)
  if (!isQuiet(localStat.mtimeMs, settleSec, now)) {
    out.skippedFresh.add(rel)
    return
  }

  const prevLocal = (state.localHashes || {})[rel]
  const prevRemote = (state.remoteHashes || {})[rel]
  const localChanged = prevLocal === undefined ? true : prevLocal !== localSha
  const remoteChanged = prevRemote === undefined ? true : prevRemote !== info.sha1

  let keepLocal
  if (!prevLocal && !prevRemote) {
    const stagingStat = await fsp.stat(stagingFile)
    keepLocal = !(stagingStat.mtimeMs > localStat.mtimeMs)
    if (!keepLocal) await copyIn(stagingFile, localFile)
  } else if (remoteChanged && !localChanged) {
    keepLocal = false
    await copyIn(stagingFile, localFile)
  } else {
    // 只有本地变 / 两端都变 / 已知分歧：保留本地
    keepLocal = true
    if (localChanged && remoteChanged) {
      const conflictsDir = path.join(dshHome, 'plugin-sync', 'conflicts')
      const dest = path.join(conflictsDir, conflictName(rel, deviceName, now))
      await atomicCopy(stagingFile, dest)
      out.conflicts.push(path.relative(dshHome, dest).split(path.sep).join('/'))
      await log.warn(`会话两端都修改，保留本地，远端版本已存冲突副本：${rel}`)
    } else if (localChanged && !remoteChanged) {
      await log.warn(`本地会话较新，保留本地：${rel}`)
    }
  }

  if (keepLocal) {
    // staging 恢复为保留的本地版本，避免索引回退到远端旧版本；并记住已拒绝的远端版本
    await atomicCopy(localFile, stagingFile)
    out.declined[rel] = info.sha1
    out.localHashes[rel] = localSha
    out.remoteHashes[rel] = info.sha1
  } else {
    out.applied.push(rel)
    out.localHashes[rel] = info.sha1
    out.remoteHashes[rel] = info.sha1
  }
}

export async function applyAll(opts) {
  const { dshHome, stagingRoot, settings, state, log, deviceName, stagingIndex, gatedRels } = opts
  const now = Date.now()
  const out = {
    applied: [],
    conflicts: [],
    skippedFresh: new Set(),
    declined: { ...(state.declined || {}) },
    localHashes: { ...(state.localHashes || {}) },
    remoteHashes: { ...(state.remoteHashes || {}) },
  }
  const ctx = { dshHome, stagingRoot, settings, state, log, deviceName, now, out, gatedRels }

  for (const [rel, info] of Object.entries(stagingIndex || {})) {
    if (rel.startsWith('workspace/')) continue

    if (rel.startsWith('sessions/') && /^session\.v4\.jsonl\.zst(d)?$/.test(path.basename(rel))) {
      await applySession(ctx, rel, info)
      continue
    }

    if (rel.startsWith('attachments/') || rel.startsWith('projcache/')) {
      const localFile = safeJoin(dshHome, rel)
      const stagingFile = safeJoin(stagingRoot, rel)
      if (!localFile || !stagingFile) continue
      const localSha = await fileSha(localFile)
      if (localSha === info.sha1) continue
      await copyIn(stagingFile, localFile)
      out.applied.push(rel)
      continue
    }

    if (rel.startsWith('config/') && rel.endsWith('cordis.patch.yml')) {
      if (!settings.applyConfig) continue
      const profile = rel.slice('config/'.length).split('/')[0]
      if (!profile) continue
      const localFile = safeJoin(dshHome, path.join('profiles', profile, 'cordis.patch.yml'))
      const stagingFile = safeJoin(stagingRoot, rel)
      if (!localFile || !stagingFile) continue
      const localSha = await fileSha(localFile)
      if (localSha === info.sha1) continue
      await copyIn(stagingFile, localFile)
      out.applied.push(rel)
    }
  }

  return out
}
