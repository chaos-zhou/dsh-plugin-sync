// v1.2.2 registry applier 测试：纯 mock 宿主 workspaceRegistry/sessionPersistence，
// 不碰真实宿主与真实 ~/.dsh。覆盖 FIX-SPEC v1.2.1 R1-R5 + v1.2.2：
// R1 注入回调契约 (injectCtx, config) 与服务可用性校验（缺方法/空对象 → proposal）；
// R2 既有 workspace 零 setTitle（标题只在 create 新建时传入）；
// R3 坏文档（engine 门禁 + applier 防御自检）零 mutation；
// R4 路径只映射一次（engine 全链路，pathRemap 的 to 含 from 以暴露二次映射）；
// R5 逐 API 故障注入（resolveByPath/create/stat/attach/archive/pin 各自断言后续条目继续、
//    其它 API 调用次数符合预期，不再整体短路；v1.2.2 补 attach/archive/pin 首项失败次项继续）；
// v1.2.2 BLOCKER 回归：「先坏后好」双 peer——本轮任一次合并失败即整轮零 registry mutation；
// v1.2.2 NIT2：带 archived/pinned 的重复轮幂等（宿主 no-op 语义，成功调用计数）。
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../lib/engine.js'
import { normalizeRemapRules, mapPathOnce, isSafeAbsolutePath } from '../lib/workspace.js'
import { mergeWorkspaces } from '../lib/workspace.js'
import { applyRegistryIndex, registryServicesUsable } from '../lib/registry-apply.js'
import { apply as applyPlugin } from '../index.js'
import { sha1 } from '../lib/util.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
await fsp.mkdir(tmpRoot, { recursive: true })
const home = await fsp.mkdtemp(path.join(tmpRoot, 'registry-'))

const activeSessionError = () => {
  const e = new Error('session is active')
  e.name = 'WorkspaceActiveSessionError'
  return e
}

