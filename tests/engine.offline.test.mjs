// 沙箱禁止监听端口时的补充证据：真实文件/引擎周期，fetch 传输由内存响应替代。
// 不能替代 engine.test.mjs 的真实 HTTP 双节点验收。
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { createEngine } from '../lib/engine.js'
import { apply as applyPlugin } from '../index.js'
import { createStore } from '../lib/store.js'
import { createSyncServer } from '../lib/server.js'
import { MAX_BLOB_BYTES, MAX_INDEX_BYTES, MAX_INDEX_ENTRIES, readFileLimited, sha1FileLimited, requestBuffer, parsePeerIndex } from '../lib/limits.js'
import { sha1 } from '../lib/util.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
const workspaceLimit = 32 * 1024 * 1024
await fsp.mkdir(tmpRoot, { recursive: true })
const home = await fsp.mkdtemp(path.join(tmpRoot, 'engine-offline-'))
const originalFetch = globalThis.fetch
const rel = 'sessions/project/session/session.v4.jsonl.zstd'
const session = (text) => {
  const data = Buffer.from(JSON.stringify({ text }) + '\n')
  const block = Buffer.alloc(3)
  block.writeUIntLE((data.length << 3) | 1, 0, 3)
  return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, data.length]), block, data])
}
const localBytes = session('local')
const remoteBytes = session('remote')
const doc = () => ({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws'], defaultWorkspaceId: 'ws', archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { ws: { path: '/project', title: 'Project', sessionIds: ['session'], createdAt: '2026-01-01', updatedAt: '2026-01-02' } } },
})
function mockDomain(initial) {
  let value = structuredClone(initial)
  const table = {
    entries: () => Object.entries(structuredClone(value.tables.workspaces))[Symbol.iterator](),
    get size() { return Object.keys(value.tables.workspaces).length },
    async put(id, entry) { value.tables.workspaces = Object.fromEntries([...Object.entries(value.tables.workspaces).filter(([key]) => key !== id), [id, structuredClone(entry)]]) },
  }
  return {
    name: 'workspace',
    global: { get: () => structuredClone(value.global), async set(global) { value.global = structuredClone(global) } },
    table: (name) => { assert.equal(name, 'workspaces'); return table },
    document: () => structuredClone(value),
  }
}

async function write(rel, bytes) {
  const file = path.join(home, rel)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, bytes)
  const old = new Date(Date.now() - 5000)
  await fsp.utimes(file, old, old)
  return file
}
let remoteIndex = { files: { [rel]: { sha1: sha1(remoteBytes), size: remoteBytes.length } } }
let remoteBody = remoteBytes
let indexHeader
let blobHeader
let healthyReads = 0
globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url)
  if (parsed.pathname === '/slow') {
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('headers already received'))
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true })
    } }))
  }
  if (parsed.pathname === '/chunked') return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.alloc(700))
    controller.enqueue(Buffer.alloc(700))
    controller.close()
  } }))
  if (init.method === 'PUT') return Response.json({ ok: true })
  if (parsed.hostname === 'healthy') { healthyReads++; return Response.json({ files: {} }) }
  if (parsed.pathname === '/v1/index') return new Response(JSON.stringify(remoteIndex), { headers: indexHeader })
  return new Response(remoteBody, { headers: blobHeader })
}

