// v1.4.0 管理端测试：真实 http server + 临时目录。
// 第一段：createSyncServer 单元层（鉴权顺序 403→401、路由、no-store、mock 更新）；
// 第二段：真实 engine 接线（status/config/sync/update 路由、pending 清除）。
// 安装目录操作全部指向 tests/.tmp 临时目录，绝不触碰真实仓库文件与 ~/.dsh。
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createSyncServer, listen, closeServer } from '../lib/server.js'
import { createEngine } from '../lib/engine.js'
import { DEFAULTS, deepMerge, publicSettings } from '../lib/config.js'
import { checkUpdate, applyUpdate } from '../lib/update.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
await fsp.mkdir(tmpRoot, { recursive: true })
const home = await fsp.mkdtemp(path.join(tmpRoot, 'admin-'))
const TOKEN = 'admin-token'

// ---- tar 构造（与 update.test.mjs 相同的助手） ----
function tarHeader({ name, size, type = '0', mode = 0o644 }) {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 'utf8')
  buf.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'utf8')
  buf.write('0000000\0', 108, 'utf8')
  buf.write('0000000\0', 116, 'utf8')
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8')
  buf.write('00000000000\0', 136, 'utf8')
  buf.write('        ', 148, 'ascii')
  buf.write(type, 156, 'ascii')
  buf.write('ustar\0', 257, 'ascii')
  buf.write('00', 263, 'ascii')
  let sum = 0
  for (const b of buf) sum += b
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
  return buf
}
function buildTgz(entries) {
  const parts = []
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0)
    parts.push(tarHeader({ name: entry.name, size: data.length, type: entry.type, mode: entry.mode }))
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(parts))
}
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

