import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { sha1, atomicWrite, safeJoin, isQuiet } from './util.js'
import { MAX_BLOB_BYTES, readFileLimited, sha1FileLimited } from './limits.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
let conflictSeq = 0

function conflictName(rel, deviceName, now) {
  const ts = new Date(now).toISOString().replace(/[:]/g, '-')
  const dev = (deviceName || 'device').replace(/[^\w.-]+/g, '_')
  return `${rel.split('/').join('__')}.conflict-${dev}-${ts}-${process.pid}-${++conflictSeq}`
}

function canonicalRel(rel) {
  return typeof rel === 'string' && rel.length > 0 && !path.isAbsolute(rel) && !/^[A-Za-z]:/.test(rel)
    && !/[\\\0]/.test(rel) && rel.split('/').every((part) => part && part !== '.' && part !== '..')
}

async function checkParents(root, file) {
  const base = path.resolve(root)
  const relative = path.relative(base, path.dirname(file))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('落回路径超出目标目录')
  let current = base
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part)
    let stat
    try { stat = await fsp.lstat(current) } catch (e) {
      if (e?.code === 'ENOENT') return
      throw e
    }
    if (stat.isSymbolicLink()) throw new Error(`落回路径父目录是符号链接，拒绝写入：${current}`)
    if (!stat.isDirectory()) throw new Error(`落回路径父级不是目录：${current}`)
  }
}

async function safeWrite(root, file, bytes) {
  await checkParents(root, file)
  await atomicWrite(file, bytes)
}

async function fileSha(file) {
  try {
    return await sha1FileLimited(file)
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e // 读取失败不能当作本地不存在，否则会绕过冲突保护。
  }
}

async function saveConflict(ctx, rel, bytes, reason) {
  const { dshHome, deviceName, now, out, log } = ctx
  const dest = path.join(dshHome, 'plugin-sync', 'conflicts', conflictName(rel, deviceName, now))
  await safeWrite(dshHome, dest, bytes)
  out.conflicts.push(path.relative(dshHome, dest).split(path.sep).join('/'))
  await log.warn(`${reason}，保留本地，远端版本已存冲突副本：${rel}`)
}

// RFC 8878 §3.1：原生解压在部分 Node 版本会接受未完成的帧，先确认完整帧边界。
// 这里只检查 framing；压缩块、校验和及实际内容仍交给 node:zlib 验证。
function checkZstdFrames(bytes) {
  let offset = 0
  let declaredTotal = 0
  const need = (size) => {
    if (offset + size > bytes.length) throw new Error('zstd 帧被截断')
  }
  while (offset < bytes.length) {
    need(4)
    const magic = bytes.readUInt32LE(offset)
    offset += 4
    if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {
      need(4)
      const size = bytes.readUInt32LE(offset)
      offset += 4
      need(size)
      offset += size
      continue
    }
    if (magic !== 0xfd2fb528) throw new Error('zstd 帧魔数无效或含尾随垃圾')
    need(1)
    const descriptor = bytes[offset++]
    if (descriptor & 8) throw new Error('zstd 帧使用保留标志位')
    const singleSegment = !!(descriptor & 32)
    let windowSize
    if (!singleSegment) {
      need(1)
      const window = bytes[offset++]
      windowSize = 2 ** (10 + (window >> 3)) * (1 + (window & 7) / 8)
    }
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]
    const sizeFlag = descriptor >> 6
    const sizeBytes = sizeFlag ? [0, 2, 4, 8][sizeFlag] : singleSegment ? 1 : 0
    need(dictionaryBytes + sizeBytes)
    offset += dictionaryBytes
    if (sizeBytes) {
      const declared = sizeBytes === 8 ? bytes.readBigUInt64LE(offset) : BigInt(bytes.readUIntLE(offset, sizeBytes) + (sizeBytes === 2 ? 256 : 0))
      if (declared > BigInt(MAX_BLOB_BYTES)) throw new Error('zstd 声明输出超过字节上限')
      declaredTotal += Number(declared)
      if (declaredTotal > MAX_BLOB_BYTES) throw new Error('zstd 声明总输出超过字节上限')
      if (singleSegment) windowSize = Number(declared)
    }
    offset += sizeBytes
    if (windowSize > MAX_BLOB_BYTES) throw new Error('zstd 解压窗口超过字节上限')
    let last = false
    while (!last) {
      need(3)
      const header = bytes.readUIntLE(offset, 3)
      offset += 3
      last = !!(header & 1)
      const type = (header >> 1) & 3
      const size = header >>> 3
      if (type === 3 || size > Math.min(windowSize, 128 * 1024)) throw new Error('zstd 数据块头无效')
      const storedSize = type === 1 ? 1 : size
      need(storedSize)
      offset += storedSize
    }
    if (descriptor & 4) { need(4); offset += 4 }
  }
}

