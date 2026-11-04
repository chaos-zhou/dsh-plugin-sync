import assert from 'node:assert'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { createEngine } from '../lib/engine.js'

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function backdate(file, hoursAgo = 1) {
  const t = new Date(Date.now() - hoursAgo * 3600 * 1000)
  fs.utimesSync(file, t, t)
}

async function writeFileRel(root, rel, content) {
  const full = path.join(root, rel)
  await fsp.mkdir(path.dirname(full), { recursive: true })
  await fsp.writeFile(full, content)
  return full
}

async function listConflicts(home, prefix) {
  const dir = path.join(home, 'plugin-sync', 'conflicts')
  try {
    return (await fsp.readdir(dir)).filter((f) => f.startsWith(prefix))
  } catch {
    return []
  }
}

const TOKEN = 'test-token-0123456789abcdef'
const SESS_A = 'sessions/projX/sess-aaa/session.v4.jsonl.zstd'
const SESS_B = 'sessions/projY/sess-bbb/session.v4.jsonl.zstd'
const ATT_A = 'attachments/img.bin'

const contentA1 = Buffer.from('session A v1 — hello from device A\n'.repeat(40))
const contentB1 = Buffer.from('session B v1 — hello from device B\n'.repeat(40))
const contentA2 = Buffer.from('session A v2 — edited on A\n'.repeat(40))
const contentB2 = Buffer.from('session B v2 — edited on B\n'.repeat(40))

function wsFor(sessionId, title, updatedAt) {
  return {
    unit: 'default',
    global: {
      workspaceIds: ['ws1'],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: 'ws1',
    },
    tables: {
      workspaces: {
        ws1: {
          path: `/tmp/proj-${title.toLowerCase()}`,
          title,
          sessionIds: [sessionId],
          createdAt: 1000,
          updatedAt,
        },
      },
    },
  }
}

