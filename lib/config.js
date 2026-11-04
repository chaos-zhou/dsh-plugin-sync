import path from 'node:path'
import os from 'node:os'
import { readJson } from './util.js'
import { guardedWrite } from './safe-writer.js'

const DEFAULTS = {
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

export function maskToken(token) {
  if (!token) return ''
  return token.slice(0, 6) + '******'
}

export function publicSettings(settings) {
  const { token, ...rest } = settings
  return { ...rest, token: maskToken(token) }
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
