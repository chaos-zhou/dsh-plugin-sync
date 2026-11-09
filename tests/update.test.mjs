// v1.4.0 自更新单元测试：mock fetchImpl + tests/.tmp 临时目录，不触网、不碰真实 ~/.dsh。
// v1.4.1 增补：B1 备份目录独占/链接预置拒绝、B2 复核失败回滚+mode+backupDir、B3 并发锁、
// B4 gzip 炸弹与元数据头计数、N3 latestTag/无 v 前缀 tag 下载。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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
  assert.equal(ok.latestTag, 'v1.5.0', 'latestTag 保留原始 tag（N3）')
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
  assert.equal(fallback.latestTag, 'v1.10.0')
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

  // D4（v1.4.1）：真实 GitHub tarball 含目录条目（以 / 结尾），必须被接受
  {
    await makeInstall('1.3.2')
    const tgz = buildTgz([
      { name: 'pax_global_header', type: 'g', data: Buffer.from('52 comment=abc\n') },
      { name: 'dsh-plugin-sync-1.4.0/', type: '5' },
      { name: 'dsh-plugin-sync-1.4.0/lib/', type: '5' },
      { name: 'dsh-plugin-sync-1.4.0/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.4.0' })) },
      { name: 'dsh-plugin-sync-1.4.0/index.js', data: Buffer.from('NEW-INDEX-DIR') },
      { name: 'dsh-plugin-sync-1.4.0/lib/engine.js', data: Buffer.from('NEW-ENGINE-DIR') },
    ])
    const res = await applyUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', version: '1.4.0', installRoot, dataDir, fetchImpl: async () => new Response(tgz) })
    assert.equal(res.error, null, '真实目录条目不应导致失败')
    assert.equal(await read('index.js'), 'NEW-INDEX-DIR')
    assert.equal(await read('lib/engine.js'), 'NEW-ENGINE-DIR')
    console.log('update D4 真实 tar 目录条目（尾 /）被正确接受 PASS')
  }
  // D5：目录条目含 .. 仍拒绝
  {
    await makeInstall('1.3.2')
    const tgz = buildTgz([
      { name: 'dsh-plugin-sync-1.4.0/', type: '5' },
      { name: 'dsh-plugin-sync-1.4.0/../evil/', type: '5' },
    ])
    const res = await applyUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', version: '1.4.0', installRoot, dataDir, fetchImpl: async () => new Response(tgz) })
    assert.ok(res.error && /不安全/.test(res.error), '含 .. 的目录条目必须被拒绝')
    console.log('update D5 目录条目含 .. 仍拒绝 PASS')
  }

  // H. v1.4.1（B1）：备份目录名被预置为符号链接/重名目录 → 独占创建失败、拒绝更新，宿主文件字节不变
  {
    await makeInstall()
    const updatesDir = path.join(dataDir, 'updates')
    await fsp.mkdir(updatesDir, { recursive: true })
    const hostFile = path.join(home, 'host-secret.txt')
    await fsp.writeFile(hostFile, 'HOST-SECRET-BYTES')
    const realRandomBytes = crypto.randomBytes
    const realNow = Date.now
    const presetName = 'backup-1.3.2-1750000000000-cdcdcdcdcdcdcdcd'
    const presetPath = path.join(updatesDir, presetName)
    crypto.randomBytes = () => Buffer.alloc(8, 0xcd)
    Date.now = () => 1750000000000
    let linked
    try {
      await fsp.symlink(hostFile, presetPath)
      linked = await apply()
    } finally {
      crypto.randomBytes = realRandomBytes
      Date.now = realNow
    }
    assert.equal(linked.applied, false)
    assert.ok(linked.error.includes('备份目录创建失败'), linked.error)
    assert.equal(linked.backupDir, null, '备份阶段失败不留备份目录')
    assert.equal(await fsp.readFile(hostFile, 'utf8'), 'HOST-SECRET-BYTES', '预置符号链接的宿主目标字节不变')
    assert.equal(await read('index.js'), 'OLD-INDEX', '备份阶段失败安装目录不变')
    await fsp.rm(presetPath)

    // 重名普通目录（含哨兵文件）同样拒绝，且目录内容不被破坏
    await fsp.mkdir(presetPath, { recursive: true })
    await fsp.writeFile(path.join(presetPath, 'sentinel.txt'), 'DO-NOT-TOUCH')
    crypto.randomBytes = () => Buffer.alloc(8, 0xcd)
    Date.now = () => 1750000000000
    let dup
    try {
      dup = await apply()
    } finally {
      crypto.randomBytes = realRandomBytes
      Date.now = realNow
    }
    assert.equal(dup.applied, false)
    assert.ok(dup.error.includes('备份目录创建失败'), dup.error)
    assert.equal(await fsp.readFile(path.join(presetPath, 'sentinel.txt'), 'utf8'), 'DO-NOT-TOUCH', '重名目录内容不变')
    assert.equal(await read('index.js'), 'OLD-INDEX')
    await fsp.rm(presetPath, { recursive: true, force: true })
    console.log('update H1（B1）备份目录被预置为符号链接/重名时拒绝且宿主文件不变 PASS')
  }

  // 正常成功路径备份目录权限：0o700 独占
  {
    await makeInstall()
    const res = await apply()
    assert.equal(res.applied, true, res.error)
    const st = await fsp.stat(res.backupDir)
    assert.equal(st.mode & 0o7777, 0o700, '备份目录权限 0o700')
    console.log('update H2（B1）备份目录以 0o700 独占创建 PASS')
  }

  // I. v1.4.1（B2）：rename 后复核失败（内容已落盘但报错）也能回滚——旧内容+mode 保留、新增清理、无 pending
  {
    await makeInstall()
    await fsp.chmod(path.join(installRoot, 'lib/engine.js'), 0o755)
    await fsp.rm(path.join(dataDir, 'updates/state.json'), { force: true })
    const libDir = path.join(installRoot, 'lib')
    const realRealpath = fsp.realpath
    let calls = 0
    // realpath(installRoot/lib) 只出现在对 lib/* 文件 guardedWrite 的写后复核阶段；
    // 跳过第 1 次（lib/update.js 复核），注入第 2 次（lib/engine.js 复核）→ 该文件 rename 后报错。
    fsp.realpath = async (p, ...args) => {
      if (p === libDir && calls++ === 1) throw new Error('injected realpath failure')
      return realRealpath(p, ...args)
    }
    const tgz = buildTgz([
      { name: 'pkg/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.4.0' })) },
      { name: 'pkg/index.js', data: Buffer.from('NEW-INDEX') },
      { name: 'pkg/lib/update.js', data: Buffer.from('NEW-UPDATE') },
      { name: 'pkg/lib/engine.js', data: Buffer.from('NEW-ENGINE') },
    ])
    let res
    try {
      res = await applyUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', version: '1.4.0', installRoot, dataDir, fetchImpl: async () => new Response(tgz) })
    } finally {
      fsp.realpath = realRealpath
    }
    assert.equal(res.applied, false)
    assert.ok(res.error.includes('engine.js'), res.error)
    assert.equal(res.backupDir, null, '回滚完整 → 不保留备份目录')
    assert.equal(await read('index.js'), 'OLD-INDEX')
    assert.equal(await read('lib/engine.js'), 'OLD-ENGINE', 'rename 后复核失败的文件也被回滚（先登记再写）')
    const mode = (await fsp.stat(path.join(installRoot, 'lib/engine.js'))).mode & 0o7777
    assert.equal(mode, 0o755, '回滚保留原 mode（可执行位）')
    await assert.rejects(fsp.access(path.join(installRoot, 'lib/update.js')), '新增文件被清理')
    const st = await readUpdateState({ dataDir })
    assert.ok(!st?.pendingVersion, '失败不写 pending')
    console.log('update I1（B2）rename 后复核失败：回滚旧内容+mode、新增清理、无 pending PASS')
  }

  // J. v1.4.1（B2）：回滚本身失败 → 返回 backupDir（非 null）并在 error 中列出问题，便于人工恢复
  {
    await makeInstall()
    await fsp.chmod(path.join(installRoot, 'lib/engine.js'), 0o755)
    await fsp.rm(path.join(dataDir, 'updates/state.json'), { force: true })
    const libDir = path.join(installRoot, 'lib')
    const realRealpath = fsp.realpath
    fsp.realpath = async (p, ...args) => {
      if (p === libDir) throw new Error('injected realpath failure (persistent)')
      return realRealpath(p, ...args)
    }
    const tgz = buildTgz([
      { name: 'pkg/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.4.0' })) },
      { name: 'pkg/lib/engine.js', data: Buffer.from('NEW-ENGINE') },
    ])
    let res
    try {
      res = await applyUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', version: '1.4.0', installRoot, dataDir, fetchImpl: async () => new Response(tgz) })
    } finally {
      fsp.realpath = realRealpath
    }
    assert.equal(res.applied, false)
    assert.ok(res.backupDir, '回滚失败必须返回 backupDir 供人工恢复')
    assert.ok(res.error.includes('回滚未完成'), res.error)
    assert.ok(res.error.includes('engine.js'), res.error)
    const backupEngine = await fsp.readFile(path.join(res.backupDir, 'lib/engine.js'), 'utf8')
    assert.equal(backupEngine, 'OLD-ENGINE', '备份目录保留旧内容供人工恢复')
    const manifest = JSON.parse(await fsp.readFile(path.join(res.backupDir, 'manifest.json'), 'utf8'))
    assert.ok(manifest.replaced.includes('lib/engine.js'))
    await fsp.rm(res.backupDir, { recursive: true, force: true })
    console.log('update J1（B2）回滚失败返回 backupDir+问题清单 PASS')
  }

  // K. v1.4.1（B3）：双次并发 apply → 一个成功、一个被跨进程锁拒绝；结束后锁文件删除
  {
    await makeInstall()
    await fsp.rm(path.join(dataDir, 'updates/state.json'), { force: true })
    const slowFetch = async () => {
      await new Promise((r) => setTimeout(r, 80))
      return new Response(NEW_TGZ())
    }
    const base = { repo: 'chaos-zhou/dsh-plugin-sync', version: '1.4.0', installRoot, dataDir }
    const [a, b] = await Promise.all([
      applyUpdate({ ...base, fetchImpl: slowFetch }),
      applyUpdate({ ...base, fetchImpl: slowFetch }),
    ])
    const winners = [a, b].filter((r) => r.applied)
    const locked = [a, b].filter((r) => !r.applied && r.error.includes('已有更新在进行'))
    assert.equal(winners.length, 1, `恰好一个成功：${JSON.stringify([a.error, b.error])}`)
    assert.equal(locked.length, 1, '另一个被锁拒绝')
    assert.equal(await read('index.js'), 'NEW-INDEX', '成功者正常完成替换')
    await assert.rejects(fsp.access(path.join(dataDir, 'updates', '.lock')), '锁文件在 finally 中删除')
    const st = await readUpdateState({ dataDir })
    assert.equal(st.pendingVersion, '1.4.0')
    console.log('update K1（B3）并发 apply 互斥：一个成功一个拒绝、锁清理 PASS')
  }

  // L. v1.4.1（B4）：gzip 炸弹（小压缩包解压 >64MiB）被 maxOutputLength 拒绝且零副作用
  {
    await makeInstall()
    const freshDataDir = path.join(home, 'dsh-bomb/plugin-sync')
    const big = Buffer.alloc(65 * 1024 * 1024, 0)
    const bomb = zlib.gzipSync(buildTar([{ name: 'pkg/big.bin', data: big }]))
    assert.ok(bomb.length < 1024 * 1024, '压缩包本身很小（炸弹形态）')
    const res = await applyUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', version: '1.4.0', installRoot, dataDir: freshDataDir, fetchImpl: async () => new Response(bomb) })
    assert.equal(res.applied, false)
    assert.ok(res.error.includes('gzip'), res.error)
    assert.ok(res.error.includes('上限'), res.error)
    assert.equal(res.backupDir, null, '解压阶段失败不建备份')
    assert.equal(await read('index.js'), 'OLD-INDEX', 'gzip 炸弹零副作用')
    console.log('update L1（B4）gzip 炸弹拒绝且零副作用 PASS')
  }

  // M. v1.4.1（B4）：L/x/g/K 等所有 tar 头（含元数据头）计入条目上限
  {
    await makeInstall()
    const many = []
    for (let i = 0; i < 2001; i++) many.push({ name: `hdr-${i}`, type: 'g', data: Buffer.from('x') })
    many.push({ name: 'pkg/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.4.0' })) })
    const res = await apply({ fetchImpl: async () => new Response(buildTgz(many)) })
    assert.equal(res.applied, false)
    assert.ok(res.error.includes('上限'), res.error)
    assert.equal(await read('index.js'), 'OLD-INDEX')
    console.log('update M1（B4）元数据头计入条目上限（2001 个 g 头拒绝）PASS')
  }

  // N. v1.4.1（N3）：无 v 前缀 tag 也可下载——下载 URL 使用传入 tag；缺省仍为 v{version}
  {
    await makeInstall()
    const urls = []
    const tgz = buildTgz([
      { name: 'dsh-plugin-sync-1.6.1/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.6.1' })) },
      { name: 'dsh-plugin-sync-1.6.1/index.js', data: Buffer.from('TAG-NOV') },
    ])
    const res = await applyUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', version: '1.6.1', tag: '1.6.1', installRoot, dataDir, fetchImpl: async (url) => { urls.push(String(url)); return new Response(tgz) } })
    assert.equal(res.applied, true, res.error)
    assert.ok(urls[0].includes('/refs/tags/1.6.1'), `下载 URL 用原始 tag：${urls[0]}`)
    assert.ok(!urls[0].includes('/refs/tags/v1.6.1'))
    assert.equal(await read('index.js'), 'TAG-NOV')

    await makeInstall('1.6.1')
    const urls2 = []
    const tgz2 = buildTgz([
      { name: 'dsh-plugin-sync-1.6.2/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-plugin-sync', version: '1.6.2' })) },
      { name: 'dsh-plugin-sync-1.6.2/index.js', data: Buffer.from('TAG-DEFAULT-V') },
    ])
    const res2 = await applyUpdate({ repo: 'chaos-zhou/dsh-plugin-sync', version: '1.6.2', installRoot, dataDir, fetchImpl: async (url) => { urls2.push(String(url)); return new Response(tgz2) } })
    assert.equal(res2.applied, true, res2.error)
    assert.ok(urls2[0].includes('/refs/tags/v1.6.2'), `缺省 tag = v{version}：${urls2[0]}`)
    console.log('update N1（N3）无 v 前缀 tag 下载/缺省 v{version} PASS')
  }

  console.log('ALL PASS（lib/update.js：checkUpdate/applyUpdate/安全解包/备份回滚/pending）')
} finally {
  await fsp.rm(home, { recursive: true, force: true })
}
