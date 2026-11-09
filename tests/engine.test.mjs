import assert from 'node:assert'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../lib/engine.js'
import { MAX_BLOB_BYTES, MAX_INDEX_BYTES, MAX_INDEX_ENTRIES, readFileLimited, requestBuffer, parsePeerIndex } from '../lib/limits.js'
import { createStore } from '../lib/store.js'
import { createSyncServer, listen, closeServer } from '../lib/server.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function backdate(file, hoursAgo = 1) {
  const t = new Date(Date.now() - hoursAgo * 3600 * 1000)
  fs.utimesSync(file, t, t)
}

async function writeFileRel(root, rel, content) {
  const full = path.join(root, rel)
  await fsp.mkdir(path.dirname(full), { recursive: true })
  await fsp.writeFile(full, content)
  return full
}

async function listConflicts(home, prefix) {
  const dir = path.join(home, 'plugin-sync', 'conflicts')
  try {
    return (await fsp.readdir(dir)).filter((f) => f.startsWith(prefix))
  } catch {
    return []
  }
}

const TOKEN = 'test-token-0123456789abcdef'
const SESS_A = 'sessions/projX/sess-aaa/session.v4.jsonl.zstd'
const SESS_B = 'sessions/projY/sess-bbb/session.v4.jsonl.zstd'
const ATT_A = 'attachments/img.bin'

// 合法的 zstd 单段 raw-block frame，无需依赖压缩库，Node 20 同样可生成。
function sessionFixture(text) {
  const data = Buffer.from(JSON.stringify({ text }) + '\n')
  assert.ok(data.length < 256)
  const block = Buffer.alloc(3)
  block.writeUIntLE((data.length << 3) | 1, 0, 3)
  return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, data.length]), block, data])
}
const contentA1 = sessionFixture('session A v1 — hello from device A')
const contentB1 = sessionFixture('session B v1 — hello from device B')
const contentA2 = sessionFixture('session A v2 — edited on A')
const contentB2 = sessionFixture('session B v2 — edited on B')

function wsFor(sessionId, title, updatedAt) {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      workspaceIds: ['ws1'],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: 'ws1',
      initialized: true,
    },
    tables: {
      workspaces: {
        ws1: {
          path: `/tmp/proj-${title.toLowerCase()}`,
          title,
          sessionIds: [sessionId],
          createdAt: new Date(1000).toISOString(),
          updatedAt: new Date(updatedAt).toISOString(),
        },
      },
    },
  }
}

// v1.1：插件不再使用宿主 domain；宿主 storages/workspace.json 只作只读本地输入与哨兵。
async function readProposal(home) {
  return JSON.parse(await fsp.readFile(path.join(home, 'plugin-sync', 'proposed', 'workspace.json'), 'utf8'))
}

