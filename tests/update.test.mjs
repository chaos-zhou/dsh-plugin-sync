// v1.4.0 自更新单元测试：mock fetchImpl + tests/.tmp 临时目录，不触网、不碰真实 ~/.dsh。
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { checkUpdate, applyUpdate, readUpdateState, clearPending, cmpSemver } from '../lib/update.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
await fsp.mkdir(tmpRoot, { recursive: true })
const home = await fsp.mkdtemp(path.join(tmpRoot, 'update-'))
const installRoot = path.join(home, 'install')
const dataDir = path.join(home, 'dsh/plugin-sync')

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

// entries: [{name, data, type, mode}]；末尾补两个全零块，模拟真实 tar 结尾。
function buildTar(entries) {
  const parts = []
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0)
    parts.push(tarHeader({ name: entry.name, size: data.length, type: entry.type, mode: entry.mode }))
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

function buildTgz(entries) {
  return zlib.gzipSync(buildTar(entries))
}

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

async function write(rel, bytes) {
  const file = path.join(installRoot, rel)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, bytes)
}

// 安装目录：v1.3.2 旧包 + 白名单外的 .git/数据文件（更新必须不动它们）。
// 每次重建为干净旧包（清掉前序用例成功更新留下的文件）。
async function makeInstall(version = '1.3.2') {
  await fsp.rm(installRoot, { recursive: true, force: true })
  await fsp.mkdir(installRoot, { recursive: true })
  await write('index.js', 'OLD-INDEX')
  await write('lib/engine.js', 'OLD-ENGINE')
  await write('README.md', 'OLD-README')
  await write('package.json', JSON.stringify({ name: 'dsh-plugin-sync', version }))
  await write('.git/HEAD', 'gitref')
  await write('data.json', '{"local":true}')
}

// 新包 v1.4.0：含 pax 全局头（git archive 产物形态）、白名单新增文件（bin/、lib/deep/）、
// 白名单外 extra.txt（不得被复制）、保持 0o755 的可执行脚本。
const NEW_TGZ = () => buildTgz([
  { name: 'pax_global_header', type: 'g', data: Buffer.from('52 comment=5a1aa9c9d2b1a2e3 git-archive\n') },
  { name: 'dsh-plugin-sync-1.4.0/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.4.0' })) },
  { name: 'dsh-plugin-sync-1.4.0/index.js', data: Buffer.from('NEW-INDEX') },
  { name: 'dsh-plugin-sync-1.4.0/lib/engine.js', data: Buffer.from('NEW-ENGINE') },
  { name: 'dsh-plugin-sync-1.4.0/lib/deep/x.js', data: Buffer.from('NEW-DEEP') },
  { name: 'dsh-plugin-sync-1.4.0/lib/update.js', data: Buffer.from('NEW-UPDATE') },
  { name: 'dsh-plugin-sync-1.4.0/README.md', data: Buffer.from('NEW-README') },
  { name: 'dsh-plugin-sync-1.4.0/bin/dsh-sync.mjs', data: Buffer.from('NEW-BIN'), mode: 0o755 },
  { name: 'dsh-plugin-sync-1.4.0/extra.txt', data: Buffer.from('must-not-copy') },
])

const apply = (overrides = {}) => applyUpdate({
  repo: 'chaos-zhou/dsh-plugin-sync',
  version: '1.4.0',
  installRoot,
  dataDir,
  fetchImpl: async () => new Response(NEW_TGZ()),
  ...overrides,
})

const read = async (rel) => fsp.readFile(path.join(installRoot, rel), 'utf8')

