import path from 'node:path'
import { readFileLimited } from './limits.js'
import { guardedWrite } from './safe-writer.js'
import { createLogger } from './log.js'

const KNOWN_ENTRY_FIELDS = new Set(['path', 'title', 'sessionIds', 'createdAt', 'updatedAt'])
export const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024
export const MAX_WORKSPACE_IDS = 100000
const MAX_IDS = MAX_WORKSPACE_IDS

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

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function plainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// 合并时就限制分配量；不能先构造无限大的并集再截断。
function unionIds(arrays, label, _errors, accepts = () => true) {
  const out = []
  const seen = new Set()
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue
    if (arr.length > MAX_IDS) throw new Error(`${label} 超过 ${MAX_IDS} 条上限`)
    for (const id of arr) {
      if (typeof id !== 'string' || !accepts(id) || seen.has(id)) continue
      if (out.length === MAX_IDS) throw new Error(`${label} 合并结果超过 ${MAX_IDS} 条上限`)
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

// v1.2 导出复用：registry applier 应用远端工作区前做同一套跨系统路径映射
export function applyRemap(p, pathRemap) {
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

// 对任何持久化路径强制校验完整 v2 信封。
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
  if (typeof doc.unit.version !== 'number' || !Number.isFinite(doc.unit.version) || doc.unit.version !== 2) {
    errs.push(`unit.version 应为数字 2，实际为 ${JSON.stringify(doc.unit.version)}`)
  }
  if (!plainObject(doc.global)) {
    errs.push('global 应为对象')
    return errs
  }
  const g = doc.global
  if (typeof g.initialized !== 'boolean') errs.push('global.initialized 应为 boolean')
  for (const k of ['workspaceIds', 'archivedSessionIds', 'pinnedSessionIds']) {
    if (!Array.isArray(g[k]) || g[k].some((id) => typeof id !== 'string')) errs.push(`global.${k} 应为字符串数组`)
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
  if (typeof g.defaultWorkspaceId === 'string' && g.defaultWorkspaceId !== '') {
    if (!tableIds.has(g.defaultWorkspaceId) || !Array.isArray(g.workspaceIds) || !g.workspaceIds.includes(g.defaultWorkspaceId)) {
      errs.push(`global.defaultWorkspaceId 引用不完整：${g.defaultWorkspaceId} 必须同时存在于表和 workspaceIds`)
    }
  }
  return errs
}

// B1：递归键路径（与测试的 collectKeys 语义一致：数组视为叶子）
function collectKeyPaths(v, prefix = '', out = []) {
  if (!plainObject(v)) return out
  for (const [k, val] of Object.entries(v)) {
    const p = `${prefix}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`
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
      d[k] = hasOwn(d, k) ? mergeUnknown(d[k], v) : v
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
  d.sessionIds = unionIds([ws.sessionIds, rw.sessionIds], `workspace ${id} sessionIds`, errors)
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
  const strict = hasV2Envelope(L) || hasV2Envelope(R)
  const errors = []
  const remoteOnly = []
  const workspaces = Object.create(null)
  let workspaceCount = 0

  for (const [id, ws] of Object.entries(localTables)) {
    if (!plainObject(ws)) errors.push(`本地 workspace ${id} 不是对象，已按空条目处理`)
    const lws = plainObject(ws) ? ws : {}
    const rawRemote = hasOwn(remoteTables, id) ? remoteTables[id] : undefined
    const remoteErrs = [...entryCoreErrors(rawRemote), ...entryTimestampErrors(rawRemote)]
    const usableRemote = plainObject(rawRemote) && (!strict || remoteErrs.length === 0)
    if (hasOwn(remoteTables, id) && !usableRemote) {
      errors.push(`远端 workspace ${id} 字段不合法，忽略远端版本：${remoteErrs.join('; ')}`)
    }
    const rw = usableRemote ? remapped(rawRemote, pathRemap) : {}
    if (++workspaceCount > MAX_IDS) throw new Error(`workspace 合并表超过 ${MAX_IDS} 条上限`)
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
    if (++workspaceCount > MAX_IDS) throw new Error(`workspace 合并表超过 ${MAX_IDS} 条上限`)
    workspaces[id] = mergeEntry(id, {}, rw, errors)
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
  gDict.workspaceIds = unionIds(
    [lg.workspaceIds, rg.workspaceIds, remoteOnly],
    'global.workspaceIds',
    errors,
    (id) => hasOwn(workspaces, id),
  )
  gDict.archivedSessionIds = unionIds([lg.archivedSessionIds, rg.archivedSessionIds], 'global.archivedSessionIds', errors)
  gDict.pinnedSessionIds = unionIds([lg.pinnedSessionIds, rg.pinnedSessionIds], 'global.pinnedSessionIds', errors)
  // B3：defaultWorkspaceId 引用不完整时回退为本地值/空串
  let defaultId = lg.defaultWorkspaceId || rg.defaultWorkspaceId || ''
  const indexedIds = new Set(gDict.workspaceIds)
  const completeDefault = (id) => typeof id === 'string' && hasOwn(workspaces, id) && indexedIds.has(id)
  if (defaultId && !completeDefault(defaultId)) {
    defaultId = lg.defaultWorkspaceId && completeDefault(lg.defaultWorkspaceId) ? lg.defaultWorkspaceId : ''
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

// 输入和产物都受同一容量限制；超限拒绝整次合并，绝不截断本地索引。
function assertWorkspaceLimits(doc) {
  if (!plainObject(doc)) throw new Error('workspace 文档应为对象')
  const tables = doc.tables?.workspaces
  if (plainObject(tables) && Object.keys(tables).length > MAX_IDS) {
    throw new Error(`workspace 表超过 ${MAX_IDS} 条上限`)
  }
  for (const key of ['workspaceIds', 'archivedSessionIds', 'pinnedSessionIds']) {
    if (Array.isArray(doc.global?.[key]) && doc.global[key].length > MAX_IDS) {
      throw new Error(`global.${key} 超过 ${MAX_IDS} 条上限`)
    }
  }
  if (plainObject(tables)) {
    for (const [id, entry] of Object.entries(tables)) {
      if (Array.isArray(entry?.sessionIds) && entry.sessionIds.length > MAX_IDS) {
        throw new Error(`workspace ${id} sessionIds 超过 ${MAX_IDS} 条上限`)
      }
    }
  }
}

// 分段计量后才组装 Buffer，避免先分配一个超出上限的序列化产物。
// workspace 文档必须是纯 JSON 数据；循环引用和不可表示的值直接拒绝。
export function serializeWorkspaceDoc(doc) {
  assertWorkspaceLimits(doc)
  const chunks = []
  const ancestors = new Set()
  let size = 0
  let pending = ''
  const append = (token) => {
    size += Buffer.byteLength(token)
    if (size > MAX_WORKSPACE_BYTES) throw new Error(`workspace 序列化超过 ${MAX_WORKSPACE_BYTES} 字节上限`)
    if (pending.length + token.length > 65536) {
      if (pending) chunks.push(Buffer.from(pending))
      pending = ''
    }
    if (token.length > 65536) chunks.push(Buffer.from(token))
    else pending += token
  }
  const string = (value) => {
    if (Buffer.byteLength(value) > MAX_WORKSPACE_BYTES) throw new Error(`workspace 字符串超过 ${MAX_WORKSPACE_BYTES} 字节上限`)
    append(JSON.stringify(value))
  }
  const visit = (value, depth = 0) => {
    if (depth > 512) throw new Error('workspace 对象嵌套超过 512 层上限')
    if (value === null) { append('null'); return }
    if (typeof value === 'string') { string(value); return }
    if (typeof value === 'boolean') { append(value ? 'true' : 'false'); return }
    if (typeof value === 'number' && Number.isFinite(value)) { append(String(value)); return }
    if (typeof value !== 'object') throw new Error('workspace 含不可表示的 JSON 值')
    if (ancestors.has(value)) throw new Error('workspace 含循环引用')
    ancestors.add(value)
    if (Array.isArray(value)) {
      append('[')
      for (let i = 0; i < value.length; i++) { if (i) append(','); visit(value[i], depth + 1) }
      append(']')
    } else {
      const proto = Object.getPrototypeOf(value)
      if (proto !== null && proto !== Object.prototype) throw new Error('workspace 含非 JSON 对象')
      append('{')
      let first = true
      for (const [key, item] of Object.entries(value)) {
        if (!first) append(',')
        first = false
        string(key); append(':'); visit(item, depth + 1)
      }
      append('}')
    }
    ancestors.delete(value)
  }
  visit(doc)
  if (pending) chunks.push(Buffer.from(pending))
  return Buffer.concat(chunks, size)
}

// 仅读：ENOENT / JSON 损坏 / I/O或容量错误分开报告，绝不写回宿主文件。
export async function readWorkspaceStatus(file) {
  let bytes
  try {
    bytes = await readFileLimited(file, MAX_WORKSPACE_BYTES)
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'read-error', value: null, bytes: null, error }
  }
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    assertWorkspaceLimits(value)
    return { state: 'ok', value, bytes, error: null }
  } catch (error) {
    return { state: error instanceof SyntaxError ? 'parse-error' : 'read-error', value: null, bytes, error }
  }
}

// V1：宿主工作区索引只读。合并结果只写 <dataDir>/proposed/workspace.json 与 staging
// 副本，应用由宿主事务 API（v1.2 registry 模式）或人工处理；即使调用方传入 domain 句柄也
// 忽略并记 warning。两个写入目标都经 lib/safe-writer.js 的 guardedWrite 做真实路径边界校验。
// proposalNotice: false 时（registry 主路径已接管应用）不再输出「待人工应用」警告。
export async function mergeWorkspace({ domain, dshHome, stagingRoot, dataDir = path.join(dshHome, 'plugin-sync'), pathRemap, log, round, proposalNotice = true } = {}) {
  const workspaceWriteMode = 'proposal'
  const proposalPath = path.join(dataDir, 'proposed', 'workspace.json')
  const stagingPath = path.join(stagingRoot, 'workspace', 'workspace.json')
  const logger = log || createLogger(path.join(dataDir, 'logs'))
  const errors = []
  const warnings = []
  const base = { merged: false, workspaceWriteMode, proposalPending: false, proposalPath, proposalPathSafe: true, errors, warnings }
  if (domain) warnings.push('检测到 workspace domain 句柄：v1.1 起插件不再写宿主工作区索引，已忽略该句柄（只生成建议文件）')
  const reject = async (message, extra = {}) => {
    const error = `workspace 合并中止：${message}`
    await logger.error(error)
    return { ...base, ...extra, error }
  }
  try {
    // 旧建议也是尚待应用的数据，每轮并入合并，防止被远端旧版本回退。
    const proposed = await readWorkspaceStatus(proposalPath)
    base.proposalPending = proposed.state !== 'missing'
    if (proposed.state === 'read-error' || proposed.state === 'parse-error') {
      return reject(`既有工作区建议读取/解析失败：${proposed.error?.message || proposed.error}`)
    }
    const previousProposal = proposed.state === 'ok' ? proposed.value : null
    if (previousProposal !== null) {
      const errs = validateWorkspaceDoc(previousProposal, { requireEnvelope: true })
      if (errs.length) return reject(`既有工作区建议校验失败：${errs.join('; ')}`)
      serializeWorkspaceDoc(previousProposal)
    }
    const staged = await readWorkspaceStatus(stagingPath)
    if (staged.state === 'read-error' || staged.state === 'parse-error') {
      return reject(`staging workspace.json ${staged.state === 'parse-error' ? 'JSON 解析失败' : `读取失败（${staged.error?.message || staged.error}）`}`)
    }
    const remote = staged.state === 'ok' ? staged.value : null
    if (remote !== null && (!hasV2Envelope(remote) || remote.unit.name !== 'workspace' || remote.unit.version !== 2)) {
      return reject('远端 workspace.json 无有效 v2 信封（unit.name=workspace、unit.version=2）')
    }
    // 宿主文件只读：有界三态读取，读取失败/损坏一律中止，绝不写回宿主文件。
    const input = await readWorkspaceStatus(path.join(dshHome, 'storages', 'workspace.json'))
    if (input.state === 'parse-error') return reject('本地 workspace.json JSON 解析失败，保留原文件')
    if (input.state === 'read-error') return reject(`读取本地 workspace.json 失败：${input.error?.message || input.error}`)
    const local = input.state === 'ok' ? input.value : null
    if (local !== null) {
      const errs = validateWorkspaceDoc(local, { requireEnvelope: true })
      if (errs.length) return reject(`本地 workspace.json 校验失败：${errs.join('; ')}`)
    }
    if (local === null) {
      const errs = validateWorkspaceDoc(previousProposal || remote, { requireEnvelope: true })
      if (errs.length) return reject(`本地缺失且远端校验失败：${errs.join('; ')}`)
    }
    // 所有合并输入都必须完成序列化容量检查。
    if (local !== null) serializeWorkspaceDoc(local)
    if (remote !== null) serializeWorkspaceDoc(remote)
    let merged = local || emptyWorkspace()
    for (const [source, remap] of [[previousProposal, undefined], [remote, pathRemap]]) {
      if (source === null) continue
      const result = mergeWorkspacesInner(merged, source, remap)
      merged = result.doc
      errors.push(...result.errors)
    }
    const bytes = serializeWorkspaceDoc(merged)
    const mergedKeys = new Set(collectKeyPaths(merged))
    const missing = collectKeyPaths(local).filter((key) => !mergedKeys.has(key))
    if (missing.length) return reject(`合并结果丢失本地递归键：${missing.slice(0, 5).join(', ')}`)
    const validation = validateWorkspaceDoc(merged, { requireEnvelope: true })
    if (validation.length) return reject(`合并结果校验失败：${validation.join('; ')}`)
    // round 缺省时每次调用自成一轮：拒绝缓存不跨调用泄漏，允许修复文件系统后重试。
    const writeRound = round || {}
    const proposalWrite = await guardedWrite({ root: dataDir, rel: 'proposed/workspace.json', bytes, dshHome, round: writeRound })
    if (!proposalWrite.ok) {
      base.proposalPathSafe = false
      return reject(proposalWrite.error?.message || String(proposalWrite.error))
    }
    base.proposalPending = true
    if (proposalNotice) warnings.push(`存在待应用的工作区合并建议：${proposalPath}`)
    const stagingWrite = await guardedWrite({ root: stagingRoot, rel: 'workspace/workspace.json', bytes, dshHome, round: writeRound })
    if (!stagingWrite.ok) {
      return reject(stagingWrite.error?.message || String(stagingWrite.error))
    }
    return { ...base, merged: true, workspace: merged }
  } catch (error) {
    return reject(error?.message || String(error))
  }
}
