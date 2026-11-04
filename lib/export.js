import fsp from 'node:fs/promises'
import path from 'node:path'
import { sha1File, atomicCopy, listFiles, isQuiet } from './util.js'

const SESSION_FILE = /^session\.v4\.jsonl\.zst(d)?$/

async function copyIfChanged(src, dest) {
  let destStat
  try {
    destStat = await fsp.stat(dest)
  } catch {
    destStat = null
  }
  if (destStat) {
    const srcStat = await fsp.stat(src)
    if (destStat.size === srcStat.size) {
      const [a, b] = await Promise.all([sha1File(src), sha1File(dest)])
      if (a === b) return false
    }
  }
  await atomicCopy(src, dest)
  return true
}

async function exportDir(dshHome, stagingRoot, opts) {
  const { srcSub, destPrefix, quiet, settleSec, now, filter, exported } = opts
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
    const dest = path.join(stagingRoot, destPrefix, rel)
    if (await copyIfChanged(full, dest)) exported.push(`${destPrefix}/${rel}`)
  }
}

export async function exportAll(dshHome, stagingRoot, settings) {
  const settleSec = settings.settleSec ?? 120
  const now = Date.now()
  const exported = []

  await exportDir(dshHome, stagingRoot, {
    srcSub: 'sessions',
    destPrefix: 'sessions',
    quiet: true,
    settleSec,
    now,
    filter: (rel) => SESSION_FILE.test(path.basename(rel)),
    exported,
  })

  await exportDir(dshHome, stagingRoot, {
    srcSub: 'attachments',
    destPrefix: 'attachments',
    quiet: false,
    settleSec,
    now,
    exported,
  })

  await exportDir(dshHome, stagingRoot, {
    srcSub: path.join('storages', 'session_projcache', 'sessions'),
    destPrefix: 'projcache/sessions',
    quiet: true,
    settleSec,
    now,
    filter: (rel) => rel.endsWith('.json'),
    exported,
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
  })

  const wsSrc = path.join(dshHome, 'storages', 'workspace.json')
  const wsDest = path.join(stagingRoot, 'workspace', 'workspace.json')
  try {
    if (await copyIfChanged(wsSrc, wsDest)) exported.push('workspace/workspace.json')
  } catch {
    // 本地还没有 workspace.json，交给合并步骤兜底
  }

  return exported
}