try {
  // A. checkUpdate
  assert.deepEqual(cmpSemver('1.10.0', '1.9.9'), 1)
  assert.deepEqual(cmpSemver('1.4.0', '1.4.0'), 0)
  assert.deepEqual(cmpSemver('0.9.9', '1.0.0'), -1)

  const ok = await checkUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', currentVersion: '1.4.0', fetchImpl: async () => jsonRes({ tag_name: 'v1.5.0', html_url: 'https://github.com/chaos-zhou/dsh-plugin-sync/releases/tag/v1.5.0' }) })
  assert.equal(ok.latest, '1.5.0')
  assert.equal(ok.available, true)
  assert.equal(ok.error, null)
  assert.ok(ok.notesUrl.includes('releases'))
  console.log('update A1 releases/latest 正常解析并判可用 PASS')

  // 404 → 回退 /tags 取最大 semver（数值比较，1.10.0 > 1.9.0；非 semver tag 过滤）
  let calls = []
  const fallback = await checkUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', currentVersion: '1.4.0', fetchImpl: async (url) => {
    calls.push(url)
    if (url.includes('/releases/latest')) return jsonRes({ message: 'Not Found' }, 404)
    return jsonRes([{ name: 'v1.3.9' }, { name: 'v1.10.0' }, { name: 'v1.9.0' }, { name: 'not-a-version' }])
  } })
  assert.equal(calls.length, 2)
  assert.ok(calls[1].includes('/tags'))
  assert.equal(fallback.latest, '1.10.0')
  assert.equal(fallback.available, true)
  assert.ok(fallback.notesUrl.includes('/releases/tag/v1.10.0'))
  console.log('update A2 releases 404 回退 tags 取最大 semver PASS')

  const none = await checkUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', currentVersion: '1.5.0', fetchImpl: async () => jsonRes({ tag_name: 'v1.5.0' }) })
  assert.equal(none.available, false)
  assert.equal(none.error, null)

  const broken = await checkUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', currentVersion: '1.4.0', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(broken.latest, null)
  assert.equal(broken.available, false)
  assert.ok(broken.error.includes('ECONNREFUSED'))
  console.log('update A3 无更新/网络错误结构化返回 PASS')

  // B. applyUpdate 正常替换
  await makeInstall()
  const result = await apply()
  assert.equal(result.applied, true, `applied 应为 true: ${result.error}`)
  assert.equal(result.fromVersion, '1.3.2')
  assert.equal(result.toVersion, '1.4.0')
  assert.equal(result.restartRequired, true)
  assert.ok(result.backupDir.includes('backup-1.3.2-'))
  assert.equal(await read('index.js'), 'NEW-INDEX')
  assert.equal(await read('lib/engine.js'), 'NEW-ENGINE')
  assert.equal(await read('lib/deep/x.js'), 'NEW-DEEP')
  assert.equal(await read('lib/update.js'), 'NEW-UPDATE')
  assert.equal(await read('README.md'), 'NEW-README')
  assert.equal((await fsp.stat(path.join(installRoot, 'bin/dsh-sync.mjs'))).mode & 0o777, 0o755, 'bin 脚本保留可执行位')
  assert.equal(await read('.git/HEAD'), 'gitref', '.git 不动')
  assert.equal(await read('data.json'), '{"local":true}', '数据文件不动')
  await assert.rejects(fsp.access(path.join(installRoot, 'extra.txt')), '白名单外文件不进入安装目录')
  const manifest = JSON.parse(await fsp.readFile(path.join(result.backupDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.from, '1.3.2')
  assert.ok(manifest.replaced.includes('index.js'))
  assert.ok(manifest.added.includes('lib/update.js'))
  const updatesEntries = await fsp.readdir(dataDir + '/updates')
  assert.ok(!updatesEntries.some((n) => n.startsWith('download-') || n.startsWith('extract-')), '下载/解包临时文件已清理')
  console.log('update B1 正常替换：白名单更新/新增、.git 与数据文件不动、临时清理 PASS')

  // 备份可还原：用备份文件覆盖回安装目录，恢复旧内容。
  for (const rel of manifest.replaced) {
    const src = path.join(result.backupDir, rel)
    const dest = path.join(installRoot, rel)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(src, dest)
  }
  assert.equal(await read('index.js'), 'OLD-INDEX')
  assert.equal(await read('lib/engine.js'), 'OLD-ENGINE')
  assert.equal(await read('README.md'), 'OLD-README')
  console.log('update B2 备份存在且可还原旧版本 PASS')

  // pending 状态写入与 clearPending
  let state = await readUpdateState({ dataDir })
  assert.equal(state.pendingVersion, '1.4.0')
  assert.equal(state.fromVersion, '1.3.2')
  assert.equal(state.restartRequired, true)
  await clearPending({ dataDir })
  state = await readUpdateState({ dataDir })
  assert.equal(state.pendingVersion, null)
  assert.equal(state.restartRequired, false)
  console.log('update B3 pending 状态写入与 clearPending PASS')

  // C. 包身份校验
  await makeInstall()
  const badName = await apply({ fetchImpl: async () => new Response(buildTgz([
    { name: 'dsh-plugin-sync-1.4.0/package.json', data: Buffer.from(JSON.stringify({ name: 'evil-pkg', version: '1.4.0' })) },
    { name: 'dsh-plugin-sync-1.4.0/index.js', data: Buffer.from('EVIL') },
  ])) })
  assert.equal(badName.applied, false)
  assert.ok(badName.error.includes('name'))
  assert.equal(await read('index.js'), 'OLD-INDEX')

  const badVersion = await apply({ fetchImpl: async () => new Response(buildTgz([
    { name: 'dsh-plugin-sync-1.4.0/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.9.9' })) },
    { name: 'dsh-plugin-sync-1.4.0/index.js', data: Buffer.from('EVIL') },
  ])) })
  assert.equal(badVersion.applied, false)
  assert.ok(badVersion.error.includes('version'))
  assert.equal(await read('index.js'), 'OLD-INDEX')

  const wrongRoot = await applyUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', version: '1.4.0', installRoot: path.join(home, 'not-a-plugin'), dataDir, fetchImpl: async () => new Response(NEW_TGZ()) })
  assert.equal(wrongRoot.applied, false)
  assert.ok(wrongRoot.error.includes('package.json'))
  console.log('update C1 包名/版本不匹配拒绝、非插件目录拒绝 PASS')

  // 同版本（不高于已安装）拒绝；force 允许重装
  await makeInstall()
  const noForce = await apply({ version: '1.3.2' })
  assert.equal(noForce.applied, false)
  assert.ok(noForce.error.includes('force'))
  const withForce = await apply({ version: 'v1.3.2', force: true, fetchImpl: async () => new Response(buildTgz([
    { name: 'dsh-plugin-sync-1.3.2/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.3.2' })) },
    { name: 'dsh-plugin-sync-1.3.2/index.js', data: Buffer.from('REINSTALL') },
  ])) })
  assert.equal(withForce.applied, true, `force 重装: ${withForce.error}`)
  assert.equal(await read('index.js'), 'REINSTALL')
  console.log('update C2 低版本默认拒绝、force 重装成功 PASS')

  // D. tar 攻击面
  await makeInstall()
  const evilParent = path.join(home, 'evil-parent.txt')
  const traversal = await apply({ fetchImpl: async () => new Response(buildTgz([
    { name: 'pkg/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.4.0' })) },
    { name: 'pkg/../evil.txt', data: Buffer.from('pwned') },
  ])) })
  assert.equal(traversal.applied, false)
  assert.ok(traversal.error.includes('不安全'))
  await assert.rejects(fsp.access(evilParent), '解包不得越出 extract 目录')

  const absPath = await apply({ fetchImpl: async () => new Response(buildTgz([
    { name: 'pkg/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.4.0' })) },
    { name: '/abs/evil.txt', data: Buffer.from('pwned') },
  ])) })
  assert.equal(absPath.applied, false)
  assert.ok(absPath.error.includes('不安全'))

  const symlink = await apply({ fetchImpl: async () => new Response(buildTgz([
    { name: 'pkg/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.4.0' })) },
    { name: 'pkg/lib', type: '2', data: Buffer.from('/tmp/target\0') },
  ])) })
  assert.equal(symlink.applied, false)
  assert.ok(symlink.error.includes('符号链接'))

  const badType = await apply({ fetchImpl: async () => new Response(buildTgz([
    { name: 'pkg/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.4.0' })) },
    { name: 'pkg/dev', type: '3', data: Buffer.alloc(0) },
  ])) })
  assert.equal(badType.applied, false)
  assert.ok(badType.error.includes('不支持'))
  assert.equal(await read('index.js'), 'OLD-INDEX', '攻击 tar 全部拒绝后安装目录不变')
  console.log('update D1 tar ../绝对路径/符号链接/设备类型拒绝，安装目录不变 PASS')

  // E. 下载超限（20MB+1 字节）
  const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 0x41)
  const over = await apply({ fetchImpl: async () => new Response(oversized) })
  assert.equal(over.applied, false)
  assert.ok(over.error.includes('上限'))
  console.log('update E1 下载超过 20MB 上限拒绝 PASS')

  // F. 替换中途失败 → 回滚已替换文件、移除已新增文件、结构化 error
  await makeInstall()
  await fsp.rm(path.join(dataDir, 'updates/state.json'), { force: true }) // 清掉 C2 残留 pending，验证失败不写新状态
  const realRename = fsp.rename
  fsp.rename = async (src, dest) => {
    if (dest === path.join(installRoot, 'lib', 'engine.js')) throw new Error('injected rename failure')
    return realRename(src, dest)
  }
  let rolled
  try {
    rolled = await apply()
  } finally {
    fsp.rename = realRename
  }
  assert.equal(rolled.applied, false)
  assert.ok(rolled.error.includes('engine.js'), rolled.error)
  assert.equal(await read('index.js'), 'OLD-INDEX', '已替换文件被回滚')
  assert.equal(await read('lib/engine.js'), 'OLD-ENGINE')
  assert.equal(await read('README.md'), 'OLD-README')
  await assert.rejects(fsp.access(path.join(installRoot, 'lib/update.js')), '未写入的新增文件不存在')
  await assert.rejects(fsp.access(path.join(installRoot, 'bin/dsh-sync.mjs')), '未写入的新增 bin 不存在')
  assert.equal(await read('.git/HEAD'), 'gitref')
  const stateAfterFail = await readUpdateState({ dataDir })
  assert.ok(!stateAfterFail?.pendingVersion, '失败不得写 pending 状态')
  console.log('update F1 替换中途失败回滚已替换/不残留新增/无pending PASS')

  // G. 下载/解包阶段失败：不产生备份目录、不碰安装目录（用独立 dataDir 隔离前序备份）
  await makeInstall()
  const freshDataDir = path.join(home, 'dsh-fresh/plugin-sync')
  const netFail = await apply({ dataDir: freshDataDir, fetchImpl: async () => { throw new Error('network down') } })
  assert.equal(netFail.applied, false)
  assert.ok(netFail.error.includes('network down'))
  assert.equal(netFail.backupDir, null)
  const updatesList = await fsp.readdir(freshDataDir + '/updates')
  assert.ok(!updatesList.some((n) => n.startsWith('backup-')), '未进入替换阶段不建备份')
  assert.equal(await read('index.js'), 'OLD-INDEX')
  console.log('update G1 下载失败零副作用 PASS')

  console.log('ALL PASS（lib/update.js：checkUpdate/applyUpdate/安全解包/备份回滚/pending）')
} finally {
  await fsp.rm(home, { recursive: true, force: true })
}
