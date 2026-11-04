// v5 安全验收：7 类真实符号链接攻击（真实文件系统 + 真实 symlink + 完整 runCycle）。
// 所有数据都在 tests/.tmp 隔离目录内，绝不触及真实 ~/.dsh。
// peer 传输用内存 fetch 替代（与 engine.offline 同口径）；真实 HTTP 哨兵在 engine.test.mjs。
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../lib/engine.js'
import { mergeWorkspace } from '../lib/workspace.js'
import { sha1 } from '../lib/util.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
await fsp.mkdir(tmpRoot, { recursive: true })

const sha1Buf = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex')

function session(text) {
  const data = Buffer.from(JSON.stringify({ text }) + '\n')
  const block = Buffer.alloc(3)
  block.writeUIntLE((data.length << 3) | 1, 0, 3)
  return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, data.length]), block, data])
}

const doc = () => ({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws'], defaultWorkspaceId: 'ws', archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { ws: { path: '/proj', title: 'Local', sessionIds: ['local-session'], createdAt: '2026-01-01', updatedAt: '2026-01-02' } } },
})

const SESSION_REL = 'sessions/proj/s1/session.v4.jsonl.zstd'

async function makeHome(label) {
  return fsp.mkdtemp(path.join(tmpRoot, `security-${label}-`))
}

function makeEngine(home, extra = {}) {
  return createEngine({ rowConfig: {
    dshHome: home, deviceName: 'security', listenPort: 0, token: 'security-token', settleSec: 0,
    ...extra,
  } })
}

// 内存 peer 传输：routes: Map<hostname, Map<rel, Buffer>>
function servePeers(routes) {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url)
    const files = routes.get(parsed.hostname) || new Map()
    if (parsed.pathname === '/v1/index') {
      const out = {}
      for (const [rel, bytes] of files) out[rel] = { sha1: sha1Buf(bytes), size: bytes.length }
      return new Response(JSON.stringify({ files: out }), { headers: { 'content-type': 'application/json' } })
    }
    if (init.method === 'PUT') return Response.json({ ok: true })
    const match = parsed.pathname.match(/^\/v1\/blob\/([0-9a-f]{40})$/)
    if (match) {
      for (const [, bytes] of files) {
        if (sha1Buf(bytes) === match[1]) return new Response(bytes)
      }
      return new Response('{"error":"blob not found"}', { status: 404 })
    }
    return Response.json({ ok: true })
  }
  return () => { globalThis.fetch = previous }
}

