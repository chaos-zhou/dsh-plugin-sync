// v1.2 registry applier 测试：纯 mock 宿主 workspaceRegistry/sessionPersistence，
// 不碰真实宿主与真实 ~/.dsh。覆盖 FEATURE-SPEC v1.2 的 8 类场景 + engine/index 接入。
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../lib/engine.js'
import { applyRegistryIndex } from '../lib/registry-apply.js'
import { apply as applyPlugin } from '../index.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
await fsp.mkdir(tmpRoot, { recursive: true })
const home = await fsp.mkdtemp(path.join(tmpRoot, 'registry-'))

const activeSessionError = () => {
  const e = new Error('session is active')
  e.name = 'WorkspaceActiveSessionError'
  return e
}

// state.byPath: Map<canonicalPath, {id, path, title, sessionIds}>；state.sessions: Set（宿主已识别）
function mockRegistry(state, opts = {}) {
  const calls = { create: [], resolveByPath: [], attach: [], archive: [], pin: [], setTitle: [], unarchive: [], unpin: [] }
  let nextId = 1
  const makeWs = (ws) => ({
    id: ws.id,
    path: ws.path,
    title: ws.title,
    sessionIds: ws.sessionIds,
    async setTitle(title) {
      calls.setTitle.push(ws.path)
      if (opts.throwSetTitle) throw new Error('setTitle failed')
      ws.title = title
    },
    async attachSession(sid) {
      calls.attach.push(`${ws.path}#${sid}`)
      if (opts.throwAttach === sid) throw new Error('attach failed')
      if (!ws.sessionIds.includes(sid)) ws.sessionIds.push(sid)
    },
    async status() { return 'ok' },
  })
  return {
    calls,
    state,
    async create(p, title) {
      calls.create.push(p)
      if (opts.throwCreate) throw new Error('create failed')
      const found = state.byPath.get(p)
      if (found) return makeWs(found)
      const ws = { id: `ws-${nextId++}`, path: p, title: typeof title === 'string' && title.length > 0 ? title : path.basename(p), sessionIds: [] }
      state.byPath.set(p, ws)
      return makeWs(ws)
    },
    async resolveByPath(p) {
      calls.resolveByPath.push(p)
      if (opts.throwResolve) throw new Error('resolve failed')
      const found = state.byPath.get(p)
      return found ? makeWs(found) : undefined
    },
    list() { return [...state.byPath.values()].map(makeWs) },
    async archiveSession(id) {
      calls.archive.push(id)
      if (state.activeSessions.has(id)) throw activeSessionError()
      if (!state.sessions.has(id)) throw new Error('session not found')
      state.archived.add(id)
    },
    async unarchiveSession(id) { calls.unarchive.push(id) },
    async pinSession(id) {
      calls.pin.push(id)
      if (state.archived.has(id) || !state.sessions.has(id)) throw new Error('cannot pin archived or missing session')
      state.pinned.add(id)
    },
    async unpinSession(id) { calls.unpin.push(id) },
  }
}

function mockSessionPersistence(knownIds, opts = {}) {
  const statCalls = []
  return {
    statCalls,
    async stat(id) {
      statCalls.push(id)
      if (opts.throwStat) throw new Error('stat I/O failure')
      return knownIds.has(id) ? { id } : undefined
    },
    async list() { return [...knownIds].map((id) => ({ id })) },
  }
}

const wsEntry = (dir, title, sessionIds) => ({
  path: dir, title, sessionIds, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
})

function doc(tables, extraGlobal = {}) {
  const ids = Object.keys(tables)
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ids,
      defaultWorkspaceId: '',
      archivedSessionIds: [],
      pinnedSessionIds: [],
      ...extraGlobal,
    },
    tables: { workspaces: tables },
  }
}

async function writeStaging(stagingRoot, value) {
  const file = path.join(stagingRoot, 'workspace', 'workspace.json')
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(value))
}

