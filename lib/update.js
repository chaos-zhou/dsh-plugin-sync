// v1.4.0 插件自更新：GitHub 检查最新版本 → 下载 tarball → 安全解包校验 → 备份后白名单替换。
// 安全边界（FIX-SPEC v1.4.0）：
// - 只动插件自身安装目录（installRoot 必须含 name=dsh-plugin-sync 的 package.json）与 dataDir/updates/；
// - 下载 ≤20MB、30s 超时；tar 解包拒绝绝对路径/.. /符号链接/硬链接/非普通文件，校验和逐一验证；
// - 校验解包产物 package.json name+version；替换前备份到 backup-<old>-<ts>/，失败回滚；
// - 任何失败返回结构化 {applied:false, error}，绝不留下半替换状态。
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { readJson } from './util.js'
import { guardedWrite, guardedRemove, guardedMkdir } from './safe-writer.js'

export const PLUGIN_NAME = 'dsh-plugin-sync'
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
export const DOWNLOAD_TIMEOUT_MS = 30000
const MAX_TAR_ENTRIES = 2000
const MAX_TAR_TOTAL_BYTES = 64 * 1024 * 1024
// 白名单：更新只替换这些安装目录内容；.git、node_modules、数据文件一律不动。
const WHITELIST_FILES = new Set(['index.js', 'hub.mjs', 'cordis.patch.yml', 'package.json', 'icon.svg', 'README.md'])
const WHITELIST_DIRS = new Set(['lib', 'bin', 'locale'])

const SEMVER_RE = /^\d+\.\d+\.\d+$/

function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v || '').replace(/^v/, ''))
  return m ? [Number(m[0].split('.')[0]), Number(m[0].split('.')[1]), Number(m[0].split('.')[2])] : null
}

export function cmpSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

function isSafeTarName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 4096) return false
  if (name.startsWith('/') || name.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(name)) return false
  if (name.includes('\\') || name.includes('\0')) return false
  return name.split('/').every((part) => part && part !== '.' && part !== '..')
}

function isWhitelisted(rel) {
  if (WHITELIST_FILES.has(rel)) return true
  const top = rel.split('/')[0]
  return WHITELIST_DIRS.has(top)
}

function stripV(tag) {
  return String(tag || '').replace(/^v/, '')
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      signal: ac.signal,
      headers: { 'user-agent': PLUGIN_NAME, accept: 'application/vnd.github+json' },
    })
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}: ${url}`), { statusCode: res.status })
    }
    const text = await res.text()
    if (text.length > 4 * 1024 * 1024) throw new Error('GitHub 响应超过 4MB 上限')
    return JSON.parse(text)
  } catch (e) {
    ac.abort(e)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// GET releases/latest；404（无 release）时回退 /tags 取最大 semver。
// v1.4.1（N3）：latestTag 保留原始 tag（可能无 v 前缀），applyUpdate 下载时优先使用它。
export async function checkUpdate({ repo, currentVersion, fetchImpl, timeoutMs = 10000 }) {
  const doFetch = fetchImpl || globalThis.fetch
  const out = { current: currentVersion, latest: null, latestTag: null, available: false, notesUrl: null, error: null }
  const base = `https://api.github.com/repos/${repo}`
  try {
    let rel
    try {
      rel = await fetchJson(doFetch, `${base}/releases/latest`, timeoutMs)
      const tag = stripV(rel?.tag_name)
      if (!SEMVER_RE.test(tag)) throw new Error(`latest release tag 不是合法 semver：${rel?.tag_name}`)
      out.latest = tag
      out.latestTag = typeof rel?.tag_name === 'string' ? rel.tag_name : `v${tag}`
      out.notesUrl = typeof rel?.html_url === 'string' ? rel.html_url : null
    } catch (e) {
      if (e?.statusCode !== 404) throw e
      // 没有 GitHub Release 时回退 tags（每仓最多 100 个 tag，取最大 semver）
      const tags = await fetchJson(doFetch, `${base}/tags?per_page=100`, timeoutMs)
      if (!Array.isArray(tags)) throw new Error('tags 响应不是数组')
      const semverTags = tags.filter((t) => SEMVER_RE.test(stripV(t?.name)))
      if (!semverTags.length) throw new Error('仓库没有任何合法 semver tag')
      semverTags.sort((a, b) => cmpSemver(stripV(a.name), stripV(b.name)))
      const maxTag = semverTags[semverTags.length - 1]
      out.latest = stripV(maxTag.name)
      out.latestTag = maxTag.name
      out.notesUrl = `https://github.com/${repo}/releases/tag/${maxTag.name}`
    }
  } catch (e) {
    out.error = e?.message || String(e)
    return out
  }
  out.available = cmpSemver(out.latest, currentVersion) > 0
  return out
}

