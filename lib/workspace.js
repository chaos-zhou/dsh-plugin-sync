import path from 'node:path'
import fsp from 'node:fs/promises'
import { writeJson } from './util.js'
import { createLogger } from './log.js'

const BACKUP_KEEP = 5
// 兼容旧格式（秒级）与 v2 新格式（毫秒+pid+自增），清理规则对两者生效
const BACKUP_RE = /^workspace\.json\.bak-\d{8}-\d{6}(-\d{3}-\d+-\d+)?$/
const KNOWN_ENTRY_FIELDS = new Set(['path', 'title', 'sessionIds', 'createdAt', 'updatedAt'])
const MAX_IDS = 100000

// B5：备份恢复失败后冻结写入，直到进程重启。模块级状态，所有后续合并直接跳过。
let WORKSPACE_WRITE_FROZEN = null
let backupSeq = 0
let restoreSeq = 0

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

function hasOwn(o, k) {
  return Object.hasOwn(o, k)
}

// 远端不可信：所有以 id/键名为索引的字典一律用无原型对象构建，输出前用
// Object.fromEntries（CreateDataProperty 语义）转回普通对象，避免 __proto__ 污染
function toDict(v) {
  const d = Object.create(null)
  if (plainObject(v)) {
    for (const [k, x] of Object.entries(v)) d[k] = x
  }
  return d
}