async function freshDir(name) {
  const dir = path.join(home, name)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

const result = { registryApplied: null, registryWarnings: [], error: null }

try {
  // ---------- 场景 1：resolveByPath 命中/未命中 → create 只在未命中时调用；attach 只对本地缺失 ----------
  {
    const stagingRoot = await freshDir('s1-staging')
    const alpha = await freshDir('s1/projects/alpha')
    const beta = await freshDir('s1/projects/beta')
    const state = {
      byPath: new Map([[alpha, { id: 'ws-a', path: alpha, title: 'Alpha', sessionIds: ['s1'] }]]),
      sessions: new Set(['s1', 's2', 's3']),
      activeSessions: new Set(),
      archived: new Set(),
      pinned: new Set(),
    }
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    await writeStaging(stagingRoot, doc({
      [alpha]: wsEntry(alpha, 'Alpha', ['s1', 's2']),
      [beta]: wsEntry(beta, 'Beta', ['s3']),
    }))
    const out = await applyRegistryIndex({ registry, sessionPersistence: sp, stagingRoot })
    assert.equal(out.error, null)
    assert.deepEqual(registry.calls.create, [beta], 'create 只在未命中时调用一次')
    assert.deepEqual(registry.calls.resolveByPath, [alpha, beta])
    assert.deepEqual(registry.calls.attach.sort(), [`${alpha}#s2`, `${beta}#s3`].sort(), 'attach 只对本地缺失的会话')
    assert.deepEqual(registry.calls.setTitle, [], 'create 已带远端标题，不再 setTitle')
    assert.deepEqual(sp.statCalls.sort(), ['s2', 's3'], '已存在的会话不查 stat')
    assert.equal(out.registryApplied.workspaces, 2)
    assert.equal(out.registryApplied.created, 1)
    assert.equal(out.registryApplied.sessions, 2)
    assert.deepEqual(out.registryWarnings, [])
    assert.deepEqual(state.byPath.get(alpha).sessionIds, ['s1', 's2'])
    assert.deepEqual(state.byPath.get(beta).sessionIds, ['s3'])
    assert.equal(state.byPath.get(beta).title, 'Beta')
    result.registryApplied = out.registryApplied
    console.log('场景1 命中/未命中 create 仅未命中一次、attach 仅缺失会话 PASS')
  }

  // ---------- 场景 2：幂等——全部已存在时零 create/attach/setTitle ----------
  {
    const stagingRoot = await freshDir('s2-staging')
    const alpha = await freshDir('s2/projects/alpha')
    const state = {
      byPath: new Map([[alpha, { id: 'ws-a', path: alpha, title: 'Alpha', sessionIds: ['s1', 's2'] }]]),
      sessions: new Set(['s1', 's2']),
      activeSessions: new Set(), archived: new Set(), pinned: new Set(),
    }
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    await writeStaging(stagingRoot, doc({ [alpha]: wsEntry(alpha, 'Alpha', ['s1', 's2']) }))
    await applyRegistryIndex({ registry, sessionPersistence: sp, stagingRoot })
    const before = structuredClone(registry.calls)
    const second = await applyRegistryIndex({ registry, sessionPersistence: sp, stagingRoot })
    assert.deepEqual(registry.calls.create, before.create, '零 create')
    assert.deepEqual(registry.calls.attach, before.attach, '零 attach')
    assert.deepEqual(registry.calls.setTitle, before.setTitle, '零 setTitle')
    assert.equal(second.registryApplied.created, 0)
    assert.equal(second.registryApplied.sessions, 0)
    assert.equal(second.registryApplied.titles, 0)
    assert.deepEqual(second.registryWarnings, [])
    console.log('场景2 幂等：全部已存在时零 create/attach/setTitle PASS')
  }

  // ---------- 场景 3：sessionPersistence.stat 缺失 → 不 attach，warning 记录 ----------
  {
    const stagingRoot = await freshDir('s3-staging')
    const alpha = await freshDir('s3/projects/alpha')
    const state = {
      byPath: new Map([[alpha, { id: 'ws-a', path: alpha, title: 'Alpha', sessionIds: ['s1'] }]]),
      sessions: new Set(['s1']),
      activeSessions: new Set(), archived: new Set(), pinned: new Set(),
    }
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    await writeStaging(stagingRoot, doc({ [alpha]: wsEntry(alpha, 'Alpha', ['s1', 'ghost-sid']) }))
    const out = await applyRegistryIndex({ registry, sessionPersistence: sp, stagingRoot })
    assert.deepEqual(registry.calls.attach, [], '宿主未识别的会话不 attach')
    assert.equal(out.registryApplied.sessions, 0)
    assert.ok(out.registryWarnings.some((w) => w.includes('ghost-sid') && w.includes('未被宿主识别')), 'warning 记录缺失会话')
    assert.equal(out.error, null)
    console.log('场景3 stat 缺失会话跳过并记 warning PASS')
  }

  // ---------- 场景 4：本地目录不存在 / 不是目录 → 跳过整个 workspace，不 create、不 attach ----------
  {
    const stagingRoot = await freshDir('s4-staging')
    const alpha = await freshDir('s4/projects/alpha')
    const ghost = path.join(home, 's4/projects/ghost')
    const notDir = path.join(home, 's4/plain-file')
    await fsp.writeFile(notDir, 'i am a file')
    const state = { byPath: new Map(), sessions: new Set(['s1', 's9']), activeSessions: new Set(), archived: new Set(), pinned: new Set() }
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    await writeStaging(stagingRoot, doc({
      [alpha]: wsEntry(alpha, 'Alpha', ['s1']),
      [ghost]: wsEntry(ghost, 'Ghost', ['s9']),
      [notDir]: wsEntry(notDir, 'NotDir', ['s9']),
    }))
    const out = await applyRegistryIndex({ registry, sessionPersistence: sp, stagingRoot })
    assert.deepEqual(registry.calls.create, [alpha], '只有真实目录被 create')
    assert.deepEqual(registry.calls.attach, [`${alpha}#s1`], '缺失目录的会话全部不处理')
    assert.ok(out.registryWarnings.some((w) => w.includes('ghost') && w.includes('不存在')))
    assert.ok(out.registryWarnings.some((w) => w.includes('不是目录')))
    assert.equal(out.registryApplied.workspaces, 1)
    assert.equal(out.error, null)
    console.log('场景4 缺目录/非目录 workspace 跳过 PASS')
  }

  // ---------- 场景 5：archive/pin 只加不减；active 归档抛错 → warning 不中断；未识别跳过 ----------
  {
    const stagingRoot = await freshDir('s5-staging')
    const alpha = await freshDir('s5/projects/alpha')
    const state = {
      byPath: new Map([[alpha, { id: 'ws-a', path: alpha, title: 'Alpha', sessionIds: [] }]]),
      sessions: new Set(['sa', 'sActive', 'sp', 'sArchived']),
      activeSessions: new Set(['sActive']),
      archived: new Set(['sArchived']),
      pinned: new Set(),
    }
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    await writeStaging(stagingRoot, doc({
      [alpha]: wsEntry(alpha, 'Alpha', []),
    }, {
      archivedSessionIds: ['sa', 'sActive', 'sMissing'],
      pinnedSessionIds: ['sp', 'sArchived'],
    }))
    const out = await applyRegistryIndex({ registry, sessionPersistence: sp, stagingRoot })
    assert.deepEqual(registry.calls.archive.sort(), ['sActive', 'sa'].sort(), '只对宿主已识别会话尝试归档（只加）')
    assert.deepEqual(registry.calls.unarchive, [], '从不 unarchive（只加不减）')
    assert.deepEqual(registry.calls.unpin, [], '从不 unpin')
    assert.equal(out.registryApplied.archived, 1, 'active 会话不计入成功')
    assert.deepEqual(registry.calls.pin.sort(), ['sArchived', 'sp'].sort(), '宿主已识别的都会尝试 pin；已归档的由宿主抛错转 warning')
    assert.equal(out.registryApplied.pinned, 1)
    assert.ok(out.registryWarnings.some((w) => w.includes('sActive') && w.includes('活动')), 'active 归档 warning')
    assert.ok(out.registryWarnings.some((w) => w.includes('sMissing') && w.includes('未被宿主识别')))
    assert.ok(out.registryWarnings.some((w) => w.includes('sArchived') && w.includes('置顶')))
    assert.equal(out.error, null)
    assert.equal(state.archived.has('sa'), true)
    assert.equal(state.pinned.has('sp'), true)
    console.log('场景5 archive/pin 只加不减、active 抛错 warning 不中断 PASS')
  }

  // ---------- 场景 6：标题规则——本地 title==basename 且远端不同才跟随；已改名不覆盖；同名不调用 ----------
  {
    const stagingRoot = await freshDir('s6-staging')
    const gamma = await freshDir('s6/projects/gamma')
    const delta = await freshDir('s6/projects/delta')
    const eps = await freshDir('s6/projects/eps')
    const state = {
      byPath: new Map([
        [gamma, { id: 'ws-g', path: gamma, title: 'gamma', sessionIds: [] }],
        [delta, { id: 'ws-d', path: delta, title: 'My Custom', sessionIds: [] }],
        [eps, { id: 'ws-e', path: eps, title: 'Epsilon', sessionIds: [] }],
      ]),
      sessions: new Set(), activeSessions: new Set(), archived: new Set(), pinned: new Set(),
    }
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    await writeStaging(stagingRoot, doc({
      [gamma]: wsEntry(gamma, 'Gamma 远端', []),
      [delta]: wsEntry(delta, 'Delta 远端', []),
      [eps]: wsEntry(eps, 'Epsilon', []),
    }))
    const out = await applyRegistryIndex({ registry, sessionPersistence: sp, stagingRoot })
    assert.deepEqual(registry.calls.setTitle, [gamma], '只在本地标题==目录 basename 且远端不同时 setTitle')
    assert.equal(state.byPath.get(gamma).title, 'Gamma 远端')
    assert.equal(state.byPath.get(delta).title, 'My Custom', '本地已改名不被远端覆盖')
    assert.equal(state.byPath.get(eps).title, 'Epsilon', '两端同名不调用')
    assert.equal(out.registryApplied.titles, 1)
    // 跟随之后下一轮不再改（单调收敛）
    await applyRegistryIndex({ registry, sessionPersistence: sp, stagingRoot })
    assert.deepEqual(registry.calls.setTitle, [gamma], 'setTitle 单调，不震荡')
    console.log('场景6 标题规则（跟随/不覆盖/同名/单调） PASS')
  }

  // ---------- 场景 7：registry 不可用 → 回退 proposal（applier 与 engine 两级验证） ----------
  {
    const stagingRoot = await freshDir('s7-staging')
    await writeStaging(stagingRoot, doc({ '/x': wsEntry('/x', 'X', []) }))
    const direct = await applyRegistryIndex({ registry: null, sessionPersistence: null, stagingRoot })
    assert.equal(direct.error, 'registry 不可用')
    assert.deepEqual(direct.registryWarnings, [])
    const half = await applyRegistryIndex({ registry: mockRegistry({ byPath: new Map(), sessions: new Set(), activeSessions: new Set(), archived: new Set(), pinned: new Set() }), sessionPersistence: null, stagingRoot })
    assert.equal(half.error, 'registry 不可用', '缺 sessionPersistence 同样降级')

    const cycleHome = path.join(home, 's7-engine')
    const engine = createEngine({ rowConfig: {
      dshHome: cycleHome, deviceName: 's7', listenPort: 0, token: 't', settleSec: 0,
    } })
    try {
      await engine.init()
      await writeStaging(path.join(cycleHome, 'plugin-sync/staging'), doc({
        '/nonexistent/path': wsEntry('/nonexistent/path', 'X', []),
      }))
      const summary = await engine.runCycle()
      assert.equal(summary.workspaceWriteMode, 'proposal', '无服务回退 proposal')
      assert.equal(summary.registryAvailable, false)
      assert.equal(summary.registryApplied, null)
      assert.equal(summary.proposalPending, true, 'proposal 文件照常生成（v1.1.2 行为）')
      assert.ok(summary.warnings.some((w) => w.includes('建议')), 'proposal 模式保留待应用提示')
      const status = await engine.status()
      assert.equal(status.workspaceWriteMode, 'proposal')
      assert.equal(status.registryAvailable, false)
      assert.equal(status.registryLastApplied, null)
      assert.deepEqual(await fsp.readdir(path.join(cycleHome, 'storages')).catch(() => []), [], '宿主 storages 目录未被创建')
    } finally {
      await engine.close()
    }
    console.log('场景7 registry 不可用回退 proposal（applier+engine） PASS')
  }

  // ---------- 场景 8：所有异常被捕获 → cycle 不 throw、warnings/errors 可见 ----------
  {
    const stagingRoot = await freshDir('s8-staging')
    const alpha = await freshDir('s8/projects/alpha')
    await writeStaging(stagingRoot, doc({ [alpha]: wsEntry(alpha, 'Alpha', ['sx']) }, { archivedSessionIds: ['sa'], pinnedSessionIds: ['sp'] }))
    const state = { byPath: new Map(), sessions: new Set(['sa', 'sp', 'sx']), activeSessions: new Set(), archived: new Set(), pinned: new Set() }
    const registry = mockRegistry(state, { throwResolve: true, throwCreate: true, throwAttach: 'sx', throwSetTitle: true })
    const sp = mockSessionPersistence(state.sessions, { throwStat: true })
    const out = await applyRegistryIndex({ registry, sessionPersistence: sp, stagingRoot })
    assert.equal(out.error, null, '单条失败不升级为 fatal')
    assert.ok(out.registryWarnings.length >= 3, '异常全部转为 warning')

    const cycleHome = path.join(home, 's8-engine')
    const throwingRegistry = {
      async resolveByPath() { throw new Error('resolve exploded') },
      async create() { throw new Error('create exploded') },
      list() { throw new Error('list exploded') },
      async archiveSession() { throw new Error('archive exploded') },
      async pinSession() { throw new Error('pin exploded') },
    }
    const engine = createEngine({ rowConfig: {
      dshHome: cycleHome, deviceName: 's8', listenPort: 0, token: 't', settleSec: 0,
    }, services: {
      workspaceRegistry: throwingRegistry,
      sessionPersistence: { async stat() { throw new Error('stat exploded') } },
    } })
    try {
      await engine.init()
      await writeStaging(path.join(cycleHome, 'plugin-sync/staging'), doc({ '/nowhere/ws': wsEntry('/nowhere/ws', 'W', ['s1']) }))
      const summary = await engine.runCycle()
      assert.equal(summary.workspaceWriteMode, 'registry')
      assert.ok(summary.registryWarnings.length >= 1, 'registry 异常进入 registryWarnings')
      assert.ok(summary.registryWarnings.every((w) => w.startsWith('registry:')), 'warning 统一前缀')
      const status = await engine.status()
      assert.deepEqual(status.registryWarnings, summary.registryWarnings)
    } finally {
      await engine.close()
    }
    console.log('场景8 全异常捕获不中断、cycle 正常返回 PASS')
  }

  // ---------- engine + index 接入：注入服务 → registry 模式；注入抛错/缺失 → proposal ----------
  {
    const cycleHome = path.join(home, 's9-engine')
    const proj = await freshDir('s9/projects/alpha')
    const state = { byPath: new Map(), sessions: new Set(['s1', 'sa']), activeSessions: new Set(['sa']), archived: new Set(), pinned: new Set() }
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    const engine = createEngine({ rowConfig: {
      dshHome: cycleHome, deviceName: 's9', listenPort: 0, token: 't', settleSec: 0,
    }, services: { workspaceRegistry: registry, sessionPersistence: sp } })
    try {
      await engine.init()
      await writeStaging(path.join(cycleHome, 'plugin-sync/staging'), doc({
        [proj]: wsEntry(proj, 'Alpha', ['s1']),
      }, { archivedSessionIds: ['sa'] }))
      const summary = await engine.runCycle()
      assert.equal(summary.workspaceWriteMode, 'registry', 'engine 在 apply 后走 registry 应用')
      assert.equal(summary.registryAvailable, true)
      assert.equal(summary.registryApplied.workspaces, 1)
      assert.equal(summary.registryApplied.created, 1)
      assert.equal(summary.registryApplied.sessions, 1)
      assert.equal(summary.registryApplied.archived, 0, 'active 会话归档失败只留 warning')
      assert.ok(summary.registryWarnings.some((w) => w.includes('sa')), 'active 归档 warning 可见')
      assert.ok(!summary.warnings.some((w) => w.includes('建议')), 'registry 模式不再提示待人工应用')
      assert.equal(registry.calls.create.length, 1)
      const second = await engine.runCycle()
      assert.equal(second.registryApplied.created, 0, '第二轮零 create（幂等）')
      assert.equal(second.registryApplied.sessions, 0, '第二轮零 attach')
      assert.equal(registry.calls.create.length, 1, '幂等：create 不重复')
      const status = await engine.status()
      assert.equal(status.workspaceWriteMode, 'registry')
      assert.equal(status.registryAvailable, true)
      assert.deepEqual(status.registryLastApplied, { at: second.at, workspaces: 1, created: 0, sessions: 0, archived: 0, pinned: 0, titles: 0 })
      assert.deepEqual(await fsp.readdir(path.join(cycleHome, 'storages')).catch(() => []), [], 'registry 模式下宿主 storages 仍零写入')
      assert.equal(summary.proposalPending, true, 'proposal 文件仍生成（审计/降级用）')
    } finally {
      await engine.close()
    }

    // index.js 注入形态：数组返回 → registry；注入抛错 → proposal 不抛
    const home2 = path.join(home, 's9-entry')
    const proj2 = await freshDir('s9-entry/projects/beta')
    const state2 = { byPath: new Map(), sessions: new Set(['s2']), activeSessions: new Set(), archived: new Set(), pinned: new Set() }
    const registry2 = mockRegistry(state2)
    const sp2 = mockSessionPersistence(state2.sessions)
    const engine2 = createEngine({ rowConfig: { dshHome: home2, deviceName: 'entry', listenPort: 0, token: 't', settleSec: 0 }, services: [registry2, sp2] })
    try {
      await engine2.init()
      await writeStaging(path.join(home2, 'plugin-sync/staging'), doc({ [proj2]: wsEntry(proj2, 'beta', ['s2']) }))
      const summary2 = await engine2.runCycle()
      assert.equal(summary2.workspaceWriteMode, 'registry', '数组形态服务同样生效')
      assert.equal(summary2.registryApplied.created, 1)
    } finally {
      await engine2.close()
    }

    const registered = new Map()
    const disposers = []
    const injectCalls = []
    const entryHome = path.join(home, 's9-index')
    const ctx = {
      inject(names) { injectCalls.push(names); throw new Error('host refuses injection') },
      effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
      tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
    }
    applyPlugin(ctx, { dshHome: entryHome, listenPort: 0, token: 'entry-token', settleSec: 0 })
    try {
      const status = () => registered.get('dsh_sync_status').execute()
      const sync = () => registered.get('dsh_sync_now').execute()
      assert.deepEqual(injectCalls, [['workspaceRegistry', 'sessionPersistence']], '只注入 registry 两服务，不再注入 storageDomain')
      const summary = await sync()
      assert.equal(summary.workspaceWriteMode, 'proposal', '注入抛错不向上抛，回退 proposal')
      assert.equal(summary.registryAvailable, false)
      assert.equal((await status()).registryAvailable, false)
    } finally {
      for (const dispose of disposers.reverse()) await dispose()
    }
    console.log('engine/index 接入（registry 模式/幂等/状态/注入降级） PASS')
  }

  console.log('ALL PASS（registry.test.mjs：8 类场景 + engine/index 接入）')
} finally {
  await fsp.rm(home, { recursive: true, force: true })
}
