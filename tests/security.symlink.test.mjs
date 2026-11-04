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
import { guardedWrite, guardedAppend, guardedRotate, assertSafeRoot, assertApplyTarget } from '../lib/safe-writer.js'

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
    // v6：目录创建经 guardedMkdir——危险配置下 logs 目录根本不创建（比 v5 更严格：连目录都不建）。
    await assert.rejects(fsp.stat(path.join(dataDir, 'logs')), { code: 'ENOENT' }, '危险配置下 logs 目录不创建')
    await assert.rejects(fsp.stat(path.join(dataDir, 'state.json')), { code: 'ENOENT' }, '危险配置下 state.json 不落盘')
    assert.ok(cycle.errors.some((e) => e.includes('危险配置') || e.includes('符号链接')), '错误对调用方可见')
    // v6：导出阶段的 guardedMkdir 即拒绝危险配置，整轮 fail-closed 提前中止
    // （runCycle 捕获该异常并以裸消息计入 errors）；state.json 因此不会落盘（下方 ENOENT 是硬证据）。
    assert.ok(cycle.errors.some((e) => e.startsWith('检测到') && e.includes('危险配置')), '本轮在导出阶段即拒绝')
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
    // v6：日志拒绝不再静默，计入 cycle.errors。
    assert.ok(cycle.errors.some((e) => e.includes('sync.log') && e.includes('符号链接')), '日志拒绝进入 cycle.errors（v6 起不再静默）')
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

  // v6：补 finally 清理——无论断言成败都删除符号链接与临时目录，不污染 tests/.tmp。
  try {
    const result = await mergeWorkspace({ dshHome: home, stagingRoot, dataDir })
    assert.equal(result.merged, false)
    assert.equal(result.proposalPathSafe, false)
    assert.match(result.error, /危险配置|拒绝写入/)
    assert.equal((await fsp.lstat(path.join(home, 'storages'))).isSymbolicLink(), true)
    await assert.rejects(fsp.stat(alias), { code: 'ENOENT' }, 'proposed 目录从未被 mkdir（别名不生效）')
    assert.deepEqual(await fsp.readFile(stagingPath), remoteBytes, 'staging 副本未被改写')
    console.log('PASS 攻击5 悬空 storages 别名（proposal 拒绝/alias 不创建/staging 不变）')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
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

// ── 攻击 8：plugin-sync 本身是符号链接 → 宿主 storages（v6 初始化目录污染）──
test('攻击8 plugin-sync→storages 符号链接：初始化不得在宿主目录创建任何目录/文件', async () => {
  const home = await makeHome('init-plugin-link')
  const storagesDir = path.join(home, 'storages')
  const hostPath = path.join(storagesDir, 'workspace.json')
  try {
    await fsp.mkdir(storagesDir, { recursive: true })
    const sentinel = Buffer.from(JSON.stringify(doc(), null, 2))
    await fsp.writeFile(hostPath, sentinel)
    await fsp.symlink(storagesDir, path.join(home, 'plugin-sync'), 'dir')

    const engine = makeEngine(home)
    try {
      // 初始化全程对宿主 storages 零写系统调用（含 mkdir——guardedMkdir 先校验后创建）。
      await assertNoWritesTo([storagesDir], () => engine.init())
      const cycle = await engine.runCycle()
      assert.deepEqual(await fsp.readFile(hostPath), sentinel, '宿主 workspace.json 字节不变')
      assert.deepEqual(await fsp.readdir(storagesDir), ['workspace.json'], '初始化未在宿主创建 staging/logs/store/conflicts')
      assert.equal((await fsp.lstat(path.join(home, 'plugin-sync'))).isSymbolicLink(), true, 'plugin-sync 链接未被替换')
      assert.ok(cycle.errors.length > 0, 'cycle.errors 记录拒绝')
    } finally {
      await engine.close()
    }
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击8 plugin-sync→storages（初始化零创建/宿主清单不变/零写系统调用）')
})

// ── 攻击 9：storages → plugin-sync/logs 悬空（初始化不得激活别名）──
test('攻击9 悬空 storages→plugin-sync/logs：初始化不得创建目录激活别名', async () => {
  const home = await makeHome('init-logs-alias')
  const alias = path.join(home, 'storages')
  const logsDir = path.join(home, 'plugin-sync', 'logs')
  try {
    await fsp.symlink(logsDir, alias, 'dir')
    const engine = makeEngine(home)
    try {
      await engine.init()
      const cycle = await engine.runCycle()
      await assert.rejects(fsp.stat(logsDir), { code: 'ENOENT' }, 'logs 目录从未被创建（别名未被激活）')
      await assert.rejects(fsp.stat(path.join(home, 'plugin-sync')), { code: 'ENOENT' }, 'plugin-sync 目录也未被创建')
      assert.equal((await fsp.lstat(alias)).isSymbolicLink(), true, 'storages 仍是悬空符号链接')
      assert.ok(cycle.errors.some((e) => e.includes('危险配置') || e.includes('符号链接')), '错误对调用方可见')
    } finally {
      await engine.close()
    }
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击9 悬空 storages→plugin-sync/logs（初始化零创建/别名不激活）')
})

// ── 攻击 10：staging 根本身是符号链接 → 宿主 storages（v6 root 链接）──
test('攻击10 staging 根本身是符号链接→storages：初始化/导出拒绝，宿主不变，dataDir 写入不受牵连', async () => {
  const home = await makeHome('staging-root-link')
  const dataDir = path.join(home, 'plugin-sync')
  const storagesDir = path.join(home, 'storages')
  const hostPath = path.join(storagesDir, 'workspace.json')
  try {
    await fsp.mkdir(storagesDir, { recursive: true })
    const sentinel = Buffer.from(JSON.stringify(doc(), null, 2))
    await fsp.writeFile(hostPath, sentinel)
    await fsp.mkdir(dataDir, { recursive: true })
    await fsp.symlink(storagesDir, path.join(dataDir, 'staging'), 'dir')

    const engine = makeEngine(home)
    try {
      await assertNoWritesTo([storagesDir], () => engine.init())
      const cycle = await engine.runCycle()
      assert.deepEqual(await fsp.readFile(hostPath), sentinel, '宿主 workspace.json 字节不变')
      assert.deepEqual(await fsp.readdir(storagesDir), ['workspace.json'], 'staging 链接未被激活：宿主目录清单不变')
      assert.equal((await fsp.lstat(path.join(dataDir, 'staging'))).isSymbolicLink(), true, 'staging 仍是符号链接')
      assert.ok(cycle.errors.some((e) => e.includes('符号链接') || e.includes('危险配置')), 'cycle.errors 记录拒绝')
      await assert.doesNotReject(fsp.access(path.join(dataDir, 'config.json')), '未受劫持的 dataDir 写入（config 播种）仍正常')
    } finally {
      await engine.close()
    }
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击10 staging根为符号链接（初始化拒绝/宿主不变/dataDir 写入不受牵连）')
})

// ── 攻击 11：sync.log 是宿主 workspace.json 的硬链接（v6 BLOCKER）──
test('攻击11 sync.log硬链接宿主索引：追加拒绝、宿主字节与nlink不变、错误可见', async () => {
  const home = await makeHome('hardlink-log')
  const dataDir = path.join(home, 'plugin-sync')
  const storagesDir = path.join(home, 'storages')
  const hostPath = path.join(storagesDir, 'workspace.json')
  try {
    await fsp.mkdir(storagesDir, { recursive: true })
    const sentinel = Buffer.from(JSON.stringify(doc(), null, 2))
    await fsp.writeFile(hostPath, sentinel)
    const logsDir = path.join(dataDir, 'logs')
    await fsp.mkdir(logsDir, { recursive: true })
    await fsp.link(hostPath, path.join(logsDir, 'sync.log'))

    const engine = makeEngine(home)
    try {
      await engine.init()
      const cycle = await engine.runCycle()
      assert.equal((await fsp.lstat(path.join(logsDir, 'sync.log'))).nlink, 2, 'sync.log nlink 未变')
      assert.equal((await fsp.lstat(hostPath)).nlink, 2, '宿主文件 nlink 未变')
      assert.deepEqual(await fsp.readFile(hostPath), sentinel, '宿主 workspace.json 原始字节不变（硬链接追加被拒绝）')
      assert.ok(cycle.errors.some((e) => e.includes('sync.log') && e.includes('硬链接')), 'errors 含日志硬链接拒绝')
      assert.ok(cycle.errors.some((e) => e.includes('拒绝追加') || e.includes('拒绝轮转')), '拒绝来自追加/轮转守卫')
    } finally {
      await engine.close()
    }
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击11 sync.log硬链接宿主索引（追加拒绝/字节与nlink不变/错误可见）')
})

// ── 攻击 12：硬链接轮转（阈值触发场景，直调守卫）──
test('攻击12 硬链接轮转：源/目标为多链接文件时轮转拒绝，不得 rename', async () => {
  const home = await makeHome('hardlink-rotate')
  const logsDir = path.join(home, 'logs')
  try {
    await fsp.mkdir(logsDir, { recursive: true })
    const big = Buffer.alloc(2 * 1024 * 1024 + 16, 0x41)
    const victim = path.join(home, 'victim.json')
    await fsp.writeFile(victim, big)
    const logFile = path.join(logsDir, 'sync.log')
    await fsp.link(victim, logFile)

    // 源是硬链接（nlink=2）且超过 2MiB 阈值 → 轮转拒绝，不 rename
    const r1 = await guardedRotate({ file: logFile, maxBytes: 2 * 1024 * 1024, dshHome: home })
    assert.equal(r1.ok, false, '轮转被拒绝')
    assert.equal(r1.code, 'hardlink')
    assert.equal((await fsp.lstat(logFile)).nlink, 2, '源未被 rename')
    await assert.rejects(fsp.stat(logFile + '.1'), { code: 'ENOENT' }, '未产生 sync.log.1')

    // 追加直调同样拒绝，宿主字节不变
    const r2 = await guardedAppend({ file: logFile, bytes: Buffer.from('evil\n'), dshHome: home })
    assert.equal(r2.ok, false)
    assert.equal(r2.code, 'hardlink')
    assert.deepEqual(await fsp.readFile(victim), big, '宿主字节不变')

    // 轮转目标是硬链接 → 同样拒绝
    const plain = path.join(logsDir, 'plain.log')
    await fsp.writeFile(plain, Buffer.alloc(2 * 1024 * 1024 + 16, 0x42))
    const other = path.join(home, 'other.json')
    await fsp.writeFile(other, Buffer.from('{}'))
    await fsp.link(other, path.join(logsDir, 'plain.log.1'))
    const r3 = await guardedRotate({ file: plain, maxBytes: 2 * 1024 * 1024, dshHome: home })
    assert.equal(r3.ok, false, '轮转目标为硬链接时拒绝')
    assert.equal(r3.code, 'hardlink')
    assert.deepEqual((await fsp.readdir(logsDir)).sort(), ['plain.log', 'plain.log.1', 'sync.log'], '轮转目标未被替换')
    assert.equal((await fsp.lstat(plain)).nlink, 1, 'plain.log 未被 rename')
    assert.equal((await fsp.lstat(path.join(logsDir, 'plain.log.1'))).nlink, 2, '轮转目标的硬链接未被破坏')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击12 硬链接轮转拒绝（源/目标多链接不rename/宿主不变）')
})

// ── 攻击 13：lstat 被欺骗时打开后 fstat 复核仍拒绝硬链接（防 TOCTOU）──
test('攻击13 fstat复核：lstat 谎报 nlink=1 时打开后仍拒绝硬链接追加', async () => {
  const home = await makeHome('fstat-recheck')
  try {
    const logsDir = path.join(home, 'logs')
    await fsp.mkdir(logsDir, { recursive: true })
    const victim = path.join(home, 'victim.json')
    const hostBytes = Buffer.from('{"host":true}')
    await fsp.writeFile(victim, hostBytes)
    const logFile = path.join(logsDir, 'sync.log')
    await fsp.link(victim, logFile)

    const originalLstat = fsp.lstat
    fsp.lstat = async (p, ...rest) => {
      const st = await originalLstat(p, ...rest)
      if (st && path.resolve(String(p)) === logFile && !st.isSymbolicLink()) {
        const fake = Object.create(Object.getPrototypeOf(st))
        Object.assign(fake, st, { nlink: 1 })
        return fake
      }
      return st
    }
    try {
      const r = await guardedAppend({ file: logFile, bytes: Buffer.from('evil\n'), dshHome: home })
      assert.equal(r.ok, false, '打开后 fstat 复核拒绝硬链接')
      assert.equal(r.code, 'hardlink')
      assert.match(r.error.message, /打开后复核/)
      assert.deepEqual(await fsp.readFile(victim), hostBytes, '宿主字节不变')
      assert.equal((await originalLstat(logFile)).nlink, 2, 'nlink 未变（未追加）')
    } finally {
      fsp.lstat = originalLstat
    }
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 攻击13 fstat复核（lstat被欺骗仍拒绝硬链接/宿主不变）')
})

// ── 故障注入：lstat/realpath 的 EACCES 全部转为结构化拒绝，不抛出（v6 失败契约）──
const injectErr = (code) => Object.assign(new Error(`注入的 ${code} 故障`), { code })
test('故障注入：lstat/realpath EACCES 转结构化拒绝；写后父目录 realpath 失败返回失败', async () => {
  const home = await makeHome('fault-inject')
  const dataDir = path.join(home, 'plugin-sync')
  const stagingRoot = path.join(dataDir, 'staging')
  try {
    await fsp.mkdir(stagingRoot, { recursive: true })
    await fsp.mkdir(path.join(home, 'storages'), { recursive: true })

    // 1) 目标 lstat EACCES → guardedWrite/guardedAppend 结构化拒绝（不抛出），零文件产生
    const originalLstat = fsp.lstat
    fsp.lstat = async (p, ...rest) => {
      const s = String(p)
      if (s.endsWith('fault-lstat.json') || s.endsWith('fault-lstat.log')) throw injectErr('EACCES')
      return originalLstat(p, ...rest)
    }
    try {
      const w1 = await guardedWrite({ root: stagingRoot, rel: 'fault-lstat.json', bytes: Buffer.from('x'), dshHome: home, round: {} })
      assert.equal(w1.ok, false, 'guardedWrite 目标 lstat 故障 → 结构化拒绝')
      assert.equal(w1.code, 'io')
      const a1 = await guardedAppend({ file: path.join(stagingRoot, 'fault-lstat.log'), bytes: Buffer.from('a'), dshHome: home })
      assert.equal(a1.ok, false, 'guardedAppend 目标 lstat 故障 → 结构化拒绝')
      assert.equal(a1.code, 'io')
      await assert.rejects(fsp.stat(path.join(stagingRoot, 'fault-lstat.json')), { code: 'ENOENT' }, '故障时未产生文件')
      await assert.rejects(fsp.stat(path.join(stagingRoot, 'fault-lstat.log')), { code: 'ENOENT' }, '追加故障时未产生文件')
    } finally {
      fsp.lstat = originalLstat
    }

    // 2) root realpath EACCES → assertSafeRoot 结构化拒绝，写路径零文件产生
    const originalReal = fsp.realpath
    fsp.realpath = async () => { throw injectErr('EACCES') }
    try {
      const r = await assertSafeRoot(stagingRoot, { dshHome: home })
      assert.equal(r.ok, false, 'assertSafeRoot realpath 故障 → 结构化拒绝')
      assert.equal(r.code, 'io')
      const w2 = await guardedWrite({ root: stagingRoot, rel: 'fault-realpath.json', bytes: Buffer.from('y'), dshHome: home, round: {} })
      assert.equal(w2.ok, false)
      assert.equal(w2.code, 'io')
      await assert.rejects(fsp.stat(path.join(stagingRoot, 'fault-realpath.json')), { code: 'ENOENT' }, 'root 校验故障时未产生文件')
    } finally {
      fsp.realpath = originalReal
    }

    // 3) 写后父目录 realpath 失败 → 必须返回失败（不能当成功），无临时文件残留
    let renamed = false
    const originalRename = fsp.rename
    fsp.rename = async (...args) => {
      const r = await originalRename(...args)
      renamed = true
      return r
    }
    fsp.realpath = async (p, ...rest) => {
      if (renamed && path.resolve(String(p)) === stagingRoot) throw injectErr('EACCES')
      return originalReal(p, ...rest)
    }
    try {
      const w3 = await guardedWrite({ root: stagingRoot, rel: 'fault-post.json', bytes: Buffer.from('z'), dshHome: home, round: {} })
      assert.equal(w3.ok, false, '写后父目录 realpath 失败必须返回失败')
      assert.match(w3.error.message, /写后复核/)
      const listing = (await fsp.readdir(stagingRoot)).filter((n) => !n.startsWith('.tmp-'))
      assert.deepEqual(listing.sort(), ['fault-post.json'], '无临时文件残留（内容已落盘但如实报错）')
    } finally {
      fsp.realpath = originalReal
      fsp.rename = originalRename
    }

    // 4) assertApplyTarget 父目录 realpath 故障 → 结构化拒绝
    fsp.realpath = async (p, ...rest) => {
      if (path.resolve(String(p)) === path.join(home, 'attachments')) throw injectErr('EACCES')
      return originalReal(p, ...rest)
    }
    try {
      const guard = await assertApplyTarget({ dshHome: home, target: path.join(home, 'attachments', 'x.bin') })
      assert.equal(guard.ok, false, '落回父目录 realpath 故障 → 结构化拒绝')
      assert.equal(guard.code, 'io')
    } finally {
      fsp.realpath = originalReal
    }
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
  console.log('PASS 故障注入 lstat/realpath EACCES（结构化拒绝/不抛出/写后复核失败按失败返回）')
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
