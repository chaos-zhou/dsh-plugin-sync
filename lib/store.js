import fsp from 'node:fs/promises'
import path from 'node:path'
import { sha1, ensureDir, atomicWrite, listFiles } from './util.js'
import { MAX_BLOB_BYTES, readFileLimited, sha1FileLimited } from './limits.js'
import { MAX_WORKSPACE_BYTES } from './workspace.js'

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
    if (buf.length > MAX_BLOB_BYTES) throw new Error(`blob 超过 ${MAX_BLOB_BYTES} 字节上限`)
    const digest = sha1(buf)
    const target = blobPath(digest)
    if (!(await hasBlob(digest))) {
      await ensureDir(path.dirname(target))
      await atomicWrite(target, buf)
    }
    return digest
  }

  async function getBlob(digest, maxBytes = MAX_BLOB_BYTES) {
    if (!/^[0-9a-f]{40}$/.test(digest)) return null
    try {
      return await readFileLimited(blobPath(digest), Math.min(maxBytes, MAX_BLOB_BYTES))
    } catch (e) {
      if (e?.code === 'ENOENT') return null
      throw e
    }
  }

  async function stageBySha1(stagingRoot, rel, digest, dest) {
    const target = dest || path.join(stagingRoot, rel)
    if (await hasBlob(digest)) {
      const current = await sha1FileLimited(target).catch(() => null)
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
        const maxBytes = rel === 'workspace/workspace.json' ? MAX_WORKSPACE_BYTES : MAX_BLOB_BYTES
        if (st.size > maxBytes) throw new Error(`blob ${rel} 超过 ${maxBytes} 字节上限`)
        const key = `${full}:${st.size}:${st.mtimeMs}`
        let digest = memo?.get(key)
        if (!digest) {
          digest = await sha1FileLimited(full, maxBytes)
          memo?.set(key, digest)
        }
        files[rel] = { sha1: digest, size: st.size, mtime: st.mtimeMs }
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e
        // 文件可能刚被删
      }
    }
    return files
  }

  return { blobsDir, blobPath, hasBlob, putBlob, getBlob, stageBySha1, buildIndex }
}
