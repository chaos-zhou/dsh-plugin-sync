import assert from 'node:assert'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mergeWorkspaces, mergeWorkspaceFiles, validateWorkspaceDoc } from '../lib/workspace.js'

// 与事故现场 /tmp/dsh-sync-accept/workspace.local.json 同构：用户手工修复后的合法 v2 文件
const V2_LOCAL = {
  unit: { name: 'workspace', version: 2 },
  global: {
    workspaceIds: ['ws-1'],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    defaultWorkspaceId: 'ws-1',
    initialized: true,
  },
  tables: {
    workspaces: {
      'ws-1': {
        path: '/home/user/Documents/deepseek-harness/default-workspace',
        title: 'default-workspace',
        sessionIds: ['sess-eba122c1', 'sess-4fdc400d', 'sess-f1517fef', 'sess-ac132ac9'],
        createdAt: '2026-11-02T01:11:35.106Z',
        updatedAt: '2026-11-04T04:11:04.338Z',
      },
    },
  },
}

// 与事故现场 /tmp/dsh-sync-accept/workspace.staging.json 同构：插件写坏的文件（缺 global.initialized）
const V2_STAGING_BROKEN = {
  unit: { name: 'workspace', version: 2 },
  global: {
    workspaceIds: ['ws-1'],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    defaultWorkspaceId: 'ws-1',
  },
  tables: {
    workspaces: {
      'ws-1': {
        path: '/home/user/Documents/deepseek-harness/default-workspace',
        title: 'default-workspace',
        sessionIds: ['sess-4fdc400d', 'sess-f1517fef', 'sess-ac132ac9'],
        createdAt: '2026-11-02T01:11:35.106Z',
        updatedAt: '2026-11-03T15:45:09.950Z',
      },
    },
  },
}

const clone = (v) => structuredClone(v)
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function collectKeys(v, prefix = '') {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return []
  const out = []
  for (const [k, val] of Object.entries(v)) {
    const p = `${prefix}/${k}`
    out.push(p, ...collectKeys(val, p))
  }
  return out
}

function keySubset(sub, sup) {
  const set = new Set(sup)
  return sub.every((k) => set.has(k))
}

async function mkHome() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ws-compat-'))
}

async function writeLocal(home, doc) {
  const dir = path.join(home, 'storages')
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'workspace.json')
  const bytes = Buffer.from(JSON.stringify(doc, null, 2))
  await fsp.writeFile(file, bytes)
  return { file, bytes }
}

async function writeStaging(home, doc) {
  const file = path.join(home, 'plugin-sync', 'staging', 'workspace', 'workspace.json')
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const bytes = Buffer.from(JSON.stringify(doc, null, 2))
  await fsp.writeFile(file, bytes)
  return bytes
}

