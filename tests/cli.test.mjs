// v1.4.0 CLI 冒烟：node 子进程执行 bin/dsh-sync.mjs，临时 DSH_SYNC_HOME。
// 预置 listenPort=0 使管理 API 永远不可达 → CLI 确定性地走「服务不可用 → 本地读写」回退路径，
// 不受开发机上真实 DSH 服务（默认 8789）干扰。不碰真实 ~/.dsh。
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
await fsp.mkdir(tmpRoot, { recursive: true })
const home = await fsp.mkdtemp(path.join(tmpRoot, 'cli-'))
const dshSyncHome = path.join(home, 'dsh/plugin-sync')
const configFile = path.join(dshSyncHome, 'config.json')
const bin = fileURLToPath(new URL('../bin/dsh-sync.mjs', import.meta.url))
const pkg = JSON.parse(await fsp.readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

// 预置：listenPort=0（端口 0 不可连接，fetch 直接失败 → CLI 回退本地读写）
await fsp.mkdir(dshSyncHome, { recursive: true })
await fsp.writeFile(configFile, JSON.stringify({ listenPort: 43219 }))

function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SYNC_HOME: dshSyncHome, DSH_HOME: path.join(home, 'dsh'), ...extraEnv },
    timeout: 30000,
  })
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

async function readConfig() {
  return JSON.parse(await fsp.readFile(configFile, 'utf8'))
}