async function testStateRecovery() {
  const home = await fsp.mkdtemp(path.join(tmpRoot, 'state-recovery-'))
  const rel = SESS_A
  let remoteContent = contentB1
  const peer = createSyncServer({
    token: () => TOKEN, getDevice: () => 'remote', getRole: () => 'peer', getVersion: () => 'test',
    getIndex: async () => ({ [rel]: { sha1: sha1(remoteContent), size: remoteContent.length } }),
    getBlob: async () => remoteContent, putBlob: async () => {},
  })
  const port = await listen(peer, 0, '127.0.0.1')
  try {
    for (const stateBytes of [undefined, '{broken JSON', 'null', '{"localHashes":null,"remoteHashes":[]}']) {
      await writeFileRel(home, rel, contentA1)
      backdate(path.join(home, rel))
      await writeFileRel(home, 'storages/workspace.json', JSON.stringify(wsFor('sess-aaa', 'Local', 2000)))
      const stateFile = path.join(home, 'plugin-sync/state.json')
      if (stateBytes === undefined) await fsp.rm(stateFile, { force: true })
      else await writeFileRel(home, 'plugin-sync/state.json', stateBytes)
      remoteContent = contentB1
      const makeEngine = () => createEngine({ rowConfig: {
        dshHome: home, deviceName: 'state-test', listenPort: 0, token: TOKEN, settleSec: 0,
        peers: [{ name: 'remote', url: `http://127.0.0.1:${port}`, token: TOKEN }],
      } })
      let engine = makeEngine()
      try {
        await engine.init()
        const before = (await listConflicts(home, '')).length
        const result = await engine.runCycle()
        assert.deepStrictEqual(result.errors, [], `state=${stateBytes} 安全恢复`)
        assert.deepStrictEqual(await fsp.readFile(path.join(home, rel)), contentA1, '无基线保留本地')
        assert.strictEqual(result.conflicts, 1, '远端存冲突副本')
        assert.strictEqual((await listConflicts(home, '')).length, before + 1)
        const saved = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
        assert.strictEqual(saved.unresolvedConflict[rel].localSha, sha1(contentA1))
        assert.strictEqual(saved.unresolvedConflict[rel].remoteSha, sha1(contentB1))
        await engine.close()
        remoteContent = contentB2
        engine = makeEngine()
        await engine.init()
        const changed = await engine.runCycle()
        assert.deepStrictEqual(changed.errors, [], '重启后远端再次变化无落回错误')
        assert.deepStrictEqual(await fsp.readFile(path.join(home, rel)), contentA1, '持久未解决冲突禁止下轮覆盖')
        const unresolved = JSON.parse(await fsp.readFile(stateFile, 'utf8')).unresolvedConflict[rel]
        assert.ok(unresolved, '远端变化后未解决标记仍存在')
      } finally {
        await engine.close()
      }
    }
    console.log('state 缺失/损坏/错误结构 → 持久冲突 → 重启后远端变化仍保留本地 PASS')
  } finally {
    await closeServer(peer)
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function testResourceLimitsAndErrors() {
  const home = await fsp.mkdtemp(path.join(tmpRoot, 'resource-limits-'))
  let indexBytes = Buffer.from('{"files":{}}')
  let declaredIndexSize = null
  let blobGets = 0
  const peer = http.createServer((req, res) => {
    if (req.url === '/slow') {
      res.writeHead(200)
      res.write('start')
      return // headers 已返回，body 永不完成，必须由客户端超时终止
    }
    if (req.url === '/chunked') {
      res.writeHead(200)
      res.write(Buffer.alloc(700))
      return res.end(Buffer.alloc(700))
    }
    if (req.url === '/bigblob' || req.url.startsWith('/v1/blob/') && req.method === 'GET') {
      blobGets++
      res.writeHead(200, { 'content-length': MAX_BLOB_BYTES + 1 })
      return res.flushHeaders()
    }
    if (req.url === '/v1/index') {
      if (declaredIndexSize !== null) {
        res.writeHead(200, { 'content-length': declaredIndexSize })
        return res.flushHeaders()
      }
      return res.end(indexBytes)
    }
    req.resume()
    req.on('end', () => res.end('{"ok":true}'))
  })
  const port = await listen(peer, 0, '127.0.0.1')
  const url = `http://127.0.0.1:${port}`
  let engine
  try {
    await assert.rejects(requestBuffer(url + '/slow', {}, { timeoutMs: 80 }), /超时|abort/i, '响应体超时也中断')
    await assert.rejects(requestBuffer(url + '/chunked', {}, { maxBytes: 1024 }), /上限/, '无 Content-Length 时逐块限制')
    await assert.rejects(requestBuffer(url + '/bigblob'), /上限/, 'blob >200MB 根据响应头提前拒收')
    const sparse = await writeFileRel(home, 'oversized-blob', '')
    await fsp.truncate(sparse, MAX_BLOB_BYTES + 1)
    await assert.rejects(readFileLimited(sparse), /上限/, '本地稀疏文件超过200MB拒读')
    const store = createStore(home)
    const digest = 'a'.repeat(40)
    await fsp.mkdir(path.dirname(store.blobPath(digest)), { recursive: true })
    await fsp.copyFile(sparse, store.blobPath(digest))
    await assert.rejects(store.getBlob(digest), /上限/, '缓存 blob 同样拒读')
    await writeFileRel(home, 'staging/large', '')
    await fsp.truncate(path.join(home, 'staging/large'), MAX_BLOB_BYTES + 1)
    await assert.rejects(store.buildIndex(path.join(home, 'staging')), /上限/, '构建索引前拒绝超限blob')

    const info = { sha1: digest, size: 1 }
    const many = Object.fromEntries(Array.from({ length: MAX_INDEX_ENTRIES + 1 }, (_, i) => [`f${i}`, info]))
    const oversizedEntries = Buffer.from(JSON.stringify({ files: many }))
    assert.ok(oversizedEntries.length < MAX_INDEX_BYTES)
    assert.throws(() => parsePeerIndex(oversizedEntries), /100000/, '单peer超过100000条拒收')
    assert.throws(() => parsePeerIndex(Buffer.alloc(MAX_INDEX_BYTES + 1)), /上限/, 'index超过16MB拒绝解析')
    assert.deepStrictEqual(parsePeerIndex(Buffer.from('{"files":{}}')), { files: {} })

    await writeFileRel(home, 'storages/workspace.json', JSON.stringify(wsFor('sess-aaa', 'Local', 2000)))
    engine = createEngine({ rowConfig: { dshHome: home, listenPort: 0, token: TOKEN, peers: [{ name: 'bad-peer', url }] } })
    await engine.init()
    for (const scenario of ['entries', 'index-bytes', 'blob-metadata', 'blob-body']) {
      declaredIndexSize = scenario === 'index-bytes' ? MAX_INDEX_BYTES + 1 : null
      indexBytes = scenario === 'entries' ? oversizedEntries : Buffer.from(JSON.stringify({ files: {
        'attachments/remote.bin': { sha1: digest, size: scenario === 'blob-metadata' ? MAX_BLOB_BYTES + 1 : 1 },
      } }))
      const before = blobGets
      const result = await engine.runCycle()
      assert.ok(result.errors.some((e) => e.includes('peer bad-peer:') && /上限|不合法/.test(e)), `${scenario} 进入cycle.errors`)
      if (scenario !== 'blob-body') assert.strictEqual(blobGets, before, '整个坏peer在blob读取前被跳过')
      await assert.rejects(fsp.access(path.join(home, 'attachments/remote.bin')), '超限blob没有落回')
    }
    declaredIndexSize = null
    indexBytes = Buffer.from('{"files":{}}')
    await writeFileRel(home, 'storages/workspace.json', '{broken')
    const rejected = await engine.runCycle()
    assert.ok(rejected.errors.some((e) => e.includes('JSON 解析失败')), 'N1 首次合并拒写 error 汇总')
    await writeFileRel(home, 'storages/workspace.json', JSON.stringify(wsFor('sess-aaa', 'Local', 2000)))
    const remote = wsFor('sess-remote', 'Remote', 3000)
    remote.global.workspaceIds.push('broken-entry')
    remote.tables.workspaces['broken-entry'] = null
    const remoteBytes = Buffer.from(JSON.stringify(remote))
    indexBytes = Buffer.from(JSON.stringify({ files: {
      'workspace/workspace.json': { sha1: sha1(remoteBytes), size: remoteBytes.length },
    } }))
    // 此次远端 workspace body 是合法JSON，坏条目应报告而不是让整个复检崩溃。
    const serveWorkspace = (req, res) => {
      if (req.method === 'GET' && req.url.startsWith('/v1/blob/')) res.end(remoteBytes)
      else if (req.url === '/v1/index') res.end(indexBytes)
      else { req.resume(); req.on('end', () => res.end('{"ok":true}')) }
    }
    peer.removeAllListeners('request')
    peer.on('request', serveWorkspace)
    const merged = await engine.runCycle()
    assert.ok(merged.errors.some((e) => e.includes('broken-entry')), 'N1 第二次合并 errors 数组汇总')
    console.log('B9 响应体超时/200MB/16MB/100000条 + N1 cycle错误汇总 PASS')
  } finally {
    await engine?.close()
    peer.closeAllConnections()
    await closeServer(peer)
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function testServerBodyLimit() {
  let stored = false
  const server = createSyncServer({
    token: () => TOKEN, putBlob: async () => { stored = true },
  })
  const port = await listen(server, 0, '127.0.0.1')
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/blob/' + 'a'.repeat(40), method: 'PUT', headers: {
        'x-dsh-sync-token': TOKEN, 'content-length': MAX_BLOB_BYTES + 1,
      } }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
      req.flushHeaders()
    })
    assert.strictEqual(status, 413, '服务端200MB请求体上限')
    assert.strictEqual(stored, false)
    console.log('服务端超限请求体拒收 PASS')
  } finally {
    server.closeAllConnections()
    await closeServer(server)
  }
}

