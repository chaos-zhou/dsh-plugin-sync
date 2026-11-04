import fsp from 'node:fs/promises'
import path from 'node:path'
import { sha1, sha1File, ensureDir, atomicWrite, listFiles } from './util.js'

export function createStore(dataDir) {
  const blobsDir = path.join(dataDir, 'store', 'blobs')

  const blobPath = (digest) => path.join(blobsDir, digest.slice(0, 2), digest)

  async function hasBlob(digest) {
    try {
      const st = await fsp.stat(blobPath(digest))
      return st.isFile()
    } catch {
      return false
    }
  }

  async function putBlob(buf, rel) {
    const digest = sha1(buf)
    const target = blobPath(digest)
    if (!(await hasBlob(digest))) {
      await ensureDir(path.dirname(target))
      await atomicWrite(target, buf)
    }
    return digest
  }

  async function getBlob(digest) {
    if (!/^[0-9a-f]{40}$/.test(digest)) return null
    try {
      return await fsp.readFile(blobPath(digest))
    } catch {
      return null
    }
  }

  async function stageBySha1(stagingRoot, rel, digest, dest) {
    const target = dest || path.join(stagingRoot, rel)
    if (await hasBlob(digest)) {
      const current = await sha1File(target).catch(() => null)
      if (current === digest) return false
      await ensureDir(path.dirname(target))
      await atomicWrite(target, await getBlob(digest))
      return true
    }
    return false
  }

  async function buildIndex(stagingRoot, memo) {
    const files = {}
    const list = await listFiles(stagingRoot)
    for (const { rel, full } of list) {
      try {
        const st = await fsp.stat(full)
        const key = `${st.size}:${st.mtimeMs}`
        let digest = memo?.get(key)
        if (!digest) {
          digest = await sha1File(full)
          memo?.set(key, digest)
        }
        files[rel] = { sha1: digest, size: st.size, mtime: st.mtimeMs }
      } catch {
        // 文件可能刚被删
      }
    }
    return files
  }

  return { blobsDir, blobPath, hasBlob, putBlob, getBlob, stageBySha1, buildIndex }
}