async function downloadLimited(fetchImpl, url, maxBytes, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`下载超时（${timeoutMs}ms）`)), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { 'user-agent': PLUGIN_NAME } })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
    const declared = res.headers.get('content-length')
    if (declared !== null && Number(declared) > maxBytes) {
      throw new Error(`下载超过 ${maxBytes} 字节上限`)
    }
    const chunks = []
    let size = 0
    if (res.body) {
      const reader = res.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) throw new Error(`下载超过 ${maxBytes} 字节上限`)
          chunks.push(Buffer.from(value))
        }
      } finally {
        reader.releaseLock()
      }
    }
    return Buffer.concat(chunks, size)
  } catch (e) {
    ac.abort(e)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function octal(bytes) {
  const text = bytes.toString('ascii').replace(/[\0 ]+$/g, '').trim()
  if (!/^[0-7]*$/.test(text)) return NaN
  return text.length ? parseInt(text, 8) : 0
}

function isZeroBlock(block) {
  return block.every((b) => b === 0)
}

function paxPath(data) {
  let offset = 0
  while (offset < data.length) {
    const nl = data.indexOf(0x0a, offset)
    if (nl < 0) break
    const line = data.subarray(offset, nl).toString('utf8')
    const sp = line.indexOf(' ')
    const len = sp > 0 ? Number(line.slice(0, sp)) : NaN
    if (!Number.isSafeInteger(len) || len <= sp + 1) break
    const kv = line.slice(sp + 1)
    const eq = kv.indexOf('=')
    if (eq > 0 && kv.slice(0, eq) === 'path') return kv.slice(eq + 1)
    offset += len
  }
  return null
}

// 手写 ustar/gnu tar 解析（codeload tar.gz 为 git archive 产物，类型有限）：
// 普通文件(0/'\0')、目录(5)、GNU 长名(L)、PAX 头(x，只取 path)、全局头(g，跳过)。
// 其余类型（符号链接 2、硬链接 1、设备等）一律拒绝。逐条校验 512 字节头校验和。
export function parseTar(buf) {
  const entries = []
  let offset = 0
  let longName = null
  let paxName = null
  let total = 0
  let headers = 0
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (isZeroBlock(header)) break
    // v1.4.1（B4）：所有 512 字节头（含 L/x/g/K 元数据头）都计入条目上限，
    // 防止用海量零成本元数据头撑爆解析时间/内存。
    headers++
    if (headers > MAX_TAR_ENTRIES) throw new Error(`tar 条目数（含元数据头）超过 ${MAX_TAR_ENTRIES} 上限`)
    const stored = octal(header.subarray(148, 156))
    if (!Number.isSafeInteger(stored)) throw new Error('tar 头校验和字段不合法')
    let sum = 0
    let sumSigned = 0
    for (let i = 0; i < 512; i++) {
      const b = i >= 148 && i < 156 ? 0x20 : header[i]
      sum += b
      sumSigned += b < 128 ? b : b - 256
    }
    if (sum !== stored && sumSigned !== stored) throw new Error('tar 头校验和不匹配（可能损坏或被篡改）')
    const size = octal(header.subarray(124, 136))
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > buf.length) {
      throw new Error('tar 条目大小不合法或超出包边界')
    }
    const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    const data = buf.subarray(offset + 512, offset + 512 + size)
    const padded = Math.ceil(size / 512) * 512
    offset += 512 + padded
    if (type === 'L') {
      longName = data.subarray(0, size).toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type === 'x') {
      paxName = paxPath(data.subarray(0, size))
      continue
    }
    if (type === 'g' || type === 'K') continue // 全局头/longlink 目标：不产生文件
    const name = longName ?? paxName ?? header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const full = prefix ? `${prefix}/${name}` : name
    longName = null
    paxName = null
    if (type === '0' || type === '\0') {
      if (!isSafeTarName(full)) throw new Error(`tar 条目路径不安全，拒绝：${JSON.stringify(full.slice(0, 200))}`)
      total += size
      if (total > MAX_TAR_TOTAL_BYTES) throw new Error(`tar 解包总量超过 ${MAX_TAR_TOTAL_BYTES} 字节上限`)
      const mode = octal(header.subarray(100, 108))
      entries.push({ name: full, type: 'file', size, data, mode: Number.isSafeInteger(mode) && mode > 0 ? mode & 0o7777 : 0o644 })
    } else if (type === '5') {
      // v1.4.1：真实 GitHub tarball 的目录条目以 '/' 结尾（如 "pkg/"、"pkg/lib/"），
      // 校验时先去掉尾部分隔符，再按普通相对路径检查；不以 '/' 判为非法。
      const dirName = full.replace(/\/+$/, '')
      if (!isSafeTarName(dirName)) throw new Error(`tar 目录路径不安全，拒绝：${JSON.stringify(full.slice(0, 200))}`)
      entries.push({ name: dirName, type: 'dir' })
    } else if (type === '1' || type === '2') {
      throw new Error(`tar 含硬链接/符号链接条目，拒绝：${JSON.stringify(full.slice(0, 200))}`)
    } else {
      throw new Error(`tar 条目类型不支持，拒绝：type=${JSON.stringify(type)} name=${JSON.stringify(full.slice(0, 200))}`)
    }
  }
  return entries
}

