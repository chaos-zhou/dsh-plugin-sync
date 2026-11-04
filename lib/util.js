import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex')
}

export async function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1')
    const s = fs.createReadStream(file)
    s.on('data', (d) => h.update(d))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

export async function atomicWrite(file, data) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

export async function atomicCopy(src, dst) {
  await ensureDir(path.dirname(dst))
  const tmp = `${dst}.tmp-${process.pid}`
  await fsp.copyFile(src, tmp)
  await fsp.rename(tmp, dst)
}

// 三态读取：missing（ENOENT）/ parse-error / read-error（非 ENOENT），调用方据此决定拒写策略
export async function readJsonStatus(file) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return { state: 'missing', value: null, error: e }
    return { state: 'read-error', value: null, error: e }
  }
  try {
    return { state: 'ok', value: JSON.parse(text), error: null }
  } catch (e) {
    return { state: 'parse-error', value: null, error: e }
  }
}

export async function readJson(file, fallback) {
  const r = await readJsonStatus(file)
  return r.state === 'ok' ? r.value : fallback
}

export async function writeJson(file, value) {
  await atomicWrite(file, JSON.stringify(value, null, 2))
}

export function safeJoin(root, rel) {
  const p = path.resolve(root, rel)
  const r = path.resolve(root)
  if (p !== r && !p.startsWith(r + path.sep)) return null
  return p
}

export function relToConflictName(rel, deviceName, ts) {
  return `${rel.split('/').join('__')}.conflict-${deviceName}-${ts}`
}

const SKIP_DIRS = new Set(['plugin-sync', 'node_modules', 'electron', 'speech-to-text', 'cache', 'llm-deepseek'])
const SKIP_FILES = new Set(['.credentials.yaml', '.anonymous-user-id'])

export function isSkipped(relPath) {
  const parts = relPath.split('/')
  for (const part of parts.slice(0, -1)) {
    if (SKIP_DIRS.has(part)) return true
  }
  const base = parts[parts.length - 1]
  if (SKIP_FILES.has(base) || base.endsWith('.lock')) return true
  if (base.startsWith('.tmp-')) return true
  return false
}

export async function listFiles(root, base = root, out = []) {
  let entries
  try {
    entries = await fsp.readdir(base, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(base, e.name)
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      await listFiles(root, full, out)
    } else if (e.isFile()) {
      if (isSkipped(rel)) continue
      out.push({ rel, full })
    }
  }
  return out
}

export function isQuiet(mtimeMs, settleSec, now = Date.now()) {
  return now - mtimeMs > settleSec * 1000
}