let engine
let ignoredDomainLookups = 0
// v1.1 引擎不再接受 domain 句柄；传入旧调用方的 getWorkspaceDomain 选项必须完全无效。
const makeEngine = () => createEngine({ getWorkspaceDomain: () => {
  ignoredDomainLookups++
  return mockDomain(doc())
}, rowConfig: {
  dshHome: home, deviceName: 'offline', listenPort: 0, token: 'test-token', settleSec: 0,
  peers: [{ name: 'remote', url: 'http://remote' }, { name: 'healthy', url: 'http://healthy' }],
} })
async function testProvidedDomainNeverWritesHost() {
  const cycleHome = path.join(home, 'domain-ignored-cycle')
  const hostFile = path.join(cycleHome, 'storages/workspace.json')
  const hostBytes = Buffer.from(JSON.stringify(doc()))
  await fsp.mkdir(path.dirname(hostFile), { recursive: true })
  await fsp.writeFile(hostFile, hostBytes)
  let lookups = 0
  const domain = mockDomain(doc())
  const table = domain.table('workspaces')
  const realPut = table.put
  const puts = []
  table.put = async (id, value) => { puts.push(id); return realPut(id, value) }
  const realSet = domain.global.set
  let sets = 0
  domain.global.set = async (global) => { sets++; return realSet(global) }
  const remoteDocs = Object.fromEntries(['one', 'two'].map((peer) => {
    const value = doc()
    value.tables.workspaces.ws.sessionIds.push(peer)
    value.global.workspaceIds.push('extra')
    value.tables.workspaces.extra = { ...value.tables.workspaces.ws, title: peer, sessionIds: [peer] }
    return [peer, Buffer.from(JSON.stringify(value))]
  }))
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'PUT') return Response.json({ ok: true })
    const parsed = new URL(url)
    const bytes = remoteDocs[parsed.hostname]
    if (parsed.pathname === '/v1/index') return Response.json({ files: {
      'workspace/workspace.json': { sha1: sha1(bytes), size: bytes.length },
    } })
    return new Response(bytes)
  }
  const cycleEngine = createEngine({ getWorkspaceDomain: () => { lookups++; return domain }, rowConfig: {
    dshHome: cycleHome, listenPort: 0, token: 'ignored-token', settleSec: 0,
    peers: [{ name: 'one', url: 'http://one' }, { name: 'two', url: 'http://two' }],
  } })
  try {
    await cycleEngine.init()
    const result = await cycleEngine.runCycle()
    assert.equal(result.workspaceWriteMode, 'proposal')
    assert.equal(result.proposalPending, true)
    assert.deepEqual(result.errors, [])
    assert.equal(lookups, 0, '引擎从不读取传入的domain句柄')
    assert.deepEqual(puts, [], '即使传入 domain 也从未调用 put')
    assert.equal(sets, 0, '即使传入 domain 也从未调用 global.set')
    assert.deepEqual(domain.document(), doc(), 'domain 数据不变')
    assert.deepEqual(await fsp.readFile(hostFile), hostBytes, '宿主文件字节不变')
    const proposal = JSON.parse(await fsp.readFile(path.join(cycleHome, 'plugin-sync/proposed/workspace.json'), 'utf8'))
    assert.deepEqual([...new Set(proposal.tables.workspaces.ws.sessionIds)].sort(), ['one', 'session', 'two'], '建议文件 sessionIds 为并集')
    assert.ok(Object.hasOwn(proposal.tables.workspaces, 'extra'), '合法远端独有条目进入建议')
  } finally {
    await cycleEngine.close()
    globalThis.fetch = previousFetch
  }
  console.log('离线 V1 提供domain句柄也不写宿主（零put/set/宿主字节不变/建议并集） PASS')
}

async function testPluginEntryLifecycle() {
  const entryHome = path.join(home, 'entry-lifecycle')
  const hostFile = path.join(entryHome, 'storages/workspace.json')
  const hostBytes = Buffer.from(JSON.stringify(doc()))
  await fsp.mkdir(path.dirname(hostFile), { recursive: true })
  await fsp.writeFile(hostFile, hostBytes)
  const registered = new Map()
  const disposers = []
  const injectCalls = []
  const ctx = {
    inject(names) { injectCalls.push(names) },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
  }
  try {
    applyPlugin(ctx, { dshHome: entryHome, listenPort: 0, token: 'entry-token', settleSec: 0 })
    const status = () => registered.get('dsh_sync_status').execute()
    const sync = () => registered.get('dsh_sync_now').execute()
    // v1.2 只请求注入 registry 两服务；宿主未提供（mock 返回 undefined）时解析为不可用并回退 proposal。
    assert.deepEqual(injectCalls, [['workspaceRegistry', 'sessionPersistence']], 'v1.2 只注入 workspaceRegistry/sessionPersistence，不再注入 storageDomain')
    assert.equal((await status()).workspaceWriteMode, 'proposal')
    assert.equal((await sync()).proposalPending, true, '宿主不提供 registry 服务也能执行工具（proposal 降级）')
    assert.equal((await status()).proposalPathSafe, true)
    assert.deepEqual(await fsp.readFile(hostFile), hostBytes, '宿主文件字节不变')
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
  }
  console.log('离线 index.apply只注入registry两服务/服务缺失降级proposal/宿主只读 PASS')
}

