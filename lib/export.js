import fsp from 'node:fs/promises'
import path from 'node:path'
import { sha1, listFiles, isQuiet } from './util.js'
import { guardedWrite, guardedMkdir } from './safe-writer.js'
import { readFileLimited, sha1FileLimited } from './limits.js'
import { MAX_WORKSPACE_BYTES, readWorkspaceStatus, serializeWorkspaceDoc, validateWorkspaceDoc } from './workspace.js'

const SESSION_FILE = /^session\.v4\.jsonl\.zst(d)?$/

async function copyIfChanged(stagingRoot, destRel, bytes, { dshHome, round } = {}) {
  const dest = path.join(stagingRoot, destRel)
  let destStat
  try {
    destStat = await fsp.stat(dest)
  } catch {
    destStat = null
  }
  if (destStat) {
    if (destStat.size === bytes.length) {
      if (sha1(bytes) === await sha1FileLimited(dest)) return false
    }
  }
  const written = await guardedWrite({ root: stagingRoot, rel: destRel, bytes, dshHome, round })
  if (!written.ok) throw written.error
  return true
}

async function exportDir(dshHome, stagingRoot, opts) {
  const { srcSub, destPrefix, quiet, settleSec, now, filter, exported, round } = opts
  const root = path.join(dshHome, srcSub)
  for (const { rel, full } of await listFiles(root)) {
    if (filter && !filter(rel)) continue
    if (quiet) {
      let st
      try {
        st = await fsp.stat(full)
      } catch {
        continue
      }
      if (!isQuiet(st.mtimeMs, settleSec, now)) continue
    }
    const bytes = await readFileLimited(full)
    if (await copyIfChanged(stagingRoot, `${destPrefix}/${rel}`, bytes, { dshHome, round })) {
      exported.push(`${destPrefix}/${rel}`)
    }
  }
}

export async function exportAll(dshHome, stagingRoot, settings, { skipWorkspace = false, round } = {}) {
  const settleSec = settings.settleSec ?? 120
  const now = Date.now()
  const exported = []
  // v6：目录创建经 guardedMkdir（staging 根是符号链接/storages 危险配置时拒绝导出）。
  const made = await guardedMkdir(stagingRoot, { dshHome, round })
  if (!made.ok) throw made.error

  await exportDir(dshHome, stagingRoot, {
    srcSub: 'sessions',
    destPrefix: 'sessions',
    quiet: true,
    settleSec,
    now,
    filter: (rel) => SESSION_FILE.test(path.basename(rel)),
    exported,
    round,
  })

  await exportDir(dshHome, stagingRoot, {
    srcSub: 'attachments',
    destPrefix: 'attachments',
    quiet: false,
    settleSec,
    now,
    exported,
    round,
  })

  await exportDir(dshHome, stagingRoot, {
    srcSub: path.join('storages', 'session_projcache', 'sessions'),
    destPrefix: 'projcache/sessions',
    quiet: true,
    settleSec,
    now,
    filter: (rel) => rel.endsWith('.json'),
    exported,
    round,
  })

  await exportDir(dshHome, stagingRoot, {
    srcSub: 'profiles',
    destPrefix: 'config',
    quiet: false,
    settleSec,
    now,
    filter: (rel) => {
      const parts = rel.split('/')
      return parts.length === 2 && parts[1] === 'cordis.patch.yml'
    },
    exported,
    round,
  })

  // 引擎的工作区导出由合并步骤负责，保留上一周期的staging/建议并集。
  if (skipWorkspace) return exported
  const wsDest = path.join(stagingRoot, 'workspace', 'workspace.json')
  let workspace
  // 宿主文件只读参考；使用32MiB有界三态读取，绝不打开为写模式。
  const source = await readWorkspaceStatus(path.join(dshHome, 'storages', 'workspace.json'))
  if (source.state !== 'missing' && source.state !== 'ok') {
    throw new Error(`本地 workspace.json ${source.state === 'parse-error' ? 'JSON 解析失败' : '读取失败'}：${source.error?.message || source.error}`)
  }
  if (source.state === 'ok') {
    const errors = validateWorkspaceDoc(source.value, { requireEnvelope: true })
    if (errors.length) throw new Error(`本地 workspace.json 校验失败：${errors.join('; ')}`)
    workspace = source.value
  }
  if (workspace !== undefined) {
    const bytes = serializeWorkspaceDoc(workspace)
    let previous
    try { previous = await readFileLimited(wsDest, MAX_WORKSPACE_BYTES) }
    catch (e) { if (e?.code !== 'ENOENT') throw e }
    if (!previous?.equals(bytes)) {
      const written = await guardedWrite({ root: stagingRoot, rel: 'workspace/workspace.json', bytes, dshHome, round })
      if (!written.ok) throw written.error
      exported.push('workspace/workspace.json')
    }
  }

  return exported
}
