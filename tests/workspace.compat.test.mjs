import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeWorkspace, mergeWorkspaces, validateWorkspaceDoc, snapshotWorkspaceDomain, serializeWorkspaceDoc, readWorkspaceStatus, MAX_WORKSPACE_BYTES, MAX_WORKSPACE_IDS } from '../lib/workspace.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
await fsp.mkdir(tmpRoot, { recursive: true })
const clone = (value) => structuredClone(value)
const entry = (title = 'local') => ({ path: '/local/project', title, sessionIds: ['local-session'], createdAt: '2026-01-01', updatedAt: '2026-01-02' })
const doc = () => ({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['ws'], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: 'ws' }, tables: { workspaces: { ws: entry() } } })
const keyPaths = (value, prefix = '') => !value || typeof value !== 'object' || Array.isArray(value) ? [] : Object.entries(value).flatMap(([key, item]) => {
  const next = `${prefix}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
  return [next, ...keyPaths(item, next)]
})
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
  const home = await fsp.mkdtemp(path.join(tmpRoot, 'workspace-v3-'))
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

test('domain 无损合并 / 只写变化条目 / put 后 global.set / 幂等', () => fixture(async ({ write, stagingPath, hostPath, merge }) => {
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
  await write(stagingPath, remote)
  await write(hostPath, 'HOST SENTINEL: domain 模式不得读取此坏 JSON')
  const result = await merge(mock.domain)
  assert.equal(result.merged, true)
  assert.equal(result.workspaceWriteMode, 'domain')
  assert.equal(result.proposalPending, false)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(mock.calls, [['put', 'ws'], ['put', 'new'], ['set']])
  assert.equal(mock.stored.global.initialized, true)
  assert.deepEqual(mock.stored.tables.workspaces.ws.extra, { keep: 1, shared: { local: true, remote: true }, same: 'local', more: 2 })
  assert.deepEqual(mock.stored.tables.workspaces.ws.sessionIds, ['local-session', 'remote-session'])
  assert.equal(mock.stored.tables.workspaces.ws.title, 'remote')
  const keys = new Set(keyPaths(result.workspace))
  assert.ok(keyPaths(before).every((key) => keys.has(key)))
  assert.deepEqual(validateWorkspaceDoc(result.workspace, { requireEnvelope: true }), [])
  assert.deepEqual(JSON.parse(await fsp.readFile(stagingPath, 'utf8')), result.workspace)
  assert.equal(await fsp.readFile(hostPath, 'utf8'), 'HOST SENTINEL: domain 模式不得读取此坏 JSON')
  mock.calls.length = 0
  await merge(mock.domain)
  assert.deepEqual(mock.calls, [])
}))

test('B3 坏远端条目不得进入索引/default，合法远端独有条目保留', () => fixture(async ({ write, stagingPath, merge }) => {
  const remote = doc()
  remote.tables.workspaces.bad = null
  remote.tables.workspaces.incomplete = { path: '/bad' }
  remote.tables.workspaces.good = entry('good')
  remote.global.workspaceIds = ['bad', 'incomplete', 'good']
  remote.global.defaultWorkspaceId = 'bad'
  const mock = mockDomain(doc())
  await write(stagingPath, remote)
  const result = await merge(mock.domain)
  assert.equal(result.merged, true)
  assert.ok(result.errors.some((message) => message.includes('bad')))
  assert.deepEqual(mock.stored.global.workspaceIds, ['ws', 'good'])
  assert.equal(mock.stored.global.defaultWorkspaceId, 'ws')
  assert.equal(Object.hasOwn(mock.stored.tables.workspaces, 'bad'), false)
  assert.equal(Object.hasOwn(mock.stored.tables.workspaces, 'incomplete'), false)
  assert.deepEqual(validateWorkspaceDoc(result.workspace, { requireEnvelope: true }), [])
}))

test('B4 特殊 id/未知子树保留且原型不污染', () => fixture(async ({ write, stagingPath, merge }) => {
  const local = doc(), remote = doc()
  local.tables.workspaces = JSON.parse('{"__proto__":null,"constructor":null}')
  local.tables.workspaces.__proto__ = entry('proto')
  local.tables.workspaces.constructor = entry('constructor')
  local.global.workspaceIds = ['__proto__', 'constructor']; local.global.defaultWorkspaceId = '__proto__'
  local.tables.workspaces.__proto__.extra = JSON.parse('{"__proto__":{"keep":1},"constructor":{"local":true}}')
  remote.tables.workspaces = JSON.parse('{"__proto__":null,"toString":null}')
  remote.tables.workspaces.__proto__ = { ...entry('remote'), extra: JSON.parse('{"__proto__":{"more":2},"constructor":{"remote":true}}') }
  remote.tables.workspaces.toString = entry('toString')
  remote.global.workspaceIds = ['__proto__', 'toString']; remote.global.defaultWorkspaceId = '__proto__'
  const mock = mockDomain(local)
  await write(stagingPath, remote)
  const result = await merge(mock.domain)
  assert.equal(result.merged, true)
  assert.deepEqual(Object.keys(result.workspace.tables.workspaces), ['__proto__', 'constructor', 'toString'])
  assert.deepEqual(result.workspace.tables.workspaces.__proto__.extra.__proto__, { keep: 1, more: 2 })
  assert.deepEqual(result.workspace.tables.workspaces.__proto__.extra.constructor, { local: true, remote: true })
  assert.equal(Object.prototype.keep, undefined)
  assert.equal(Object.prototype.more, undefined)
}))

test('坏本地domain/坏信封/坏合并结果均零写入', () => fixture(async ({ write, stagingPath, merge }) => {
  const broken = [doc(), doc(), doc(), doc(), doc()]
  delete broken[0].global.initialized
  broken[1].tables.workspaces.ws = null
  broken[2].global.workspaceIds.push('dangling')
  broken[3].global.defaultWorkspaceId = 'dangling'
  broken[4].tables.workspaces.ws.createdAt = 1
  for (const value of broken) {
    const mock = mockDomain(value)
    await write(stagingPath, doc())
    const result = await merge(mock.domain)
    assert.equal(result.merged, false)
    assert.ok(result.error)
    assert.deepEqual(mock.calls, [])
  }
  for (const remote of [{}, { ...doc(), unit: { name: 'other', version: 2 } }, { ...doc(), unit: { name: 'workspace', version: 3 } }, null]) {
    const mock = mockDomain(doc())
    await write(stagingPath, remote === null ? 'null' : remote)
    const result = await merge(mock.domain)
    assert.equal(result.merged, false)
    assert.deepEqual(mock.calls, [])
  }
  const mock = mockDomain(doc())
  const remote = doc(); remote.global.workspaceIds = { nested: true }
  await write(stagingPath, remote)
  const result = await merge(mock.domain)
  assert.equal(result.merged, true, '坏远端已知数组被现有本地合法值隔离')
  assert.deepEqual(mock.calls, [])
}))

test('put 中途失败保留已成功写入，停止后续put/global/staging，无回滚', () => fixture(async ({ write, stagingPath, hostPath, merge }) => {
  const remote = doc()
  remote.tables.workspaces.ws.title = 'changed'; remote.tables.workspaces.ws.updatedAt = '2027'
  remote.tables.workspaces.fail = entry('fail'); remote.tables.workspaces.later = entry('later')
  remote.global.workspaceIds.push('fail', 'later')
  await write(stagingPath, remote)
  const stagedBefore = await fsp.readFile(stagingPath)
  await write(hostPath, 'untouched host')
  const mock = mockDomain(doc(), { failPut: 'fail' })
  const result = await merge(mock.domain)
  assert.equal(result.domainWriteFailed, true)
  assert.equal(result.merged, false)
  assert.match(result.error, /injected put failure/)
  assert.deepEqual(mock.calls, [['put', 'ws'], ['put', 'fail']])
  assert.equal(mock.stored.tables.workspaces.ws.title, 'changed')
  assert.equal(Object.hasOwn(mock.stored.tables.workspaces, 'later'), false)
  assert.deepEqual(mock.stored.global.workspaceIds, ['ws'])
  assert.deepEqual(await fsp.readFile(stagingPath), stagedBefore)
  assert.equal(await fsp.readFile(hostPath, 'utf8'), 'untouched host')
  assert.deepEqual(await fsp.readdir(path.dirname(hostPath)), ['workspace.json'])
}))

test('global.set 失败不回滚已完成put且返回错误', () => fixture(async ({ write, stagingPath, merge }) => {
  const remote = doc(); remote.tables.workspaces.new = entry(); remote.global.workspaceIds.push('new')
  await write(stagingPath, remote)
  const mock = mockDomain(doc(), { failGlobal: true })
  const result = await merge(mock.domain)
  assert.equal(result.domainWriteFailed, true)
  assert.match(result.error, /injected global failure/)
  assert.deepEqual(mock.calls, [['put', 'new'], ['set']])
  assert.ok(Object.hasOwn(mock.stored.tables.workspaces, 'new'))
  assert.deepEqual(mock.stored.global.workspaceIds, ['ws'])
}))

test('proposal 降级原子写建议/staging，宿主从未打开写且原始字节不变', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
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
  try { result = await merge(undefined) }
  finally { fsp.open = originalOpen; fsp.writeFile = originalWrite; fsp.rename = originalRename; fsp.copyFile = originalCopy }
  assert.ok(hostOpens >= 1)
  assert.equal(result.merged, true)
  assert.equal(result.workspaceWriteMode, 'proposal')
  assert.equal(result.proposalPending, true)
  assert.equal(result.proposalPath, proposalPath)
  assert.ok(result.warnings.some((message) => message.includes('存在待应用的工作区合并建议')))
  assert.deepEqual(result.errors, [])
  assert.deepEqual(await fsp.readFile(hostPath), original)
  assert.deepEqual(await fsp.readFile(proposalPath), await fsp.readFile(stagingPath))
  assert.deepEqual(JSON.parse(await fsp.readFile(proposalPath, 'utf8')).tables.workspaces.ws.sessionIds, ['local-session', 'remote-session'])
  assert.deepEqual(await fsp.readdir(path.dirname(hostPath)), ['workspace.json'])
}))

test('proposal 本地缺失仅完整合法远端可生成；domain恢复后清除旧建议', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  await write(stagingPath, doc())
  assert.equal((await merge(undefined)).proposalPending, true)
  await assert.rejects(fsp.access(hostPath), { code: 'ENOENT' })
  const mock = mockDomain(doc())
  assert.equal((await merge(mock.domain)).workspaceWriteMode, 'domain')
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
  const broken = doc(); delete broken.global.initialized
  await write(stagingPath, broken)
  const result = await merge(undefined)
  assert.equal(result.merged, false)
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
}))

test('跨周期proposal积累与恢复domain：旧建议独有会话不得丢失', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  await write(hostPath, doc())
  const firstRemote = doc(); firstRemote.tables.workspaces.ws.sessionIds = ['first-remote']
  await write(stagingPath, firstRemote)
  assert.equal((await merge(undefined)).proposalPending, true)
  const nextRemote = doc(); nextRemote.tables.workspaces.ws.sessionIds = ['next-remote']
  await write(stagingPath, nextRemote)
  const second = await merge(undefined)
  assert.deepEqual(second.workspace.tables.workspaces.ws.sessionIds, ['local-session', 'first-remote', 'next-remote'])
  // 即使 staging 丢掉旧建议，恢复domain也必须先消费proposal。
  await write(stagingPath, doc())
  const mock = mockDomain(doc())
  const restored = await merge(mock.domain)
  assert.equal(restored.proposalPending, false)
  assert.deepEqual(mock.stored.tables.workspaces.ws.sessionIds, ['local-session', 'first-remote', 'next-remote'])
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
  await write(proposalPath, '{bad proposal')
  const broken = await merge(mock.domain)
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
  assert.match((await merge(undefined)).error, /JSON 解析失败/)
  assert.deepEqual(await fsp.readFile(hostPath), before)
  await fsp.rm(hostPath)
  await fsp.mkdir(hostPath)
  assert.equal((await readWorkspaceStatus(hostPath)).state, 'read-error')
  assert.equal((await merge(undefined)).merged, false)
  await fsp.rm(hostPath, { recursive: true })
  await write(hostPath, '')
  await fsp.truncate(hostPath, MAX_WORKSPACE_BYTES + 1)
  assert.match((await merge(undefined)).error, /上限/)
  assert.equal((await fsp.stat(hostPath)).size, MAX_WORKSPACE_BYTES + 1)
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
  await write(hostPath, doc()); await write(stagingPath, '{bad')
  assert.match((await merge(undefined)).error, /staging.*JSON 解析失败/)
  await fsp.truncate(stagingPath, MAX_WORKSPACE_BYTES + 1)
  assert.match((await merge(mockDomain(doc()).domain)).error, /上限/)
  await fsp.rm(stagingPath)
  const unreadable = path.join(home, 'unreadable'); await fsp.mkdir(unreadable)
  assert.equal((await readWorkspaceStatus(unreadable)).state, 'read-error')
}))

test('B9 domain 输入32MiB/数组100000/表100000上限，超限零put/set', () => fixture(async ({ write, stagingPath, merge }) => {
  await write(stagingPath, doc())
  const oversized = doc(); oversized.global.extra = 'x'.repeat(MAX_WORKSPACE_BYTES)
  const tooMany = doc(); tooMany.tables.workspaces.ws.sessionIds = Array.from({ length: MAX_WORKSPACE_IDS + 1 }, (_, i) => `s${i}`)
  for (const input of [oversized, tooMany]) {
    const mock = mockDomain(input)
    const result = await merge(mock.domain)
    assert.equal(result.merged, false)
    assert.match(result.error, /上限/)
    assert.deepEqual(mock.calls, [])
  }
  const mock = mockDomain(doc())
  const originalTable = mock.domain.table
  mock.domain.table = () => ({ ...originalTable('workspaces'), size: MAX_WORKSPACE_IDS + 1 })
  assert.match((await merge(mock.domain)).error, /100000/)
  assert.deepEqual(mock.calls, [])
  assert.throws(() => snapshotWorkspaceDomain({ global: { get: () => doc().global }, table: () => ({ *entries() { for (let i = 0; i <= MAX_WORKSPACE_IDS; i++) yield [`id-${i}`, entry()] } }) }), /100000/)
}))

test('B9 合并产物超32MiB时domain/proposal均拒写且保留原建议', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  const local = doc(), remote = doc(), text = 'x'.repeat(17 * 1024 * 1024)
  local.tables.workspaces.ws.extra = { local: text }
  remote.tables.workspaces.ws.extra = { remote: text }
  assert.ok(serializeWorkspaceDoc(local).length < MAX_WORKSPACE_BYTES)
  assert.ok(serializeWorkspaceDoc(remote).length < MAX_WORKSPACE_BYTES)
  await write(stagingPath, remote)
  const mock = mockDomain(local)
  assert.match((await merge(mock.domain)).error, /上限/)
  assert.deepEqual(mock.calls, [])
  const oldProposal = doc(); oldProposal.global.keepSuggestion = true
  await write(hostPath, local); await write(proposalPath, oldProposal)
  const bytes = await fsp.readFile(hostPath)
  const suggestionBytes = await fsp.readFile(proposalPath)
  const rejected = await merge(undefined)
  assert.match(rejected.error, /上限/)
  assert.equal(rejected.proposalPending, true)
  assert.deepEqual(await fsp.readFile(proposalPath), suggestionBytes)
  assert.deepEqual(await fsp.readFile(hostPath), bytes)
}))

test('B9 合并sessionIds/表并集超100000时domain/proposal均拒写', () => fixture(async ({ write, stagingPath, hostPath, proposalPath, merge }) => {
  const local = doc(), remote = doc()
  local.tables.workspaces.ws.sessionIds = Array.from({ length: 50001 }, (_, i) => `l${i}`)
  remote.tables.workspaces.ws.sessionIds = Array.from({ length: 50000 }, (_, i) => `r${i}`)
  await write(stagingPath, remote)
  const mock = mockDomain(local)
  assert.match((await merge(mock.domain)).error, /100000/)
  assert.deepEqual(mock.calls, [])
  await write(hostPath, local)
  assert.match((await merge(undefined)).error, /100000/)
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
  const table = (prefix, count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, entry()]))
  local.tables.workspaces = table('l', 50001); remote.tables.workspaces = table('r', 50000)
  local.global.workspaceIds = []; local.global.defaultWorkspaceId = ''; remote.global.workspaceIds = []; remote.global.defaultWorkspaceId = ''
  await write(stagingPath, remote)
  const tableMock = mockDomain(local)
  assert.match((await merge(tableMock.domain)).error, /100000/)
  assert.deepEqual(tableMock.calls, [])
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

for (const [name, run] of tests) { await run(); console.log(`PASS ${name}`) }
console.log(`ALL PASS (${tests.length} workspace domain/proposal cases)`)