async function rmScratch(dir) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
}

// 收集安装目录里白名单范围内现存文件（供备份）；符号链接/非普通文件跳过（替换时才会显式拒绝）。
async function collectInstallFiles(installRoot) {
  const out = []
  async function walk(abs, rel) {
    let stat
    try {
      stat = await fsp.lstat(abs)
    } catch {
      return
    }
    if (stat.isFile()) out.push({ rel, abs, mode: stat.mode & 0o7777 })
    else if (stat.isDirectory()) {
      for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
        await walk(path.join(abs, entry.name), rel ? `${rel}/${entry.name}` : entry.name)
      }
    }
  }
  for (const name of WHITELIST_FILES) await walk(path.join(installRoot, name), name)
  for (const dir of WHITELIST_DIRS) await walk(path.join(installRoot, dir), dir)
  return out
}

// v1.4.1（B2）：回滚恢复被替换文件时保留原 mode（stat.mode & 0o7777，含可执行位）。
// 返回问题列表；非空表示自动回滚不完整，调用方必须把 backupDir 报给用户以便人工恢复。
async function rollback({ installRoot, backupDir, replaced, added, modes, dshHome }) {
  const problems = []
  for (const rel of added) {
    const removed = await guardedRemove({ root: installRoot, rel, dshHome })
    if (!removed.ok) problems.push(`回滚删除新增文件 ${rel} 失败：${removed.error.message}`)
  }
  for (const rel of replaced) {
    try {
      const bytes = await fsp.readFile(path.join(backupDir, rel))
      const written = await guardedWrite({ root: installRoot, rel, bytes, mode: modes.get(rel), dshHome })
      if (!written.ok) problems.push(`回滚恢复 ${rel} 失败：${written.error.message}`)
    } catch (e) {
      problems.push(`回滚读取备份 ${rel} 失败：${e?.message || e}`)
    }
  }
  return problems
}