// state.byPath: Map<canonicalPath, {id, path, title, sessionIds}>；state.sessions: Set（宿主已识别）
// opts.throwXxx 支持 true 或 (arg) => boolean，用于逐 API 精确注入故障。
function mockRegistry(state, opts = {}) {
  const calls = { create: [], createTitles: [], resolveByPath: [], attach: [], archive: [], pin: [], setTitle: [], unarchive: [], unpin: [] }
  const shouldThrow = (spec, arg) => spec === true || (typeof spec === 'function' && spec(arg))
  let nextId = 1
  const makeWs = (ws) => ({
    id: ws.id,
    path: ws.path,
    title: ws.title,
    sessionIds: ws.sessionIds,
    async setTitle(title) {
      calls.setTitle.push(ws.path)
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
      calls.createTitles.push(title === undefined ? null : title)
      if (shouldThrow(opts.throwCreate, p)) throw new Error('create failed')
      const found = state.byPath.get(p)
      if (found) return makeWs(found)
      const ws = { id: `ws-${nextId++}`, path: p, title: typeof title === 'string' && title.length > 0 ? title : path.basename(p), sessionIds: [] }
      state.byPath.set(p, ws)
      return makeWs(ws)
    },
    async resolveByPath(p) {
      calls.resolveByPath.push(p)
      if (shouldThrow(opts.throwResolve, p)) throw new Error('resolve failed')
      const found = state.byPath.get(p)
      return found ? makeWs(found) : undefined
    },
    list() { return [...state.byPath.values()].map(makeWs) },
    async archiveSession(id) {
      calls.archive.push(id)
      if (shouldThrow(opts.throwArchive, id)) throw new Error('archive failed')
      if (state.activeSessions.has(id)) throw activeSessionError()
      if (!state.sessions.has(id)) throw new Error('session not found')
      state.archived.add(id)
    },
    async unarchiveSession(id) { calls.unarchive.push(id) },
    async pinSession(id) {
      calls.pin.push(id)
      if (shouldThrow(opts.throwPin, id)) throw new Error('pin failed')
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

const emptyState = () => ({ byPath: new Map(), sessions: new Set(), activeSessions: new Set(), archived: new Set(), pinned: new Set() })

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

// 模拟宿主自身的 storages/workspace.json（插件对它只读）
async function writeHostWorkspace(dshHome, value) {
  const file = path.join(dshHome, 'storages', 'workspace.json')
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(value))
}

async function freshDir(name) {
  const dir = path.join(home, name)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

const zeroMutationCalls = (registry, sp, label) => {
  assert.deepEqual(registry.calls.resolveByPath, [], `${label}：零 resolveByPath`)
  assert.deepEqual(registry.calls.create, [], `${label}：零 create`)
  assert.deepEqual(registry.calls.attach, [], `${label}：零 attach`)
  assert.deepEqual(registry.calls.archive, [], `${label}：零 archive`)
  assert.deepEqual(registry.calls.pin, [], `${label}：零 pin`)
  assert.deepEqual(registry.calls.setTitle, [], `${label}：零 setTitle`)
  assert.deepEqual(sp.statCalls, [], `${label}：连 stat 都不调用`)
}

try {
  // ---------- 场景 1：applier 直连正常路径 + R2 标题策略 ----------
  // 既有 workspace：本地标题==目录 basename 且远端不同（旧实现会 setTitle，新实现必须零调用）；
  // 新建 workspace：create 收到远端 title。
  {
    const alpha = await freshDir('s1/projects/alpha')
    const beta = await freshDir('s1/projects/beta')
    const state = {
      byPath: new Map([[alpha, { id: 'ws-a', path: alpha, title: 'alpha', sessionIds: ['s1'] }]]),
      sessions: new Set(['s1', 's2', 's3']),
      activeSessions: new Set(), archived: new Set(), pinned: new Set(),
    }
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({
      [alpha]: wsEntry(alpha, 'Alpha-远端', ['s1', 's2']),
      [beta]: wsEntry(beta, 'Beta', ['s3']),
    }) })
    assert.equal(out.error, null)
    assert.deepEqual(registry.calls.create, [beta], 'create 只在未命中时调用一次')
    assert.deepEqual(registry.calls.createTitles, ['Beta'], 'R2：新建时 create 收到远端 title')
    assert.deepEqual(registry.calls.resolveByPath, [alpha, beta])
    assert.deepEqual(registry.calls.attach.sort(), [`${alpha}#s2`, `${beta}#s3`].sort(), 'attach 只对本地缺失的会话')
    assert.deepEqual(registry.calls.setTitle, [], 'R2：既有 workspace 零 setTitle（本地标题==basename 且远端不同也不改）')
    assert.equal(state.byPath.get(alpha).title, 'alpha', '既有标题不被远端覆盖（重命名不跨设备同步）')
    assert.equal(state.byPath.get(beta).title, 'Beta')
    assert.deepEqual(sp.statCalls.sort(), ['s2', 's3'], '已存在的会话不查 stat')
    assert.deepEqual(out.registryApplied, { workspaces: 2, created: 1, sessions: 2, archived: 0, pinned: 0 })
    assert.deepEqual(out.registryWarnings, [])
    assert.deepEqual(state.byPath.get(alpha).sessionIds, ['s1', 's2'])
    assert.deepEqual(state.byPath.get(beta).sessionIds, ['s3'])
    console.log('场景1 正常路径 + R2 标题（既有零 setTitle / create 带 title） PASS')
  }

  // ---------- 场景 2：幂等——全部已存在时零 create/attach/setTitle ----------
  {
    const alpha = await freshDir('s2/projects/alpha')
    const state = {
      byPath: new Map([[alpha, { id: 'ws-a', path: alpha, title: 'alpha', sessionIds: ['s1', 's2'] }]]),
      sessions: new Set(['s1', 's2']),
      activeSessions: new Set(), archived: new Set(), pinned: new Set(),
    }
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    const docValue = doc({ [alpha]: wsEntry(alpha, 'alpha', ['s1', 's2']) })
    await applyRegistryIndex({ registry, sessionPersistence: sp, doc: docValue })
    const before = structuredClone(registry.calls)
    const second = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: docValue })
    assert.deepEqual(registry.calls.create, before.create, '零 create')
    assert.deepEqual(registry.calls.attach, before.attach, '零 attach')
    assert.deepEqual(registry.calls.setTitle, before.setTitle, '零 setTitle')
    assert.deepEqual(second.registryApplied, { workspaces: 1, created: 0, sessions: 0, archived: 0, pinned: 0 })
    assert.deepEqual(second.registryWarnings, [])
    console.log('场景2 幂等：全部已存在时零 create/attach/setTitle PASS')
  }

  // ---------- 场景 3：R3 applier 防御性自检——坏文档直接返回，不触碰任何 registry API ----------
  {
    const missingUnit = { global: doc({}).global, tables: { workspaces: {} } }
    const missingInitialized = doc({})
    delete missingInitialized.global.initialized
    const badEntry = doc({ '/nowhere/ws': { path: '/nowhere/ws', title: 123, sessionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' } })
    const badDocs = [
      ['缺 unit 信封', missingUnit],
      ['缺 global.initialized', missingInitialized],
      ['条目 title 非法', badEntry],
      ['doc 为 null', null],
    ]
    for (const [label, bad] of badDocs) {
      const registry = mockRegistry(emptyState())
      const sp = mockSessionPersistence(new Set())
      const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: bad })
      assert.ok(out.error && out.error.includes('零 mutation'), `${label}：错误说明零 mutation`)
      assert.deepEqual(out.registryApplied, { workspaces: 0, created: 0, sessions: 0, archived: 0, pinned: 0 }, `${label}：计数全零`)
      assert.deepEqual(out.registryWarnings, [], `${label}：零 warning`)
      zeroMutationCalls(registry, sp, label)
    }
    console.log('场景3 R3 applier 防御自检：4 类坏文档零 mutation PASS')
  }

  // ---------- 场景 4：本地目录不存在 / 不是目录 → 跳过整个 workspace，不 create、不 attach ----------
  {
    const alpha = await freshDir('s4/projects/alpha')
    const ghost = path.join(home, 's4/projects/ghost')
    const notDir = path.join(home, 's4/plain-file')
    await fsp.writeFile(notDir, 'i am a file')
    const state = { byPath: new Map(), sessions: new Set(['s1', 's9']), activeSessions: new Set(), archived: new Set(), pinned: new Set() }
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({
      [alpha]: wsEntry(alpha, 'Alpha', ['s1']),
      [ghost]: wsEntry(ghost, 'Ghost', ['s9']),
      [notDir]: wsEntry(notDir, 'NotDir', ['s9']),
    }) })
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
    const alpha = await freshDir('s5/projects/alpha')
    const state = {
      byPath: new Map([[alpha, { id: 'ws-a', path: alpha, title: 'alpha', sessionIds: [] }]]),
      sessions: new Set(['sa', 'sActive', 'sp', 'sArchived']),
      activeSessions: new Set(['sActive']),
      archived: new Set(['sArchived']),
      pinned: new Set(),
    }
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({
      [alpha]: wsEntry(alpha, 'alpha', []),
    }, {
      archivedSessionIds: ['sa', 'sActive', 'sMissing'],
      pinnedSessionIds: ['sp', 'sArchived'],
    }) })
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

  // ---------- 场景 6：R5 逐 API 故障注入（每例断言 warning、后续条目继续、其它 API 次数） ----------
  {
    // 6a resolveByPath 对第一个 workspace 抛错 → 该条跳过，第二个 workspace 完整处理
    {
      const alpha = await freshDir('s6a/projects/alpha')
      const beta = await freshDir('s6a/projects/beta')
      const registry = mockRegistry(emptyState(), { throwResolve: (p) => p === alpha })
      const sp = mockSessionPersistence(new Set(['s1', 's2']))
      const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({
        [alpha]: wsEntry(alpha, 'Alpha', ['s1']),
        [beta]: wsEntry(beta, 'Beta', ['s2']),
      }) })
      assert.equal(out.error, null)
      assert.ok(out.registryWarnings.some((w) => w.includes(alpha) && w.includes('resolve failed')), 'resolve 错误进 warning')
      assert.deepEqual(registry.calls.resolveByPath, [alpha, beta], '后续条目继续 resolve')
      assert.deepEqual(registry.calls.create, [beta], '后续条目继续 create')
      assert.deepEqual(registry.calls.attach, [`${beta}#s2`], '故障条目零 attach，其它条目正常 attach')
      assert.deepEqual(out.registryApplied, { workspaces: 1, created: 1, sessions: 1, archived: 0, pinned: 0 })
    }
    // 6b create 抛错 → 两条都失败，但第二条仍被尝试（不被首条短路），attach 均不发生
    {
      const alpha = await freshDir('s6b/projects/alpha')
      const beta = await freshDir('s6b/projects/beta')
      const registry = mockRegistry(emptyState(), { throwCreate: true })
      const sp = mockSessionPersistence(new Set(['s1', 's2']))
      const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({
        [alpha]: wsEntry(alpha, 'Alpha', ['s1']),
        [beta]: wsEntry(beta, 'Beta', ['s2']),
      }) })
      assert.equal(out.error, null)
      assert.equal(out.registryWarnings.filter((w) => w.includes('create failed')).length, 2, '两条 create 失败都有 warning')
      assert.deepEqual(registry.calls.resolveByPath, [alpha, beta], '后续条目继续 resolve')
      assert.deepEqual(registry.calls.create, [alpha, beta], '后续条目继续尝试 create')
      assert.deepEqual(registry.calls.attach, [], 'create 失败的条目零 attach')
    }
    // 6c stat 抛错 → archive/pin/attach 全部跳过并各有一条 warning，但 workspace 级 create 不受影响
    {
      const alpha = await freshDir('s6c/projects/alpha')
      const registry = mockRegistry(emptyState())
      const sp = mockSessionPersistence(new Set(['sa', 'sp', 'sx']), { throwStat: true })
      const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({
        [alpha]: wsEntry(alpha, 'Alpha', ['sx']),
      }, { archivedSessionIds: ['sa'], pinnedSessionIds: ['sp'] }) })
      assert.equal(out.error, null)
      assert.deepEqual(sp.statCalls, ['sa', 'sp', 'sx'], '三个 id 各尝试一次 stat')
      assert.deepEqual(registry.calls.archive, [], 'stat 失败不 archive')
      assert.deepEqual(registry.calls.pin, [], 'stat 失败不 pin')
      assert.deepEqual(registry.calls.attach, [], 'stat 失败不 attach')
      assert.deepEqual(registry.calls.create, [alpha], 'workspace 级 create 不被 stat 故障短路')
      assert.equal(out.registryWarnings.length, 3, '归档/置顶/附加各一条 warning')
      assert.ok(out.registryWarnings.some((w) => w.includes('sa') && w.includes('归档')))
      assert.ok(out.registryWarnings.some((w) => w.includes('sp') && w.includes('置顶')))
      assert.ok(out.registryWarnings.some((w) => w.includes('sx') && w.includes('附加')))
    }
    // 6d attachSession 对特定会话抛错 → 同工作区后续会话继续，其它工作区也继续
    {
      const alpha = await freshDir('s6d/projects/alpha')
      const beta = await freshDir('s6d/projects/beta')
      const state = {
        byPath: new Map([
          [alpha, { id: 'ws-a', path: alpha, title: 'alpha', sessionIds: [] }],
          [beta, { id: 'ws-b', path: beta, title: 'beta', sessionIds: [] }],
        ]),
        sessions: new Set(['s1', 's2', 's3']),
        activeSessions: new Set(), archived: new Set(), pinned: new Set(),
      }
      const registry = mockRegistry(state, { throwAttach: 's2' })
      const sp = mockSessionPersistence(state.sessions)
      const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({
        [alpha]: wsEntry(alpha, 'alpha', ['s1', 's2']),
        [beta]: wsEntry(beta, 'beta', ['s3']),
      }) })
      assert.equal(out.error, null)
      assert.deepEqual(registry.calls.attach, [`${alpha}#s1`, `${alpha}#s2`, `${beta}#s3`], 's2 抛错后 s3 与 beta 仍继续')
      assert.ok(out.registryWarnings.some((w) => w.includes('s2') && w.includes('attach failed')), 'attach 错误进 warning')
      assert.equal(out.registryApplied.sessions, 2, '仅两条成功')
      assert.deepEqual(state.byPath.get(alpha).sessionIds, ['s1'], '失败的 s2 未入表')
      assert.deepEqual(state.byPath.get(beta).sessionIds, ['s3'])
    }
    // 6e archiveSession 抛错 → warning；pin 循环与 workspace 处理照常
    {
      const alpha = await freshDir('s6e/projects/alpha')
      const state = { byPath: new Map(), sessions: new Set(['sa', 'sp', 's1']), activeSessions: new Set(), archived: new Set(), pinned: new Set() }
      const registry = mockRegistry(state, { throwArchive: true })
      const sp = mockSessionPersistence(state.sessions)
      const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({
        [alpha]: wsEntry(alpha, 'Alpha', ['s1']),
      }, { archivedSessionIds: ['sa'], pinnedSessionIds: ['sp'] }) })
      assert.equal(out.error, null)
      assert.ok(out.registryWarnings.some((w) => w.includes('sa') && w.includes('archive failed')), 'archive 错误进 warning')
      assert.deepEqual(registry.calls.archive, ['sa'], 'archive 仍被尝试')
      assert.deepEqual(registry.calls.pin, ['sp'], '后续 pin 循环继续')
      assert.deepEqual(registry.calls.create, [alpha], 'workspace 处理继续')
      assert.deepEqual(registry.calls.attach, [`${alpha}#s1`])
      assert.equal(out.registryApplied.pinned, 1)
    }
    // 6f pinSession 抛错 → warning；workspace 处理照常
    {
      const alpha = await freshDir('s6f/projects/alpha')
      const state = { byPath: new Map(), sessions: new Set(['sp', 's1']), activeSessions: new Set(), archived: new Set(), pinned: new Set() }
      const registry = mockRegistry(state, { throwPin: true })
      const sp = mockSessionPersistence(state.sessions)
      const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({
        [alpha]: wsEntry(alpha, 'Alpha', ['s1']),
      }, { pinnedSessionIds: ['sp'] }) })
      assert.equal(out.error, null)
      assert.ok(out.registryWarnings.some((w) => w.includes('sp') && w.includes('pin failed')), 'pin 错误进 warning')
      assert.deepEqual(registry.calls.pin, ['sp'], 'pin 仍被尝试')
      assert.deepEqual(registry.calls.create, [alpha], 'workspace 处理继续')
      assert.deepEqual(registry.calls.attach, [`${alpha}#s1`])
    }
    console.log('场景6 R5 逐 API 故障注入（resolve/create/stat/attach/archive/pin） PASS')
  }

  // ---------- 场景 6g-6i：R5 v1.2.2 补充——attach/archive/pin「首项失败、次项成功」 ----------
  {
    // 6g attachSession：第一个会话 id 抛错 → 错误进 warning，第二个仍 attach（计数 +1），循环继续
    {
      const alpha = await freshDir('s6g/projects/alpha')
      const state = {
        byPath: new Map([[alpha, { id: 'ws-a', path: alpha, title: 'alpha', sessionIds: [] }]]),
        sessions: new Set(['s1', 's2']),
        activeSessions: new Set(), archived: new Set(), pinned: new Set(),
      }
      const registry = mockRegistry(state, { throwAttach: 's1' })
      const sp = mockSessionPersistence(state.sessions)
      const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({
        [alpha]: wsEntry(alpha, 'alpha', ['s1', 's2']),
      }) })
      assert.equal(out.error, null)
      assert.deepEqual(registry.calls.attach, [`${alpha}#s1`, `${alpha}#s2`], '首项 s1 抛错后 s2 仍被调用（计数 +1）')
      assert.ok(out.registryWarnings.some((w) => w.includes('s1') && w.includes('attach failed')), '首项错误进 warnings')
      assert.equal(out.registryApplied.sessions, 1, '仅次项成功计数')
      assert.deepEqual(state.byPath.get(alpha).sessionIds, ['s2'], '失败的 s1 未入表，s2 已入表')
    }
    // 6h archiveSession：第一个 id 抛错 → warning，第二个仍 archive，归档循环不中断
    {
      const state = emptyState()
      state.sessions = new Set(['sa1', 'sa2'])
      const registry = mockRegistry(state, { throwArchive: (id) => id === 'sa1' })
      const sp = mockSessionPersistence(state.sessions)
      const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({}, { archivedSessionIds: ['sa1', 'sa2'] }) })
      assert.equal(out.error, null)
      assert.deepEqual(registry.calls.archive, ['sa1', 'sa2'], '首项 sa1 抛错后 sa2 仍被调用（计数 +1）')
      assert.ok(out.registryWarnings.some((w) => w.includes('sa1') && w.includes('archive failed')), '首项错误进 warnings')
      assert.equal(out.registryApplied.archived, 1, '仅次项成功计数')
      assert.equal(state.archived.has('sa2'), true)
      assert.equal(state.archived.has('sa1'), false)
    }
    // 6i pinSession：第一个 id 抛错 → warning，第二个仍 pin，置顶循环不中断
    {
      const state = emptyState()
      state.sessions = new Set(['sp1', 'sp2'])
      const registry = mockRegistry(state, { throwPin: (id) => id === 'sp1' })
      const sp = mockSessionPersistence(state.sessions)
      const out = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: doc({}, { pinnedSessionIds: ['sp1', 'sp2'] }) })
      assert.equal(out.error, null)
      assert.deepEqual(registry.calls.pin, ['sp1', 'sp2'], '首项 sp1 抛错后 sp2 仍被调用（计数 +1）')
      assert.ok(out.registryWarnings.some((w) => w.includes('sp1') && w.includes('pin failed')), '首项错误进 warnings')
      assert.equal(out.registryApplied.pinned, 1, '仅次项成功计数')
      assert.equal(state.pinned.has('sp2'), true)
      assert.equal(state.pinned.has('sp1'), false)
    }
    console.log('场景6g-6i attach/archive/pin 首项失败次项继续 PASS')
  }

  // ---------- 场景 7：R4 engine 全链路只映射一次 ----------
  // pathRemap 故意取 to=from+'/local'（二次映射会产生 /local/local 并触发目录不存在警告）。
  {
    const cycleHome = path.join(home, 's7-engine')
    const remapFrom = path.join(home, 's7/projects')
    const realDir = await freshDir('s7/projects/local/alpha')
    const state = emptyState()
    state.sessions = new Set(['s1'])
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    const engine = createEngine({ rowConfig: {
      dshHome: cycleHome, deviceName: 's7', listenPort: 0, token: 't', settleSec: 0,
      pathRemap: [{ from: remapFrom, to: path.join(remapFrom, 'local') }],
    } })
    engine.setServices({ workspaceRegistry: registry, sessionPersistence: sp })
    try {
      await engine.init()
      await writeStaging(path.join(cycleHome, 'plugin-sync/staging'), doc({
        [path.join(remapFrom, 'alpha')]: wsEntry(path.join(remapFrom, 'alpha'), 'Alpha', ['s1']),
      }))
      const summary = await engine.runCycle()
      assert.equal(summary.workspaceWriteMode, 'registry')
      assert.deepEqual(registry.calls.resolveByPath, [realDir], 'R4：resolveByPath 收到映射一次后的最终路径')
      assert.deepEqual(registry.calls.create, [realDir])
      assert.ok(!registry.calls.resolveByPath.some((p) => p.includes('/local/local')), '无二次映射产物')
      assert.deepEqual(summary.registryWarnings, [], '二次映射必产生目录不存在警告——零警告佐证只映射一次')
      assert.equal(summary.registryApplied.workspaces, 1)
      assert.equal(summary.registryApplied.sessions, 1)
    } finally {
      await engine.close()
    }
    console.log('场景7 R4 engine 全链路路径只映射一次 PASS')
  }

  // ---------- 场景 8：R3 engine 门禁——坏文档零 mutation ----------
  {
    // 8a 缺信封 → mergeWorkspace 整体拒绝（merged:false）→ 不应用
    const cycleHome = path.join(home, 's8-engine-envelope')
    const registry = mockRegistry(emptyState())
    const sp = mockSessionPersistence(new Set(['s1']))
    const engine = createEngine({ rowConfig: { dshHome: cycleHome, deviceName: 's8', listenPort: 0, token: 't', settleSec: 0 } })
    engine.setServices({ workspaceRegistry: registry, sessionPersistence: sp })
    try {
      await engine.init()
      const noEnvelope = doc({ '/nowhere/ws': wsEntry('/nowhere/ws', 'W', ['s1']) })
      delete noEnvelope.unit
      await writeStaging(path.join(cycleHome, 'plugin-sync/staging'), noEnvelope)
      const summary = await engine.runCycle()
      assert.equal(summary.workspaceWriteMode, 'registry', '服务可用，但应用被门禁拦截')
      assert.equal(summary.registryApplied, null, 'merged:false → 不应用')
      zeroMutationCalls(registry, sp, '8a')
      assert.ok(summary.errors.some((m) => m.includes('信封')), '合并中止错误可见')
      assert.ok(summary.warnings.some((m) => m.includes('零 mutation')), '跳过原因可见')
    } finally {
      await engine.close()
    }

    // 8b 信封合法但条目非法（缺 createdAt）→ merged:true 但合并 errors 非空 → 仍零 mutation
    const cycleHome2 = path.join(home, 's8-engine-entry')
    const proj = await freshDir('s8-entry/projects/alpha')
    const registry2 = mockRegistry(emptyState())
    const sp2 = mockSessionPersistence(new Set())
    const engine2 = createEngine({ rowConfig: { dshHome: cycleHome2, deviceName: 's8b', listenPort: 0, token: 't', settleSec: 0 } })
    engine2.setServices({ workspaceRegistry: registry2, sessionPersistence: sp2 })
    try {
      await engine2.init()
      // 宿主已有合法文件：让合并走「宽容跳过坏条目」路径（merged:true + errors 非空）
      await writeHostWorkspace(cycleHome2, doc({}))
      await writeStaging(path.join(cycleHome2, 'plugin-sync/staging'), doc({
        [proj]: { path: proj, title: 'Alpha', sessionIds: [], updatedAt: '2026-01-02T00:00:00Z' },
      }))
      const summary = await engine2.runCycle()
      assert.equal(summary.merged, 1, '合并本身成功')
      assert.equal(summary.registryApplied, null, 'errors 非空 → 不应用')
      zeroMutationCalls(registry2, sp2, '8b')
      assert.ok(summary.errors.some((m) => m.includes('createdAt')), '合并错误保留可见')
      assert.ok(summary.warnings.some((m) => m.includes('零 mutation')), '跳过原因可见')
    } finally {
      await engine2.close()
    }
    console.log('场景8 R3 engine 门禁（merged:false / errors 非空 → 零 mutation） PASS')
  }

  // ---------- 场景 9：R1 注入契约与降级（entry 级 + setServices 服务校验） ----------
  {
    // 9a mock ctx.inject 以 Cordis 契约 (injectCtx, undefined) 调用回调 → registry 模式；卸载清理回退 proposal
    const entryHome = path.join(home, 's9-entry')
    const proj = await freshDir('s9-entry/projects/alpha')
    const state = emptyState()
    state.sessions = new Set(['s1'])
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    const registered = new Map()
    const disposers = []
    const injectCalls = []
    let injectDispose = null
    const ctx = {
      inject(names, cb) {
        injectCalls.push(names)
        const dispose = cb({ workspaceRegistry: registry, sessionPersistence: sp }, undefined)
        if (typeof dispose === 'function') injectDispose = dispose
      },
      effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
      tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
    }
    applyPlugin(ctx, { dshHome: entryHome, listenPort: 0, token: 'entry-token', settleSec: 0 })
    const statusTool = registered.get('dsh_sync_status')
    const syncTool = registered.get('dsh_sync_now')
    try {
      assert.deepEqual(injectCalls, [['workspaceRegistry', 'sessionPersistence']], '只注入 registry 两服务')
      assert.equal((await statusTool.execute()).workspaceWriteMode, 'registry', 'R1：回调参数即注入 Context，服务立即可用')
      assert.equal((await statusTool.execute()).registryAvailable, true)
      await writeStaging(path.join(entryHome, 'plugin-sync/staging'), doc({ [proj]: wsEntry(proj, 'Alpha', ['s1']) }))
      const summary = await syncTool.execute()
      assert.equal(summary.workspaceWriteMode, 'registry')
      assert.deepEqual(summary.registryApplied, { workspaces: 1, created: 1, sessions: 1, archived: 0, pinned: 0 })
    } finally {
      // 卸载顺序模拟 Cordis：先 effect 清理（关引擎），再 inject 清理（setServices(null)）
      for (const dispose of disposers.reverse()) await dispose()
      if (injectDispose) await injectDispose()
    }
    const after = await statusTool.execute()
    assert.equal(after.registryAvailable, false, '注入清理后立即回退 proposal（无需等下一轮）')
    assert.equal(after.workspaceWriteMode, 'proposal')
    console.log('场景9a R1 入口注入契约（(injectCtx, config) → registry 模式 / 清理 → proposal） PASS')

    // 9b 宿主无 inject → proposal，工具照常可用
    {
      const noInjectHome = path.join(home, 's9-noinject')
      const registered2 = new Map()
      const disposers2 = []
      const ctx2 = {
        effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers2.push(dispose); return dispose },
        tools: { register(tool) { registered2.set(tool.name, tool); return () => registered2.delete(tool.name) } },
      }
      applyPlugin(ctx2, { dshHome: noInjectHome, listenPort: 0, token: 't', settleSec: 0 })
      try {
        const st = await registered2.get('dsh_sync_status').execute()
        assert.equal(st.workspaceWriteMode, 'proposal', '不注入回退 proposal')
        assert.equal(st.registryAvailable, false)
        const sync = await registered2.get('dsh_sync_now').execute()
        assert.equal(sync.workspaceWriteMode, 'proposal')
      } finally {
        for (const dispose of disposers2.reverse()) await dispose()
      }
    }

    // 9c 注入抛错 → proposal，不向上抛
    {
      const throwHome = path.join(home, 's9-throwinject')
      const registered3 = new Map()
      const disposers3 = []
      const ctx3 = {
        inject() { throw new Error('host refuses injection') },
        effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers3.push(dispose); return dispose },
        tools: { register(tool) { registered3.set(tool.name, tool); return () => registered3.delete(tool.name) } },
      }
      applyPlugin(ctx3, { dshHome: throwHome, listenPort: 0, token: 't', settleSec: 0 })
      try {
        const st = await registered3.get('dsh_sync_status').execute()
        assert.equal(st.workspaceWriteMode, 'proposal', '注入抛错不向上抛，回退 proposal')
        assert.equal(st.registryAvailable, false)
      } finally {
        for (const dispose of disposers3.reverse()) await dispose()
      }
    }

    // 9d 服务可用性按契约方法集判定（NIT）：缺任一方法/空对象 → proposal
    {
      const svcHome = path.join(home, 's9-services')
      const engine = createEngine({ rowConfig: { dshHome: svcHome, deviceName: 's9', listenPort: 0, token: 't', settleSec: 0 } })
      try {
        await engine.init()
        const full = mockRegistry(emptyState())
        const noList = { create: full.create, resolveByPath: full.resolveByPath, archiveSession: full.archiveSession, pinSession: full.pinSession }
        engine.setServices({ workspaceRegistry: noList, sessionPersistence: { stat: async () => undefined } })
        let st = await engine.status()
        assert.equal(st.registryAvailable, false, '缺 list 的 registry 视为不可用')
        assert.equal(st.workspaceWriteMode, 'proposal')
        engine.setServices({ workspaceRegistry: {}, sessionPersistence: {} })
        st = await engine.status()
        assert.equal(st.registryAvailable, false, '空对象同样不可用')
        engine.setServices({ workspaceRegistry: full, sessionPersistence: { stat: async () => ({ id: 'x' }) } })
        st = await engine.status()
        assert.equal(st.registryAvailable, true, '方法齐全才可用')
        assert.equal(st.workspaceWriteMode, 'registry')
        engine.setServices(null)
        st = await engine.status()
        assert.equal(st.registryAvailable, false, 'setServices(null) 立即回退')
        assert.equal(st.workspaceWriteMode, 'proposal')
      } finally {
        await engine.close()
      }
      assert.equal(registryServicesUsable(null, null), false)
      assert.equal(registryServicesUsable({ create() {}, resolveByPath() {}, list() {}, archiveSession() {}, pinSession() {} }, {}), false, '缺 stat 不可用')
    }
    console.log('场景9 R1 注入降级（无 inject/抛错/服务校验） PASS')
  }

  // ---------- 场景 10：engine registry 正常路径 + 幂等 + 状态 + stat 抛错引擎级可见 ----------
  {
    const cycleHome = path.join(home, 's10-engine')
    const proj = await freshDir('s10/projects/alpha')
    const state = emptyState()
    state.sessions = new Set(['s1', 'sa'])
    state.activeSessions = new Set(['sa'])
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    const engine = createEngine({ rowConfig: { dshHome: cycleHome, deviceName: 's10', listenPort: 0, token: 't', settleSec: 0 } })
    engine.setServices({ workspaceRegistry: registry, sessionPersistence: sp })
    try {
      await engine.init()
      await writeStaging(path.join(cycleHome, 'plugin-sync/staging'), doc({
        [proj]: wsEntry(proj, 'Alpha', ['s1']),
      }, { archivedSessionIds: ['sa'] }))
      const summary = await engine.runCycle()
      assert.equal(summary.workspaceWriteMode, 'registry', 'engine 在 apply 后走 registry 应用')
      assert.equal(summary.registryAvailable, true)
      assert.deepEqual(summary.registryApplied, { workspaces: 1, created: 1, sessions: 1, archived: 0, pinned: 0 }, 'active 会话归档失败只留 warning')
      assert.ok(summary.registryWarnings.some((w) => w.includes('sa')), 'active 归档 warning 可见')
      assert.ok(!summary.warnings.some((w) => w.includes('建议')), 'registry 模式不再提示待人工应用')
      assert.deepEqual(registry.calls.setTitle, [], 'R2：宿主 setTitle 永不被插件调用')
      assert.equal(registry.calls.create.length, 1)
      const second = await engine.runCycle()
      assert.equal(second.registryApplied.created, 0, '第二轮零 create（幂等）')
      assert.equal(second.registryApplied.sessions, 0, '第二轮零 attach')
      assert.equal(registry.calls.create.length, 1, '幂等：create 不重复')
      const status = await engine.status()
      assert.equal(status.workspaceWriteMode, 'registry')
      assert.equal(status.registryAvailable, true)
      assert.deepEqual(status.registryLastApplied, { at: second.at, workspaces: 1, created: 0, sessions: 0, archived: 0, pinned: 0 })
      assert.deepEqual(await fsp.readdir(path.join(cycleHome, 'storages')).catch(() => []), [], 'registry 模式下宿主 storages 仍零写入')
      assert.equal(summary.proposalPending, true, 'proposal 文件仍生成（审计/降级用）')
    } finally {
      await engine.close()
    }

    // stat 抛错的引擎级表现：单条失败全部转 registryWarnings，cycle 正常完成
    const statHome = path.join(home, 's10-engine-stat')
    const proj3 = await freshDir('s10-stat/projects/alpha')
    const registry3 = mockRegistry(emptyState())
    const engine3 = createEngine({ rowConfig: { dshHome: statHome, deviceName: 's10b', listenPort: 0, token: 't', settleSec: 0 } })
    engine3.setServices({
      workspaceRegistry: registry3,
      sessionPersistence: { async stat() { throw new Error('stat exploded') }, async list() { return [] } },
    })
    try {
      await engine3.init()
      await writeStaging(path.join(statHome, 'plugin-sync/staging'), doc({
        [proj3]: wsEntry(proj3, 'Alpha', ['s1']),
      }, { archivedSessionIds: ['sa2'] }))
      const summary = await engine3.runCycle()
      assert.equal(summary.workspaceWriteMode, 'registry')
      assert.ok(summary.registryWarnings.length >= 2, 'stat 抛错：归档与附加各一条 warning')
      assert.ok(summary.registryWarnings.every((w) => w.startsWith('registry:')), 'warning 统一前缀')
      assert.deepEqual(registry3.calls.create, [proj3], 'stat 抛错不阻塞 workspace 级 create')
      const status = await engine3.status()
      assert.deepEqual(status.registryWarnings, summary.registryWarnings)
    } finally {
      await engine3.close()
    }
    console.log('场景10 engine registry 正常路径/幂等/状态/stat 抛错 PASS')
  }

  // ---------- 场景 11：v1.2.2 BLOCKER 回归——「先坏后好」双 peer，整轮零 registry mutation ----------
  // peer1 拉回缺 createdAt 的坏条目（合并宽容跳过：merged:true + errors）→ peer2 拉回合法
  // 文档（合并成功）。旧行为：最后一次成功合并覆盖失败标记，registry 照常应用（BLOCKER）；
  // 新行为：workspaceMergeFailed 本轮累计不清除，registry 四类 API 零调用，peer1 错误保留。
  {
    const cycleHome = path.join(home, 's11-engine')
    await writeHostWorkspace(cycleHome, doc({}))
    const goodDir = await freshDir('s11/projects/good')
    const badId = 'ws-bad-entry'
    const badBytes = Buffer.from(JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [badId], defaultWorkspaceId: '', archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: { [badId]: { path: '/nowhere/bad', title: 'Bad', sessionIds: [], updatedAt: '2026-01-02T00:00:00Z' } } },
    }))
    const goodBytes = Buffer.from(JSON.stringify(doc({ [goodDir]: wsEntry(goodDir, 'Good', ['s1']) })))
    const previousFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === 'PUT') return Response.json({ ok: true })
      const parsed = new URL(url)
      const bytes = parsed.hostname === 'peer1-bad' ? badBytes : goodBytes
      if (parsed.pathname === '/v1/index') return Response.json({ files: { 'workspace/workspace.json': { sha1: sha1(bytes), size: bytes.length } } })
      return new Response(bytes)
    }
    const state = emptyState()
    state.sessions = new Set(['s1'])
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    const engine = createEngine({ rowConfig: {
      dshHome: cycleHome, deviceName: 's11', listenPort: 0, token: 't', settleSec: 0,
      peers: [{ name: 'peer1', url: 'http://peer1-bad' }, { name: 'peer2', url: 'http://peer2-good' }],
    } })
    engine.setServices({ workspaceRegistry: registry, sessionPersistence: sp })
    try {
      await engine.init()
      const summary = await engine.runCycle()
      assert.equal(summary.workspaceWriteMode, 'registry')
      assert.equal(summary.merged, 3, '三次合并全部执行（初始 + peer1 + peer2），peer2 合并成功计入 merged')
      assert.equal(summary.registryApplied, null, '先坏后好：registry 整轮零 mutation')
      assert.ok(summary.registrySkippedReason?.includes('零 mutation'), 'registrySkippedReason 写明跳过原因')
      zeroMutationCalls(registry, sp, '先坏后好')
      assert.ok(summary.errors.some((m) => m.includes(badId) && m.includes('createdAt')), 'peer1 的合并错误保留（不被后续成功合并覆盖）')
      assert.ok(summary.warnings.some((m) => m.includes('零 mutation')), '跳过警告本轮可见')
      const status = await engine.status()
      assert.equal(status.registrySkippedReason, summary.registrySkippedReason, 'status 暴露 registrySkippedReason')
    } finally {
      await engine.close()
      globalThis.fetch = previousFetch
    }
    console.log('场景11 v1.2.2 先坏后好（peer1 坏条目 → peer2 成功 → registry 零 mutation、errors 保留） PASS')
  }

  // ---------- 场景 12：v1.2.2 NIT2——带 archived/pinned 的重复轮幂等 ----------
  // applier 没有「查询已归档/已置顶」的宿主 API，每轮对远端集合重新调用 archive/pin；
  // 宿主对已归档/已置顶的重复调用是 no-op。archived/pinned 计数口径 = 成功调用的 API 次数（含 no-op）。
  {
    const alpha = await freshDir('s12/projects/alpha')
    const state = emptyState()
    state.sessions = new Set(['s1', 'sa', 'sp'])
    state.archived = new Set(['sa'])
    const registry = mockRegistry(state)
    const sp = mockSessionPersistence(state.sessions)
    const docValue = doc({ [alpha]: wsEntry(alpha, 'alpha', ['s1']) }, { archivedSessionIds: ['sa'], pinnedSessionIds: ['sp'] })
    const first = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: docValue })
    assert.deepEqual(first.registryApplied, { workspaces: 1, created: 1, sessions: 1, archived: 1, pinned: 1 }, '首轮全量应用')
    assert.deepEqual(first.registryWarnings, [])
    const firstCalls = structuredClone(registry.calls)
    const second = await applyRegistryIndex({ registry, sessionPersistence: sp, doc: docValue })
    assert.equal(second.error, null)
    assert.deepEqual(second.registryWarnings, [], 'no-op 重复调用不产生警告')
    assert.equal(second.registryApplied.created, 0, '第二轮零 create')
    assert.equal(second.registryApplied.sessions, 0, '第二轮零 attach')
    assert.equal(second.registryApplied.workspaces, 1, '第二轮仅确认工作区存在')
    assert.equal(second.registryApplied.archived, 1, '已归档会话：宿主 no-op，仍调用并计成功（口径=成功调用次数）')
    assert.equal(second.registryApplied.pinned, 1, '已置顶会话：同上')
    assert.deepEqual(registry.calls.create, firstCalls.create, 'create 调用不重复')
    assert.deepEqual(registry.calls.attach, firstCalls.attach, 'attach 调用不重复')
    assert.deepEqual(registry.calls.archive, [...firstCalls.archive, 'sa'], 'archive 每轮重新调用（宿主 no-op）')
    assert.deepEqual(registry.calls.pin, [...firstCalls.pin, 'sp'], 'pin 每轮重新调用（宿主 no-op）')
    assert.equal(state.archived.has('sa'), true, '归档集合只加不减')
    assert.equal(state.pinned.has('sp'), true, '置顶集合只加不减')
    console.log('场景12 v1.2.2 带 archived/pinned 的重复轮幂等（宿主 no-op 语义） PASS')
  }

  // ---- v1.3.0：映射只在 registry applier 使用路径时做一次（合并阶段不映射） ----
  {
    const quiet = { info: async () => {}, warn: async () => {}, error: async () => {} }
    const rawPath = 'C:\\Users\\peer'
    const mappedPath = path.join(home, 'mapped-workspace')
    await fsp.mkdir(mappedPath, { recursive: true })
    const state = {
      byPath: new Map([[mappedPath, { id: 'w1', path: mappedPath, title: 't', sessionIds: [] }]]),
      sessions: new Set(['s1', 's2']),
      archived: new Set(),
      pinned: new Set(),
    }
    const registry = mockRegistry(state)
    const persistence = mockSessionPersistence(state.sessions)
    const d = doc({ w1: { path: rawPath, title: 't', sessionIds: ['s1', 's2'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } })
    const remap = [{ from: 'C:\\Users\\peer', to: mappedPath }]
    const first = await applyRegistryIndex({ registry, sessionPersistence: persistence, doc: d, pathRemap: remap, log: quiet })
    assert.equal(first.error, null)
    assert.deepEqual(registry.calls.resolveByPath, [mappedPath], 'resolveByPath 收到映射后的本机路径')
    assert.deepEqual(registry.calls.attach.sort(), [mappedPath + '#s1', mappedPath + '#s2'].sort(), '两个会话 attach')
    // 第二轮（同一原始 doc 再次应用）：映射结果稳定，无重复路径增长
    const second = await applyRegistryIndex({ registry, sessionPersistence: persistence, doc: d, pathRemap: remap, log: quiet })
    assert.deepEqual(registry.calls.resolveByPath, [mappedPath, mappedPath], '每轮映射结果一致，无重复后缀')
    assert.equal(second.registryApplied.sessions, 0, '第二轮不重复 attach')
    console.log('v1.3.0 映射只在 applier 应用一次（两轮稳定） PASS')

    // 合并阶段保留原始路径（不映射）
    const merged = mergeWorkspaces(doc({}), d, remap)
    assert.equal(merged.tables.workspaces.w1.path, rawPath, '合并阶段不做映射，派生文档保留原始路径')
    console.log('v1.3.0 合并阶段不映射 PASS')

    // 非法规则：整组禁用 + 零 mutation
    const state2 = { byPath: new Map(), sessions: new Set(['s1']), archived: new Set(), pinned: new Set() }
    const reg2 = mockRegistry(state2)
    const bad = await applyRegistryIndex({ registry: reg2, sessionPersistence: mockSessionPersistence(state2.sessions), doc: d, pathRemap: [{ from: 'relative/path', to: path.join(home, 'x') }], log: quiet })
    assert.equal(reg2.calls.create.length, 0, '非法规则 → 零 create')
    assert.equal(reg2.calls.attach.length, 0, '非法规则 → 零 attach')
    assert.ok(bad.registryWarnings.length > 0, '非法规则产生可见 warning')
    console.log('v1.3.0 非法映射规则整组禁用（零 mutation） PASS')

    // 链式规则：单次应用、确定性（不再是增长）
    const state3 = { byPath: new Map(), sessions: new Set(), archived: new Set(), pinned: new Set() }
    const reg3 = mockRegistry(state3)
    const srcRoot = path.join(home, 'proj', 'src')
    const midRoot = path.join(home, 'proj', 'local')
    const dstRoot = path.join(home, 'proj', 'archive')
    await fsp.mkdir(path.join(dstRoot, 'alpha'), { recursive: true })
    const chain = [{ from: srcRoot, to: midRoot }, { from: midRoot, to: dstRoot }]
    const d3 = doc({ w2: { path: path.join(srcRoot, 'alpha'), title: 't', sessionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } })
    await applyRegistryIndex({ registry: reg3, sessionPersistence: mockSessionPersistence(new Set()), doc: d3, pathRemap: chain, log: quiet })
    await applyRegistryIndex({ registry: reg3, sessionPersistence: mockSessionPersistence(new Set()), doc: d3, pathRemap: chain, log: quiet })
    const wantMapped = path.join(dstRoot, 'alpha')
    assert.deepEqual(reg3.calls.resolveByPath, [wantMapped, wantMapped], '链式规则单次应用、两轮结果稳定')
    console.log('v1.3.0 链式规则单次应用稳定 PASS')
  }

  // ---- v1.3.1：本机条目不再映射（防反馈膨胀）+ 规则/路径严格校验 ----
  {
    const quiet = { info: async () => {}, warn: async () => {}, error: async () => {} }
    // 1) 反馈循环：宿主已持久化的本机路径（真实存在）在三轮里都不得被再次映射
    const localDir = path.join(home, 'fb', 'a', 'local')
    await fsp.mkdir(localDir, { recursive: true })
    const seen = []
    const registry = {
      async resolveByPath(p) { seen.push(p); return { sessionIds: [], async attachSession() {} } },
      async create(p) { seen.push('create:' + p); return { sessionIds: [], async attachSession() {} } },
      async list() { return [] }, async archiveSession() {}, async pinSession() {},
    }
    const sp = { async stat() { return { header: {} } } }
    const d = doc({ w1: { path: localDir, title: 'local', sessionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } })
    const remap = [{ from: path.join(home, 'fb', 'a'), to: path.join(home, 'fb', 'a', 'local') }]
    for (let i = 0; i < 3; i++) await applyRegistryIndex({ registry, sessionPersistence: sp, doc: d, pathRemap: remap, log: quiet })
    assert.deepEqual(seen, [localDir, localDir, localDir], '本机已存在路径三轮都不映射（无 local/local 膨胀）')
    console.log('v1.3.1 反馈循环：本机路径不映射 PASS')

    // 2) 非法规则：archive/pin 也必须是零 mutation
    const st2 = emptyState()
    st2.sessions = new Set(['sa', 'sp'])
    const reg2 = mockRegistry(st2)
    const out2 = await applyRegistryIndex({ registry: reg2, sessionPersistence: mockSessionPersistence(st2.sessions), doc: doc({}, { archivedSessionIds: ['sa'], pinnedSessionIds: ['sp'] }), pathRemap: [{ from: 'relative', to: '/dest' }], log: quiet })
    assert.equal(reg2.calls.archive.length, 0, '非法规则 → 零 archive')
    assert.equal(reg2.calls.pin.length, 0, '非法规则 → 零 pin')
    assert.ok(out2.error && out2.error.includes('pathRemap'), '非法规则错误可见')
    console.log('v1.3.1 非法规则先于 archive/pin 拒绝（零 mutation） PASS')

    // 3) 空规则下非法 path（"."）也必须零 mutation
    const st3 = emptyState(); const reg3 = mockRegistry(st3)
    const out3 = await applyRegistryIndex({ registry: reg3, sessionPersistence: mockSessionPersistence(st3.sessions), doc: doc({ w1: { path: '.', title: 't', sessionIds: ['s1'], createdAt: 'x', updatedAt: 'x' } }), pathRemap: [], log: quiet })
    assert.equal(reg3.calls.resolveByPath.length + reg3.calls.create.length + reg3.calls.attach.length, 0, '非法 path 零 mutation')
    assert.ok(out3.registryWarnings.some((w) => w.includes('不合法')), '非法 path warning 可见')
    console.log('v1.3.1 非法 path（.）零 mutation PASS')

    // 4) UNC 规则被拒绝；盘符大小写不敏感
    const unc = normalizeRemapRules([{ from: '\\\\server\\share', to: '/dest' }])
    assert.ok(unc.errors.length > 0, 'UNC 规则被拒绝')
    const ciDir = path.join(home, 'ci', 'local', 'p')
    await fsp.mkdir(ciDir, { recursive: true })
    const st4 = emptyState(); const reg4 = mockRegistry(st4)
    await applyRegistryIndex({ registry: reg4, sessionPersistence: mockSessionPersistence(new Set()), doc: doc({ w2: { path: 'c:/Users/A/p', title: 't', sessionIds: [], createdAt: 'x', updatedAt: 'x' } }), pathRemap: [{ from: 'C:/Users/A', to: path.join(home, 'ci', 'local') }], log: quiet })
    assert.deepEqual(reg4.calls.resolveByPath, [ciDir], '盘符大小写不敏感匹配')
    console.log('v1.3.1 UNC 拒绝 + 盘符大小写不敏感 PASS')
  }

  // ---- v1.3.2：根路径拒绝、混合分隔符、stat 故障不当作“不存在” ----
  {
    const quiet = { info: async () => {}, warn: async () => {}, error: async () => {} }
    // 1) 根路径规则被拒绝
    const roots = normalizeRemapRules([{ from: '/', to: '/mapped' }])
    assert.ok(roots.errors.length > 0, 'from=/ 被拒绝')
    const roots2 = normalizeRemapRules([{ from: '/source', to: '/' }])
    assert.ok(roots2.errors.length > 0, 'to=/ 被拒绝')
    const roots3 = normalizeRemapRules([{ from: 'C:/', to: '/dest' }])
    assert.ok(roots3.errors.length > 0, 'from=C:/ 被拒绝')
    console.log('v1.3.2 根路径规则拒绝 PASS')

    // 2) 混合分隔符/UNC：POSIX 路径含反斜杠 → 不合法；映射结果复验
    assert.equal(isSafeAbsolutePath('/source/..\\outside'), false, 'POSIX 含反斜杠判为不合法')
    assert.equal(isSafeAbsolutePath('/\\server\\share'), false, '混合 UNC 判为不合法')
    const mappedBad = mapPathOnce('/source/..\\outside', [{ from: '/source', to: '/dest' }])
    assert.ok(mappedBad.errors.length > 0, '映射结果复验拒绝')
    console.log('v1.3.2 混合分隔符/UNC 拒绝 PASS')

    // 3) stat EIO 不当作不存在（不得回退到映射目标）
    const targetDir = path.join(home, 'v132', 'target')
    await fsp.mkdir(targetDir, { recursive: true })
    const st = emptyState()
    const reg = mockRegistry(st)
    const eio = new Error('io error'); eio.code = 'EIO'
    const out = await applyRegistryIndex({
      registry: reg,
      sessionPersistence: mockSessionPersistence(st.sessions),
      doc: doc({ w1: { path: '/source', title: 't', sessionIds: ['s1'], createdAt: 'x', updatedAt: 'x' } }),
      pathRemap: [{ from: '/source', to: targetDir }],
      statFn: async (p) => {
        if (p === '/source') throw eio
        return { isDirectory: () => true }
      },
      log: quiet,
    })
    assert.equal(reg.calls.create.length + reg.calls.attach.length, 0, 'stat EIO 不得继续 create/attach')
    assert.ok(out.registryWarnings.some((w) => w.includes('EIO')), 'EIO warning 可见')
    console.log('v1.3.2 stat EIO 不当作不存在 PASS')
  }

  console.log('ALL PASS（registry.test.mjs：R1-R5 + v1.2.2 覆盖，12 组场景）')
} finally {
  await fsp.rm(home, { recursive: true, force: true })
}
