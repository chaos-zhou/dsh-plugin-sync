import path from 'node:path'
import os from 'node:os'
import { readJson } from './util.js'
import { guardedWrite } from './safe-writer.js'

export const DEFAULTS = {
  deviceName: '',
  role: 'peer',
  listenPort: 8789,
  bindHost: '0.0.0.0',
  token: '',
  peers: [],
  hubUrl: '',
  intervalSec: 300,
  settleSec: 120,
  dshHome: '',
  pathRemap: [],
  applyConfig: false,
  autoApply: true,
  repo: 'chaos-zhou/dsh-plugin-sync',
  updateCheck: false,
  autoApplyUpdate: false,
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

export function resolveDshHome(cfg) {
  return cfg.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

// v1.4.1（B7）：短 token（≤12）整体打码不保留任何字符；长 token 最多保留前 4 位。
export function maskToken(token) {
  if (!token) return ''
  const s = String(token)
  if (s.length <= 12) return '********'
  return s.slice(0, 4) + '****'
}

// v1.4.1（B7）：输出视图统一脱敏——顶层 token 与 peers[].token 都打码。
export function publicSettings(settings) {
  const { token, ...rest } = settings
  const peers = Array.isArray(rest.peers)
    ? rest.peers.map((p) => (isPlainObject(p) && p.token ? { ...p, token: maskToken(p.token) } : p))
    : rest.peers
  return { ...rest, token: maskToken(token), peers }
}

// v1.4.1（B6）：疑似打码串（maskToken 输出形态）即视为“不修改”。正常 token 为 base64url/hex，
// 不含 '*'；若用户确需设置含 '*' 的 token，请改用直接编辑 config.json。
export function looksMasked(v) {
  return typeof v === 'string' && (/^\*+$/.test(v) || (/^.{1,6}\*{4}$/.test(v)))
}

// v1.4.1（B6）：保存入口统一过滤。凭据只允许“显式真实值”或“与当前脱敏值相同的占位符”；
// 身份不唯一（重名/未命名 peer）或无法唯一确定原凭据时，直接拒绝保存，绝不猜/串用/静默删除。
export function sanitizeConfigSet(set, current = null) {
  if (!isPlainObject(set)) return set
  const out = { ...set }
  const cur = isPlainObject(current) ? current : {}
  const curPeers = Array.isArray(cur.peers) ? cur.peers : []

  // 顶层 token：空/脱敏/与当前脱敏值一致 → 保留当前真实值（不写入）。
  if (Object.hasOwn(out, 'token')) {
    const v = out.token
    if (v === '' || looksMasked(v) || (cur.token && v === maskToken(cur.token))) delete out.token
  }

  if (Array.isArray(out.peers)) {
    // 身份唯一性：提交数组与当前配置中都不允许重名（含空名重复）。
    const identity = (p) => (isPlainObject(p) && typeof p.name === 'string' && p.name.length > 0 ? `name:${p.name}` : '')
    const submitted = out.peers.map(identity)
    const currentNames = curPeers.map(identity)
    const dup = (arr) => arr.some((id, i) => id && arr.indexOf(id) !== i)
    const unnamed = (arr) => arr.filter((id) => !id).length
    if (dup(submitted) || dup(currentNames) || unnamed(submitted) > 1 || unnamed(currentNames) > 1) {
      throw new Error('peers 存在重名/多个未命名条目，无法唯一确定凭据；请先使用唯一 name 再保存')
    }
    out.peers = out.peers.map((p, i) => {
      if (!isPlainObject(p)) return p
      const masked = !Object.hasOwn(p, 'token') || p.token === '' || looksMasked(p.token) || p.token === maskToken(curPeers[i]?.token)
      if (!masked) return p
      const src = p.name
        ? curPeers.find((c) => isPlainObject(c) && c.name === p.name && typeof c.token === 'string')
        : (isPlainObject(curPeers[i]) && !curPeers[i].name && typeof curPeers[i].token === 'string' ? curPeers[i] : null)
      if (!src?.token) throw new Error(`无法唯一确定 peer（${p.name || '未命名'}）的 token；请显式传入真实 token`)
      return { ...p, token: src.token }
    })
  }
  return out
}

export async function loadConfig(dataDir, rowConfig) {
  const file = path.join(dataDir, 'config.json')
  const dshHome = path.dirname(dataDir)
  const persisted = await readJson(file, null)
  if (persisted) {
    return { settings: deepMerge(DEFAULTS, persisted), file, seeded: false }
  }
  const seeded = deepMerge(DEFAULTS, rowConfig || {})
  // 播种失败（如 storages 为符号链接的危险配置）不阻断启动：设置保存在内存中。
  const written = await guardedWrite({ root: dataDir, rel: 'config.json', bytes: JSON.stringify(seeded, null, 2), dshHome })
  return { settings: seeded, file, seeded: true, seedError: written.ok ? null : written.error }
}

export async function saveConfig(file, settings) {
  const dataDir = path.dirname(file)
  const written = await guardedWrite({ root: dataDir, rel: path.basename(file), bytes: JSON.stringify(settings, null, 2), dshHome: path.dirname(dataDir) })
  if (!written.ok) throw written.error
}