async function main() {
  const homeA = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-a-'))
  const homeB = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-b-'))
  const portA = await freePort()
  const portB = await freePort()

  const engineA = createEngine({
    rowConfig: {
      deviceName: 'A',
      role: 'peer',
      listenPort: portA,
      token: TOKEN,
      peers: [{ name: 'B', url: `http://127.0.0.1:${portB}`, token: TOKEN }],
      intervalSec: 300,
      settleSec: 60,
      dshHome: homeA,
    },
  })
  const engineB = createEngine({
    rowConfig: {
      deviceName: 'B',
      role: 'peer',
      listenPort: portB,
      token: TOKEN,
      peers: [{ name: 'A', url: `http://127.0.0.1:${portA}`, token: TOKEN }],
      intervalSec: 300,
      settleSec: 60,
      dshHome: homeB,
    },
  })

  try {
    await engineA.init()
    await engineB.init()
    assert.strictEqual(engineA.listening, portA, 'A 监听端口')
    assert.strictEqual(engineB.listening, portB, 'B 监听端口')

    const statusA = await engineA.status()
    assert.strictEqual(statusA.token, 'test-t' + '******', 'token 打码')
    assert.strictEqual(statusA.device, 'A')

    // ---------- 1. 初始同步：A 的会话/附件/workspaces 送到 B，workspace sessionIds 并集 ----------
    await writeFileRel(homeA, SESS_A, contentA1)
    backdate(path.join(homeA, SESS_A))
    await writeFileRel(homeA, ATT_A, Buffer.from('attachment-bytes-A'))
    await writeFileRel(homeA, path.join('storages', 'workspace.json'), JSON.stringify(wsFor('sess-aaa', 'ProjX', 2000)))

    await writeFileRel(homeB, SESS_B, contentB1)
    backdate(path.join(homeB, SESS_B))
    await writeFileRel(homeB, path.join('storages', 'workspace.json'), JSON.stringify(wsFor('sess-bbb', 'ProjY', 2500)))

    const rA1 = await engineA.runCycle()
    assert.ok(!rA1.skipped, 'cycle 未被跳过')
    assert.deepStrictEqual(rA1.errors, [], 'A 第一轮无错误')
    const rB1 = await engineB.runCycle()
    assert.deepStrictEqual(rB1.errors, [], 'B 第一轮无错误')

    const gotSessB = await fsp.readFile(path.join(homeB, SESS_A))
    assert.strictEqual(sha1(gotSessB), sha1(contentA1), 'B 的 dshHome 出现 A 的会话')
    const gotAttB = await fsp.readFile(path.join(homeB, ATT_A))
    assert.strictEqual(sha1(gotAttB), sha1(Buffer.from('attachment-bytes-A')), 'B 收到附件')

    const wsB = JSON.parse(await fsp.readFile(path.join(homeB, 'storages', 'workspace.json'), 'utf8'))
    assert.deepStrictEqual(
      [...wsB.tables.workspaces.ws1.sessionIds].sort(),
      ['sess-aaa', 'sess-bbb'],
      'B 的 workspace sessionIds 为并集',
    )

    // B 的会话也推给 A（B 第一轮推、A 第二轮拉）
    const rA2 = await engineA.runCycle()
    assert.deepStrictEqual(rA2.errors, [], 'A 第二轮无错误')
    const gotSessA = await fsp.readFile(path.join(homeA, SESS_B))
    assert.strictEqual(sha1(gotSessA), sha1(contentB1), 'A 收到 B 的会话')
    const wsA = JSON.parse(await fsp.readFile(path.join(homeA, 'storages', 'workspace.json'), 'utf8'))
    assert.deepStrictEqual(
      [...wsA.tables.workspaces.ws1.sessionIds].sort(),
      ['sess-aaa', 'sess-bbb'],
      'A 的 workspace sessionIds 为并集',
    )

    // ---------- 2. 冲突：两端都改同一会话 ----------
    await writeFileRel(homeA, SESS_A, contentA2)
    backdate(path.join(homeA, SESS_A))
    await writeFileRel(homeB, SESS_A, contentB2)
    backdate(path.join(homeB, SESS_A))

    const rA3 = await engineA.runCycle()
    assert.deepStrictEqual(rA3.errors, [], 'A 冲突轮无错误')
    const rB3 = await engineB.runCycle()
    assert.deepStrictEqual(rB3.errors, [], 'B 冲突轮无错误')

    const aNow = await fsp.readFile(path.join(homeA, SESS_A))
    assert.strictEqual(sha1(aNow), sha1(contentA2), 'A 保留本地版本')
    const bNow = await fsp.readFile(path.join(homeB, SESS_A))
    assert.strictEqual(sha1(bNow), sha1(contentB2), 'B 保留本地版本')

    // ---------- 3. 幂等：再各跑两轮，pulled/pushed 为 0，本地 sha1 不变 ----------
    const rA4 = await engineA.runCycle()
    assert.strictEqual(rA4.pulled, 0, `A 幂等轮 pulled=0 (got ${rA4.pulled})`)
    assert.strictEqual(rA4.pushed, 0, `A 幂等轮 pushed=0 (got ${rA4.pushed})`)
    const rB4 = await engineB.runCycle()
    assert.strictEqual(rB4.pulled, 0, `B 幂等轮 pulled=0 (got ${rB4.pulled})`)
    assert.strictEqual(rB4.pushed, 0, `B 幂等轮 pushed=0 (got ${rB4.pushed})`)
    assert.strictEqual(sha1(await fsp.readFile(path.join(homeA, SESS_A))), sha1(contentA2), 'A 本地 sha1 不变')
    assert.strictEqual(sha1(await fsp.readFile(path.join(homeB, SESS_A))), sha1(contentB2), 'B 本地 sha1 不变')

    const conflictPrefix = SESS_A.split('/').join('__') + '.conflict-'
    const conflictsA = await listConflicts(homeA, conflictPrefix)
    assert.ok(conflictsA.length >= 1, 'A 的 conflicts/ 出现对端副本')
    const aConflictSha = sha1(await fsp.readFile(path.join(homeA, 'plugin-sync', 'conflicts', conflictsA[0])))
    assert.strictEqual(aConflictSha, sha1(contentB2), 'A 的冲突副本内容为 B 的版本')

    const conflictsB = await listConflicts(homeB, conflictPrefix)
    assert.ok(conflictsB.length >= 1, 'B 的 conflicts/ 出现对端副本')
    const bConflictSha = sha1(await fsp.readFile(path.join(homeB, 'plugin-sync', 'conflicts', conflictsB[0])))
    assert.strictEqual(bConflictSha, sha1(contentA2), 'B 的冲突副本内容为 A 的版本')

    const rA5 = await engineA.runCycle()
    assert.strictEqual(rA5.pulled, 0, 'A 第二个幂等轮 pulled=0')
    assert.strictEqual(rA5.pushed, 0, 'A 第二个幂等轮 pushed=0')
    const rB5 = await engineB.runCycle()
    assert.strictEqual(rB5.pulled, 0, 'B 第二个幂等轮 pulled=0')
    assert.strictEqual(rB5.pushed, 0, 'B 第二个幂等轮 pushed=0')
    assert.strictEqual(sha1(await fsp.readFile(path.join(homeA, SESS_A))), sha1(contentA2), 'A 本地 sha1 仍不变')
    assert.strictEqual(sha1(await fsp.readFile(path.join(homeB, SESS_A))), sha1(contentB2), 'B 本地 sha1 仍不变')

    console.log('ALL PASS')
  } finally {
    await engineA.close()
    await engineB.close()
    await fsp.rm(homeA, { recursive: true, force: true })
    await fsp.rm(homeB, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('TEST FAILED:', e)
  process.exit(1)
})
