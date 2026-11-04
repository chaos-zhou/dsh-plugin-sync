import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeWorkspace, validateWorkspaceDoc } from '../lib/workspace.js'

const source = '/tmp/dsh-sync-accept'
const localSource = path.join(source, 'workspace.local.json')
const stagingSource = path.join(source, 'workspace.staging.json')
const [localBytes, remoteBytes] = await Promise.all([fsp.readFile(localSource), fsp.readFile(stagingSource)])
const local = JSON.parse(localBytes)
const remote = JSON.parse(remoteBytes)
function keys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([key, item]) => {
    const next = `${prefix}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
    return [next, ...keys(item, next)]
  })
}
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const tempRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
await fsp.mkdir(tempRoot, { recursive: true })
const home = await fsp.mkdtemp(path.join(tempRoot, 'fixture-accept-'))
const dataDir = path.join(home, 'plugin-sync')
const stagingRoot = path.join(dataDir, 'staging')
const hostPath = path.join(home, 'storages', 'workspace.json')
const stagingPath = path.join(stagingRoot, 'workspace', 'workspace.json')
const proposalPath = path.join(dataDir, 'proposed', 'workspace.json')
const check = (out) => {
  assert.deepEqual(validateWorkspaceDoc(out, { requireEnvelope: true }), [])
  assert.equal(out.global.initialized, local.global.initialized)
  const outputKeys = new Set(keys(out))
  assert.ok(keys(local).every((key) => outputKeys.has(key)), '本地递归键不缩减')
  for (const [id, workspace] of Object.entries(local.tables.workspaces)) {
    const union = [...new Set([...workspace.sessionIds, ...(remote.tables.workspaces[id]?.sessionIds || [])])]
    assert.deepEqual(out.tables.workspaces[id].sessionIds, union)
  }
}
try {
  await fsp.mkdir(path.dirname(hostPath), { recursive: true })
  await fsp.mkdir(path.dirname(stagingPath), { recursive: true })
  await fsp.writeFile(hostPath, localBytes)
  await fsp.writeFile(stagingPath, remoteBytes)
  const result = await mergeWorkspace({ dshHome: home, stagingRoot, dataDir })
  assert.equal(result.merged, true)
  assert.equal(result.workspaceWriteMode, 'proposal')
  assert.equal(result.proposalPending, true)
  assert.deepEqual(result.errors, [])
  const proposal = JSON.parse(await fsp.readFile(proposalPath, 'utf8'))
  check(proposal)
  assert.deepEqual(await fsp.readFile(hostPath), localBytes, 'proposal模式宿主原字节完全不变')
  assert.deepEqual(await fsp.readFile(stagingPath), await fsp.readFile(proposalPath))

  // 同一事故输入也走宿主domain mock，不能依靠文件回写使测试通过。
  const stored = structuredClone(local)
  const table = { get size() { return Object.keys(stored.tables.workspaces).length }, entries: () => Object.entries(stored.tables.workspaces)[Symbol.iterator](), async put(id, value) { Object.defineProperty(stored.tables.workspaces, id, { value: structuredClone(value), enumerable: true, writable: true, configurable: true }) } }
  const domain = { name: 'workspace', table(name) { assert.equal(name, 'workspaces'); return table }, global: { get: () => stored.global, async set(value) { stored.global = structuredClone(value) } } }
  await fsp.writeFile(stagingPath, remoteBytes)
  const applied = await mergeWorkspace({ domain, dshHome: home, stagingRoot, dataDir })
  assert.equal(applied.merged, true)
  assert.equal(applied.workspaceWriteMode, 'domain')
  assert.equal(applied.proposalPending, false)
  assert.deepEqual(applied.errors, [])
  check(stored)
  check(applied.workspace)
  assert.deepEqual(await fsp.readFile(hostPath), localBytes, 'domain模式宿主原字节也完全不变')
  await assert.rejects(fsp.access(proposalPath), { code: 'ENOENT' })
  assert.deepEqual(await fsp.readFile(localSource), localBytes, '原始fixture不修改')
  assert.deepEqual(await fsp.readFile(stagingSource), remoteBytes, '原始fixture不修改')
  console.log(`真实 fixture local sha256=${digest(localBytes)}`)
  console.log(`真实 fixture staging sha256=${digest(remoteBytes)}`)
  console.log('domain + proposal / 合法v2 / initialized / 本地递归键 / sessionIds并集 / 宿主字节不变 ALL PASS')
} finally {
  await fsp.rm(home, { recursive: true, force: true })
}