const merge = (home) => mergeWorkspaceFiles(home, path.join(home, 'plugin-sync', 'staging'))
const readLocal = async (home) => fsp.readFile(path.join(home, 'storages', 'workspace.json'))
const readLocalJson = async (home) => JSON.parse(await fsp.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'))
const readStaging = async (home) => fsp.readFile(path.join(home, 'plugin-sync', 'staging', 'workspace', 'workspace.json'))
async function listBaks(home) {
  try {
    return (await fsp.readdir(path.join(home, 'storages'))).filter((n) => /^workspace\.json\.bak-\d{8}-\d{6}$/.test(n))
  } catch {
    return []
  }
}

async function case1Lossless() {
  const home = await mkHome()
  try {
    const local = clone(V2_LOCAL)
    local.customTop = { nested: 1 }
    local.global.customFlag = 'keepme'
    local.tables.workspaces['ws-1'].extra = { note: 'x' }
    await writeLocal(home, local)
    await writeStaging(home, clone(V2_STAGING_BROKEN))

    const result = await merge(home)
    assert.strictEqual(result.merged, true, 'case1 合并成功')
    const out = await readLocalJson(home)
    assert.strictEqual(typeof out.global.initialized, 'boolean', 'initialized 仍为 boolean')
    assert.strictEqual(out.global.initialized, true, 'initialized 值保留')
    assert.strictEqual(out.global.customFlag, 'keepme', '未知键 global.customFlag 保留')
    assert.deepStrictEqual(out.tables.workspaces['ws-1'].extra, { note: 'x' }, 'workspace 条目未知键 extra 保留')
    assert.deepStrictEqual(out.customTop, { nested: 1 }, '顶层未知键保留')
    assert.ok(keySubset(collectKeys(local), collectKeys(out)), '本地全部键递归保留')
    assert.deepStrictEqual(validateWorkspaceDoc(out), [], '合并输出通过 v2 校验')

    const pure = mergeWorkspaces(local, clone(V2_STAGING_BROKEN))
    assert.ok(keySubset(collectKeys(local), collectKeys(pure)), '纯函数同样无损')
    assert.deepStrictEqual(pure.unit, { name: 'workspace', version: 2 }, 'unit 信封保留')
    console.log('case1 无损合并（initialized/未知键保留）PASS')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function case2RemoteMissingFields() {
  const home = await mkHome()
  try {
    await writeLocal(home, clone(V2_LOCAL))
    await writeStaging(home, clone(V2_STAGING_BROKEN))

    const result = await merge(home)
    assert.strictEqual(result.merged, true, 'case2 合并成功')
    assert.deepStrictEqual(result.errors, [], '无错误')
    const out = await readLocalJson(home)
    assert.strictEqual(out.global.initialized, true, '输出包含 initialized（远端缺失由本地补齐）')
    assert.deepStrictEqual(
      [...out.tables.workspaces['ws-1'].sessionIds].sort(),
      [...V2_LOCAL.tables.workspaces['ws-1'].sessionIds].sort(),
      '远端/本地 sessionIds 并集',
    )
    console.log('case2 远端缺 initialized 仍正常合并 PASS')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function case3InvalidLocalRefusesWrite() {
  const home = await mkHome()
  try {
    const local = clone(V2_LOCAL)
    delete local.global.initialized
    const { bytes } = await writeLocal(home, local)
    const stagingBytes = await writeStaging(home, clone(V2_STAGING_BROKEN))

    const result = await merge(home)
    assert.strictEqual(result.merged, false, 'case3 拒绝合并')
    assert.ok(result.error, '返回 error')
    assert.strictEqual(sha256(await readLocal(home)), sha256(bytes), '本地文件哈希不变')
    assert.strictEqual(sha256(await readStaging(home)), sha256(stagingBytes), 'staging 文件未被改写')
    assert.deepStrictEqual(await listBaks(home), [], '不存在备份')
    console.log('case3 本地非法拒写 PASS')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function case4RemoteOnlyWorkspaceMissingFields() {
  const home = await mkHome()
  try {
    await writeLocal(home, clone(V2_LOCAL))
    const staged = clone(V2_STAGING_BROKEN)
    staged.tables.workspaces['ws-remote'] = {
      path: '/tmp/other-project',
      sessionIds: ['sess-other'],
      updatedAt: '2026-11-01T00:00:00.000Z',
    }
    await writeStaging(home, staged)

    const result = await merge(home)
    assert.strictEqual(result.merged, true, 'case4 合法部分正常合并')
    assert.ok(result.errors.length >= 1, '报 error')
    const out = await readLocalJson(home)
    assert.strictEqual('ws-remote' in out.tables.workspaces, false, '坏条目未写入')
    assert.deepStrictEqual(validateWorkspaceDoc(out), [], '写出的文件仍是合法 v2')
    assert.ok(keySubset(collectKeys(V2_LOCAL), collectKeys(out)), '本地键不受影响')
    console.log('case4 远端独有坏 workspace 跳过并报 error PASS')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function case5VersionGuard() {
  const home = await mkHome()
  try {
    const { bytes } = await writeLocal(home, clone(V2_LOCAL))
    const staged = clone(V2_STAGING_BROKEN)
    staged.unit.version = 3
    const stagingBytes = await writeStaging(home, staged)

    const result = await merge(home)
    assert.strictEqual(result.merged, false, 'case5 拒绝合并')
    assert.strictEqual(result.skipped, true, '标记 skipped')
    assert.strictEqual(sha256(await readLocal(home)), sha256(bytes), '本地字节不变')
    assert.strictEqual(sha256(await readStaging(home)), sha256(stagingBytes), 'staging 字节不变')
    assert.deepStrictEqual(await listBaks(home), [], '未产生备份')
    console.log('case5 版本守卫（version=3 跳过不写）PASS')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function case6BackupAndPrune() {
  const home = await mkHome()
  try {
    const { bytes } = await writeLocal(home, clone(V2_LOCAL))
    const storagesDir = path.join(home, 'storages')
    for (let i = 1; i <= 7; i++) {
      await fsp.writeFile(path.join(storagesDir, `workspace.json.bak-2026010${i}-000000`), '"old"')
    }
    const staged = clone(V2_STAGING_BROKEN)
    staged.global.pinnedSessionIds = ['sess-pinned-remote']
    await writeStaging(home, staged)

    const result = await merge(home)
    assert.strictEqual(result.merged, true, 'case6 合并成功')
    const baks = await listBaks(home)
    assert.strictEqual(baks.length, 5, `备份最多保留 5 个 (got ${baks.length})`)
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const ymd = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    const newest = baks.find((n) => n.startsWith(`workspace.json.bak-${ymd}`))
    assert.ok(newest, '本次写盘前创建了新备份')
    assert.strictEqual(sha256(await fsp.readFile(path.join(storagesDir, newest))), sha256(bytes), '备份内容等于写前原文件')
    const out = await readLocalJson(home)
    assert.deepStrictEqual(out.global.pinnedSessionIds, ['sess-pinned-remote'], '本地内容已更新')
    console.log('case6 备份与保留 5 个 PASS')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function case7Idempotent() {
  const home = await mkHome()
  try {
    await writeLocal(home, clone(V2_LOCAL))
    await writeStaging(home, clone(V2_STAGING_BROKEN))

    await merge(home)
    const local1 = await readLocal(home)
    const staging1 = await readStaging(home)
    await merge(home)
    const local2 = await readLocal(home)
    const staging2 = await readStaging(home)
    assert.strictEqual(sha256(local2), sha256(local1), '第二次合并本地输出字节相同')
    assert.strictEqual(sha256(staging2), sha256(staging1), '第二次合并 staging 输出字节相同')

    const pure1 = mergeWorkspaces(clone(V2_LOCAL), clone(V2_STAGING_BROKEN))
    const pure2 = mergeWorkspaces(clone(V2_LOCAL), clone(V2_STAGING_BROKEN))
    assert.deepStrictEqual(pure2, pure1, '纯函数幂等')
    console.log('case7 幂等 PASS')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function case8LocalMissing() {
  const home = await mkHome()
  try {
    // 本地缺失 + 远端不合法 → 禁止创建残缺文件
    await writeStaging(home, clone(V2_STAGING_BROKEN))
    let result = await merge(home)
    assert.strictEqual(result.merged, false, '远端不合法时不创建')
    await assert.rejects(readLocal(home), 'workspace.json 未被创建')

    // 本地缺失 + 远端合法 → 允许创建且字段齐全
    await writeStaging(home, clone(V2_LOCAL))
    result = await merge(home)
    assert.strictEqual(result.merged, true, '远端合法时创建')
    const out = await readLocalJson(home)
    assert.strictEqual(out.global.initialized, true, '创建的文件含 initialized')
    assert.deepStrictEqual(validateWorkspaceDoc(out), [], '创建的文件通过校验')
    console.log('case8 本地缺失按远端合法性决定写入 PASS')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function main() {
  await case1Lossless()
  await case2RemoteMissingFields()
  await case3InvalidLocalRefusesWrite()
  await case4RemoteOnlyWorkspaceMissingFields()
  await case5VersionGuard()
  await case6BackupAndPrune()
  await case7Idempotent()
  await case8LocalMissing()
  console.log('ALL PASS')
}

main().catch((e) => {
  console.error('TEST FAILED:', e)
  process.exit(1)
})
