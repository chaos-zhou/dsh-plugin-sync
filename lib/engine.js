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
import { applyRegistryIndex, registryServicesUsable } from './registry-apply.js'
import { MAX_WORKSPACE_BYTES, mergeWorkspace, validateWorkspaceDoc } from './workspace.js'
import { readJson, listFiles, isSkipped, safeJoin, sha1 } from './util.js'
import { guardedWrite, guardedMkdir, assertSafeRoot } from './safe-writer.js'
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

function plainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
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
  // v1.2.1：宿主 registry 服务句柄。由 index.js 的 ctx.inject 回调经 engine.setServices
  // 原子替换；置空或不满足契约立即回退 v1.1.2 的 proposal 模式。
  let registry = null
  let sessionPersistence = null
  let registryAvailable = false
  let registryLastApplied = null
  let lastRegistryWarnings = []
  let lastRegistrySkippedReason = null

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

  // v1.2.1（BLOCKER 1）：Cordis 的 ctx.inject(deps, cb) 回调签名是 (injectCtx, config)，
  // 服务必须从回调参数（注入后的 Context）读取。index.js 取到后经此入口运行时原子替换；
  // 置 null / 服务不满足契约方法集时立即恢复 proposal（registryAvailable=false）。
  engine.setServices = function setServices(handle) {
    const next = plainObject(handle) ? handle : null
    registry = next && plainObject(next.workspaceRegistry) ? next.workspaceRegistry : null
    sessionPersistence = next && plainObject(next.sessionPersistence) ? next.sessionPersistence : null
    registryAvailable = registryServicesUsable(registry, sessionPersistence)
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
    // v6：目录创建统一走 guardedMkdir（plugin-sync/storages 被符号链接劫持时拒绝，
    // 不在宿主目录创建任何目录）。共享祖先必须逐级创建，因此串行执行。
    const initRound = { round: 'init' }
    let initDirError = null
    for (const rel of ['staging', 'store/blobs', 'conflicts', 'logs']) {
      const made = await guardedMkdir(path.join(dataDir, rel), { dshHome, round: initRound })
      if (!made.ok) { initDirError = made.error; break }
    }
    // v5：init 即校验数据目录边界；storages 为符号链接等危险配置只记错误，不抛出
    // （后续所有写入会被 safe-writer 逐次拒绝）。
    const rootCheck = await assertSafeRoot(dataDir, { dshHome })
    const cfg = await loadConfig(dataDir, rowConfig)
    settings = cfg.settings
    configFile = cfg.file
    store = createStore(dataDir, { dshHome })
    log = createLogger(path.join(dataDir, 'logs'), { dshHome })
    if (!rootCheck.ok) await log.error(`插件数据目录校验失败，所有写入将被拒绝：${rootCheck.error.message}`)
    if (initDirError) await log.error(`插件目录创建被拒绝：${initDirError.message}`)
    if (cfg.seedError) await log.warn(`config.json 播种被拒绝：${cfg.seedError.message}`)
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
    log?.newRound?.()
    // v1.2.1：每轮按契约方法集重判服务可用性；不可用则整轮保持 v1.1.2 的 proposal 行为
    registryAvailable = registryServicesUsable(registry, sessionPersistence)
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
      workspaceWriteMode: registryAvailable ? 'registry' : 'proposal',
      registryAvailable,
      registryApplied: null,
      registrySkippedReason: null,
      registryWarnings: [],
      proposalPending,
      proposalPath,
      proposalPathSafe,
      at: new Date().toISOString(),
    }
    try {
      // 本轮唯一拒绝缓存键：safe-writer 对失败写目标在 round 存活期内不再重试。
      const round = { round: 'cycle' }
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
      // R3（BLOCKER 3）：只有「本轮全部合并都成功（每次 merged:true 且无 errors）」的产物才允许
      // 进入 registry 应用。v1.2.2（BLOCKER）：workspaceMergeFailed 本轮累计、绝不清除——
      // 一轮内多次合并（首个 peer 拉回坏条目 → 后续 peer 拉回好数据）时，任何一次失败
      // 都置位且不被后续成功恢复，否则早期失败会被最后一次成功合并掩盖、错误产物仍被应用。
      // workspaceApplyDoc 始终保存最后一次合并的产物（供审计），门禁只看累计标记。
      // 远端路径已经 pathRemap 本地化（R4：applier 不再做第二次映射）。
      let workspaceMergeFailed = false
      let workspaceApplyDoc = null
      const mergeWorkspaceIndex = async () => {
        // registry 模式下 proposal 仍生成（审计/降级用），但不再提示“待人工应用”
        const result = await mergeWorkspace({ dshHome, stagingRoot, dataDir, pathRemap: settings.pathRemap, log, round, proposalNotice: !registryAvailable })
        if (result.merged) summary.merged++
        if (result.merged !== true || (result.errors?.length ?? 0) > 0 || !plainObject(result.workspace)) {
          workspaceMergeFailed = true
          workspaceApplyDoc = null
        } else {
          workspaceApplyDoc = result.workspace
        }
        proposalPending = result.proposalPending ?? proposalPending
        proposalPath = result.proposalPath ?? proposalPath
        proposalPathSafe = result.proposalPathSafe ?? proposalPathSafe
        summary.proposalPending = proposalPending
        summary.proposalPath = proposalPath
        summary.proposalPathSafe = proposalPathSafe
        await recordErrors(result)
      }
      const exported = await exportAll(dshHome, stagingRoot, settings, { skipWorkspace: true, round })
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
            // v5：拉取落盘经 safe-writer；被拒绝的目标（含符号链接劫持）本轮不再重试。
            const written = await guardedWrite({ root: stagingRoot, rel, bytes: buf, dshHome, round })
            if (!written.ok) throw written.error
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
        round,
      })
      summary.applied = result.applied.length
      summary.conflicts = result.conflicts.length
      await recordErrors(result)

      // v1.2.1：apply 之后通过宿主 registry 事务 API 应用工作区索引，但只应用「本轮全部合并
      // 成功且校验通过」的产物（R3 + v1.2.2 失败累计）——任何一次合并失败/有错误/校验不过
      // 一律整轮零 mutation；applier 内部还会再自检一次。applier 捕获全部单条失败为 warning；
      // fatal 并入本轮 errors。跳过原因写入 registrySkippedReason。
      if (registryAvailable) {
        if (workspaceMergeFailed) {
          const msg = 'registry: 本轮存在工作区合并失败（任一次 merged:false 或合并错误，后续合并成功也不恢复），跳过 registry 应用（整轮零 mutation）'
          if (!warnings.includes(msg)) warnings.push(msg)
          await log.warn(msg)
          summary.registrySkippedReason = msg
          lastRegistryWarnings = []
          lastRegistrySkippedReason = msg
        } else {
          const validation = validateWorkspaceDoc(workspaceApplyDoc, { requireEnvelope: true })
          if (validation.length) {
            const msg = `registry: 合并产物校验失败，跳过 registry 应用（零 mutation）：${validation.join('; ')}`
            errors.push(msg)
            await log.error(msg)
            summary.registrySkippedReason = msg
            lastRegistryWarnings = []
            lastRegistrySkippedReason = msg
          } else {
            const reg = await applyRegistryIndex({ registry, sessionPersistence, doc: workspaceApplyDoc, log })
            summary.registryApplied = reg.registryApplied
            summary.registryWarnings = reg.registryWarnings
            lastRegistryWarnings = reg.registryWarnings
            lastRegistrySkippedReason = null
            if (reg.error) {
              errors.push(reg.error)
              await log.error(reg.error)
            } else {
              registryLastApplied = { at: summary.at, ...reg.registryApplied }
            }
          }
        }
      } else {
        lastRegistryWarnings = []
        lastRegistrySkippedReason = null
      }

      const remoteHashes = {}
      for (const rel of Object.keys(result.remoteHashes)) {
        if (stagingIndex[rel]) remoteHashes[rel] = result.remoteHashes[rel]
      }
      state.localHashes = result.localHashes
      state.remoteHashes = remoteHashes
      state.declined = result.declined
      state.unresolvedConflict = result.unresolvedConflict
      state.lastRun = summary.at
      const saved = await guardedWrite({ root: dataDir, rel: 'state.json', bytes: JSON.stringify(state, null, 2), dshHome, round })
      if (!saved.ok) {
        const msg = `state.json 持久化失败：${saved.error.message}`
        errors.push(msg)
        await log.error(msg)
      }
    } catch (e) {
      const msg = e?.message || String(e)
      errors.push(msg)
      await log.error(`cycle 失败: ${msg}`)
    } finally {
      inFlight = false
      lastRun = summary.at
      lastResult = summary
      // v6：日志自身的拒绝（硬链接/符号链接/危险配置）不再静默，并入本轮 errors[]。
      for (const message of (log?.drainRejected?.() || [])) {
        if (!errors.includes(message)) errors.push(message)
      }
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
      workspaceWriteMode: registryAvailable ? 'registry' : 'proposal',
      registryAvailable,
      registryLastApplied,
      registrySkippedReason: lastRegistrySkippedReason,
      registryWarnings: lastRegistryWarnings,
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
