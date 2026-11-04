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
import { mergeWorkspaceFiles } from './workspace.js'
import { ensureDir, atomicWrite, writeJson, readJson, listFiles, isSkipped, safeJoin, sha1 } from './util.js'

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
  let state = { localHashes: {}, remoteHashes: {}, declined: {}, pushed: {}, lastRun: null }
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
    state = await readJson(stateFile, state)

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
          return await fsp.readFile(file)
        } catch {
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

  async function request(peer, pathname, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      return await fetch(trimUrl(peer.url) + pathname, {
        ...init,
        headers: {
          'x-dsh-sync-token': peer.token || '',
          ...(init.headers || {}),
        },
        signal: ac.signal,
      })
    } finally {
      clearTimeout(t)
    }
  }

  async function fetchIndex(peer) {
    const res = await request(peer, '/v1/index')
    if (!res.ok) throw new Error(`GET /v1/index -> ${res.status}`)
    return res.json()
  }

  async function fetchBlob(peer, sha1) {
    const res = await request(peer, `/v1/blob/${sha1}`)
    if (!res.ok) throw new Error(`GET /v1/blob/${sha1} -> ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  async function putBlob(peer, sha1, buf, rel) {
    const res = await request(peer, `/v1/blob/${sha1}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': buf.length,
        ...(rel ? { 'x-dsh-sync-path': rel } : {}),
      },
      body: buf,
    })
    if (!res.ok) throw new Error(`PUT /v1/blob/${sha1} -> ${res.status}`)
  }

  engine.runCycle = async function runCycle() {
    await ensureListening()
    if (inFlight) return { skipped: true }
    inFlight = true
    const errors = []
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
      at: new Date().toISOString(),
    }
    try {
      const exported = await exportAll(dshHome, stagingRoot, settings)
      summary.exported = exported.length

      const m1 = await mergeWorkspaceFiles(dshHome, stagingRoot, settings.pathRemap)
      if (m1.merged) summary.merged++

      const peers = effectivePeers()
      summary.peers = peers.map((p) => p.name)
      const memo = new Map()
      const gatedRels = new Set()
      let stagingIndex = await store.buildIndex(stagingRoot, memo)

      for (const peer of peers) {
        try {
          const remote = await fetchIndex(peer)
          const remoteFiles = remote.files || {}
          const peerPushed = (state.pushed[peer.name] = state.pushed[peer.name] || {})

          // 推：staging 有、远端 index 没有该 sha1 → PUT（已推送过且远端仍持其他版本时不再重推）
          for (const [rel, info] of Object.entries(stagingIndex)) {
            const remoteSha = remoteFiles[rel]?.sha1
            if (remoteSha === info.sha1) continue
            if (remoteFiles[rel] && peerPushed[rel] === info.sha1) continue
            const file = safeJoin(stagingRoot, rel)
            if (!file) continue
            const buf = await fsp.readFile(file)
            await putBlob(peer, info.sha1, buf, rel)
            peerPushed[rel] = info.sha1
            summary.pushed++
          }

          // 拉：远端版本相对上次基线确实变化时才取回 staging（避免覆盖未推送的本地新内容 / 已拒绝版本）
          const pulledRels = []
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
            let buf = await store.getBlob(info.sha1)
            if (buf === null) {
              buf = await fetchBlob(peer, info.sha1)
              summary.pulled++
            }
            if (sha1(buf) !== info.sha1) throw new Error(`blob sha1 mismatch for ${rel}`)
            await atomicWrite(dest, buf)
            stagingIndex[rel] = { sha1: info.sha1, size: info.size ?? buf.length, mtime: info.mtime ?? Date.now() }
            pulledRels.push(rel)
            mergeRels.push(rel)
          }
          if (mergeRels.includes('workspace/workspace.json')) {
            const m2 = await mergeWorkspaceFiles(dshHome, stagingRoot, settings.pathRemap)
            if (m2.merged) summary.merged++
          }
        } catch (e) {
          const msg = `peer ${peer.name}: ${e?.message || e}`
          errors.push(msg)
          await log.warn(msg)
        }
      }

      stagingIndex = await store.buildIndex(stagingRoot, memo)
      const result = await applyAll({
        dshHome,
        stagingRoot,
        settings,
        state,
        log,
        deviceName: deviceName(),
        stagingIndex,
        gatedRels,
      })
      summary.applied = result.applied.length
      summary.conflicts = result.conflicts.length

      const remoteHashes = {}
      for (const rel of Object.keys(result.remoteHashes)) {
        if (stagingIndex[rel]) remoteHashes[rel] = result.remoteHashes[rel]
      }
      state.localHashes = result.localHashes
      state.remoteHashes = remoteHashes
      state.declined = result.declined
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