try {
  // version / help
  const v = run(['version'])
  assert.equal(v.code, 0, `version exit: ${v.stderr}`)
  assert.equal(v.stdout.trim(), pkg.version)
  const h = run(['help'])
  assert.equal(h.code, 0)
  assert.ok(h.stdout.includes('用法'))
  assert.ok(h.stdout.includes('update apply'))
  console.log('cli S1 version/help 退出码与输出 PASS')

  // config get（无字段时输出默认设置）
  const g0 = run(['config', 'get'])
  assert.equal(g0.code, 0, g0.stderr)
  const settings0 = JSON.parse(g0.stdout)
  assert.equal(settings0.listenPort, 43219)
  assert.equal(settings0.role, 'peer')
  console.log('cli S2 config get 输出默认设置 PASS')

  // config set：深合并写入并持久化
  const s = run(['config', 'set', '{"deviceName":"cli-test","token":"abc123","intervalSec":45}'])
  assert.equal(s.code, 0, s.stderr)
  assert.ok(s.stdout.includes('直接写入'), '提示服务未运行走本地写入')
  let saved = await readConfig()
  assert.equal(saved.deviceName, 'cli-test')
  assert.equal(saved.token, 'abc123')
  assert.equal(saved.intervalSec, 45)
  assert.equal(saved.listenPort, 43219, '未设置字段保留原值')

  const g1 = run(['config', 'get', 'token'])
  assert.equal(g1.code, 0)
  // v1.4.1（B7）：CLI 本地读取走 publicSettings 打码；短 token（≤12）整体打码
  assert.equal(g1.stdout.trim(), '********', g1.stdout)

  const g2 = run(['config', 'get', 'no-such-key'])
  assert.equal(g2.code, 1)
  assert.ok(g2.stderr.includes('不存在'))
  console.log('cli S3 config set 深合并持久化 / get key / 不存在报错 PASS')

  // v1.4.1（B6）：CLI config set 携带打码 token → 视为「不修改」，不回写
  const b6a = run(['config', 'set', '{"intervalSec":46,"token":"********"}'])
  assert.equal(b6a.code, 0, b6a.stderr)
  saved = await readConfig()
  assert.equal(saved.intervalSec, 46)
  assert.equal(saved.token, 'abc123', '打码 token 不回写')

  // v1.4.1（B6）：空串 token 同样视为不修改
  const b6b = run(['config', 'set', '{"settleSec":9,"token":""}'])
  assert.equal(b6b.code, 0, b6b.stderr)
  saved = await readConfig()
  assert.equal(saved.settleSec, 9)
  assert.equal(saved.token, 'abc123', '空串 token 不回写')
  console.log('cli S3b（B6）打码/空 token 不回写 PASS')

  // peers 管理
  const a1 = run(['config', 'add-peer', 'MBP', 'http://192.168.1.5:8789', 'peer-tok'])
  assert.equal(a1.code, 0, a1.stderr)
  saved = await readConfig()
  assert.deepEqual(saved.peers, [{ name: 'MBP', url: 'http://192.168.1.5:8789', token: 'peer-tok' }])

  const a2 = run(['config', 'add-peer', 'MBP', 'http://x'])
  assert.equal(a2.code, 1, '同名 peer 拒绝')
  assert.ok(a2.stderr.includes('已存在'))

  const r1 = run(['config', 'remove-peer', 'MBP'])
  assert.equal(r1.code, 0, r1.stderr)
  saved = await readConfig()
  assert.deepEqual(saved.peers, [])

  const r2 = run(['config', 'remove-peer', 'ghost'])
  assert.equal(r2.code, 1)
  assert.ok(r2.stderr.includes('未找到'))
  console.log('cli S4 add-peer/remove-peer/同名与不存在报错 PASS')

  // set-token（生成）/ set-remap / remove-remap / 路径校验
  const t1 = run(['config', 'set-token'])
  assert.equal(t1.code, 0, t1.stderr)
  saved = await readConfig()
  assert.ok(saved.token.length >= 32, '省略参数生成随机 token')
  assert.notEqual(saved.token, 'abc123')

  const m1 = run(['config', 'set-remap', '/Users/alice/Projects', '/Users/bob/Projects'])
  assert.equal(m1.code, 0, m1.stderr)
  saved = await readConfig()
  assert.deepEqual(saved.pathRemap, [{ from: '/Users/alice/Projects', to: '/Users/bob/Projects' }])

  const m2 = run(['config', 'set-remap', 'relative/path', '/abs'])
  assert.equal(m2.code, 1, '相对路径拒绝')
  assert.ok(m2.stderr.includes('绝对路径'))

  const m3 = run(['config', 'set-remap', '/a/../b', '/c'])
  assert.equal(m3.code, 1, '点段拒绝')

  const m4 = run(['config', 'remove-remap', '0'])
  assert.equal(m4.code, 0, m4.stderr)
  saved = await readConfig()
  assert.deepEqual(saved.pathRemap, [])

  const m5 = run(['config', 'remove-remap', '5'])
  assert.equal(m5.code, 1, '越界拒绝')
  console.log('cli S5 set-token 生成/set-remap/remove-remap/非法路径拒绝 PASS')

  // status：服务未运行 → 本地摘要 + installedVersion，退出 0
  const st = run(['status'])
  assert.equal(st.code, 0, st.stderr)
  assert.ok(st.stdout.includes('管理服务未运行'))
  const stJson = JSON.parse(st.stdout)
  assert.equal(stJson.installedVersion, pkg.version)
  assert.equal(stJson.deviceName, 'cli-test')
  assert.equal(stJson.listenPort, 43219)
  console.log('cli S6 status 服务未运行回退本地摘要 PASS')

  // sync：服务未运行 → 非零退出并说明原因
  const sy = run(['sync'])
  assert.equal(sy.code, 1)
  assert.ok(sy.stderr.includes('管理服务未运行'))
  console.log('cli S7 sync 服务未运行非零退出 PASS')

  // 未知命令 / 参数不足
  const bad = run(['frobnicate'])
  assert.equal(bad.code, 1)
  assert.ok(bad.stderr.includes('未知命令'))
  const noArg = run(['config', 'set'])
  assert.equal(noArg.code, 1)
  assert.ok(noArg.stderr.includes('用法'))
  console.log('cli S8 未知命令/参数不足报错 PASS')

  // v1.4.1（B7）：长 token 保留前 4 位打码；config get / status 全输出不含完整 token（含 peers）
  const fullToken = (await readConfig()).token
  assert.ok(fullToken.length >= 32, 'S5 已生成随机长 token')
  const gToken = run(['config', 'get', 'token'])
  assert.equal(gToken.code, 0)
  assert.equal(gToken.stdout.trim(), fullToken.slice(0, 4) + '****', `长 token 打码：${gToken.stdout}`)
  assert.ok(!gToken.stdout.includes(fullToken))

  const a2b = run(['config', 'add-peer', 'P1', 'http://127.0.0.1:9', 'peer-secret-token-9'])
  assert.equal(a2b.code, 0, a2b.stderr)
  const gAll = run(['config', 'get'])
  assert.equal(gAll.code, 0)
  assert.ok(!gAll.stdout.includes(fullToken), 'config get 不含完整顶层 token')
  assert.ok(!gAll.stdout.includes('peer-secret-token-9'), 'config get 不含完整 peer token')
  assert.ok(gAll.stdout.includes('peer****'), 'peer token 打码展示')

  // v1.4.1（B6）：带打码 peer token 的整组 peers 保存 → 真实 peer token 不丢
  const b6c = run(['config', 'set', '{"peers":[{"name":"P1","url":"http://127.0.0.1:9","token":"peer****"}]}'])
  assert.equal(b6c.code, 0, b6c.stderr)
  saved = await readConfig()
  assert.equal(saved.peers[0].token, 'peer-secret-token-9', '打码 peer token 保持原值')
  assert.equal(saved.peers[0].name, 'P1')

  const stTok = run(['status'])
  assert.equal(stTok.code, 0, stTok.stderr)
  assert.ok(!stTok.stdout.includes(fullToken), 'status 不含完整 token')
  assert.ok(!stTok.stdout.includes('peer-secret-token-9'), 'status 不含完整 peer token')
  assert.ok(stTok.stdout.includes('peer****'), 'status peers 打码展示')
  console.log('cli S9（B7/B6）config get/status 全脱敏、打码 peers 保存不丢凭据 PASS')

  // v1.4.1（B3）：请求已发出（连接已建立）后超时 → 「结果未知」，绝不回退离线更新
  {
    const http = await import('node:http')
    const hang = http.createServer(() => { /* 接受连接但不响应 */ })
    await new Promise((r) => hang.listen(0, '127.0.0.1', r))
    const hangPort = hang.address().port
    await fsp.writeFile(configFile, JSON.stringify({ listenPort: hangPort, token: 'cli-hang-token' }))
    const updatesDir = path.join(dshSyncHome, 'updates')
    const before = await fsp.readFile(configFile, 'utf8')
    const hung = run(['update', 'apply', '--version', '9.9.9'], { DSH_SYNC_API_TIMEOUT_MS: '500' })
    assert.equal(hung.code, 1, `超时命令应非零退出：${hung.stdout} ${hung.stderr}`)
    assert.ok(hung.stderr.includes('结果未知'), `必须报结果未知：${hung.stderr}`)
    assert.ok(!hung.stderr.includes('直接下载替换'), '超时不得回退离线下载')
    assert.equal(await fsp.readFile(configFile, 'utf8'), before, '超时后本地 config 不被改动')
    await assert.rejects(fsp.access(path.join(updatesDir, 'state.json')), '超时不触发离线更新（无 pending 状态）')
    await new Promise((r) => hang.close(r))
    console.log('cli S10（B3）请求后超时报结果未知、不触发离线更新 PASS')
  }
  console.log('ALL PASS（bin/dsh-sync.mjs CLI 冒烟）')
} finally {
  await fsp.rm(home, { recursive: true, force: true })
}