// ---- 第一段：server 单元层 ----
async function testServerUnit() {
  let settings = deepMerge(DEFAULTS, { token: TOKEN, intervalSec: 300 })
  let inFlight = false
  const unitInstall = path.join(home, 'unit-install')
  const unitData = path.join(home, 'unit-dsh/plugin-sync')
  await fsp.mkdir(path.join(unitInstall), { recursive: true })
  await fsp.writeFile(path.join(unitInstall, 'package.json'), JSON.stringify({ name: 'dsh-plugin-sync', version: '1.0.0' }))
  await fsp.writeFile(path.join(unitInstall, 'index.js'), 'UNIT-OLD')

  const ops = {
    token: () => TOKEN,
    getDevice: () => 'unit', getRole: () => 'peer', getVersion: () => '9.9.9-unit',
    getIndex: async () => ({}), getBlob: async () => null, putBlob: async () => {},
    admin: {
      getStatus: async () => ({ ok: true, note: 'unit-status' }),
      getConfig: async () => ({ settings: publicSettings(settings), needRestart: false }),
      putConfig: async (set) => { settings = deepMerge(settings, set); return { settings: publicSettings(settings), needRestart: false } },
      triggerSync: async () => {
        if (inFlight) return { started: false, reason: 'inFlight' }
        inFlight = true
        setTimeout(() => { inFlight = false }, 200)
        return { started: true }
      },
      updateCheck: () => checkUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', currentVersion: '1.0.0', fetchImpl: async () => jsonRes({ tag_name: 'v2.0.0' }) }),
      updateApply: ({ version, force } = {}) => applyUpdate({
        repo: 'chaos-zhou/dsh-plugin-sync',
        version: version || '1.1.0',
        force: !!force,
        installRoot: unitInstall,
        dataDir: unitData,
        fetchImpl: async (url) => {
          if (String(url).includes('codeload.github.com')) return new Response(buildTgz([
            { name: 'dsh-plugin-sync-1.1.0/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.1.0' })) },
            { name: 'dsh-plugin-sync-1.1.0/index.js', data: Buffer.from('UNIT-NEW') },
          ]))
          return jsonRes({ tag_name: 'v1.1.0' })
        },
      }),
    },
  }

  const server = createSyncServer(ops)
  const port = await listen(server, 0, '127.0.0.1')
  const base = `http://127.0.0.1:${port}`
  const call = async (pathname, { method = 'GET', token, body } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: { ...(token !== undefined ? { 'x-dsh-sync-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, headers: res.headers, text, json }
  }

  try {
    // 鉴权：HTML 页与 API 无 token/错 token → 401
    for (const [p, t] of [['/admin', undefined], ['/admin', 'wrong'], ['/v1/admin/status', undefined], ['/v1/admin/status', 'wrong']]) {
      const r = await call(p, { token: t })
      assert.equal(r.status, 401, `${p} token=${t}`)
      assert.equal(r.headers.get('cache-control'), 'no-store')
    }

    // 403：非 loopback 来源（伪造 remoteAddress；真实回环连接无法伪造，走 fake socket）
    {
      const server2 = createSyncServer({ token: () => TOKEN, admin: { getStatus: async () => ({}) } })
      const req = new PassThrough()
      req.method = 'GET'
      req.url = '/v1/admin/status'
      req.headers = { 'x-dsh-sync-token': TOKEN }
      req.socket = { remoteAddress: '192.168.1.50' }
      let code = null
      const done = new Promise((resolve) => {
        server2.emit('request', req, { writeHead(c) { code = c }, end() { resolve() } })
      })
      await done
      assert.equal(code, 403, '非 loopback 即使 token 正确也 403')
      await closeServer(server2)
    }

    // HTML 页
    const page = await call('/admin', { token: TOKEN })
    assert.equal(page.status, 200)
    assert.ok(page.headers.get('content-type').includes('text/html'))
    assert.equal(page.headers.get('cache-control'), 'no-store')
    for (const keyword of ['本地管理', '状态', '配置', '立即同步', '检查更新', '应用更新', '重启 DSH', 'localStorage']) {
      assert.ok(page.text.includes(keyword), `HTML 缺少关键文案：${keyword}`)
    }
    // query token（浏览器无法设自定义头，允许 ?token=）
    const pageQuery = await call('/admin?token=' + TOKEN)
    assert.equal(pageQuery.status, 200)

    // status/config 路由
    const status = await call('/v1/admin/status', { token: TOKEN })
    assert.equal(status.status, 200)
    assert.equal(status.json.note, 'unit-status')
    assert.equal(status.headers.get('cache-control'), 'no-store')

    const cfg0 = await call('/v1/admin/config', { token: TOKEN })
    assert.equal(cfg0.status, 200)
    assert.equal(cfg0.json.settings.intervalSec, 300)

    const cfgPut = await call('/v1/admin/config', { method: 'PUT', token: TOKEN, body: JSON.stringify({ set: { intervalSec: 60 } }) })
    assert.equal(cfgPut.status, 200)
    assert.equal(cfgPut.json.settings.intervalSec, 60)
    assert.ok(cfgPut.json.settings.token.includes('******'), 'token 打码')

    const cfgBad = await call('/v1/admin/config', { method: 'PUT', token: TOKEN, body: JSON.stringify({ noSet: true }) })
    assert.equal(cfgBad.status, 400)
    const cfgBadJson = await call('/v1/admin/config', { method: 'PUT', token: TOKEN, body: '{broken' })
    assert.equal(cfgBadJson.status, 400)

    // sync：started / inFlight
    const sync1 = await call('/v1/admin/sync', { method: 'POST', token: TOKEN })
    assert.deepEqual(sync1.json, { started: true })
    const sync2 = await call('/v1/admin/sync', { method: 'POST', token: TOKEN })
    assert.deepEqual(sync2.json, { started: false, reason: 'inFlight' })
    await new Promise((r) => setTimeout(r, 250))

    // update check（mock GitHub）
    const check = await call('/v1/admin/update/check', { token: TOKEN })
    assert.equal(check.status, 200)
    assert.equal(check.json.latest, '2.0.0')
    assert.equal(check.json.available, true)
    assert.equal(check.json.current, '1.0.0')
    assert.equal(check.headers.get('cache-control'), 'no-store')

    // update apply（mock codeload 下载 → 白名单替换临时安装目录）
    const apply1 = await call('/v1/admin/update/apply', { method: 'POST', token: TOKEN, body: JSON.stringify({}) })
    assert.equal(apply1.status, 200)
    assert.equal(apply1.json.applied, true, `apply: ${apply1.json.error}`)
    assert.equal(apply1.json.fromVersion, '1.0.0')
    assert.equal(apply1.json.toVersion, '1.1.0')
    assert.equal(apply1.json.restartRequired, true)
    assert.equal(await fsp.readFile(path.join(unitInstall, 'index.js'), 'utf8'), 'UNIT-NEW')
    const unitState = JSON.parse(await fsp.readFile(path.join(unitData, 'updates/state.json'), 'utf8'))
    assert.equal(unitState.pendingVersion, '1.1.0')
    assert.equal(unitState.restartRequired, true)

    // 已是目标版本（1.1.0 不高于 1.1.0）默认拒绝
    const apply2 = await call('/v1/admin/update/apply', { method: 'POST', token: TOKEN, body: JSON.stringify({ version: '1.1.0' }) })
    assert.equal(apply2.json.applied, false)
    assert.ok(apply2.json.error.includes('force'))

    // 未知 admin 路由 → 404 且 no-store
    const nf = await call('/v1/admin/nope', { token: TOKEN })
    assert.equal(nf.status, 404)
    assert.equal(nf.headers.get('cache-control'), 'no-store')
    console.log('admin U1 单元层：401/403 顺序、HTML 关键文案、config/sync/update 路由、no-store、mock 应用替换 PASS')
  } finally {
    await closeServer(server)
  }
}

// ---- 第二段：真实 engine 接线 ----
async function testEngineIntegration() {
  const dshHome = path.join(home, 'engine-dsh')
  const makeEngine = () => createEngine({ rowConfig: {
    dshHome, deviceName: 'admin-engine', listenPort: 0, bindHost: '127.0.0.1', token: TOKEN, settleSec: 0,
  } })
  const engine = makeEngine()
  await engine.init()
  const port = engine.listening
  assert.ok(port > 0)
  const base = `http://127.0.0.1:${port}`
  const call = async (pathname, { method = 'GET', token = TOKEN, body } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: { 'x-dsh-sync-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, headers: res.headers, json }
  }

  const originalFetch = globalThis.fetch
  try {
    const status = await call('/v1/admin/status')
    assert.equal(status.status, 200)
    assert.equal(status.json.installedVersion, engine.version)
    assert.equal(status.json.device, 'admin-engine')
    assert.deepEqual(status.json.update, { latest: null, available: false, pendingVersion: null, restartRequired: false, checkedAt: null, error: null })
    assert.equal(status.headers.get('cache-control'), 'no-store')

    // config：读（token 打码）→ 写 → config.json 持久化
    const cfg0 = await call('/v1/admin/config')
    assert.ok(cfg0.json.settings.token.includes('******'))
    const cfgPut = await call('/v1/admin/config', { method: 'PUT', body: JSON.stringify({ set: { intervalSec: 61, listenPort: 9999 } }) })
    assert.equal(cfgPut.status, 200)
    assert.equal(cfgPut.json.settings.intervalSec, 61)
    assert.equal(cfgPut.json.needRestart, true, 'listenPort 变更标记 needRestart')
    const persisted = JSON.parse(await fsp.readFile(path.join(dshHome, 'plugin-sync/config.json'), 'utf8'))
    assert.equal(persisted.intervalSec, 61)
    assert.equal(persisted.listenPort, 9999)

    // sync：触发后 lastRun 出现
    const sync = await call('/v1/admin/sync', { method: 'POST' })
    assert.deepEqual(sync.json, { started: true })
    for (let i = 0; i < 100 && !(await call('/v1/admin/status')).json.lastRun; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.ok((await call('/v1/admin/status')).json.lastRun, 'sync 后 lastRun 出现')

    // update check：mock GitHub（全局 fetch 由 engine 使用；其余请求原样转发含 headers）
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('api.github.com')) return jsonRes({ tag_name: 'v9.8.7', html_url: 'https://github.com/chaos-zhou/dsh-plugin-sync/releases/tag/v9.8.7' })
      return originalFetch(url, init)
    }
    const check = await call('/v1/admin/update/check')
    assert.equal(check.status, 200)
    assert.equal(check.json.latest, '9.8.7')
    assert.equal(check.json.available, true)
    const status2 = await call('/v1/admin/status')
    assert.equal(status2.json.update.latest, '9.8.7')
    assert.ok(status2.json.update.checkedAt)

    // update apply：低于当前版本 → 结构化拒绝（不触碰真实安装目录）
    const refused = await call('/v1/admin/update/apply', { method: 'POST', body: JSON.stringify({ version: '0.0.1' }) })
    assert.equal(refused.status, 200)
    assert.equal(refused.json.applied, false)
    assert.ok(refused.json.error.includes('force'))

    // 无 token 的管理 API 仍 401（真实 engine 路径）
    const anon = await call('/v1/admin/status', { token: 'bad' })
    assert.equal(anon.status, 401)
    console.log('admin U2 engine 接线：status/config 持久化/sync/检查/拒绝低版本 PASS')
  } finally {
    globalThis.fetch = originalFetch
    await engine.close()
  }

  // pending 状态与重启清除：
  // 1) pendingVersion != 运行版本 → 保留并在 status 显示
  const updatesDir = path.join(dshHome, 'plugin-sync/updates')
  await fsp.mkdir(updatesDir, { recursive: true })
  await fsp.writeFile(path.join(updatesDir, 'state.json'), JSON.stringify({ pendingVersion: '9.9.9', fromVersion: '1.0.0', restartRequired: true }))
  const engineKeep = makeEngine()
  await engineKeep.init()
  const keepStatus = await call2(engineKeep, '/v1/admin/status')
  assert.equal(keepStatus.json.update.pendingVersion, '9.9.9')
  assert.equal(keepStatus.json.update.restartRequired, true)
  await engineKeep.close()

  // 2) pendingVersion == 运行版本 → init 时清除「待重启」标记
  await fsp.writeFile(path.join(updatesDir, 'state.json'), JSON.stringify({ pendingVersion: engine.version, fromVersion: '1.0.0', restartRequired: true }))
  const engineClear = makeEngine()
  await engineClear.init()
  const clearStatus = await call2(engineClear, '/v1/admin/status')
  assert.equal(clearStatus.json.update.pendingVersion, null)
  assert.equal(clearStatus.json.update.restartRequired, false)
  const cleared = JSON.parse(await fsp.readFile(path.join(updatesDir, 'state.json'), 'utf8'))
  assert.equal(cleared.pendingVersion, null)
  assert.ok(cleared.clearedAt)
  await engineClear.close()
  console.log('admin U3 pending 保留（版本不符）/重启加载新版本后自动清除 PASS')
}

async function call2(engine, pathname) {
  const res = await fetch(`http://127.0.0.1:${engine.listening}${pathname}`, { headers: { 'x-dsh-sync-token': TOKEN } })
  const json = await res.json()
  return { status: res.status, json }
}

try {
  await testServerUnit()
  await testEngineIntegration()
  console.log('ALL PASS（lib/server.js 管理端 + engine 接线）')
} finally {
  await fsp.rm(home, { recursive: true, force: true })
}