function sessionContentError(bytes) {
  if (bytes.length < ZSTD_MAGIC.length || !bytes.subarray(0, 4).equals(ZSTD_MAGIC)) {
    return '会话为空或缺少 zstd 魔数'
  }
  if (typeof zlib.zstdDecompressSync !== 'function') return '运行时不支持 zstd 解压，无法验证会话内容'
  let text
  try {
    checkZstdFrames(bytes)
    const decoded = zlib.zstdDecompressSync(bytes, { maxOutputLength: MAX_BLOB_BYTES })
    text = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
  } catch (e) {
    return `zstd 解压失败或输出超过 ${MAX_BLOB_BYTES} 字节上限：${e?.message || e}`
  }
  if (!text.length) return '会话 JSONL 为空'
  // 不 split 整个文件：在有界解压结果上逐行解析，避免为大量短行再分配数组。
  let start = 0
  let line = 1
  while (start < text.length) {
    const next = text.indexOf('\n', start)
    const end = next < 0 ? text.length : next
    const value = text.slice(start, end).replace(/\r$/, '')
    try { JSON.parse(value) } catch (e) {
      return `会话 JSONL 第 ${line} 行无效：${e?.message || e}`
    }
    start = next < 0 ? text.length : next + 1
    line++
  }
  return null
}

function rememberConflict(out, rel, localSha, remoteSha) {
  out.unresolvedConflict[rel] = {
    sessionId: path.posix.basename(path.posix.dirname(rel)), localSha, remoteSha,
  }
}

function observedConvergence(ctx, rel, localSha) {
  if (ctx.gatedRels?.has(rel)) return false
  const observed = ctx.observedRemoteHashes?.[rel]
  return Array.isArray(observed) && observed.length > 0 && observed.every((hash) => hash === localSha)
}

async function applySession(ctx, rel, info) {
  const { dshHome, stagingRoot, settings, state, log, now, out, gatedRels } = ctx
  const stagingFile = safeJoin(stagingRoot, rel)
  const localFile = safeJoin(dshHome, rel)
  if (!stagingFile || !localFile) return
  await checkParents(dshHome, localFile)
  await checkParents(stagingRoot, stagingFile)
  // 校验和落盘使用同一份有界快照，避免校验后 staging 被替换。
  const bytes = await readFileLimited(stagingFile)
  const actualSha = sha1(bytes)
  const invalid = actualSha !== info.sha1 ? 'staging 会话哈希不匹配' : sessionContentError(bytes)
  if (invalid) {
    const error = `${rel}：${invalid}，拒绝落回`
    out.errors.push(error)
    await log.error(error)
    if (state.declined?.[rel] !== info.sha1) await saveConflict(ctx, rel, bytes, '远端会话内容校验失败')
    out.declined[rel] = info.sha1
    return
  }

  const localSha = await fileSha(localFile)
  const unresolved = Object.hasOwn(out.unresolvedConflict, rel)
  if (localSha === info.sha1) {
    // staging 每轮会被本地导出覆盖，只有本轮实际看见所有远端内容相同才可解锁。
    if (unresolved && !observedConvergence(ctx, rel, localSha)) return
    if (!gatedRels?.has(rel)) {
      delete out.unresolvedConflict[rel]
      delete out.declined[rel]
      out.localHashes[rel] = localSha
      out.remoteHashes[rel] = info.sha1
    }
    return
  }
  if (unresolved) {
    const prior = out.unresolvedConflict[rel]
    if (prior?.remoteSha !== info.sha1) await saveConflict(ctx, rel, bytes, '会话存在未解决冲突')
    rememberConflict(out, rel, localSha, info.sha1)
    out.declined[rel] = info.sha1
    if (localSha !== null) {
      await safeWrite(stagingRoot, stagingFile, await readFileLimited(localFile))
      out.localHashes[rel] = localSha
    }
    return
  }
  if (localSha === null) {
    await safeWrite(dshHome, localFile, bytes)
    out.applied.push(rel)
    out.localHashes[rel] = info.sha1
    out.remoteHashes[rel] = info.sha1
    return
  }

  const prevLocal = Object.hasOwn(state.localHashes || {}, rel) ? state.localHashes[rel] : undefined
  const prevRemote = Object.hasOwn(state.remoteHashes || {}, rel) ? state.remoteHashes[rel] : undefined
  const hasBaseline = typeof prevLocal === 'string' && typeof prevRemote === 'string'
  const localChanged = prevLocal !== localSha
  const remoteChanged = prevRemote !== info.sha1

  // 接收时间不能证明远端内容较新。缺少任一侧基线时一律保留本地及远端冲突副本。
  if (!hasBaseline) {
    await saveConflict(ctx, rel, bytes, '会话缺少同步基线')
    rememberConflict(out, rel, localSha, info.sha1)
  } else {
    const localStat = await fsp.stat(localFile)
    if (!isQuiet(localStat.mtimeMs, settings.settleSec ?? 120, now)) {
      out.skippedFresh.add(rel)
      return
    }
    if (remoteChanged && !localChanged) {
      await safeWrite(dshHome, localFile, bytes)
      out.applied.push(rel)
      out.localHashes[rel] = info.sha1
      out.remoteHashes[rel] = info.sha1
      return
    }
    if (localChanged && remoteChanged) {
      await saveConflict(ctx, rel, bytes, '会话两端都修改')
      rememberConflict(out, rel, localSha, info.sha1)
    } else if (localChanged && !remoteChanged) {
      await log.warn(`本地会话已修改，保留本地：${rel}`)
    }
  }

  await safeWrite(stagingRoot, stagingFile, await readFileLimited(localFile))
  out.declined[rel] = info.sha1
  out.localHashes[rel] = localSha
  out.remoteHashes[rel] = info.sha1
}

