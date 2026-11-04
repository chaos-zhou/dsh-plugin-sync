import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createSyncServer, listen, closeServer } from './server.js'
import { createStore } from './store.js'
import { createLogger } from './log.js'
import { loadConfig, saveConfig, deepMerge, resolveDshHome, publicSettings } from './config.js'
import { exportAll } from './export.js'
import { applyAll } from './apply.js'
import { MAX_WORKSPACE_BYTES, mergeWorkspace } from './workspace.js'
import { ensureDir, atomicWrite, writeJson, readJson, listFiles, isSkipped, safeJoin, sha1 } from './util.js'
import { MAX_BLOB_BYTES, MAX_INDEX_BYTES, readFileLimited, requestBuffer, parsePeerIndex } from './limits.js'

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const RESTART_FIELDS = ['listenPort', 'role', 'bindHost', 'token']
const REQUEST_TIMEOUT_MS = 30000
const SESSION_FILE = /^session\.v4\.jsonl\.zst(d)?$/

function hashMap(value) {
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []
  return Object.assign(Object.create(null), Object.fromEntries(entries.filter(([, hash]) => typeof hash === 'string')))
}

function normalizeState(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const pushed = Object.create(null)
  if (record.pushed && typeof record.pushed === 'object' && !Array.isArray(record.pushed)) {
    for (const [peer, hashes] of Object.entries(record.pushed)) pushed[peer] = hashMap(hashes)
  }
  const unresolvedConflict = Object.create(null)
  if (record.unresolvedConflict && typeof record.unresolvedConflict === 'object' && !Array.isArray(record.unresolvedConflict)) {
    for (const [rel, conflict] of Object.entries(record.unresolvedConflict)) {
      // 损坏的冲突记录也保守保留为阻断标记，不能悄悄恢复自动覆盖。
      unresolvedConflict[rel] = {
        sessionId: typeof conflict?.sessionId === 'string' ? conflict.sessionId : path.posix.basename(path.posix.dirname(rel)),
        localSha: typeof conflict?.localSha === 'string' ? conflict.localSha : null,
        remoteSha: typeof conflict?.remoteSha === 'string' ? conflict.remoteSha : '',
      }
    }
  }
  return {
    localHashes: hashMap(record.localHashes), remoteHashes: hashMap(record.remoteHashes),
    declined: hashMap(record.declined), unresolvedConflict, pushed, lastRun: record.lastRun ?? null,
  }
}

function trimUrl(url) {
  return String(url || '').replace(/\/+$/, '')
}