async function main() {
  await fsp.mkdir(tmpRoot, { recursive: true })
  const portA = await freePort()
  const portB = await freePort()
  const homeA = await fsp.mkdtemp(path.join(tmpRoot, 'dsh-sync-a-'))
  const homeB = await fsp.mkdtemp(path.join(tmpRoot, 'dsh-sync-b-'))

  const engineA = createEngine({
    rowConfig: {
      deviceName: 'A',
      role: 'peer',
      listenPort: portA,
      token: TOKEN,
      peers: [{ name: 'B', url: `http://127.0.0.1:${portB}`, token: TOKEN }],
      intervalSec: 300,
      settleSec: 60,
      dshHome: homeA,
    },
  })
  const engineB = createEngine({
    rowConfig: {
      deviceName: 'B',
      role: 'peer',
      listenPort: portB,
      token: TOKEN,
      peers: [{ name: 'A', url: `http://127.0.0.1:${portA}`, token: TOKEN }],
      intervalSec: 300,
      settleSec: 60,
      dshHome: homeB,
    },
  })

  try {
    await engineA.init()
    await engineB.init()
    assert.strictEqual(engineA.listening, portA, 'A 监听端口')
    assert.strictEqual(engineB.listening, portB, 'B 监听端口')

    const statusA = await engineA.status()
    assert.strictEqual(statusA.token, 'test' + '****', 'token 打码（v1.4.1 B7：长 token 保留前 4 位）')
    assert.strictEqual(statusA.device, 'A')
    assert.strictEqual(statusA.workspaceWriteMode, 'proposal')
    assert.strictEqual(statusA.proposalPending, false)
    assert.strictEqual(statusA.proposalPathSafe, true)

    // ---------- 1. 初始同步：A 的会话/附件/workspaces 送到 B，workspace sessionIds 并集 ----------
    await writeFileRel(homeA, SESS_A, contentA1)
    backdate(path.join(homeA, SESS_A))
    await writeFileRel(homeA, ATT_A, Buffer.from('attachment-bytes-A'))
    await writeFileRel(homeA, path.join('storages', 'workspace.json'), JSON.stringify(wsFor('sess-aaa', 'ProjX', 2000)))
    const hostABytes = await fsp.readFile(path.join(homeA, 'storages', 'workspace.json'))

    await writeFileRel(homeB, SESS_B, contentB1)
    backdate(path.join(homeB, SESS_B))
    await writeFileRel(homeB, path.join('storages', 'workspace.json'), JSON.stringify(wsFor('sess-bbb', 'ProjY', 2500)))
    const hostBBytes = await fsp.readFile(path.join(homeB, 'storages', 'workspace.json'))

    const rA1 = await engineA.runCycle()
    assert.ok(!rA1.skipped, 'cycle 未被跳过')
    assert.deepStrictEqual(rA1.errors, [], 'A 第一轮无错误')
    const rB1 = await engineB.runCycle()
    assert.deepStrictEqual(rB1.errors, [], 'B 第一轮无错误')

    const gotSessB = await fsp.readFile(path.join(homeB, SESS_A))
    assert.strictEqual(sha1(gotSessB), sha1(contentA1), 'B 的 dshHome 出现 A 的会话')
    const gotAttB = await fsp.readFile(path.join(homeB, ATT_A))
    assert.strictEqual(sha1(gotAttB), sha1(Buffer.from('attachment-bytes-A')), 'B 收到附件')

    const wsB = await readProposal(homeB)
    assert.deepStrictEqual(
      [...wsB.tables.workspaces.ws1.sessionIds].sort(),
      ['sess-aaa', 'sess-bbb'],
      'B 的建议文件 workspace sessionIds 为并集',
    )
    assert.strictEqual((await engineB.status()).proposalPending, true, 'B 建议待应用')

    // B 的会话也推给 A（B 第一轮推、A 第二轮拉）
    const rA2 = await engineA.runCycle()
    assert.deepStrictEqual(rA2.errors, [], 'A 第二轮无错误')
    const gotSessA = await fsp.readFile(path.join(homeA, SESS_B))
    assert.strictEqual(sha1(gotSessA), sha1(contentB1), 'A 收到 B 的会话')
    const wsA = await readProposal(homeA)
    assert.deepStrictEqual(
      [...wsA.tables.workspaces.ws1.sessionIds].sort(),
      ['sess-aaa', 'sess-bbb'],
      'A 的建议文件 workspace sessionIds 为并集',
    )

    // ---------- 2. 冲突：两端都改同一会话 ----------
    await writeFileRel(homeA, SESS_A, contentA2)
    backdate(path.join(homeA, SESS_A))
    await writeFileRel(homeB, SESS_A, contentB2)
    backdate(path.join(homeB, SESS_A))

    const rA3 = await engineA.runCycle()
    assert.deepStrictEqual(rA3.errors, [], 'A 冲突轮无错误')
    const rB3 = await engineB.runCycle()
    assert.deepStrictEqual(rB3.errors, [], 'B 冲突轮无错误')

    const aNow = await fsp.readFile(path.join(homeA, SESS_A))
    assert.strictEqual(sha1(aNow), sha1(contentA2), 'A 保留本地版本')
    const bNow = await fsp.readFile(path.join(homeB, SESS_A))
    assert.strictEqual(sha1(bNow), sha1(contentB2), 'B 保留本地版本')

    // ---------- 3. 幂等：再各跑两轮，pulled/pushed 为 0，本地 sha1 不变 ----------
    const rA4 = await engineA.runCycle()
    assert.strictEqual(rA4.pulled, 0, `A 幂等轮 pulled=0 (got ${rA4.pulled})`)
    assert.strictEqual(rA4.pushed, 0, `A 幂等轮 pushed=0 (got ${rA4.pushed})`)
    const rB4 = await engineB.runCycle()
    assert.strictEqual(rB4.pulled, 0, `B 幂等轮 pulled=0 (got ${rB4.pulled})`)
    assert.strictEqual(rB4.pushed, 0, `B 幂等轮 pushed=0 (got ${rB4.pushed})`)
    assert.strictEqual(sha1(await fsp.readFile(path.join(homeA, SESS_A))), sha1(contentA2), 'A 本地 sha1 不变')
    assert.strictEqual(sha1(await fsp.readFile(path.join(homeB, SESS_A))), sha1(contentB2), 'B 本地 sha1 不变')

    const conflictPrefix = SESS_A.split('/').join('__') + '.conflict-'
    const conflictsA = await listConflicts(homeA, conflictPrefix)
    assert.ok(conflictsA.length >= 1, 'A 的 conflicts/ 出现对端副本')
    const aConflictSha = sha1(await fsp.readFile(path.join(homeA, 'plugin-sync', 'conflicts', conflictsA[0])))
    assert.strictEqual(aConflictSha, sha1(contentB2), 'A 的冲突副本内容为 B 的版本')

    const conflictsB = await listConflicts(homeB, conflictPrefix)
    assert.ok(conflictsB.length >= 1, 'B 的 conflicts/ 出现对端副本')
    const bConflictSha = sha1(await fsp.readFile(path.join(homeB, 'plugin-sync', 'conflicts', conflictsB[0])))
    assert.strictEqual(bConflictSha, sha1(contentA2), 'B 的冲突副本内容为 A 的版本')

    const rA5 = await engineA.runCycle()
    assert.strictEqual(rA5.pulled, 0, 'A 第二个幂等轮 pulled=0')
    assert.strictEqual(rA5.pushed, 0, 'A 第二个幂等轮 pushed=0')
    const rB5 = await engineB.runCycle()
    assert.strictEqual(rB5.pulled, 0, 'B 第二个幂等轮 pulled=0')
    assert.strictEqual(rB5.pushed, 0, 'B 第二个幂等轮 pushed=0')
    assert.strictEqual(sha1(await fsp.readFile(path.join(homeA, SESS_A))), sha1(contentA2), 'A 本地 sha1 仍不变')
    assert.strictEqual(sha1(await fsp.readFile(path.join(homeB, SESS_A))), sha1(contentB2), 'B 本地 sha1 仍不变')

    // v5：宿主哨兵按初始 Buffer 原始字节比较，任何重排/重序列化都会失败。
    assert.ok(
      (await fsp.readFile(path.join(homeA, 'storages/workspace.json'))).equals(hostABytes),
      'proposal模式从未改宿主文件哨兵A（原始字节）',
    )
    assert.ok(
      (await fsp.readFile(path.join(homeB, 'storages/workspace.json'))).equals(hostBBytes),
      'proposal模式从未改宿主文件哨兵B（原始字节）',
    )
    await testStateRecovery()
    await testResourceLimitsAndErrors()
    await testServerBodyLimit()
    console.log('ALL PASS')
  } finally {
    await engineA.close()
    await engineB.close()
    await fsp.rm(homeA, { recursive: true, force: true })
    await fsp.rm(homeB, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('TEST FAILED:', e)
  process.exit(1)
})
