import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { applyAll } from '../lib/apply.js'
import { exportAll } from '../lib/export.js'
import { loadConfig } from '../lib/config.js'
import { sha1 } from '../lib/util.js'
import { MAX_BLOB_BYTES } from '../lib/limits.js'

const TMP = fileURLToPath(new URL('./.tmp/', import.meta.url))
const SESSION = 'sessions/project/session-1/session.v4.jsonl.zstd'
const CACHE = 'projcache/sessions/session-1.json'
const CACHE_LOCAL = 'storages/session_projcache/sessions/session-1.json'
const CONFIG = 'config/default/cordis.patch.yml'
const PROFILE = 'profiles/default/cordis.patch.yml'

// 合法 zstd 单块 raw frame，内含真实 JSONL；不依赖外部 zstd 或新版本 Node API。
function rawFrame(body) {
  body = Buffer.from(body)
  assert.ok(body.length < 256)
  const block = Buffer.alloc(3)
  block.writeUIntLE((body.length << 3) | 1, 0, 3)
  return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, body.length]), block, body])
}

function session(text) {
  return rawFrame(JSON.stringify({ type: 'message', text }) + '\n')
}

async function write(root, rel, bytes) {
  const file = path.join(root, rel)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, bytes)
  const settled = new Date(Date.now() - 2000)
  await fsp.utimes(file, settled, settled)
  return file
}