// 在 fn 执行期间劫持 fsp 写操作：任何落在 protectedDirs 内的写系统调用都记为违规。
// 读操作（'r' 打开/lstat/realpath/readdir）不受限——守卫本身需要它们做校验。
async function assertNoWritesTo(protectedDirs, fn) {
  const dirs = protectedDirs.map((dir) => path.resolve(dir))
  const original = {}
  for (const name of ['open', 'rename', 'copyFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'writeFile', 'truncate']) {
    original[name] = fsp[name]
  }
  const violations = []
  const check = (p) => {
    if (typeof p !== 'string' || !p) return
    const abs = path.resolve(p)
    for (const dir of dirs) {
      if (abs === dir || abs.startsWith(dir + path.sep)) violations.push(`${abs} (via ${p})`)
    }
  }
  const writeish = (flags) => typeof flags === 'number'
    ? (flags & 0b11) !== 0 || (flags & fs.constants.O_CREAT) !== 0
    : String(flags) !== 'r'
  const wrap = (name, watched) => {
    fsp[name] = (...args) => {
      for (const p of watched(args)) check(p)
      return original[name](...args)
    }
  }
  wrap('open', (args) => (writeish(args[1]) ? [args[0]] : []))
  wrap('rename', (args) => [args[0], args[1]])
  wrap('copyFile', (args) => [args[1]])
  wrap('appendFile', (args) => [args[0]])
  wrap('mkdir', (args) => [args[0]])
  wrap('rm', (args) => [Array.isArray(args[0]) ? '' : args[0]])
  wrap('unlink', (args) => [args[0]])
  wrap('writeFile', (args) => [args[0]])
  wrap('truncate', (args) => [args[0]])
  try {
    const result = await fn()
    assert.deepEqual(violations, [], '受保护路径上不得出现任何写操作')
    return result
  } finally {
    for (const [name, fnOriginal] of Object.entries(original)) fsp[name] = fnOriginal
  }
}

const tests = []
const test = (name, run) => tests.push([name, run])

// ── 攻击 1：staging/workspace → 宿主 storages，完整 runCycle（含双 peer 拉取）──
test('攻击1 staging/workspace→storages：runCycle 后宿主字节不变、错误可见、该目标不再重试', async () => {
  const home = await makeHome('staging-ws')
  const dataDir = path.join(home, 'plugin-sync')
  const stagingRoot = path.join(dataDir, 'staging')
  const storagesDir = path.join(home, 'storages')
  const hostPath = path.join(storagesDir, 'workspace.json')
  await fsp.mkdir(storagesDir, { recursive: true })
  const sentinel = Buffer.from(JSON.stringify(doc(), null, 2))
  await fsp.writeFile(hostPath, sentinel)
  await fsp.mkdir(stagingRoot, { recursive: true })
  await fsp.symlink(storagesDir, path.join(stagingRoot, 'workspace'), 'dir')

  const sessionBytes = session('remote session for attack 1')
  const remoteDoc = Buffer.from(JSON.stringify(doc()))
  const files = new Map([[SESSION_REL, sessionBytes], ['workspace/workspace.json', remoteDoc]])
  const restoreFetch = servePeers(new Map([['p1', files], ['p2', files]]))
  const engine = makeEngine(home, { peers: [{ name: 'p1', url: 'http://p1' }, { name: 'p2', url: 'http://p2' }] })
  try {
    await engine.init()
    const cycle = await engine.runCycle()
    assert.deepEqual(await fsp.readFile(hostPath), sentinel, '宿主 workspace.json 字节不变')
    assert.deepEqual(await fsp.readdir(storagesDir), ['workspace.json'], 'storages 内无新增文件')
    assert.ok(cycle.errors.some((e) => e.includes('拒绝写入') && e.includes('符号链接')), 'cycle.errors 记录拒绝')
    assert.ok(cycle.errors.some((e) => e.includes('不再重试')), '第二个 peer 对同一目标不再重试')
    assert.deepEqual(await fsp.readFile(path.join(home, SESSION_REL)), sessionBytes, '会话拉取不受影响，正常落盘')
    assert.equal(JSON.parse(await fsp.readFile(path.join(dataDir, 'proposed', 'workspace.json'), 'utf8')).global.initialized, true, '建议文件不受 staging 劫持影响')

    // 第二轮：新 round 后 fs 校验仍拒绝；全程对受保护子树零写系统调用（含 mkdir/rename/tmp）。
    const cycle2 = await assertNoWritesTo([path.join(stagingRoot, 'workspace'), storagesDir], () => engine.runCycle())
    assert.ok(cycle2.errors.some((e) => e.includes('拒绝写入')), '第二轮仍记录拒绝')
    assert.deepEqual(await fsp.readFile(hostPath), sentinel, '第二轮宿主字节仍不变')
    assert.deepEqual(await fsp.readdir(storagesDir), ['workspace.json'])
  } finally {
    await engine.close()
    restoreFetch()
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击1 staging/workspace→storages（runCycle/哨兵字节/错误可见/不再重试/零写系统调用）')
})

// ── 攻击 2：dshHome/storages 为悬空符号链接（→ plugin-sync/proposed），初始化/合并/日志 ──
test('攻击2 storages 悬空符号链接：初始化/合并/日志/state 都不得创建或写入 alias 目标', async () => {
  const home = await makeHome('dangling-storages')
  const dataDir = path.join(home, 'plugin-sync')
  const stagingRoot = path.join(dataDir, 'staging')
  const alias = path.join(dataDir, 'proposed')
  await fsp.mkdir(path.join(stagingRoot, 'workspace'), { recursive: true })
  // 远端合法文档已在 staging：若防护失效，合并会把建议写进 proposed，令别名生效。
  await fsp.writeFile(path.join(stagingRoot, 'workspace', 'workspace.json'), JSON.stringify(doc()))
  await fsp.symlink(alias, path.join(home, 'storages'), 'dir')

  const engine = makeEngine(home)
  try {
    await engine.init()
    const cycle = await engine.runCycle()
    assert.equal((await fsp.lstat(path.join(home, 'storages'))).isSymbolicLink(), true, 'storages 仍是符号链接')
    await assert.rejects(fsp.stat(alias), { code: 'ENOENT' }, 'alias 目标 proposed 从未被创建')
    await assert.rejects(fsp.stat(path.join(alias, 'workspace.json')))
    await assert.rejects(fsp.readFile(path.join(home, 'storages', 'workspace.json')), { code: 'ENOENT' }, '宿主视角仍是悬空链接（字节视图不变）')
    await assert.rejects(fsp.stat(path.join(dataDir, 'config.json')), { code: 'ENOENT' }, '危险配置下 config.json 不播种')
    assert.deepEqual(await fsp.readdir(path.join(dataDir, 'logs')), [], '危险配置下日志不落盘')
    await assert.rejects(fsp.stat(path.join(dataDir, 'state.json')), { code: 'ENOENT' }, '危险配置下 state.json 不落盘')
    assert.ok(cycle.errors.some((e) => e.includes('危险配置') || e.includes('符号链接')), '错误对调用方可见')
    assert.ok(cycle.errors.some((e) => e.includes('state.json 持久化失败')), 'state 拒写可见')
    assert.equal(cycle.merged, 0)
  } finally {
    await engine.close()
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击2 storages 悬空符号链接（零 alias 创建/config/logs/state 拒写/错误可见）')
})

// ── 攻击 3：plugin-sync/logs/sync.log → 宿主 storages/workspace.json ──
test('攻击3 logs/sync.log→storages/workspace.json：播种日志与空token警告都不得追加', async () => {
  const home = await makeHome('log-link')
  const dataDir = path.join(home, 'plugin-sync')
  const storagesDir = path.join(home, 'storages')
  const hostPath = path.join(storagesDir, 'workspace.json')
  await fsp.mkdir(storagesDir, { recursive: true })
  const sentinel = Buffer.from(JSON.stringify(doc(), null, 2))
  await fsp.writeFile(hostPath, sentinel)
  const logsDir = path.join(dataDir, 'logs')
  await fsp.mkdir(logsDir, { recursive: true })
  await fsp.symlink(hostPath, path.join(logsDir, 'sync.log'), 'file')

  const engine = makeEngine(home, { token: '' })
  try {
    await engine.init()
    const cycle = await engine.runCycle()
    assert.deepEqual(await fsp.readFile(hostPath), sentinel, '宿主 workspace.json 字节不变（未追加播种/警告/运行日志）')
    assert.equal((await fsp.lstat(path.join(logsDir, 'sync.log'))).isSymbolicLink(), true, 'sync.log 仍是符号链接，未被替换')
    // 目录里只应有我们预埋的符号链接本身；不得出现真实 sync.log 或轮转出的 sync.log.1
    assert.deepEqual(await fsp.readdir(logsDir), ['sync.log'], '无新文件落盘（链接未被替换，也未轮转出 sync.log.1）')
    assert.deepEqual(cycle.errors, [], '仅日志路径受影响，其余写入正常')
    assert.equal(cycle.merged, 1)
  } finally {
    await engine.close()
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击3 logs/sync.log→storages/workspace.json（零追加/链接保留/宿主字节不变）')
})

// ── 攻击 4：staging/workspace/workspace.json 本身是符号链接 ──
test('攻击4 staging目标文件是符号链接：拒绝写入且不清理链接，宿主字节不变', async () => {
  const home = await makeHome('staging-file-link')
  const dataDir = path.join(home, 'plugin-sync')
  const stagingRoot = path.join(dataDir, 'staging')
  const storagesDir = path.join(home, 'storages')
  const hostPath = path.join(storagesDir, 'workspace.json')
  await fsp.mkdir(storagesDir, { recursive: true })
  const sentinel = Buffer.from(JSON.stringify(doc(), null, 2))
  await fsp.writeFile(hostPath, sentinel)
  const linkPath = path.join(stagingRoot, 'workspace', 'workspace.json')
  await fsp.mkdir(path.dirname(linkPath), { recursive: true })
  await fsp.symlink(hostPath, linkPath, 'file')

  const sessionBytes = session('remote session for attack 4')
  const remoteDoc = Buffer.from(JSON.stringify(doc()))
  const files = new Map([[SESSION_REL, sessionBytes], ['workspace/workspace.json', remoteDoc]])
  const restoreFetch = servePeers(new Map([['p1', files]]))
  const engine = makeEngine(home, { peers: [{ name: 'p1', url: 'http://p1' }] })
  try {
    await engine.init()
    const cycle = await engine.runCycle()
    assert.deepEqual(await fsp.readFile(hostPath), sentinel, '宿主 workspace.json 字节不变')
    assert.equal((await fsp.lstat(linkPath)).isSymbolicLink(), true, '符号链接未被写入替换、也未被清理')
    assert.ok(cycle.errors.some((e) => e.includes('符号链接')), 'cycle.errors 记录拒绝')
    assert.ok(cycle.errors.some((e) => e.includes('不再重试')), '同轮 pull 对该目标不再重试')
    assert.deepEqual(await fsp.readFile(path.join(home, SESSION_REL)), sessionBytes, '会话同步不受影响')
    assert.equal(JSON.parse(await fsp.readFile(path.join(dataDir, 'proposed', 'workspace.json'), 'utf8')).global.initialized, true, '建议文件正常写出')
  } finally {
    await engine.close()
    restoreFetch()
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击4 staging/workspace/workspace.json 为符号链接（拒写/不清理/宿主字节不变）')
})

// ── 攻击 5：storages → plugin-sync/proposed 且 proposed 不存在（Codex 复现的悬空别名）──
test('攻击5 storages→proposed 悬空别名：proposal 写被拒绝，alias 目标不被创建', async () => {
  const home = await makeHome('dangling-proposal')
  const dataDir = path.join(home, 'plugin-sync')
  const stagingRoot = path.join(dataDir, 'staging')
  const stagingPath = path.join(stagingRoot, 'workspace', 'workspace.json')
  const alias = path.join(dataDir, 'proposed')
  await fsp.mkdir(path.dirname(stagingPath), { recursive: true })
  const remoteBytes = Buffer.from(JSON.stringify(doc()))
  await fsp.writeFile(stagingPath, remoteBytes)
  await fsp.symlink(alias, path.join(home, 'storages'), 'dir')

  const result = await mergeWorkspace({ dshHome: home, stagingRoot, dataDir })
  assert.equal(result.merged, false)
  assert.equal(result.proposalPathSafe, false)
  assert.match(result.error, /危险配置|拒绝写入/)
  assert.equal((await fsp.lstat(path.join(home, 'storages'))).isSymbolicLink(), true)
  await assert.rejects(fsp.stat(alias), { code: 'ENOENT' }, 'proposed 目录从未被 mkdir（别名不生效）')
  assert.deepEqual(await fsp.readFile(stagingPath), remoteBytes, 'staging 副本未被改写')
  console.log('PASS 攻击5 悬空 storages 别名（proposal 拒绝/alias 不创建/staging 不变）')
})

// ── 攻击 6：apply 落回目标父级为符号链接（指向 storages）──
test('攻击6 attachments 父级符号链接→storages：apply 拒绝，宿主文件不变', async () => {
  const home = await makeHome('apply-parent-link')
  const dataDir = path.join(home, 'plugin-sync')
  const storagesDir = path.join(home, 'storages')
  const hostPath = path.join(storagesDir, 'workspace.json')
  await fsp.mkdir(storagesDir, { recursive: true })
  const sentinel = Buffer.from(JSON.stringify(doc(), null, 2))
  await fsp.writeFile(hostPath, sentinel)
  await fsp.symlink(storagesDir, path.join(home, 'attachments'), 'dir')

  const evil = Buffer.from('{"evil":"must not land in storages"}')
  const restoreFetch = servePeers(new Map([['p1', new Map([['attachments/evil.bin', evil]])]]))
  const engine = makeEngine(home, { peers: [{ name: 'p1', url: 'http://p1' }] })
  try {
    await engine.init()
    const cycle = await engine.runCycle()
    assert.ok(cycle.errors.some((e) => e.includes('父目录是符号链接')), 'cycle.errors 记录父级符号链接拒绝')
    assert.deepEqual(await fsp.readFile(hostPath), sentinel, '宿主 workspace.json 字节不变')
    assert.deepEqual(await fsp.readdir(storagesDir), ['workspace.json'], 'storages 内无 evil.bin 或临时文件')
    assert.equal((await fsp.lstat(path.join(home, 'attachments'))).isSymbolicLink(), true, 'attachments 链接未被改动')
  } finally {
    await engine.close()
    restoreFetch()
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击6 apply 落回父级符号链接（拒绝/宿主字节不变/storages 无新文件）')
})

// ── 攻击 7：真实事故 fixture（proposal 输出合法、宿主字节不变、initialized 保留、
// 本地递归键不缩减、sessionIds 并集）──
test('攻击7 真实事故fixture：合并输出合法且宿主字节不变', async () => {
  const source = '/tmp/dsh-sync-accept'
  const localBytes = await fsp.readFile(path.join(source, 'workspace.local.json'))
  const remoteBytes = await fsp.readFile(path.join(source, 'workspace.staging.json'))
  const local = JSON.parse(localBytes.toString('utf8'))
  const remote = JSON.parse(remoteBytes.toString('utf8'))
  const keys = (value, prefix = '') => (!value || typeof value !== 'object' || Array.isArray(value))
    ? []
    : Object.entries(value).flatMap(([key, item]) => {
      const next = `${prefix}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
      return [next, ...keys(item, next)]
    })

  const home = await makeHome('incident-fixture')
  const dataDir = path.join(home, 'plugin-sync')
  const stagingRoot = path.join(dataDir, 'staging')
  const hostPath = path.join(home, 'storages', 'workspace.json')
  const proposalPath = path.join(dataDir, 'proposed', 'workspace.json')
  try {
    await fsp.mkdir(path.dirname(hostPath), { recursive: true })
    await fsp.mkdir(path.join(stagingRoot, 'workspace'), { recursive: true })
    await fsp.writeFile(hostPath, localBytes)
    await fsp.writeFile(path.join(stagingRoot, 'workspace', 'workspace.json'), remoteBytes)
    const result = await mergeWorkspace({ dshHome: home, stagingRoot, dataDir })
    assert.equal(result.merged, true)
    assert.equal(result.workspaceWriteMode, 'proposal')
    assert.deepEqual(result.errors, [])
    const proposalBytes = await fsp.readFile(proposalPath)
    const proposal = JSON.parse(proposalBytes.toString('utf8'))
    assert.equal(proposal.global.initialized, local.global.initialized, 'initialized 保留')
    const outputKeys = new Set(keys(proposal))
    assert.ok(keys(local).every((key) => outputKeys.has(key)), '本地递归键不缩减')
    for (const [id, workspace] of Object.entries(local.tables.workspaces)) {
      const union = [...new Set([...workspace.sessionIds, ...(remote.tables.workspaces[id]?.sessionIds || [])])]
      assert.deepEqual(proposal.tables.workspaces[id].sessionIds, union, `workspace ${id} sessionIds 并集`)
    }
    assert.deepEqual(await fsp.readFile(hostPath), localBytes, '宿主原字节完全不变')
    assert.deepEqual(await fsp.readFile(path.join(stagingRoot, 'workspace', 'workspace.json')), proposalBytes)
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击7 真实事故fixture（合法v2/initialized/递归键/并集/宿主字节不变）')
})

let failed = 0
for (const [name, run] of tests) {
  try {
    await run()
  } catch (e) {
    failed++
    console.error(`FAIL ${name}`)
    console.error(e)
  }
}
if (failed) {
  console.error(`FAILED (${failed}/${tests.length})`)
  process.exitCode = 1
} else {
  console.log(`ALL PASS (${tests.length} real-symlink attack cases)`)
}