// 更新主流程。任何一步失败：清理临时文件、返回 {applied:false, error}，安装目录保持原状
// （替换阶段失败则用备份回滚已替换文件）。
// v1.4.1：B3 跨进程锁（dataDir/updates/.lock，引擎自动更新与 CLI/admin 手动更新共用）；
// B1 备份目录独占随机创建且备份写入走 guardedWrite；B2 替换前先登记 planned replaced/added。
export async function applyUpdate({ repo, version, tag, installRoot, dataDir, log, fetchImpl, force = false }) {
  const doFetch = fetchImpl || globalThis.fetch
  const target = stripV(version)
  const updatesDir = path.join(dataDir, 'updates')
  const fail = (error) => ({ applied: false, fromVersion: null, toVersion: target, restartRequired: false, backupDir: null, error })
  if (!SEMVER_RE.test(target)) return fail(`目标版本不是合法 semver：${JSON.stringify(version)}`)
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(`repo 不合法：${JSON.stringify(repo)}`)
  // v1.4.1（N3）：下载用原始 tag（缺省 v{version}）；限定安全字符防止拼进 URL 的路径注入。
  const downloadTag = typeof tag === 'string' && tag ? tag : `v${target}`
  if (!/^[\w.-]{1,120}$/.test(downloadTag)) return fail(`tag 不合法：${JSON.stringify(tag)}`)

  // 安装目录自检：必须本身就是本插件的安装目录（含匹配 package.json），否则拒绝。
  let installed = null
  try {
    installed = JSON.parse(await fsp.readFile(path.join(installRoot, 'package.json'), 'utf8'))
  } catch {}
  if (!installed || installed.name !== PLUGIN_NAME) {
    return fail(`安装目录 ${installRoot} 不含 name=${PLUGIN_NAME} 的 package.json，拒绝更新非本插件目录`)
  }
  const fromVersion = typeof installed.version === 'string' ? installed.version : '0.0.0'
  if (!force && cmpSemver(target, fromVersion) <= 0) {
    return fail(`目标版本 ${target} 不高于已安装版本 ${fromVersion}（如需强制安装请显式 force）`)
  }

  const dshHome = path.dirname(dataDir)
  const made = await guardedMkdir(updatesDir, { dshHome })
  if (!made.ok) return fail(`创建更新目录失败：${made.error.message}`)

  // v1.4.1（B3）：跨进程互斥锁。wx 独占创建；finally 必删；持锁期间其余进程/协程的
  // 更新请求一律拒绝，避免两路更新交错写同一安装目录。
  const lockPath = path.join(updatesDir, '.lock')
  let lockHandle = null
  try {
    lockHandle = await fsp.open(lockPath, 'wx', 0o600)
    await lockHandle.writeFile(`${process.pid} ${new Date().toISOString()}\n`)
  } catch (e) {
    if (e?.code === 'EEXIST') {
      return fail(`已有更新在进行（${lockPath} 被占用；若确认没有更新进程在运行，可手动删除该文件后重试）`)
    }
    return fail(`创建更新锁失败：${e?.message || e}`)
  }

  const downloadPath = path.join(updatesDir, `download-${target}.tgz`)
  const extractDir = path.join(updatesDir, `extract-${target}`)
  let backupDir = null
  let backupDirOwned = false
  let replaced = []
  let added = []
  let modes = new Map()
  try {
    // 1) 下载（≤20MB / 30s）
    const bytes = await downloadLimited(doFetch, `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(downloadTag)}`, MAX_DOWNLOAD_BYTES, DOWNLOAD_TIMEOUT_MS)
    const saved = await guardedWrite({ root: updatesDir, rel: path.basename(downloadPath), bytes, dshHome })
    if (!saved.ok) return fail(`写入下载文件失败：${saved.error.message}`)

    // 2) 安全解包（v1.4.1 B4：限制 gunzip 输出上限，gzip 炸弹在此被拒绝）
    let tarBuf
    try {
      tarBuf = zlib.gunzipSync(bytes, { maxOutputLength: MAX_TAR_TOTAL_BYTES + 1 })
    } catch (e) {
      throw new Error(`gzip 解压失败（疑似 gzip 炸弹：解压输出超过 ${MAX_TAR_TOTAL_BYTES} 字节上限）：${e?.message || e}`)
    }
    const entries = parseTar(tarBuf)
    await rmScratch(extractDir)
    const topLevel = new Set()
    for (const entry of entries) {
      const dest = path.join(extractDir, entry.name)
      const realExtract = path.resolve(extractDir)
      if (!dest.startsWith(realExtract + path.sep)) throw new Error(`解包路径越界：${entry.name}`)
      if (entry.type === 'dir') {
        await fsp.mkdir(dest, { recursive: true })
      } else {
        topLevel.add(entry.name.split('/')[0])
        await fsp.mkdir(path.dirname(dest), { recursive: true })
        await fsp.writeFile(dest, entry.data, { mode: entry.mode })
      }
    }
    if (topLevel.size !== 1) throw new Error(`tar 顶层目录应为唯一目录，实际 ${topLevel.size} 个`)
    const top = [...topLevel][0]

    // 3) 校验包身份
    let pkg
    try {
      pkg = JSON.parse(await fsp.readFile(path.join(extractDir, top, 'package.json'), 'utf8'))
    } catch (e) {
      throw new Error(`读取新包 package.json 失败：${e?.message || e}`)
    }
    if (pkg?.name !== PLUGIN_NAME) throw new Error(`新包 name 不匹配：${JSON.stringify(pkg?.name)}，期望 ${PLUGIN_NAME}`)
    if (pkg?.version !== target) throw new Error(`新包 version 不匹配：${JSON.stringify(pkg?.version)}，期望 ${target}`)

    // 4) 备份当前白名单文件（v1.4.1 B1：目录独占随机创建 + 备份写入全部走 guardedWrite）。
    // 备份失败在替换前中止——此时安装目录零改动。
    const installFiles = await collectInstallFiles(installRoot)
    backupDir = path.join(updatesDir, `backup-${fromVersion}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`)
    try {
      await fsp.mkdir(backupDir, { recursive: false, mode: 0o700 })
      backupDirOwned = true
    } catch (e) {
      throw new Error(`备份目录创建失败（须独占新建，已存在/被预置为链接均拒绝）：${backupDir}：${e?.message || e}`)
    }
    for (const file of installFiles) {
      const bytes = await fsp.readFile(file.abs)
      const written = await guardedWrite({ root: backupDir, rel: file.rel, bytes, mode: file.mode, dshHome })
      if (!written.ok) throw new Error(`备份 ${file.rel} 失败：${written.error.message}`)
    }

    // 5) 白名单原子替换（临时文件 + rename；新包白名单外文件不动）。
    // v1.4.1（B2）：先登记全部 planned replaced/added 再动手写——即使某次 guardedWrite
    // 在 rename 之后的复核阶段报错（内容其实已落盘），登记里也有该文件，回滚能覆盖它。
    const newFiles = entries.filter((e) => e.type === 'file' && e.name.startsWith(top + '/') && isWhitelisted(e.name.slice(top.length + 1)))
    modes = new Map(installFiles.map((f) => [f.rel, f.mode]))
    for (const entry of newFiles) {
      const rel = entry.name.slice(top.length + 1)
      if (installFiles.some((f) => f.rel === rel)) replaced.push(rel)
      else added.push(rel)
    }
    // manifest 在替换前写入备份目录：即使替换中途失败/回滚不完整，人工恢复也有清单可查。
    const manifestBytes = Buffer.from(JSON.stringify({ from: fromVersion, to: target, tag: downloadTag, replaced, added, at: new Date().toISOString() }, null, 2))
    const manifestWritten = await guardedWrite({ root: backupDir, rel: 'manifest.json', bytes: manifestBytes, dshHome })
    if (!manifestWritten.ok) throw new Error(`写备份 manifest 失败：${manifestWritten.error.message}`)
    for (const entry of newFiles) {
      const rel = entry.name.slice(top.length + 1)
      const written = await guardedWrite({ root: installRoot, rel, bytes: entry.data, mode: entry.mode, dshHome })
      if (!written.ok) throw new Error(`替换 ${rel} 失败：${written.error.message}`)
    }

    // 6) 清理临时文件 + 写 pending 状态
    await rmScratch(extractDir)
    await fsp.rm(downloadPath, { force: true }).catch(() => {})
    const state = { pendingVersion: target, appliedAt: new Date().toISOString(), fromVersion, restartRequired: true }
    const stateWritten = await guardedWrite({ root: updatesDir, rel: 'state.json', bytes: JSON.stringify(state, null, 2), dshHome })
    if (!stateWritten.ok) throw new Error(`写 pending 状态失败：${stateWritten.error.message}`)
    await log?.info?.(`已更新插件 ${fromVersion} → ${target}，重启 DSH 后生效（备份：${backupDir}）`)
    return { applied: true, fromVersion, toVersion: target, restartRequired: true, backupDir, error: null }
  } catch (e) {
    const message = e?.message || String(e)
    // 只有替换阶段失败（replaced/added 非空）才需要回滚；下载/解包/校验/备份失败时
    // 安装目录尚未被改动（零副作用），只清理半成品备份目录。
    let rollbackProblems = []
    if (backupDir) {
      if (replaced.length || added.length) {
        rollbackProblems = await rollback({ installRoot, backupDir, replaced, added, modes, dshHome })
      } else if (backupDirOwned) {
        // 仅清理本进程独占创建的半成品备份；预置的同名目录/链接不是我们创建的，不得触碰。
        await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {})
      }
    }
    await rmScratch(extractDir)
    await fsp.rm(downloadPath, { force: true }).catch(() => {})
    await log?.error?.(`更新失败：${message}${rollbackProblems.length ? '；回滚问题：' + rollbackProblems.join('; ') : ''}`)
    // v1.4.1（B2）：回滚不完整时保留 backupDir（非 null）并在 error 中列出问题，便于人工恢复。
    return {
      applied: false,
      fromVersion,
      toVersion: target,
      restartRequired: false,
      backupDir: rollbackProblems.length ? backupDir : null,
      error: rollbackProblems.length ? `${message}（回滚未完成，备份保留在 ${backupDir}，需人工恢复。回滚问题：${rollbackProblems.join('; ')}）` : message,
    }
  } finally {
    await lockHandle.close().catch(() => {})
    await fsp.rm(lockPath, { force: true }).catch(() => {})
  }
}

export async function readUpdateState({ dataDir }) {
  return readJson(path.join(dataDir, 'updates', 'state.json'), null)
}

// 当运行版本已经等于 pendingVersion（宿主重启加载了新版本）时清除「待重启」标记。
export async function clearPending({ dataDir }) {
  const updatesDir = path.join(dataDir, 'updates')
  const state = await readJson(path.join(updatesDir, 'state.json'), null)
  if (!state || !state.pendingVersion) return
  const written = await guardedWrite({ root: updatesDir, rel: 'state.json', bytes: JSON.stringify({ ...state, pendingVersion: null, restartRequired: false, clearedAt: new Date().toISOString() }, null, 2), dshHome: path.dirname(dataDir) })
  if (!written.ok) throw written.error
}