export async function applyAll(opts) {
  const { dshHome, stagingRoot, settings, log, deviceName, stagingIndex, gatedRels, observedRemoteHashes } = opts
  const state = opts.state || {}
  const now = Date.now()
  const out = {
    applied: [],
    conflicts: [],
    errors: [],
    skippedFresh: new Set(),
    declined: { ...(state.declined || {}) },
    localHashes: { ...(state.localHashes || {}) },
    remoteHashes: { ...(state.remoteHashes || {}) },
    unresolvedConflict: { ...(state.unresolvedConflict || {}) },
  }
  const ctx = { dshHome, stagingRoot, settings, state, log, deviceName, now, out, gatedRels, observedRemoteHashes }
  if (settings.applyConfig) await log.warn('暂不支持自动落回插件配置')

  for (const [rel, info] of Object.entries(stagingIndex || {})) {
    try {
      if (!canonicalRel(rel)) throw new Error('同步路径不是规范的相对路径')
      if (rel.startsWith('workspace/')) continue
      if (rel.startsWith('sessions/') && /^session\.v4\.jsonl\.zst(d)?$/.test(path.basename(rel))) {
        await applySession(ctx, rel, info)
        continue
      }
      if (rel.startsWith('attachments/') || rel.startsWith('projcache/')) {
        const localRel = rel.startsWith('projcache/')
          ? `storages/session_projcache/${rel.slice('projcache/'.length)}`
          : rel
        const localFile = safeJoin(dshHome, localRel)
        const stagingFile = safeJoin(stagingRoot, rel)
        if (!localFile || !stagingFile) continue
        await checkParents(dshHome, localFile)
        await checkParents(stagingRoot, stagingFile)
        const localSha = await fileSha(localFile)
        if (localSha === info.sha1) continue
        if (rel.startsWith('projcache/')) {
          const bytes = await readFileLimited(stagingFile)
          JSON.parse(bytes.toString('utf8'))
          if (sha1(bytes) !== info.sha1) throw new Error('staging 摘要缓存哈希不匹配')
          await safeWrite(dshHome, localFile, bytes)
        } else {
          await safeWrite(dshHome, localFile, await readFileLimited(stagingFile))
        }
        out.applied.push(rel)
      }
      // 插件配置继续导出；本轮禁止自动写回（包括 applyConfig=true）。
    } catch (e) {
      const error = `${rel}：落回失败，已跳过：${e?.message || e}`
      out.errors.push(error)
      await log.error(error)
    }
  }
  return out
}