export function createEngine(opts = {}) {
  const rowConfig = opts.rowConfig || {}
  let settings
  let configFile
  let dshHome
  let dataDir
  let stagingRoot
  let store
  let log
  let state = normalizeState(null)
  let stateFile
  let server = null
  let boundPort = null
  let boundHost = null
  let listenError = null
  let inFlight = false
  let lastRun = null
  let lastResult = null
  let nextRunAt = null
  let timer = null
  let initialTimer = null
  let proposalPending = false
  let proposalPath = null
  let proposalPathSafe = true

  const engine = {
    ready: null,
    get settings() {
      return settings
    },
    get dataDir() {
      return dataDir
    },
    get deviceName() {
      return deviceName()
    },
    get listening() {
      return boundPort
    },
    get inFlight() {
      return inFlight
    },
    version: VERSION,
  }

  function deviceName() {
    return settings.deviceName || os.hostname()
  }

  function effectivePeers() {
    const peers = []
    for (const p of Array.isArray(settings.peers) ? settings.peers : []) {
      if (p && p.url) peers.push({ name: p.name || p.url, url: trimUrl(p.url), token: p.token ?? settings.token })
    }
    if (settings.hubUrl) peers.push({ name: 'hub', url: trimUrl(settings.hubUrl), token: settings.token })
    return peers
  }

  async function countSessions(root, requireSessionsPrefix) {
    let n = 0
    for (const { rel } of await listFiles(root)) {
      if (requireSessionsPrefix && !rel.startsWith('sessions/')) continue
      if (SESSION_FILE.test(path.basename(rel))) n++
    }
    return n
  }

  async function countConflicts() {
    const dir = path.join(dataDir, 'conflicts')
    try {
      return (await fsp.readdir(dir)).filter((f) => !f.startsWith('.')).length
    } catch {
      return 0
    }
  }

  async function ensureListening() {
    if (boundPort !== null || !server) return
    try {
      boundPort = await listen(server, settings.listenPort ?? 8789, boundHost)
      listenError = null
      if (settings.listenPort === 0) await log.info(`HTTP 随机端口：${boundPort}`)
    } catch (e) {
      listenError = e?.message || String(e)
      boundPort = null
      // 端口被占用（例如旧代际尚未释放）时降级为纯客户端，下一轮/重载时自动重试
      await log.warn(`HTTP 监听失败（${listenError}），暂以客户端模式运行`)
    }
  }

  engine.init = async function init() {
    dshHome = resolveDshHome(rowConfig)
    dataDir = path.join(dshHome, 'plugin-sync')
    stagingRoot = path.join(dataDir, 'staging')
    stateFile = path.join(dataDir, 'state.json')
    await Promise.all([
      ensureDir(stagingRoot),
      ensureDir(path.join(dataDir, 'store', 'blobs')),
      ensureDir(path.join(dataDir, 'conflicts')),
      ensureDir(path.join(dataDir, 'logs')),
    ])
    const cfg = await loadConfig(dataDir, rowConfig)
    settings = cfg.settings
    configFile = cfg.file
    store = createStore(dataDir)
    log = createLogger(path.join(dataDir, 'logs'))
    state = normalizeState(await readJson(stateFile, null))
    proposalPath = path.join(dataDir, 'proposed', 'workspace.json')
    try { proposalPending = (await fsp.stat(proposalPath)).isFile() }
    catch (e) { if (e?.code !== 'ENOENT') throw e }

    if (cfg.seeded) await log.info('config.json 首次播种')

    server = createSyncServer({
      token: () => settings.token,
      getDevice: () => deviceName(),
      getRole: () => settings.role,
      getVersion: () => VERSION,
      getIndex: () => store.buildIndex(stagingRoot),
      getBlob: async (sha1Hex) => {
        const buf = await store.getBlob(sha1Hex)
        if (buf !== null) return buf
        // staging 即内容：按 index 反查 rel，直接读文件
        const files = await store.buildIndex(stagingRoot)
        const rel = Object.keys(files).find((r) => files[r].sha1 === sha1Hex)
        if (!rel) return null
        const file = safeJoin(stagingRoot, rel)
        if (!file) return null
        try {
          return await readFileLimited(file)
        } catch (e) {
          await log.error(`读取 blob 失败：${e?.message || e}`)
          return null
        }
      },
      putBlob: (buf, rel) => store.putBlob(buf, rel),
    })
    boundHost = settings.token ? settings.bindHost || '0.0.0.0' : '127.0.0.1'
    if (!settings.token) await log.warn('token 为空，HTTP 服务仅绑定 127.0.0.1')
    await ensureListening()
    return engine
  }

  engine.startTimer = function startTimer() {
    if (timer || initialTimer) return
    if (!settings) return // init() 尚未完成
    const intervalSec = Math.max(5, settings.intervalSec ?? 300)
    initialTimer = setTimeout(() => {
      initialTimer = null
      engine.runCycle()
      timer = setInterval(() => {
        nextRunAt = Date.now() + intervalSec * 1000
        engine.runCycle()
      }, intervalSec * 1000)
      timer.unref?.()
    }, 10000)
    initialTimer.unref?.()
    nextRunAt = Date.now() + 10000
  }

  engine.stopTimer = function stopTimer() {
    if (initialTimer) clearTimeout(initialTimer)
    if (timer) clearInterval(timer)
    initialTimer = null
    timer = null
    nextRunAt = null
  }

  engine.close = async function close() {
    engine.stopTimer()
    await closeServer(server)
    server = null
    boundPort = null
    listenError = null
  }

  async function request(peer, pathname, init = {}, maxBytes = MAX_BLOB_BYTES) {
    return requestBuffer(trimUrl(peer.url) + pathname, {
        ...init,
        headers: {
          'x-dsh-sync-token': peer.token || '',
          ...(init.headers || {}),
        },
      }, { maxBytes, timeoutMs: REQUEST_TIMEOUT_MS })
  }

  async function fetchIndex(peer) {
    return parsePeerIndex(await request(peer, '/v1/index', {}, MAX_INDEX_BYTES))
  }

  async function fetchBlob(peer, sha1, maxBytes = MAX_BLOB_BYTES) {
    return request(peer, `/v1/blob/${sha1}`, {}, maxBytes)
  }

  async function putBlob(peer, sha1, buf, rel) {
    if (buf.length > MAX_BLOB_BYTES) throw new Error(`blob 超过 ${MAX_BLOB_BYTES} 字节上限`)
    await request(peer, `/v1/blob/${sha1}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': buf.length,
        ...(rel ? { 'x-dsh-sync-path': rel } : {}),
      },
      body: buf,
    }, MAX_INDEX_BYTES)
  }

  engine.runCycle = async function runCycle() {
    await ensureListening()
    if (inFlight) return { skipped: true }
    inFlight = true
    const errors = []
    const warnings = []
    const summary = {
      device: deviceName(),
      role: settings.role,
      peers: [],
      exported: 0,
      pulled: 0,
      pushed: 0,
      applied: 0,
      conflicts: 0,
      merged: 0,
      errors,
      warnings,
      workspaceWriteMode: 'proposal',
      proposalPending,
      proposalPath,
      proposalPathSafe,
      at: new Date().toISOString(),
    }
    try {
      const recordErrors = async (result) => {
        const messages = new Set([...(result.errors || []), ...(result.error ? [result.error] : [])])
        for (const message of messages) {
          errors.push(message)
          await log.error(message)
        }
        for (const message of new Set(result.warnings || [])) {
          if (!warnings.includes(message)) warnings.push(message)
          await log.warn(message)
        }
      }
      const mergeWorkspaceIndex = async () => {
        const result = await mergeWorkspace({ dshHome, stagingRoot, dataDir, pathRemap: settings.pathRemap, log })
        if (result.merged) summary.merged++
        proposalPending = result.proposalPending ?? proposalPending
        proposalPath = result.proposalPath ?? proposalPath
        proposalPathSafe = result.proposalPathSafe ?? proposalPathSafe
        summary.proposalPending = proposalPending
        summary.proposalPath = proposalPath
        summary.proposalPathSafe = proposalPathSafe
        await recordErrors(result)
      }
      const exported = await exportAll(dshHome, stagingRoot, settings, { skipWorkspace: true })
      summary.exported = exported.length

      await mergeWorkspaceIndex()

      const peers = effectivePeers()
      summary.peers = peers.map((p) => p.name)
      const memo = new Map()
      const gatedRels = new Set()
      const observedRemoteHashes = Object.create(null)
      const observedRemoteCounts = Object.create(null)
      let stagingIndex = await store.buildIndex(stagingRoot, memo)

      for (const peer of peers) {
        try {
          const remote = await fetchIndex(peer)
          const remoteFiles = remote.files || {}
          for (const [rel, info] of Object.entries(remoteFiles)) {
            const observed = observedRemoteHashes[rel] ||= []
            if (!observed.includes(info.sha1)) observed.push(info.sha1)
            observedRemoteCounts[rel] = (observedRemoteCounts[rel] || 0) + 1
          }
          const peerPushed = (state.pushed[peer.name] = state.pushed[peer.name] || Object.create(null))

          // 推：staging 有、远端 index 没有该 sha1 → PUT（已推送过且远端仍持其他版本时不再重推）
          for (const [rel, info] of Object.entries(stagingIndex)) {
            const remoteSha = remoteFiles[rel]?.sha1
            if (remoteSha === info.sha1) continue
            if (remoteFiles[rel] && peerPushed[rel] === info.sha1) continue
            const file = safeJoin(stagingRoot, rel)
            if (!file) continue
            const buf = await readFileLimited(file)
            await putBlob(peer, info.sha1, buf, rel)
            peerPushed[rel] = info.sha1
            summary.pushed++
          }

          // 拉：远端版本相对上次基线确实变化时才取回 staging（避免覆盖未推送的本地新内容 / 已拒绝版本）
          const mergeRels = []
          for (const [rel, info] of Object.entries(remoteFiles)) {
            if (isSkipped(rel)) continue
            const stagedSha = stagingIndex[rel]?.sha1
            if (stagedSha === info.sha1) continue
            if (state.declined[rel] === info.sha1) {
              gatedRels.add(rel)
              continue
            }
            if (stagedSha !== undefined && state.remoteHashes[rel] === info.sha1) {
              gatedRels.add(rel)
              continue
            }
            const dest = safeJoin(stagingRoot, rel)
            if (!dest) continue
            const maxBytes = rel === 'workspace/workspace.json' ? MAX_WORKSPACE_BYTES : MAX_BLOB_BYTES
            if (info.size > maxBytes) throw new Error(`${rel} 超过 ${maxBytes} 字节上限`)
            let buf = await store.getBlob(info.sha1, maxBytes)
            if (buf === null) {
              buf = await fetchBlob(peer, info.sha1, maxBytes)
              summary.pulled++
            }
            if (sha1(buf) !== info.sha1) throw new Error(`blob sha1 mismatch for ${rel}`)
            await atomicWrite(dest, buf)
            stagingIndex[rel] = { sha1: info.sha1, size: buf.length, mtime: info.mtime }
            mergeRels.push(rel)
          }
          if (mergeRels.includes('workspace/workspace.json')) {
            await mergeWorkspaceIndex()
            stagingIndex = await store.buildIndex(stagingRoot, memo)
          }
        } catch (e) {
          const msg = `peer ${peer.name}: ${e?.message || e}`
          errors.push(msg)
          await log.warn(msg)
        }
      }

      stagingIndex = await store.buildIndex(stagingRoot, memo)
      // 冲突记录未绑定单一peer；只有所有配置peer本轮都证实同一版本才可自动解锁。
      for (const rel of Object.keys(observedRemoteHashes)) {
        if (observedRemoteCounts[rel] !== peers.length) observedRemoteHashes[rel] = []
      }
      const result = await applyAll({
        dshHome,
        stagingRoot,
        settings,
        state,
        log,
        deviceName: deviceName(),
        stagingIndex,
        gatedRels,
        observedRemoteHashes,
      })
      summary.applied = result.applied.length
      summary.conflicts = result.conflicts.length
      await recordErrors(result)

      const remoteHashes = {}
      for (const rel of Object.keys(result.remoteHashes)) {
        if (stagingIndex[rel]) remoteHashes[rel] = result.remoteHashes[rel]
      }
      state.localHashes = result.localHashes
      state.remoteHashes = remoteHashes
      state.declined = result.declined
      state.unresolvedConflict = result.unresolvedConflict
      state.lastRun = summary.at
      await writeJson(stateFile, state)
    } catch (e) {
      const msg = e?.message || String(e)
      errors.push(msg)
      await log.error(`cycle 失败: ${msg}`)
    } finally {
      inFlight = false
      lastRun = summary.at
      lastResult = summary
    }
    return summary
  }

  engine.updateSettings = async function updateSettings(set) {
    const before = { listenPort: settings.listenPort, role: settings.role, bindHost: settings.bindHost }
    settings = deepMerge(settings, set || {})
    await saveConfig(configFile, settings)
    let needRestart = false
    for (const f of RESTART_FIELDS) {
      if ((set || {})[f] !== undefined && String(before[f]) !== String(settings[f])) needRestart = true
    }
    return { settings: publicSettings(settings), needRestart }
  }

  engine.status = async function status() {
    return {
      device: deviceName(),
      role: settings.role,
      dshHome,
      dataDir,
      workspaceWriteMode: 'proposal',
      proposalPending,
      proposalPath,
      proposalPathSafe,
      listenHost: boundHost,
      listenPort: boundPort ?? settings.listenPort,
      serverBound: boundPort !== null,
      listenError,
      token: mask(settings.token),
      peers: (Array.isArray(settings.peers) ? settings.peers : []).map((p) => ({ name: p?.name, url: p?.url })),
      hubUrl: settings.hubUrl || '',
      intervalSec: settings.intervalSec,
      settleSec: settings.settleSec,
      sessions: {
        local: await countSessions(path.join(dshHome, 'sessions'), false),
        staged: await countSessions(stagingRoot, true),
      },
      conflicts: await countConflicts(),
      lastRun,
      lastResult,
      nextRun: nextRunAt ? new Date(nextRunAt).toISOString() : null,
      inFlight,
    }
  }

  return engine
}

function mask(token) {
  if (!token) return ''
  return token.slice(0, 6) + '******'
}
