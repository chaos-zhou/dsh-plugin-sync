import path from 'node:path'
import { readJson, writeJson } from './util.js'

export function emptyWorkspace() {
  return {
    global: {
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: '',
    },
    tables: { workspaces: {} },
  }
}

function orderedUnion(a, b) {
  const out = [...(a || [])]
  const seen = new Set(out)
  for (const x of b || []) {
    if (!seen.has(x)) {
      out.push(x)
      seen.add(x)
    }
  }
  return out
}

function setUnion(a, b) {
  return [...new Set([...(a || []), ...(b || [])])]
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function applyRemap(p, pathRemap) {
  let out = p
  for (const r of pathRemap || []) {
    if (typeof r?.from === 'string') out = out.split(r.from).join(r.to)
  }
  return out
}

function remapped(ws, pathRemap) {
  const out = { ...ws }
  if (typeof out.path === 'string') out.path = applyRemap(out.path, pathRemap)
  return out
}

export function mergeWorkspaces(local, remote, pathRemap) {
  const L = local && typeof local === 'object' ? local : emptyWorkspace()
  const R = remote && typeof remote === 'object' ? remote : {}
  const lg = L.global || {}
  const rg = R.global || {}
  const localTables = L.tables?.workspaces || {}
  const remoteTables = R.tables?.workspaces || {}

  const tables = { workspaces: {} }
  const mergedIds = new Set()

  for (const [id, ws] of Object.entries(localTables)) {
    const rw = remapped(remoteTables[id] || {}, pathRemap)
    const hasRemote = Object.keys(rw).length > 0
    const lUpd = num(ws.updatedAt, -Infinity)
    const rUpd = hasRemote ? num(rw.updatedAt, -Infinity) : -Infinity
    const newer = rUpd > lUpd ? rw : ws
    const created = Math.min(num(ws.createdAt, Infinity), hasRemote ? num(rw.createdAt, Infinity) : Infinity)
    tables.workspaces[id] = {
      ...newer,
      ...(Number.isFinite(created) ? { createdAt: created } : {}),
      ...(Number.isFinite(Math.max(lUpd, rUpd)) ? { updatedAt: Math.max(lUpd, rUpd) } : {}),
      sessionIds: orderedUnion(ws.sessionIds, rw.sessionIds),
    }
    mergedIds.add(id)
  }

  const remoteOnly = []
  for (const [id, ws] of Object.entries(remoteTables)) {
    if (mergedIds.has(id)) continue
    tables.workspaces[id] = remapped(ws, pathRemap)
    remoteOnly.push(id)
  }

  return {
    ...L,
    global: {
      workspaceIds: orderedUnion(orderedUnion(lg.workspaceIds, rg.workspaceIds), remoteOnly),
      archivedSessionIds: setUnion(lg.archivedSessionIds, rg.archivedSessionIds),
      pinnedSessionIds: setUnion(lg.pinnedSessionIds, rg.pinnedSessionIds),
      defaultWorkspaceId: lg.defaultWorkspaceId || rg.defaultWorkspaceId || '',
    },
    tables,
  }
}

export async function mergeWorkspaceFiles(dshHome, stagingRoot, pathRemap) {
  const localPath = path.join(dshHome, 'storages', 'workspace.json')
  const stagingPath = path.join(stagingRoot, 'workspace', 'workspace.json')
  const [local, staged] = await Promise.all([readJson(localPath, null), readJson(stagingPath, null)])
  if (!local && !staged) return { merged: false }
  const merged = mergeWorkspaces(local || emptyWorkspace(), staged || emptyWorkspace(), pathRemap)
  await writeJson(localPath, merged)
  await writeJson(stagingPath, merged)
  return { merged: true, workspace: merged }
}