try {
  for (const bytes of [undefined, '{bad JSON', 'null', '{"localHashes":null,"remoteHashes":[]}']) {
    remoteBody = remoteBytes
    remoteIndex = { files: { [rel]: { sha1: sha1(remoteBytes), size: remoteBytes.length } } }
    await write(rel, localBytes)
    await write('storages/workspace.json', JSON.stringify(doc()))
    if (bytes === undefined) await fsp.rm(path.join(home, 'plugin-sync/state.json'), { force: true })
    else await write('plugin-sync/state.json', bytes)
    engine = makeEngine()
    await engine.init()
    const result = await engine.runCycle()
    assert.deepEqual(result.errors, [], `坏/缺 state 不产生落回错误：${bytes}`)
    assert.equal(result.conflicts, 1)
    assert.deepEqual(await fsp.readFile(path.join(home, rel)), localBytes)
    const files = await fsp.readdir(path.join(home, 'plugin-sync/conflicts'))
    assert.ok((await Promise.all(files.map((file) => fsp.readFile(path.join(home, 'plugin-sync/conflicts', file)))))
      .some((bytes) => bytes.equals(remoteBytes)))
    const stateFile = path.join(home, 'plugin-sync/state.json')
    const saved = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
    assert.equal(saved.unresolvedConflict[rel].localSha, sha1(localBytes))
    assert.equal(saved.unresolvedConflict[rel].remoteSha, sha1(remoteBytes))
    await engine.close()
    remoteBody = session('remote changed after conflict')
    remoteIndex = { files: { [rel]: { sha1: sha1(remoteBody), size: remoteBody.length } } }
    engine = makeEngine()
    await engine.init()
    const next = await engine.runCycle()
    assert.deepEqual(next.errors, [])
    assert.deepEqual(await fsp.readFile(path.join(home, rel)), localBytes, '重启后远端再次变化不能覆盖未解决本地冲突')
    assert.ok(JSON.parse(await fsp.readFile(stateFile, 'utf8')).unresolvedConflict[rel])
    // 下一轮仅导出本地到 staging，不能把它误判为远端已收敛而清除持久标记。
    await engine.runCycle()
    assert.ok(JSON.parse(await fsp.readFile(stateFile, 'utf8')).unresolvedConflict[rel])
    await engine.close()
  }
  console.log('离线 B7 state安全恢复 / 冲突持久化 / 重启后远端再变更仍保留本地 PASS')

  const hostBytes = Buffer.from(JSON.stringify(doc()))
  await write('storages/workspace.json', hostBytes)
  remoteBody = Buffer.from('proposal attachment')
  remoteIndex = { files: { 'attachments/proposal.bin': { sha1: sha1(remoteBody), size: remoteBody.length } } }
  engine = makeEngine()
  await engine.init()
  const proposal = await engine.runCycle()
  assert.deepEqual(proposal.errors, [])
  assert.equal(proposal.workspaceWriteMode, 'proposal')
  assert.equal(proposal.proposalPending, true)
  assert.ok(proposal.warnings.some((warning) => warning.includes('建议')))
  const proposalStatus = await engine.status()
  assert.equal(proposalStatus.workspaceWriteMode, 'proposal')
  assert.equal(proposalStatus.proposalPending, true)
  assert.equal(proposalStatus.proposalPath, path.join(home, 'plugin-sync/proposed/workspace.json'))
  assert.equal(JSON.parse(await fsp.readFile(proposalStatus.proposalPath, 'utf8')).global.initialized, true)
  assert.deepEqual(await fsp.readFile(path.join(home, 'storages/workspace.json')), hostBytes)
  assert.deepEqual(await fsp.readFile(path.join(home, 'attachments/proposal.bin')), remoteBody, 'proposal模式附件仍自动落回')
  const proposalRemote = doc()
  proposalRemote.tables.workspaces.ws.sessionIds.push('proposal-session')
  remoteBody = Buffer.from(JSON.stringify(proposalRemote))
  remoteIndex = { files: { 'workspace/workspace.json': { sha1: sha1(remoteBody), size: remoteBody.length } } }
  await engine.runCycle()
  const pendingDoc = JSON.parse(await fsp.readFile(proposalStatus.proposalPath, 'utf8'))
  assert.deepEqual(pendingDoc.tables.workspaces.ws.sessionIds, ['session', 'proposal-session'])
  remoteIndex = { files: {} }
  await engine.runCycle()
  assert.deepEqual(JSON.parse(await fsp.readFile(proposalStatus.proposalPath, 'utf8')), pendingDoc, '远端离线后建议并集跨周期保留')
  await write('storages/workspace.json', '{bad JSON')
  const blockedProposal = await engine.runCycle()
  assert.ok(blockedProposal.errors.some((message) => message.includes('JSON 解析失败')))
  assert.equal((await engine.status()).proposalPending, true, '建议仍在时拒绝后续合并不能清除pending状态')
  assert.deepEqual(JSON.parse(await fsp.readFile(proposalStatus.proposalPath, 'utf8')), pendingDoc)
  await write('storages/workspace.json', hostBytes)
  const restoredCycle = await engine.runCycle()
  assert.equal(restoredCycle.workspaceWriteMode, 'proposal', '宿主恢复后仍只写建议文件')
  assert.deepEqual(JSON.parse(await fsp.readFile(proposalStatus.proposalPath, 'utf8')).tables.workspaces.ws.sessionIds, ['session', 'proposal-session'], '宿主恢复后建议并集保留')
  assert.deepEqual(await fsp.readFile(path.join(home, 'storages/workspace.json')), hostBytes)
  assert.equal(ignoredDomainLookups, 0, '引擎从不读取传入的domain句柄')
  await engine.close()
  console.log('离线 V1-V3 proposal状态/跨周期建议并集/附件同步/宿主字节不变/忽略domain句柄 PASS')
  await testPluginEntryLifecycle()
  await testProvidedDomainNeverWritesHost()

  await assert.rejects(requestBuffer('http://remote/slow', {}, { timeoutMs: 30 }), /超时/)
  await assert.rejects(requestBuffer('http://remote/chunked', {}, { maxBytes: 1024 }), /上限/)
  const sparse = await write('oversized', '')
  await fsp.truncate(sparse, MAX_BLOB_BYTES + 1)
  await assert.rejects(readFileLimited(sparse), /上限/)
  const store = createStore(path.join(home, 'bounded-store'))
  const digest = 'a'.repeat(40)
  const blobFile = store.blobPath(digest)
  await fsp.mkdir(path.dirname(blobFile), { recursive: true })
  await fsp.writeFile(blobFile, '')
  await fsp.truncate(blobFile, MAX_BLOB_BYTES + 1)
  await assert.rejects(store.getBlob(digest), /上限/)
  await assert.rejects(store.buildIndex(path.join(home, 'bounded-store/store')), /上限/)
  // 小于通用200MiB blob上限的工作区仍须独立受32MiB约束。
  await fsp.truncate(blobFile, workspaceLimit + 1)
  assert.ok((await fsp.stat(blobFile)).size < MAX_BLOB_BYTES)
  await assert.rejects(store.getBlob(digest, workspaceLimit), /上限/, '工作区缓存按32MiB拒读')
  const oversizedWorkspace = await write('workspace-index/workspace/workspace.json', '')
  await fsp.truncate(oversizedWorkspace, workspaceLimit + 1)
  await assert.rejects(store.buildIndex(path.join(home, 'workspace-index')), /上限/, '工作区staging按32MiB拒建index')
  const growing = await write('growing', '1234')
  const originalOpen = fsp.open
  fsp.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (args[0] === growing) {
      const stat = handle.stat.bind(handle)
      handle.stat = async () => {
        const before = await stat()
        await fsp.appendFile(growing, '56789')
        return before
      }
    }
    return handle
  }
  try {
    await assert.rejects(readFileLimited(growing, 8), /上限/, 'stat后文件增长也被拒读')
    await fsp.writeFile(growing, '1234')
    await assert.rejects(sha1FileLimited(growing, 8), /上限/, '流式哈希也防stat后增长')
  } finally { fsp.open = originalOpen }
  const fileA = await write('memo-index/a', 'AAAA')
  const fileB = await write('memo-index/b', 'BBBB')
  const exactTime = new Date('2026-01-01T00:00:00Z')
  await fsp.utimes(fileA, exactTime, exactTime)
  await fsp.utimes(fileB, exactTime, exactTime)
  const memoIndex = await store.buildIndex(path.join(home, 'memo-index'), new Map())
  assert.equal(memoIndex.a.sha1, sha1(Buffer.from('AAAA')))
  assert.equal(memoIndex.b.sha1, sha1(Buffer.from('BBBB')), '同大小同mtime不同路径不共用错误哈希')
  assert.throws(() => parsePeerIndex(Buffer.alloc(MAX_INDEX_BYTES + 1)), /上限/)
  const info = { sha1: digest, size: 1 }
  const entries = Object.fromEntries(Array.from({ length: MAX_INDEX_ENTRIES + 1 }, (_, i) => [`f${i}`, info]))
  assert.throws(() => parsePeerIndex(Buffer.from(JSON.stringify({ files: entries }))), /100000/)
  console.log('离线 B9 响应体超时/逐块限额/200MB文件/32MiB工作区缓存与index/16MB解析/100000条 PASS')

  for (const declared of [true, false]) {
    let stored = false
    const server = createSyncServer({ token: () => 'test-token', putBlob: async () => { stored = true } })
    const req = new PassThrough()
    req.method = 'PUT'; req.url = '/v1/blob/' + 'a'.repeat(40)
    req.headers = { 'x-dsh-sync-token': 'test-token', ...(declared ? { 'content-length': MAX_BLOB_BYTES + 1 } : {}) }
    let status
    const response = new Promise((resolve) => {
      server.emit('request', req, { writeHead(code) { status = code }, end(body) { resolve(JSON.parse(body)) } })
    })
    if (declared) req.end()
    else {
      // 重复使用同一块内存，真实走服务端逐块计数，不分配201MiB测试载荷。
      const chunk = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < 201; i++) req.write(chunk)
      req.end()
    }
    assert.equal((await response).error, 'body too large')
    assert.equal(status, 413)
    assert.equal(stored, false)
  }
  console.log('离线 B9 服务端真实handler的声明长度/无长度逐块200MiB请求体上限 PASS')

  engine = makeEngine()
  await engine.init()
  for (const scenario of ['index-count', 'index-bytes', 'blob-size', 'blob-body']) {
    remoteIndex = { files: scenario === 'index-count' ? entries : {
      'attachments/oversized.bin': { sha1: digest, size: scenario === 'blob-size' ? MAX_BLOB_BYTES + 1 : 1 },
    } }
    indexHeader = scenario === 'index-bytes' ? { 'content-length': String(MAX_INDEX_BYTES + 1) } : undefined
    blobHeader = scenario === 'blob-body' ? { 'content-length': String(MAX_BLOB_BYTES + 1) } : undefined
    const before = healthyReads
    const result = await engine.runCycle()
    assert.ok(result.errors.some((e) => e.includes('peer remote:') && /上限|不合法/.test(e)), scenario)
    assert.equal(healthyReads, before + 1, '坏peer不影响下一个peer')
    await assert.rejects(fsp.access(path.join(home, 'attachments/oversized.bin')))
  }
  remoteIndex = { files: {} }; indexHeader = undefined; blobHeader = undefined
  await write('storages/workspace.json', '{bad')
  assert.ok((await engine.runCycle()).errors.some((e) => e.includes('JSON 解析失败')), 'N1首次合并error汇总')
  await write('storages/workspace.json', JSON.stringify(doc()))
  const badRemote = doc()
  badRemote.global.workspaceIds.push('bad-entry')
  badRemote.tables.workspaces['bad-entry'] = null
  remoteBody = Buffer.from(JSON.stringify(badRemote))
  remoteIndex = { files: { 'workspace/workspace.json': { sha1: sha1(remoteBody), size: remoteBody.length } } }
  assert.ok((await engine.runCycle()).errors.some((e) => e.includes('bad-entry')), 'N1第二次合并errors汇总')
  remoteBody = Buffer.from('invalid zstd')
  remoteIndex = { files: { [rel]: { sha1: sha1(remoteBody), size: remoteBody.length } } }
  assert.ok((await engine.runCycle()).errors.some((e) => e.includes('zstd 魔数')), 'apply错误汇总')
  await fsp.truncate(path.join(home, 'storages/workspace.json'), workspaceLimit + 1)
  assert.ok((await engine.runCycle()).errors.some((e) => e.includes('上限')), '本地超限workspace在导出时拒读并记录错误')
  assert.equal((await fsp.stat(path.join(home, 'storages/workspace.json'))).size, workspaceLimit + 1)
  console.log('离线 B9 坏peer跳过、后续peer继续；N1两次workspace/apply错误进入cycle PASS')
  console.log('ALL PASS（内存传输补充验证；真实 HTTP 仍待验收）')
} finally {
  await engine?.close()
  globalThis.fetch = originalFetch
  await fsp.rm(home, { recursive: true, force: true })
}