async function withHome(name, fn) {
  await fsp.mkdir(TMP, { recursive: true })
  const home = await fsp.mkdtemp(path.join(TMP, 'apply-'))
  const messages = { warn: [], error: [] }
  const ctx = {
    dshHome: home,
    stagingRoot: path.join(home, 'plugin-sync', 'staging'),
    settings: { settleSec: 0, applyConfig: false },
    state: { localHashes: {}, remoteHashes: {}, declined: {} },
    deviceName: 'compat',
    log: {
      warn: async (msg) => messages.warn.push(msg),
      error: async (msg) => messages.error.push(msg),
    },
    stagingIndex: {},
    messages,
  }
  ctx.stage = async (rel, bytes) => {
    const file = await write(ctx.stagingRoot, rel, bytes)
    const st = await fsp.stat(file)
    ctx.stagingIndex[rel] = { sha1: sha1(bytes), size: bytes.length, mtime: st.mtimeMs }
    return file
  }
  ctx.local = (rel) => fsp.readFile(path.join(home, rel))
  try {
    await fn(ctx)
    console.log(`${name} PASS`)
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function assertConflict(ctx, out, expected) {
  assert.equal(out.conflicts.length, 1, '保留一份远端冲突副本')
  assert.deepEqual(await ctx.local(out.conflicts[0]), expected, '冲突副本字节等于远端输入')
}

async function caseNoBaseline() {
  for (const timestamp of [Date.now() + 3600000, Date.now() - 7200000]) {
    await withHome(`B7 无基线且远端mtime${timestamp > Date.now() ? '较新' : '较旧'}`, async (ctx) => {
      const local = session('local newest content')
      const remote = session('remote different content')
      const localFile = await write(ctx.dshHome, SESSION, local)
      const old = new Date(Date.now() - 3600000)
      await fsp.utimes(localFile, old, old)
      const staged = await ctx.stage(SESSION, remote)
      const remoteTime = new Date(timestamp)
      await fsp.utimes(staged, remoteTime, remoteTime)
      ctx.state = {} // state 缺记录，与 state.json 缺失/解析失败后的安全状态一致。
      const out = await applyAll(ctx)
      assert.deepEqual(await ctx.local(SESSION), local, '接收时间不能覆盖本地')
      assert.deepEqual(await fsp.readFile(staged), local, 'staging 恢复本地内容')
      assert.deepEqual(out.applied, [])
      assert.deepEqual(out.errors, [])
      assert.equal(out.declined[SESSION], sha1(remote))
      assert.deepEqual(out.unresolvedConflict[SESSION], {
        sessionId: 'session-1', localSha: sha1(local), remoteSha: sha1(remote),
      })
      await assertConflict(ctx, out, remote)
    })
  }
}

async function caseUnresolvedAcrossCycles() {
  await withHome('B7 首轮冲突→state持久化/重载→远端再变更仍不覆盖', async (ctx) => {
    const local = session('local preserved across cycles')
    const remote1 = session('first remote conflict')
    const remote2 = session('remote changes next cycle')
    await write(ctx.dshHome, SESSION, local)
    await ctx.stage(SESSION, remote1)
    let out = await applyAll(ctx)
    await assertConflict(ctx, out, remote1)
    // 按引擎持久化形状真正写入并重新解析，不借助同一个对象引用。
    const statePath = await write(ctx.dshHome, 'plugin-sync/state.json', JSON.stringify(out))
    ctx.state = JSON.parse(await fsp.readFile(statePath, 'utf8'))
    await ctx.stage(SESSION, remote2)
    out = await applyAll(ctx)
    assert.deepEqual(await ctx.local(SESSION), local)
    assert.deepEqual(out.applied, [])
    assert.equal(out.unresolvedConflict[SESSION].remoteSha, sha1(remote2))
    await assertConflict(ctx, out, remote2)

    // export 把 staging 换回本地不代表两侧收敛；无远端、被gate、多peer不一致均不能清除。
    for (const observed of [undefined, [sha1(remote2)], [sha1(local), sha1(remote2)]]) {
      ctx.state = JSON.parse(JSON.stringify(out))
      await ctx.stage(SESSION, local)
      ctx.observedRemoteHashes = observed ? { [SESSION]: observed } : undefined
      out = await applyAll(ctx)
      assert.ok(out.unresolvedConflict[SESSION], '导出本地不得清除未解决冲突')
    }
    ctx.state = out
    ctx.observedRemoteHashes = { [SESSION]: [sha1(local)] }
    ctx.gatedRels = new Set([SESSION])
    out = await applyAll(ctx)
    assert.ok(out.unresolvedConflict[SESSION], '被gate的staging相等不能清除冲突')
    ctx.state = out
    ctx.gatedRels.clear()
    out = await applyAll(ctx)
    assert.equal(out.unresolvedConflict[SESSION], undefined, '实际观测两侧一致才清除冲突')
    assert.equal(out.declined[SESSION], undefined)
    assert.equal(out.localHashes[SESSION], sha1(local))
    assert.equal(out.remoteHashes[SESSION], sha1(local))

    // 收敛后重新建立的基线仍允许真正仅远端改动。
    ctx.state = out
    await ctx.stage(SESSION, remote2)
    out = await applyAll(ctx)
    assert.deepEqual(await ctx.local(SESSION), remote2)
    assert.deepEqual(out.applied, [SESSION])
  })
  await withHome('B7 未解决冲突期间删除本地也不自动创建；手动清除后可重试', async (ctx) => {
    const local = session('local')
    const remote = session('remote')
    await write(ctx.dshHome, SESSION, local)
    await ctx.stage(SESSION, remote)
    ctx.state = await applyAll(ctx)
    await fsp.rm(path.join(ctx.dshHome, SESSION))
    await ctx.stage(SESSION, session('new remote after local deletion'))
    let out = await applyAll(ctx)
    await assert.rejects(ctx.local(SESSION), { code: 'ENOENT' })
    assert.equal(out.unresolvedConflict[SESSION].localSha, null)
    assert.deepEqual(out.applied, [])
    ctx.state = out
    delete ctx.state.unresolvedConflict[SESSION]
    out = await applyAll(ctx)
    assert.deepEqual(out.applied, [SESSION])
  })
}

async function casePartialBaselineAndFresh() {
  for (const field of ['localHashes', 'remoteHashes']) {
    await withHome(`B7 ${field} 单侧基线且本地尚新鲜`, async (ctx) => {
      const local = session('local active session')
      const remote = session('remote version')
      await write(ctx.dshHome, SESSION, local)
      await ctx.stage(SESSION, remote)
      ctx.settings.settleSec = 3600
      ctx.state[field][SESSION] = field === 'localHashes' ? sha1(local) : sha1(remote)
      const out = await applyAll(ctx)
      assert.deepEqual(await ctx.local(SESSION), local)
      assert.deepEqual(out.applied, [])
      await assertConflict(ctx, out, remote)
    })
  }
}

async function caseKnownBaseline() {
  await withHome('B7 有基线：仅远端修改可落回；两端修改保留本地', async (ctx) => {
    const initial = session('initial')
    const remote = session('remote changed')
    await write(ctx.dshHome, SESSION, initial)
    await ctx.stage(SESSION, remote)
    ctx.state.localHashes[SESSION] = sha1(initial)
    ctx.state.remoteHashes[SESSION] = sha1(initial)
    let out = await applyAll(ctx)
    assert.deepEqual(await ctx.local(SESSION), remote)
    assert.deepEqual(out.applied, [SESSION])
    assert.deepEqual(out.errors, [])

    const local2 = session('local independently changed')
    const remote2 = session('remote independently changed')
    await write(ctx.dshHome, SESSION, local2)
    await ctx.stage(SESSION, remote2)
    ctx.state = out
    out = await applyAll(ctx)
    assert.deepEqual(await ctx.local(SESSION), local2)
    assert.deepEqual(out.applied, [])
    await assertConflict(ctx, out, remote2)
  })
}

async function caseMissingLocalValid() {
  await withHome('B7/B8 本地缺失可创建合法会话，同内容建立基线', async (ctx) => {
    const remote = session('remote-only session')
    await ctx.stage(SESSION, remote)
    const out = await applyAll(ctx)
    assert.deepEqual(await ctx.local(SESSION), remote)
    assert.deepEqual(out.applied, [SESSION])
    ctx.state = {}
    const again = await applyAll(ctx)
    assert.deepEqual(again.applied, [])
    assert.deepEqual(again.conflicts, [])
    assert.equal(again.localHashes[SESSION], sha1(remote))
    assert.equal(again.remoteHashes[SESSION], sha1(remote))
  })
}

async function caseInvalidSessions() {
  const cases = [Buffer.alloc(0), Buffer.from('plain JSONL, not zstd\n'), Buffer.from([0x28, 0xb5, 0x2f])]
  for (const [i, remote] of cases.entries()) {
    await withHome(`B8 坏会话${i}：哈希正确也不得覆盖`, async (ctx) => {
      const local = session('valid local')
      await write(ctx.dshHome, SESSION, local)
      await ctx.stage(SESSION, remote)
      ctx.state.localHashes[SESSION] = sha1(local)
      ctx.state.remoteHashes[SESSION] = sha1(local)
      const out = await applyAll(ctx)
      assert.deepEqual(await ctx.local(SESSION), local)
      assert.deepEqual(out.applied, [])
      assert.ok(out.errors.some((e) => e.includes('zstd 魔数')))
      await assertConflict(ctx, out, remote)
    })
  }
  await withHome('B8 本地缺失也拒绝创建坏会话', async (ctx) => {
    const bad = Buffer.from('not zstd')
    await ctx.stage(SESSION, bad)
    const out = await applyAll(ctx)
    await assert.rejects(ctx.local(SESSION), { code: 'ENOENT' })
    await assertConflict(ctx, out, bad)
  })
  await withHome('B8 staging 与已校验哈希不符时拒写', async (ctx) => {
    const local = session('valid local')
    const remote = session('staging changed after index')
    await write(ctx.dshHome, SESSION, local)
    await ctx.stage(SESSION, remote)
    ctx.stagingIndex[SESSION].sha1 = sha1(session('index previous content'))
    const out = await applyAll(ctx)
    assert.deepEqual(await ctx.local(SESSION), local)
    assert.ok(out.errors.some((e) => e.includes('哈希不匹配')))
    await assertConflict(ctx, out, remote)
  })
}

async function caseDecodedSessionValidation() {
  const truncated = rawFrame('{}\n')
  truncated[5] = 5
  truncated.writeUIntLE((5 << 3) | 1, 6, 3)
  const missingLast = rawFrame('{}\n')
  missingLast[6] &= 0xfe
  const missingChecksum = rawFrame('{}\n')
  missingChecksum[4] |= 4
  for (const [name, remote, expected] of [
    ['带正确魔数的坏zstd帧', Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0, 0, 0]), /zstd 解压失败/],
    ['帧被截断但原生可返回合法JSONL', truncated, /zstd 帧被截断/],
    ['缺少最后块标记', missingLast, /zstd 帧被截断/],
    ['缺少声明的校验和', missingChecksum, /zstd 帧被截断/],
    ['合法帧后跟垃圾', Buffer.concat([rawFrame('{}\n'), Buffer.from('junk')]), /尾随垃圾/],
    ['zstd合法但JSONL第二行损坏', rawFrame('{"valid":true}\n{broken JSON\n'), /JSONL 第 2 行无效/],
    ['zstd合法但JSONL含空行', rawFrame('{}\n\n{}\n'), /JSONL 第 2 行无效/],
    ['zstd合法但解压结果为空', rawFrame(''), /JSONL 为空/],
    ['zstd合法但UTF-8损坏', rawFrame(Buffer.from([0xff, 0xfe, 0x0a])), /解压失败/],
  ]) {
    await withHome(`B8 ${name}拒绝覆盖`, async (ctx) => {
      const local = session('valid original')
      await write(ctx.dshHome, SESSION, local)
      await ctx.stage(SESSION, remote)
      ctx.state.localHashes[SESSION] = sha1(local)
      ctx.state.remoteHashes[SESSION] = sha1(local)
      const out = await applyAll(ctx)
      assert.deepEqual(await ctx.local(SESSION), local)
      assert.deepEqual(out.applied, [])
      assert.ok(out.errors.some((message) => expected.test(message)), out.errors.join('\n'))
      await assertConflict(ctx, out, remote)
    })
  }
  await withHome('B8 合法多行JSONL与CRLF可落回', async (ctx) => {
    const remote = rawFrame('{}\r\n{"next":true}\r\n')
    await ctx.stage(SESSION, remote)
    const out = await applyAll(ctx)
    assert.deepEqual(out.errors, [])
    assert.deepEqual(out.applied, [SESSION])
    assert.deepEqual(await ctx.local(SESSION), remote)
  })
  await withHome('B8 多个合法zstd帧拼接可落回', async (ctx) => {
    const remote = Buffer.concat([rawFrame('{}\n'), rawFrame('{"next":true}\n')])
    await ctx.stage(SESSION, remote)
    const out = await applyAll(ctx)
    assert.deepEqual(out.errors, [])
    assert.deepEqual(out.applied, [SESSION])
    assert.deepEqual(await ctx.local(SESSION), remote)
  })
  await withHome('B8 原生压缩与校验和帧通过验证，坏校验和拒写', async (ctx) => {
    const body = Buffer.from(JSON.stringify({ text: 'compressed message '.repeat(200) }) + '\n')
    const remote = zlib.zstdCompressSync(body, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
    await ctx.stage(SESSION, remote)
    let out = await applyAll(ctx)
    assert.deepEqual(out.errors, [])
    assert.deepEqual(out.applied, [SESSION])
    assert.deepEqual(await ctx.local(SESSION), remote)

    const corrupted = Buffer.from(remote)
    corrupted[corrupted.length - 1] ^= 1
    await ctx.stage(SESSION, corrupted)
    ctx.state = out
    out = await applyAll(ctx)
    assert.deepEqual(out.applied, [])
    assert.deepEqual(await ctx.local(SESSION), remote)
    assert.ok(out.errors.some((message) => /zstd 解压失败/.test(message)))
    await assertConflict(ctx, out, corrupted)
  })
  for (const mode of ['unavailable', 'output-limit']) {
    await withHome(`B8 解压${mode === 'unavailable' ? '能力缺失' : '输出有界'}时保守拒写`, async (ctx) => {
      const local = session('local')
      const remote = session('remote decompressed content')
      await write(ctx.dshHome, SESSION, local)
      await ctx.stage(SESSION, remote)
      const original = zlib.zstdDecompressSync
      let seen = false
      zlib.zstdDecompressSync = mode === 'unavailable' ? undefined : (bytes, options) => {
        seen = true
        assert.equal(options.maxOutputLength, MAX_BLOB_BYTES, '必须给原生解压器传递硬输出上限')
        // 用更小真实上限触发原生超限异常，避免测试分配200MiB解压内容。
        return original(bytes, { ...options, maxOutputLength: 8 })
      }
      let out
      try { out = await applyAll(ctx) } finally { zlib.zstdDecompressSync = original }
      assert.deepEqual(await ctx.local(SESSION), local)
      assert.deepEqual(out.applied, [])
      assert.ok(out.errors.some((message) => /不支持 zstd 解压|输出超过/.test(message)))
      if (mode === 'output-limit') assert.equal(seen, true)
      await assertConflict(ctx, out, remote)
    })
  }
}

async function caseProjcache() {
  await withHome('B8 摘要缓存坏JSON拒写，合法JSON落回真实缓存目录', async (ctx) => {
    const local = Buffer.from('{"summary":"local"}')
    await write(ctx.dshHome, CACHE_LOCAL, local)
    await ctx.stage(CACHE, Buffer.from('{"summary": broken'))
    let out = await applyAll(ctx)
    assert.deepEqual(await ctx.local(CACHE_LOCAL), local)
    assert.deepEqual(out.applied, [])
    assert.equal(out.errors.length, 1)
    await assert.rejects(ctx.local(CACHE), { code: 'ENOENT' })

    const remote = Buffer.from('{"summary":"remote validated"}')
    await ctx.stage(CACHE, remote)
    out = await applyAll(ctx)
    assert.deepEqual(await ctx.local(CACHE_LOCAL), remote)
    assert.deepEqual(out.applied, [CACHE])
    assert.deepEqual(out.errors, [])
    await assert.rejects(ctx.local(CACHE), { code: 'ENOENT' })
  })
  await withHome('B8 缺失摘要缓存也不得创建坏JSON', async (ctx) => {
    await ctx.stage(CACHE, Buffer.from('null trailing garbage'))
    const out = await applyAll(ctx)
    await assert.rejects(ctx.local(CACHE_LOCAL), { code: 'ENOENT' })
    assert.equal(out.errors.length, 1)
  })
}

async function caseConfigNeverApply() {
  await withHome('B8 applyConfig 默认false，true亦仅警告，配置仍可导出', async (ctx) => {
    const cfg = await loadConfig(path.join(ctx.dshHome, 'plugin-sync'), {})
    assert.equal(cfg.settings.applyConfig, false)
    const local = Buffer.from('plugins:\n  local: true\n')
    const remote = Buffer.from('invalid yaml: [\n')
    await write(ctx.dshHome, PROFILE, local)
    await ctx.stage(CONFIG, remote)
    let out = await applyAll(ctx)
    assert.deepEqual(await ctx.local(PROFILE), local)
    assert.deepEqual(out.applied, [])
    ctx.settings.applyConfig = true
    out = await applyAll(ctx)
    assert.deepEqual(await ctx.local(PROFILE), local)
    assert.deepEqual(await fsp.readFile(path.join(ctx.stagingRoot, CONFIG)), remote)
    assert.deepEqual(out.applied, [])
    assert.ok(ctx.messages.warn.includes('暂不支持自动落回插件配置'))

    const exportRoot = path.join(ctx.dshHome, 'plugin-sync', 'export-proof')
    const exported = await exportAll(ctx.dshHome, exportRoot, ctx.settings)
    assert.ok(exported.includes(CONFIG))
    assert.deepEqual(await fsp.readFile(path.join(exportRoot, CONFIG)), local)
    await fsp.rm(path.join(ctx.dshHome, PROFILE))
    out = await applyAll(ctx)
    await assert.rejects(ctx.local(PROFILE), { code: 'ENOENT' })
    assert.deepEqual(out.applied, [])
  })
}

async function caseLocalReadError() {
  await withHome('B7 本地读取失败不视为不存在', async (ctx) => {
    await fsp.mkdir(path.join(ctx.dshHome, SESSION), { recursive: true })
    await write(path.join(ctx.dshHome, SESSION), 'keep.txt', 'preserve directory data')
    await ctx.stage(SESSION, session('remote should never replace directory'))
    const out = await applyAll(ctx)
    assert.deepEqual(out.applied, [])
    assert.equal(out.errors.length, 1)
    assert.equal((await fsp.stat(path.join(ctx.dshHome, SESSION))).isDirectory(), true)
    assert.equal((await ctx.local(`${SESSION}/keep.txt`)).toString(), 'preserve directory data')
  })
}

async function caseHostWorkspaceWriteGuards() {
  for (const rel of ['attachments/../storages/workspace.json', 'projcache/../workspace.json']) {
    await withHome(`W1 ${rel}不能绕过workspace写禁令`, async (ctx) => {
      const original = Buffer.from('{"host":"must remain byte-identical"}')
      await write(ctx.dshHome, 'storages/workspace.json', original)
      await ctx.stage(rel, Buffer.from('{"remote":"must not overwrite host"}'))
      const out = await applyAll(ctx)
      assert.deepEqual(out.applied, [])
      assert.ok(out.errors.some((message) => /不是规范的相对路径/.test(message)))
      assert.deepEqual(await ctx.local('storages/workspace.json'), original)
    })
  }
  await withHome('W1 拒绝绝对路径、点段、空段、反斜线及NUL', async (ctx) => {
    const invalid = ['/attachments/file', 'C:/attachments/file', 'attachments/./file', 'attachments//file', 'attachments\\file', 'attachments/\0file']
    for (const rel of invalid) ctx.stagingIndex[rel] = { sha1: 'a'.repeat(40) }
    const out = await applyAll(ctx)
    assert.equal(out.errors.length, invalid.length)
    assert.deepEqual(out.applied, [])
    assert.ok(out.errors.every((message) => /不是规范的相对路径/.test(message)))
  })
  for (const kind of ['attachments', 'projcache']) {
    await withHome(`W1 ${kind}父目录符号链接不能写宿主workspace`, async (ctx) => {
      const original = Buffer.from('{"host":"must remain byte-identical"}')
      await write(ctx.dshHome, 'storages/workspace.json', original)
      const link = kind === 'attachments' ? 'attachments' : 'storages/session_projcache'
      await fsp.symlink(path.join(ctx.dshHome, 'storages'), path.join(ctx.dshHome, link), 'dir')
      await ctx.stage(`${kind}/workspace.json`, Buffer.from('{"remote":"must not overwrite through symlink"}'))
      const out = await applyAll(ctx)
      assert.deepEqual(out.applied, [])
      assert.ok(out.errors.some((message) => /父目录是符号链接/.test(message)))
      assert.deepEqual(await ctx.local('storages/workspace.json'), original)
    })
  }
}

async function main() {
  await caseNoBaseline()
  await casePartialBaselineAndFresh()
  await caseUnresolvedAcrossCycles()
  await caseKnownBaseline()
  await caseMissingLocalValid()
  await caseInvalidSessions()
  await caseDecodedSessionValidation()
  await caseProjcache()
  await caseConfigNeverApply()
  await caseLocalReadError()
  await caseHostWorkspaceWriteGuards()
  console.log('ALL PASS')
}

main().catch((e) => {
  console.error('TEST FAILED:', e)
  process.exitCode = 1
})
