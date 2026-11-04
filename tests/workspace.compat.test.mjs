import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeWorkspace, mergeWorkspaces, validateWorkspaceDoc, serializeWorkspaceDoc, readWorkspaceStatus, MAX_WORKSPACE_BYTES, MAX_WORKSPACE_IDS } from '../lib/workspace.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
await fsp.mkdir(tmpRoot, { recursive: true })
const clone = (value) => structuredClone(value)
const entry = (title = 'local') => ({ path: '/local/project', title, sessionIds: ['local-session'], createdAt: '2026-01-01', updatedAt: '2026-01-02' })
const doc = () => ({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['ws'], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: 'ws' }, tables: { workspaces: { ws: entry() } } })
const keyPaths = (value, prefix = '') => !value || typeof value !== 'object' || Array.isArray(value) ? [] : Object.entries(value).flatMap(([key, item]) => {
  const next = `${prefix}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
  return [next, ...keyPaths(item, next)]
})
// domain 句柄只用于证明「即使提供了也不得写」：任何 put/set 调用都会让测试失败。
function mockDomain(initial, { failPut, failGlobal } = {}) {
  const stored = clone(initial)
  const calls = []
  const table = {
    get size() { return Object.keys(stored.tables.workspaces).length },
    get: (id) => stored.tables.workspaces[id],
    entries: () => Object.entries(stored.tables.workspaces)[Symbol.iterator](),
    async put(id, value) {
      calls.push(['put', id])
      if (id === failPut) throw new Error(`injected put failure ${id}`)
      Object.defineProperty(stored.tables.workspaces, id, { value: clone(value), enumerable: true, writable: true, configurable: true })
    },
  }
  return { stored, calls, domain: { name: 'workspace', table(name) { assert.equal(name, 'workspaces'); return table }, global: { get: () => stored.global, async set(value) { calls.push(['set']); if (failGlobal) throw new Error('injected global failure'); stored.global = clone(value) } } } }
}
async function fixture(run) {
  const home = await fsp.mkdtemp(path.join(tmpRoot, 'workspace-v4-'))
  const dataDir = path.join(home, 'plugin-sync')
  const stagingRoot = path.join(dataDir, 'staging')
  const hostPath = path.join(home, 'storages', 'workspace.json')
  const stagingPath = path.join(stagingRoot, 'workspace', 'workspace.json')
  const proposalPath = path.join(dataDir, 'proposed', 'workspace.json')
  const write = async (file, value) => { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)) }
  const merge = (domain) => mergeWorkspace({ domain, dshHome: home, stagingRoot, dataDir })
  try { await run({ home, dataDir, stagingRoot, hostPath, stagingPath, proposalPath, write, merge }) }
  finally { await fsp.rm(home, { recursive: true, force: true }) }
}
const tests = []
const test = (name, run) => tests.push([name, run])

test('提供 domain 句柄也不得写宿主：零 put/set，结果只进建议/staging', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  const local = doc()
  local.global.extra = { keep: true }
  local.tables.workspaces.ws.extra = { keep: 1, shared: { local: true }, same: 'local' }
  const remote = doc()
  delete remote.global.initialized // 真实事故：本地 initialized 必须保留。
  remote.tables.workspaces.ws = { ...entry('remote'), updatedAt: '2026-02-01', sessionIds: ['remote-session'], extra: { more: 2, shared: { remote: true }, same: 'remote' } }
  remote.tables.workspaces.new = entry('new')
  remote.global.workspaceIds.push('new')
  const before = clone(local)
  const mock = mockDomain(local)
  await write(hostPath, JSON.stringify(local, null, 2))
  await write(stagingPath, remote)
  const hostBytes = await fsp.readFile(hostPath)
  const result = await merge(mock.domain)
  assert.equal(result.merged, true)
  assert.equal(result.workspaceWriteMode, 'proposal')
  assert.equal(result.proposalPending, true)
  assert.equal(result.proposalPathSafe, true)
  assert.ok(result.warnings.some((message) => message.includes('domain')), '提供 domain 时必须给出忽略警告')
  assert.deepEqual(result.errors, [])
  assert.deepEqual(mock.calls, [], '即使提供 domain 也不得调用 put/set')
  assert.deepEqual(mock.stored, before, '宿主 domain 数据不变')
  assert.deepEqual(await fsp.readFile(hostPath), hostBytes, '宿主文件字节不变')
  const proposal = JSON.parse(await fsp.readFile(proposalPath, 'utf8'))
  assert.equal(proposal.global.initialized, true)
  assert.deepEqual(proposal.tables.workspaces.ws.extra, { keep: 1, shared: { local: true, remote: true }, same: 'local', more: 2 })
  assert.deepEqual(proposal.tables.workspaces.ws.sessionIds, ['local-session', 'remote-session'])
  assert.equal(proposal.tables.workspaces.ws.title, 'remote')
  const keys = new Set(keyPaths(result.workspace))
  assert.ok(keyPaths(before).every((key) => keys.has(key)))
  assert.deepEqual(validateWorkspaceDoc(result.workspace, { requireEnvelope: true }), [])
  assert.deepEqual(JSON.parse(await fsp.readFile(stagingPath, 'utf8')), result.workspace)
  mock.calls.length = 0
  const again = await merge(mock.domain)
  assert.deepEqual(mock.calls, [], '幂等轮同样零调用')
  assert.equal(again.merged, true)
  assert.deepEqual(again.workspace, result.workspace)
}))

test('B3 坏远端条目不得进入索引/default，合法远端独有条目保留', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  const remote = doc()
  remote.tables.workspaces.bad = null
  remote.tables.workspaces.incomplete = { path: '/bad' }
  remote.tables.workspaces.good = entry('good')
  remote.global.workspaceIds = ['bad', 'incomplete', 'good']
  remote.global.defaultWorkspaceId = 'bad'
  await write(hostPath, doc())
  await write(stagingPath, remote)
  const result = await merge()
  assert.equal(result.merged, true)
  assert.ok(result.errors.some((message) => message.includes('bad')))
  const proposal = JSON.parse(await fsp.readFile(proposalPath, 'utf8'))
  assert.deepEqual(proposal.global.workspaceIds, ['ws', 'good'])
  assert.equal(proposal.global.defaultWorkspaceId, 'ws')
  assert.equal(Object.hasOwn(proposal.tables.workspaces, 'bad'), false)
  assert.equal(Object.hasOwn(proposal.tables.workspaces, 'incomplete'), false)
  assert.deepEqual(validateWorkspaceDoc(result.workspace, { requireEnvelope: true }), [])
}))

test('B4 特殊 id/未知子树保留且原型不污染', () => fixture(async ({ write, stagingPath, hostPath, merge }) => {
  const local = doc()
  local.tables.workspaces = JSON.parse('{"__proto__":null,"constructor":null}')
  local.tables.workspaces.__proto__ = entry('proto')
  local.tables.workspaces.constructor = entry('constructor')
  local.global.workspaceIds = ['__proto__', 'constructor']; local.global.defaultWorkspaceId = '__proto__'
  local.tables.workspaces.__proto__.extra = JSON.parse('{"__proto__":{"keep":1},"constructor":{"local":true}}')
  const remote = doc()
  remote.tables.workspaces = JSON.parse('{"__proto__":null,"toString":null}')
  remote.tables.workspaces.__proto__ = { ...entry('remote'), extra: JSON.parse('{"__proto__":{"more":2},"constructor":{"remote":true}}') }
  remote.tables.workspaces.toString = entry('toString')
  remote.global.workspaceIds = ['__proto__', 'toString']; remote.global.defaultWorkspaceId = '__proto__'
  await write(hostPath, JSON.stringify(local))
  await write(stagingPath, remote)
  const result = await merge()
  assert.equal(result.merged, true)
  assert.deepEqual(Object.keys(result.workspace.tables.workspaces), ['__proto__', 'constructor', 'toString'])
  assert.deepEqual(result.workspace.tables.workspaces.__proto__.extra.__proto__, { keep: 1, more: 2 })
  assert.deepEqual(result.workspace.tables.workspaces.__proto__.extra.constructor, { local: true, remote: true })
  assert.equal(Object.prototype.keep, undefined)
  assert.equal(Object.prototype.more, undefined)
}))

test('坏本地文件/坏信封/坏合并结果均零写入', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  const broken = [doc(), doc(), doc(), doc(), doc()]
  delete broken[0].global.initialized
  broken[1].tables.workspaces.ws = null
  broken[2].global.workspaceIds.push('dangling')
  broken[3].global.defaultWorkspaceId = 'dangling'
  broken[4].tables.workspaces.ws.createdAt = 1
  for (const value of broken) {
    await write(hostPath, JSON.stringify(value))
    await write(stagingPath, doc())
    const result = await merge()
    assert.equal(result.merged, false)
    assert.ok(result.error)
    await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
  }
  for (const remote of [{}, { ...doc(), unit: { name: 'other', version: 2 } }, { ...doc(), unit: { name: 'workspace', version: 3 } }, null]) {
    await write(hostPath, JSON.stringify(doc()))
    await write(stagingPath, remote === null ? 'null' : remote)
    const result = await merge()
    assert.equal(result.merged, false)
    await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
  }
  const remote = doc(); remote.global.workspaceIds = { nested: true }
  await write(stagingPath, remote)
  const result = await merge()
  assert.equal(result.merged, true, '坏远端已知数组被现有本地合法值隔离')
}))

test('proposal 原子写建议/staging，宿主从未打开写且原始字节不变', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  const local = doc(), remote = doc()
  local.customTop = { keep: true }; local.tables.workspaces.ws.extra = { local: true }
  remote.tables.workspaces.ws.sessionIds.push('remote-session')
  await write(hostPath, JSON.stringify(local, null, 2))
  await write(stagingPath, remote)
  const original = await fsp.readFile(hostPath)
  const originalOpen = fsp.open, originalWrite = fsp.writeFile, originalRename = fsp.rename, originalCopy = fsp.copyFile
  let hostOpens = 0
  fsp.open = async (file, flags, ...args) => { if (path.resolve(String(file)) === hostPath) { hostOpens++; assert.equal(flags, 'r') } return originalOpen(file, flags, ...args) }
  fsp.writeFile = async (file, ...args) => { assert.notEqual(path.resolve(String(file)), hostPath); return originalWrite(file, ...args) }
  fsp.rename = async (src, dest, ...args) => { assert.notEqual(path.resolve(String(dest)), hostPath); return originalRename(src, dest, ...args) }
  fsp.copyFile = async (src, dest, ...args) => { assert.notEqual(path.resolve(String(dest)), hostPath); return originalCopy(src, dest, ...args) }
  let result
  try { result = await merge() }
  finally { fsp.open = originalOpen; fsp.writeFile = originalWrite; fsp.rename = originalRename; fsp.copyFile = originalCopy }
  assert.ok(hostOpens >= 1)
  assert.equal(result.merged, true)
  assert.equal(result.workspaceWriteMode, 'proposal')
  assert.equal(result.proposalPending, true)
  assert.equal(result.proposalPath, proposalPath)
  assert.equal(result.proposalPathSafe, true)
  assert.ok(result.warnings.some((message) => message.includes('存在待应用的工作区合并建议')))
  assert.deepEqual(result.errors, [])
  assert.deepEqual(await fsp.readFile(hostPath), original)
  assert.deepEqual(await fsp.readFile(proposalPath), await fsp.readFile(stagingPath))
  assert.deepEqual(JSON.parse(await fsp.readFile(proposalPath, 'utf8')).tables.workspaces.ws.sessionIds, ['local-session', 'remote-session'])
  assert.deepEqual(await fsp.readdir(path.dirname(hostPath)), ['workspace.json'])
}))

test('本地缺失仅完整合法远端可生成建议；坏远端不能破坏既有建议', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  await write(stagingPath, doc())
  const first = await merge()
  assert.equal(first.proposalPending, true)
  assert.equal(first.proposalPathSafe, true)
  await assert.rejects(fsp.access(hostPath), { code: 'ENOENT' }, '本地缺失时绝不创建宿主文件')
  const pendingDoc = JSON.parse(await fsp.readFile(proposalPath, 'utf8'))
  // 完全没有合法输入（无本地、无建议、坏远端）时必须中止且不产生任何文件。
  await fsp.rm(proposalPath)
  const broken = doc(); delete broken.global.initialized
  await write(stagingPath, broken)
  const result = await merge()
  assert.equal(result.merged, false)
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
  // 既有建议在场时，坏远端不能破坏它（建议每轮参与合并）。
  await write(proposalPath, JSON.stringify(pendingDoc))
  const kept = await merge()
  assert.equal(kept.merged, true)
  assert.deepEqual(JSON.parse(await fsp.readFile(proposalPath, 'utf8')), pendingDoc)
}))

test('跨周期proposal积累：旧建议独有会话不得丢失，坏建议拒合并', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  await write(hostPath, doc())
  const firstRemote = doc(); firstRemote.tables.workspaces.ws.sessionIds = ['first-remote']
  await write(stagingPath, firstRemote)
  assert.equal((await merge()).proposalPending, true)
  const nextRemote = doc(); nextRemote.tables.workspaces.ws.sessionIds = ['next-remote']
  await write(stagingPath, nextRemote)
  const second = await merge()
  assert.deepEqual(second.workspace.tables.workspaces.ws.sessionIds, ['local-session', 'first-remote', 'next-remote'])
  // staging 回退为旧版本时，建议每轮参与合并，独有会话不得丢失。
  await write(stagingPath, doc())
  const third = await merge()
  assert.deepEqual(third.workspace.tables.workspaces.ws.sessionIds, ['local-session', 'first-remote', 'next-remote'])
  await write(proposalPath, '{bad proposal')
  const broken = await merge()
  assert.equal(broken.merged, false)
  assert.equal(broken.proposalPending, true)
  assert.match(broken.error, /既有工作区建议/)
  assert.equal(await fsp.readFile(proposalPath, 'utf8'), '{bad proposal')
}))

test('有界三态读取：missing / JSON损坏 / I/O失败 / 容量失败均不写', () => fixture(async ({ home, write, stagingPath, hostPath, proposalPath, merge }) => {
  assert.equal((await readWorkspaceStatus(hostPath)).state, 'missing')
  await write(hostPath, '{bad')
  assert.equal((await readWorkspaceStatus(hostPath)).state, 'parse-error')
  await write(stagingPath, doc())
  const before = await fsp.readFile(hostPath)
  assert.match((await merge()).error, /JSON 解析失败/)
  assert.deepEqual(await fsp.readFile(hostPath), before)
  await fsp.rm(hostPath)
  await fsp.mkdir(hostPath)
  assert.equal((await readWorkspaceStatus(hostPath)).state, 'read-error')
  assert.equal((await merge()).merged, false)
  await fsp.rm(hostPath, { recursive: true })
  await write(hostPath, '')
  await fsp.truncate(hostPath, MAX_WORKSPACE_BYTES + 1)
  assert.match((await merge()).error, /上限/)
  assert.equal((await fsp.stat(hostPath)).size, MAX_WORKSPACE_BYTES + 1)
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
  await write(hostPath, doc()); await write(stagingPath, '{bad')
  assert.match((await merge()).error, /staging.*JSON 解析失败/)
  await fsp.truncate(stagingPath, MAX_WORKSPACE_BYTES + 1)
  assert.match((await merge()).error, /上限/)
  await fsp.rm(stagingPath)
  const unreadable = path.join(home, 'unreadable'); await fsp.mkdir(unreadable)
  assert.equal((await readWorkspaceStatus(unreadable)).state, 'read-error')
}))

test('B9 本地文件输入超限（32MiB字节/数组100000）时拒写', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  await write(stagingPath, doc())
  await write(hostPath, '')
  await fsp.truncate(hostPath, MAX_WORKSPACE_BYTES + 1)
  let result = await merge()
  assert.equal(result.merged, false)
  assert.match(result.error, /上限/)
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
  const tooMany = doc(); tooMany.tables.workspaces.ws.sessionIds = Array.from({ length: MAX_WORKSPACE_IDS + 1 }, (_, i) => `s${i}`)
  await write(hostPath, JSON.stringify(tooMany))
  result = await merge()
  assert.equal(result.merged, false)
  assert.match(result.error, /上限/)
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
}))

test('B9 合并产物超32MiB时拒写且保留原建议', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  const local = doc(), remote = doc(), text = 'x'.repeat(17 * 1024 * 1024)
  local.tables.workspaces.ws.extra = { local: text }
  remote.tables.workspaces.ws.extra = { remote: text }
  assert.ok(serializeWorkspaceDoc(local).length < MAX_WORKSPACE_BYTES)
  assert.ok(serializeWorkspaceDoc(remote).length < MAX_WORKSPACE_BYTES)
  await write(stagingPath, remote)
  const oldProposal = doc(); oldProposal.global.keepSuggestion = true
  await write(hostPath, local); await write(proposalPath, oldProposal)
  const bytes = await fsp.readFile(hostPath)
  const suggestionBytes = await fsp.readFile(proposalPath)
  const rejected = await merge()
  assert.match(rejected.error, /上限/)
  assert.equal(rejected.proposalPending, true)
  assert.deepEqual(await fsp.readFile(proposalPath), suggestionBytes)
  assert.deepEqual(await fsp.readFile(hostPath), bytes)
}))

test('B9 合并sessionIds/表并集超100000时拒写', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  const local = doc(), remote = doc()
  local.tables.workspaces.ws.sessionIds = Array.from({ length: 50001 }, (_, i) => `l${i}`)
  remote.tables.workspaces.ws.sessionIds = Array.from({ length: 50000 }, (_, i) => `r${i}`)
  await write(stagingPath, remote)
  await write(hostPath, local)
  let result = await merge()
  assert.match(result.error, /100000/)
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
  const table = (prefix, count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, entry()]))
  local.tables.workspaces = table('l', 50001); remote.tables.workspaces = table('r', 50000)
  local.global.workspaceIds = []; local.global.defaultWorkspaceId = ''; remote.global.workspaceIds = []; remote.global.defaultWorkspaceId = ''
  await write(hostPath, local)
  await write(stagingPath, remote)
  result = await merge()
  assert.match(result.error, /100000/)
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
}))

test('序列化准确按UTF8/转义后字节限额，循环/非JSON输入拒绝', () => {
  const exact = doc(); exact.extra = ''
  exact.extra = 'x'.repeat(MAX_WORKSPACE_BYTES - serializeWorkspaceDoc(exact).length)
  assert.equal(serializeWorkspaceDoc(exact).length, MAX_WORKSPACE_BYTES)
  exact.extra += 'x'
  assert.throws(() => serializeWorkspaceDoc(exact), /上限/)
  const escaped = doc(); escaped.extra = '\u0000'.repeat(MAX_WORKSPACE_BYTES / 4)
  assert.throws(() => serializeWorkspaceDoc(escaped), /上限/)
  const utf8 = doc(); utf8.extra = '中'.repeat(Math.ceil(MAX_WORKSPACE_BYTES / 3))
  assert.throws(() => serializeWorkspaceDoc(utf8), /上限/)
  const cyclic = doc(); cyclic.global.loop = cyclic
  assert.throws(() => serializeWorkspaceDoc(cyclic), /循环/)
  assert.deepEqual(validateWorkspaceDoc({ ...doc(), tables: { workspaces: { ws: null } } }, { requireEnvelope: true }).length > 0, true)
  const plain = doc(), merged = mergeWorkspaces(plain, doc())
  assert.deepEqual(plain, doc(), '纯合并不改变输入')
  assert.deepEqual(validateWorkspaceDoc(merged, { requireEnvelope: true }), [])
})

test('符号链接攻击：proposed 指向宿主 storages 必须拒绝写', () => fixture(async ({ dataDir, write, stagingPath, hostPath, proposalPath, merge }) => {
  await write(hostPath, doc())
  const sentinel = await fsp.readFile(hostPath)
  await write(stagingPath, doc())
  const storagesDir = path.dirname(hostPath)
  await fsp.mkdir(dataDir, { recursive: true })
  await fsp.symlink(storagesDir, path.dirname(proposalPath))
  const result = await merge()
  assert.equal(result.merged, false)
  assert.match(result.error, /拒绝写入/)
  assert.equal(result.proposalPathSafe, false)
  assert.deepEqual(await fsp.readFile(hostPath), sentinel, '宿主 storages/workspace.json 字节不变')
  assert.deepEqual(await fsp.readdir(storagesDir), ['workspace.json'], 'storages 内没有新增文件')
}))

test('符号链接攻击：staging/workspace 指向宿主 storages 必须拒绝写', () => fixture(async ({ stagingRoot, write, stagingPath, hostPath, proposalPath, merge }) => {
  await write(hostPath, doc())
  const sentinel = await fsp.readFile(hostPath)
  const storagesDir = path.dirname(hostPath)
  await fsp.mkdir(stagingRoot, { recursive: true })
  await fsp.symlink(storagesDir, path.join(stagingRoot, 'workspace'))
  const result = await merge()
  assert.equal(result.merged, false)
  assert.match(result.error, /拒绝写入/)
  assert.deepEqual(await fsp.readFile(hostPath), sentinel, '宿主 storages/workspace.json 字节不变')
  assert.deepEqual(await fsp.readdir(storagesDir), ['workspace.json'], 'storages 内没有新增文件')
  // 建议文件路径本身安全：proposal 正常写出，供宿主/人工应用。
  assert.equal(result.proposalPending, true)
  assert.equal(result.proposalPathSafe, true)
  assert.equal(JSON.parse(await fsp.readFile(proposalPath, 'utf8')).global.initialized, true)
}))

test('符号链接攻击：目标文件本身是符号链接必须拒绝写', () => fixture(async ({ dataDir, write, stagingPath, hostPath, proposalPath, merge }) => {
  await write(hostPath, doc())
  const sentinel = await fsp.readFile(hostPath)
  await write(stagingPath, doc())
  await fsp.mkdir(dataDir, { recursive: true })
  await fsp.mkdir(path.dirname(proposalPath), { recursive: true })
  await fsp.symlink(hostPath, proposalPath, 'file')
  let result = await merge()
  assert.equal(result.merged, false)
  assert.match(result.error, /符号链接/)
  assert.equal(result.proposalPathSafe, false)
  assert.deepEqual(await fsp.readFile(hostPath), sentinel, '宿主 storages/workspace.json 字节不变')
  // 换成 staging 目标文件同样受保护
  await fsp.rm(proposalPath)
  result = await merge()
  assert.equal(result.merged, true, '清除符号链接后建议文件可正常写出')
  await fsp.rm(stagingPath)
  await fsp.symlink(hostPath, stagingPath, 'file')
  result = await merge()
  assert.equal(result.merged, false)
  assert.match(result.error, /符号链接/)
  assert.deepEqual(await fsp.readFile(hostPath), sentinel, '宿主 storages/workspace.json 字节不变')
}))

for (const [name, run] of tests) { await run(); console.log(`PASS ${name}`) }
console.log(`ALL PASS (${tests.length} workspace proposal-only cases)`)
