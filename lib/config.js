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
  return typeof v === 'string' && (/^\*{8}$/.test(v) || (/^[^*]{4}\*{4}$/.test(v)))
}

// v1.4.1（B6）：保存入口统一过滤——顶层 token / peers[].token 为打码串或空串时从 set 剔除。
// peers 是整组替换（deepMerge 不做数组合并），被打码/留空的 peer token 用当前配置里的真实值
// （同名优先，其次同下标）回填，保证“只改其他字段保存”不丢凭据；current 为空时仅剔除。
export function sanitizeConfigSet(set, current = null) {
  if (!isPlainObject(set)) return set
  const out = { ...set }
  if (Object.hasOwn(out, 'token') && (out.token === '' || looksMasked(out.token))) {
    delete out.token
  }
  if (Array.isArray(out.peers)) {
    const cur = current && Array.isArray(current.peers) ? current.peers : []
    out.peers = out.peers.map((p, i) => {
      if (!isPlainObject(p)) return p
      if (!Object.hasOwn(p, 'token') || p.token === '' || looksMasked(p.token)) {
        // 只有“身份唯一可判定”时才回填 token，避免重名/未命名 peer 串用他人凭据。
        const named = typeof p.name === 'string' && p.name.length > 0
        const sameName = named ? cur.filter((c) => isPlainObject(c) && c.name === p.name && typeof c.token === 'string' && c.token) : []
        let tok
        if (named && sameName.length === 1) tok = sameName[0].token
        else if (!named && cur.length === 1 && isPlainObject(cur[0]) && !cur[0].name && typeof cur[0].token === 'string') tok = cur[0].token
        if (tok) return { ...p, token: tok }
        const { token: _omit, ...rest } = p
        return rest
      }
      return p
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