function fromDict(d) {
  return Object.fromEntries(Object.entries(d))
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

// 远端视为不可信输入：只接受字符串数组，其余一律按空处理
function strArr(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
}

function plainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// B9：数组字段硬上限，超限截断并记 error（防止内存耗尽）
function capIds(arr, label, errors) {
  if (arr.length > MAX_IDS) {
    errors.push(`${label} 超过 ${MAX_IDS} 条上限，已截断`)
    return arr.slice(0, MAX_IDS)
  }
  return arr
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

// v2 信封：unit 为对象时按新 schema 校验与守卫；旧格式（无信封）仅做无损合并
function hasV2Envelope(doc) {
  return plainObject(doc) && plainObject(doc.unit)
}

function entryCoreErrors(ws) {
  if (!plainObject(ws)) return ['workspace 条目应为对象']
  const errs = []
  if (typeof ws.path !== 'string') errs.push('path 应为 string')
  if (typeof ws.title !== 'string') errs.push('title 应为 string')
  if (!Array.isArray(ws.sessionIds) || ws.sessionIds.some((x) => typeof x !== 'string')) {
    errs.push('sessionIds 应为字符串数组')
  }
  return errs
}

function entryTimestampErrors(ws) {
  if (!plainObject(ws)) return [] // N4：null/非对象条目不抛 TypeError
  const errs = []
  for (const k of ['createdAt', 'updatedAt']) {
    if (typeof ws[k] !== 'string') errs.push(`${k} 应为 string`)
  }
  return errs
}

// 返回错误列表（空数组 = 合法）。requireEnvelope: true 时无 v2 信封一律非法（B2）。
export function validateWorkspaceDoc(doc, opts = {}) {
  const requireEnvelope = opts.requireEnvelope === true
  if (!hasV2Envelope(doc)) {
    return requireEnvelope ? ['缺少 v2 信封（unit 应为对象）'] : []
  }
  const errs = []
  if (doc.unit.name !== 'workspace') {
    errs.push(`unit.name 应为 'workspace'，实际为 ${JSON.stringify(doc.unit.name)}`)
  }
  if (typeof doc.unit.version !== 'number') {
    errs.push(`unit.version 应为数字，实际为 ${JSON.stringify(doc.unit.version)}`)
  }
  if (!plainObject(doc.global)) {
    errs.push('global 应为对象')
    return errs
  }
  const g = doc.global
  if (typeof g.initialized !== 'boolean') errs.push('global.initialized 应为 boolean')
  for (const k of ['workspaceIds', 'archivedSessionIds', 'pinnedSessionIds']) {
    if (!Array.isArray(g[k])) errs.push(`global.${k} 应为数组`)
  }
  if (typeof g.defaultWorkspaceId !== 'string') errs.push('global.defaultWorkspaceId 应为 string')
  if (!plainObject(doc.tables) || !plainObject(doc.tables.workspaces)) {
    errs.push('tables.workspaces 应为对象')
    return errs
  }
  for (const [id, ws] of Object.entries(doc.tables.workspaces)) {
    for (const e of [...entryCoreErrors(ws), ...entryTimestampErrors(ws)]) {
      errs.push(`workspace ${id} ${e}`)
    }
  }
  // B3：引用完整性
  const tableIds = new Set(Object.keys(doc.tables.workspaces))
  if (Array.isArray(g.workspaceIds)) {
    for (const id of g.workspaceIds) {
      if (!tableIds.has(id)) errs.push(`global.workspaceIds 引用了不存在的 workspace：${id}`)
    }
  }
  if (typeof g.defaultWorkspaceId === 'string' && g.defaultWorkspaceId !== '' && !tableIds.has(g.defaultWorkspaceId)) {
    errs.push(`global.defaultWorkspaceId 引用了不存在的 workspace：${g.defaultWorkspaceId}`)
  }
  return errs
}

// B1：递归键路径（与测试的 collectKeys 语义一致：数组视为叶子）
function collectKeyPaths(v, prefix = '', out = []) {
  if (!plainObject(v)) return out
  for (const [k, val] of Object.entries(v)) {
    const p = `${prefix}/${k}`
    out.push(p)
    collectKeyPaths(val, p, out)
  }
  return out
}

function newerThan(remote, local) {
  if (typeof remote === 'number' && Number.isFinite(remote) && typeof local === 'number' && Number.isFinite(local)) {
    return remote > local
  }
  if (typeof remote === 'string' && typeof local === 'string') return remote > local
  return false // 类型不可比（如远端坏数据）时以本地为准
}

// B4：未知字段子树递归合并——保留本地全部子键，远端只补充本地缺失的键
function mergeUnknown(localVal, remoteVal) {
  if (plainObject(localVal) && plainObject(remoteVal)) {
    const d = toDict(localVal)
    for (const [k, v] of Object.entries(remoteVal)) {
      if (!hasOwn(d, k)) d[k] = v
    }
    return fromDict(d)
  }
  return localVal // 数组/原始值/类型不一致：本地为准
}

// 单个 workspace 条目合并：已知同步字段按原规则（updatedAt 定胜者、createdAt/updatedAt 取
// 数值极值、sessionIds 并集），未知字段本地递归保留 + 远端补缺
function mergeEntry(id, ws, rw, errors) {
  const hasRemote = Object.keys(rw).length > 0
  const winner = hasRemote && newerThan(rw.updatedAt, ws.updatedAt) ? rw : ws
  const loser = winner === rw ? ws : rw
  const d = Object.create(null)
  for (const k of ['path', 'title', 'createdAt', 'updatedAt']) {
    if (hasOwn(winner, k)) d[k] = winner[k]
    else if (hasOwn(loser, k)) d[k] = loser[k]
  }
  for (const [k, v] of Object.entries(ws)) {
    if (KNOWN_ENTRY_FIELDS.has(k)) continue
    d[k] = hasOwn(rw, k) ? mergeUnknown(v, rw[k]) : v
  }
  for (const [k, v] of Object.entries(rw)) {
    if (KNOWN_ENTRY_FIELDS.has(k) || hasOwn(d, k)) continue
    d[k] = v
  }
  const created = Math.min(num(ws.createdAt, Infinity), hasRemote ? num(rw.createdAt, Infinity) : Infinity)
  if (Number.isFinite(created)) d.createdAt = created
  const updated = Math.max(num(ws.updatedAt, -Infinity), hasRemote ? num(rw.updatedAt, -Infinity) : -Infinity)
  if (Number.isFinite(updated)) d.updatedAt = updated
  d.sessionIds = capIds(orderedUnion(strArr(ws.sessionIds), strArr(rw.sessionIds)), `workspace ${id} sessionIds`, errors)
  return fromDict(d)
}

// 无损合并：本地全部键原样保留（含未知字段），只对已知数组做并集
function mergeWorkspacesInner(local, remote, pathRemap) {
  const L = plainObject(local) ? local : emptyWorkspace()
  const R = plainObject(remote) ? remote : {}
  const lg = plainObject(L.global) ? L.global : {}
  const rg = plainObject(R.global) ? R.global : {}
  const localTables = plainObject(L.tables) && plainObject(L.tables.workspaces) ? L.tables.workspaces : {}
  const remoteTables = plainObject(R.tables) && plainObject(R.tables.workspaces) ? R.tables.workspaces : {}
  const strict = hasV2Envelope(L)
  const errors = []
  const remoteOnly = []
  const workspaces = Object.create(null)

  for (const [id, ws] of Object.entries(localTables)) {
    if (!plainObject(ws)) errors.push(`本地 workspace ${id} 不是对象，已按空条目处理`)
    const lws = plainObject(ws) ? ws : {}
    const rawRemote = remoteTables[id]
    const usableRemote = plainObject(rawRemote) && (!strict || entryCoreErrors(rawRemote).length === 0)
    if (rawRemote !== undefined && rawRemote !== null && !usableRemote) {
      errors.push(`远端 workspace ${id} 字段不合法，忽略远端版本：${entryCoreErrors(rawRemote).join('; ')}`)
    }
    const rw = usableRemote ? remapped(rawRemote, pathRemap) : {}
    workspaces[id] = mergeEntry(id, lws, rw, errors)
  }

  for (const [id, ws] of Object.entries(remoteTables)) {
    if (hasOwn(workspaces, id)) continue
    if (!plainObject(ws)) {
      errors.push(`远端 workspace ${id} 不是对象，已跳过`)
      continue
    }
    const rw = remapped(ws, pathRemap)
    if (strict) {
      const errs = [...entryCoreErrors(rw), ...entryTimestampErrors(rw)]
      if (errs.length) {
        errors.push(`远端独有 workspace ${id} 缺必需字段，已跳过：${errs.join('; ')}`)
        continue
      }
    }
    workspaces[id] = rw
    remoteOnly.push(id)
  }

  const gDict = toDict(lg)
  for (const [k, v] of Object.entries(rg)) {
    if (hasOwn(gDict, k)) continue
    if (k === 'initialized') {
      if (typeof v === 'boolean') gDict[k] = v
    } else {
      gDict[k] = v
    }
  }
  // B3：workspaceIds 只保留确实存在于结果表的 id（过滤并保持顺序）
  const idUnion = orderedUnion(orderedUnion(strArr(lg.workspaceIds), strArr(rg.workspaceIds)), remoteOnly)
  gDict.workspaceIds = capIds(
    idUnion.filter((id) => hasOwn(workspaces, id)),
    'global.workspaceIds',
    errors,
  )
  gDict.archivedSessionIds = setUnion(strArr(lg.archivedSessionIds), strArr(rg.archivedSessionIds))
  gDict.pinnedSessionIds = setUnion(strArr(lg.pinnedSessionIds), strArr(rg.pinnedSessionIds))
  // B3：defaultWorkspaceId 引用不完整时回退为本地值/空串
  let defaultId = lg.defaultWorkspaceId || rg.defaultWorkspaceId || ''
  if (defaultId && !hasOwn(workspaces, defaultId)) {
    defaultId = lg.defaultWorkspaceId && hasOwn(workspaces, lg.defaultWorkspaceId) ? lg.defaultWorkspaceId : ''
  }
  gDict.defaultWorkspaceId = defaultId

  const docDict = toDict(L)
  for (const [k, v] of Object.entries(R)) {
    if (!hasOwn(docDict, k)) docDict[k] = v
  }
  const doc = fromDict(docDict)
  doc.global = fromDict(gDict)
  const tablesDict = toDict(L.tables)
  if (plainObject(R.tables)) {
    for (const [k, v] of Object.entries(R.tables)) {
      if (!hasOwn(tablesDict, k)) tablesDict[k] = v
    }
  }
  const tables = fromDict(tablesDict)
  tables.workspaces = fromDict(workspaces)
  doc.tables = tables
  return { doc, errors }
}

export function mergeWorkspaces(local, remote, pathRemap) {
  return mergeWorkspacesInner(local, remote, pathRemap).doc
}

function backupStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  // 毫秒 + pid + 自增，保证同一秒内多次备份互不覆盖（N2）
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}-${process.pid}-${++backupSeq}`
}

async function pruneBackups(dir, keep) {
  let names
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  const baks = names.filter((n) => BACKUP_RE.test(n)).sort().reverse()
  for (const n of baks.slice(keep)) {
    try {
      await fsp.unlink(path.join(dir, n))
    } catch {
      // 删不掉的旧备份不影响主流程
    }
  }
}

// 三态读取：ok（含解析值）/ missing（ENOENT）/ parse-error / read-error（B2）
async function readJsonRawState(file) {
  let bytes
  try {
    bytes = await fsp.readFile(file)
  } catch (e) {
    if (e?.code === 'ENOENT') return { state: 'missing', bytes: null, value: null, error: e }
    return { state: 'read-error', bytes: null, value: null, error: e }
  }
  try {
    return { state: 'ok', bytes, value: JSON.parse(bytes.toString('utf8')) }
  } catch (e) {
    return { state: 'parse-error', bytes, value: null, error: e }
  }
}

// B5：写临时文件 + 原子 rename + 校验字节。返回 {ok} 结构化结果，不抛异常。
export async function restoreWorkspaceFromBackup(localPath, backupPath) {
  const tmp = `${localPath}.restore-${process.pid}-${++restoreSeq}`
  try {
    const bytes = await fsp.readFile(backupPath)
    await fsp.writeFile(tmp, bytes)
    await fsp.rename(tmp, localPath)
    const after = await fsp.readFile(localPath)
    if (!after.equals(bytes)) throw new Error('恢复后字节校验不一致')
    return { ok: true }
  } catch (e) {
    try {
      await fsp.rm(tmp, { force: true })
    } catch {
      // 清理临时文件失败不掩盖原始错误
    }
    return { ok: false, error: e?.message || String(e), backupPath }
  }
}

export async function mergeWorkspaceFiles(dshHome, stagingRoot, pathRemap, log) {
  const localPath = path.join(dshHome, 'storages', 'workspace.json')
  const stagingPath = path.join(stagingRoot, 'workspace', 'workspace.json')
  const logger = log || createLogger(path.join(dshHome, 'plugin-sync', 'logs'))
  const reject = async (error) => {
    await logger.error(`workspace.json 合并中止：${error}`)
    return { merged: false, error }
  }

  // B5：冻结期间所有合并直接跳过，并持续在日志中提示
  if (WORKSPACE_WRITE_FROZEN) {
    await logger.error(`workspace.json 写入已冻结（${WORKSPACE_WRITE_FROZEN}），本轮跳过合并；重启进程后恢复`)
    return { merged: false, skipped: true, error: `写入已冻结：${WORKSPACE_WRITE_FROZEN}` }
  }

  // 本地文件三态：缺失才允许继续；损坏/读取失败一律拒写并保留原文件（B2/B5）
  const localRaw = await readJsonRawState(localPath)
  if (localRaw.state === 'read-error') {
    return reject(`读取本地 workspace.json 失败（${localRaw.error?.message || localRaw.error}），拒绝写入`)
  }
  if (localRaw.state === 'parse-error') {
    return reject('本地 workspace.json JSON 解析失败，拒写并保留原文件')
  }
  const local = localRaw.state === 'ok' ? localRaw.value : null
  const origLocalBytes = localRaw.state === 'ok' ? localRaw.bytes : null

  if (local !== null && !plainObject(local)) {
    return reject('本地 workspace.json 不是 JSON 对象，拒绝覆盖')
  }

  // 远端（staging）文件：任何读取/解析失败都视为本轮没有远端数据
  const stagedRaw = await readJsonRawState(stagingPath)
  let remote = null
  if (stagedRaw.state === 'read-error' || stagedRaw.state === 'parse-error') {
    await logger.warn(`workspace.json：staging 远端文件读取/解析失败（${stagedRaw.state}），本轮按无远端处理`)
  } else if (stagedRaw.state === 'ok') {
    if (!plainObject(stagedRaw.value)) {
      await logger.warn('workspace.json：staging 里的远端文件不是 JSON 对象，已忽略')
    } else {
      remote = stagedRaw.value
    }
  }

  // 版本守卫：任一方声明了 v2 信封但版本不受支持 → 跳过合并，绝不改写文件
  for (const [label, doc] of [
    ['本地', local],
    ['远端', remote],
  ]) {
    if (hasV2Envelope(doc) && (typeof doc.unit.version !== 'number' || doc.unit.version !== 2)) {
      const error = `版本守卫：${label} unit.version=${JSON.stringify(doc.unit.version)} 不受支持（仅支持 2）`
      await logger.warn(`workspace.json ${error}，跳过合并`)
      return { merged: false, skipped: true, error }
    }
  }

  if (hasV2Envelope(remote) && remote.unit.name !== 'workspace') {
    return reject(`远端 unit.name=${JSON.stringify(remote.unit.name)} 不是 workspace，拒绝采信远端数据`)
  }

  // 本地文件必须合法：非法则不写任何文件，保持本地字节不变。
  // 旧格式（无信封）保持兼容（校验恒通过）；带信封的文档走完整校验。
  if (local !== null) {
    const errs = validateWorkspaceDoc(local)
    if (errs.length) return reject(`本地 workspace.json 校验失败：${errs.join('; ')}`)
  } else {
    // B2：本地缺失时，仅当远端为合法 v2 信封且完全通过校验才可创建
    if (!hasV2Envelope(remote)) {
      return reject('本地 workspace.json 缺失且远端无 v2 信封，不创建新文件')
    }
    const errs = validateWorkspaceDoc(remote, { requireEnvelope: true })
    if (errs.length) return reject(`本地缺失且远端校验失败，不创建残缺的 workspace.json：${errs.join('; ')}`)
  }

  const strictDoc = hasV2Envelope(local) || hasV2Envelope(remote)

  const { doc: merged, errors: entryErrors } = mergeWorkspacesInner(
    local || emptyWorkspace(),
    remote || emptyWorkspace(),
    pathRemap,
  )
  for (const e of entryErrors) await logger.error(`workspace.json ${e}`)

  // B1：写盘前检查本地递归键集不得缩减，发现缩减即拒写
  const localKeyPaths = collectKeyPaths(local || emptyWorkspace())
  if (localKeyPaths.length) {
    const mergedKeySet = new Set(collectKeyPaths(merged))
    const missing = localKeyPaths.filter((p) => !mergedKeySet.has(p))
    if (missing.length) {
      return reject(`合并结果丢失本地键（${missing.length} 处）：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`)
    }
  }

  // 写盘前校验（先校验，后写入）
  let mergedErrs
  try {
    mergedErrs = validateWorkspaceDoc(merged, { requireEnvelope: strictDoc })
  } catch (e) {
    mergedErrs = [`校验异常：${e?.message || e}`]
  }
  if (mergedErrs.length) return reject(`合并结果校验失败，放弃写盘：${mergedErrs.join('; ')}`)

  const mergedBytes = Buffer.from(JSON.stringify(merged, null, 2))

  // B6：写盘前重新读取本地文件，与合并输入时的原始字节比较，防止覆盖宿主期间的修改
  let currentRaw
  try {
    currentRaw = await fsp.readFile(localPath)
  } catch (e) {
    if (e?.code === 'ENOENT') {
      currentRaw = null
    } else {
      return reject(`写盘前重读本地 workspace.json 失败（${e?.message || e}），等待下一轮`)
    }
  }
  if (origLocalBytes === null) {
    if (currentRaw !== null) {
      return reject('本地 workspace.json 在合并期间被新增，放弃本轮写入，等待下一轮')
    }
  } else if (!currentRaw || !currentRaw.equals(origLocalBytes)) {
    return reject('本地 workspace.json 在合并期间被修改，等待下一轮')
  }

  if (!currentRaw || !currentRaw.equals(mergedBytes)) {
    const storagesDir = path.dirname(localPath)
    let backupPath = null
    if (currentRaw) {
      backupPath = path.join(storagesDir, `workspace.json.bak-${backupStamp()}`)
      try {
        await fsp.writeFile(backupPath, currentRaw)
        await pruneBackups(storagesDir, BACKUP_KEEP)
      } catch (e) {
        return reject(`创建备份失败，拒绝覆盖本地文件：${e?.message || e}`)
      }
    }

    try {
      await writeJson(localPath, merged)
    } catch (e) {
      if (backupPath) {
        const rr = await restoreWorkspaceFromBackup(localPath, backupPath)
        if (!rr.ok) return freezeAndReturn(logger, backupPath, `写盘失败且恢复失败：${rr.error}`)
        return reject(`写盘失败（${e?.message || e}），已用备份恢复原文件`)
      }
      return reject(`写盘失败：${e?.message || e}`)
    }

    // 写入后重新读回并再次校验（requireEnvelope 与预检一致），失败则回滚
    const reRaw = await readJsonRawState(localPath)
    let reErrs
    try {
      reErrs =
        reRaw.state === 'ok'
          ? validateWorkspaceDoc(reRaw.value, { requireEnvelope: strictDoc })
          : [`重新读回失败（${reRaw.state}）`]
    } catch (e) {
      reErrs = [`复检异常：${e?.message || e}`]
    }
    if (reErrs.length) {
      if (backupPath) {
        const rr = await restoreWorkspaceFromBackup(localPath, backupPath)
        if (!rr.ok) return freezeAndReturn(logger, backupPath, `复检失败且恢复失败：${rr.error}`)
        return reject(`写盘后复检失败（${reErrs.join('; ')}），已用备份恢复原文件`)
      }
      try {
        await fsp.rm(localPath, { force: true })
      } catch {
        // 删除失败按原样返回错误
      }
      return reject(`写盘后复检失败（${reErrs.join('; ')}），已移除新写入的文件`)
    }
  }

  await writeJson(stagingPath, merged)
  return { merged: true, workspace: merged, errors: entryErrors }
}

function freezeAndReturn(logger, backupPath, reason) {
  WORKSPACE_WRITE_FROZEN = reason
  const error = `${reason}（备份：${backupPath}）；写入已冻结，重启进程前不再尝试合并`
  void logger.error(`workspace.json ${error}`)
  return { merged: false, skipped: true, error, backupPath }
}
