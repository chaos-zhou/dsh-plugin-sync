import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

export const MAX_BLOB_BYTES = 200 * 1024 * 1024
export const MAX_INDEX_BYTES = 16 * 1024 * 1024
export const MAX_INDEX_ENTRIES = 100000

function tooLarge(label, limit) {
  return new Error(`${label} 超过 ${limit} 字节上限`)
}

// 先检查文件大小，再按块读取；文件在检查后增长也不能突破上限。
async function consumeFileLimited(file, limit, consume) {
  const handle = await fsp.open(file, 'r')
  try {
    const st = await handle.stat()
    if (st.size > limit) throw tooLarge(file, limit)
    let size = 0
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > limit) throw tooLarge(file, limit)
      consume(chunk.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
}

export async function readFileLimited(file, limit = MAX_BLOB_BYTES) {
  const chunks = []
  await consumeFileLimited(file, limit, (chunk) => chunks.push(chunk))
  return Buffer.concat(chunks)
}

export async function sha1FileLimited(file, limit = MAX_BLOB_BYTES) {
  const hash = crypto.createHash('sha1')
  await consumeFileLimited(file, limit, (chunk) => hash.update(chunk))
  return hash.digest('hex')
}

// 计时器覆盖连接、响应头和整个响应体；不能信任 Content-Length。
export async function requestBuffer(url, init = {}, { maxBytes = MAX_BLOB_BYTES, timeoutMs = 30000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  let reader
  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
    const declared = res.headers.get('content-length')
    if (declared !== null && Number(declared) > maxBytes) throw tooLarge('响应体', maxBytes)
    const chunks = []
    let size = 0
    if (res.body) {
      reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) throw tooLarge('响应体', maxBytes)
        chunks.push(Buffer.from(value))
      }
    }
    return Buffer.concat(chunks, size)
  } catch (e) {
    ac.abort(e)
    throw e
  } finally {
    clearTimeout(timer)
    reader?.releaseLock()
  }
}

export function parsePeerIndex(bytes) {
  if (bytes.length > MAX_INDEX_BYTES) throw tooLarge('peer index', MAX_INDEX_BYTES)
  const index = JSON.parse(bytes.toString('utf8'))
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw new Error('peer index 应为对象')
  const files = index.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('peer index.files 应为对象')
  const entries = Object.entries(files)
  if (entries.length > MAX_INDEX_ENTRIES) throw new Error(`peer index 超过 ${MAX_INDEX_ENTRIES} 条上限`)
  for (const [rel, info] of entries) {
    if (!info || typeof info !== 'object' || !/^[0-9a-f]{40}$/.test(info.sha1)) {
      throw new Error(`peer index 条目不合法：${rel}`)
    }
    if (info.size !== undefined && (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_BLOB_BYTES)) {
      throw new Error(`blob ${rel} size 不合法或超过 ${MAX_BLOB_BYTES} 字节上限`)
    }
  }
  return index
}
