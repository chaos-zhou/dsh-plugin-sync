// 统一安全写入层（v6）：所有插件写盘与目录创建的唯一入口。
// 防护目标：任何写路径都不得被符号链接/硬链接/目录别名重定向到 <dshHome>/storages
// （尤其是宿主索引 storages/workspace.json）。
//
// 能力边界（如实声明）：
// - O_NOFOLLOW 只保护“打开时的最后一级组件”；临时文件用 O_CREAT|O_EXCL|O_NOFOLLOW
//   独占创建，rename 不跟随目标符号链接（替换的是链接本身），写前已拒绝链接目标。
// - lstat/realpath 校验与最终 rename 之间存在理论 TOCTOU 窗口；写后复核
//   （lstat 目标 + realpath 父目录）用于发现而非阻止该窗口内的父目录替换。
// - 追加/轮转增加硬链接防护：目标 nlink>1 拒绝（打开后 fstat 复核），
//   防止 sync.log 是宿主文件的硬链接时追加损坏宿主 inode。
// - <dshHome>/storages 是符号链接视为危险配置：所有写入（含 proposal/日志/state）拒绝。
// - 失败契约：任何内部异常（realpath/lstat/stat 的 EACCES/EIO/ELOOP 等）都转为
//   结构化拒绝 {ok:false, code, error}，不向调用方抛出；写后复核失败按失败返回。
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0

// 每轮（round）的拒绝缓存：失败目标在 round 存活期间不再重试。
// round 是调用方持有的临时对象（如一次 runCycle），GC 自动回收其缓存。
const rejectedTargets = new WeakMap()

function fail(code, message) {
  return { ok: false, code, error: new Error(message) }
}

function pass(extra = {}) {
  return { ok: true, ...extra }
}

function inside(parent, child, allowEqual = false) {
  const rel = path.relative(parent, child)
  if (path.isAbsolute(rel) || rel.startsWith('..')) return false
  return allowEqual || rel !== ''
}

export function isSafeRel(rel) {
  return typeof rel === 'string' && rel.length > 0 && !path.isAbsolute(rel)
    && !/^[A-Za-z]:/.test(rel)
    && !/[\\\0]/.test(rel)
    && rel.split('/').every((part) => part && part !== '.' && part !== '..')
}

function roundMap(round, create = false) {
  if (!round) return null
  let map = rejectedTargets.get(round)
  if (!map && create) {
    map = new Map()
    rejectedTargets.set(round, map)
  }
  return map
}

export function rejectedError(round, target) {
  const first = roundMap(round)?.get(target)
  return first || null
}

function markRejected(round, target, error) {
  roundMap(round, true)?.set(target, error)
}

// 从文件系统根部逐级 lstat：任何一级是符号链接、或中间层不是真实目录 → 拒绝。
// root 必须已存在且是真实目录。
async function assertRealDirChain(dir) {
  const abs = path.resolve(dir)
  const root = path.parse(abs).root
  let st
  try {
    st = await fsp.lstat(root)
  } catch (e) {
    return fail('root-missing', `文件系统根部不可访问：${root}（${e?.message || e}）`)
  }
  if (!st.isDirectory()) return fail('not-dir', `文件系统根部不是目录：${root}`)
  const segments = abs.slice(root.length).split(path.sep).filter(Boolean)
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      st = await fsp.lstat(current)
    } catch (e) {
      return fail('root-missing', `路径不存在或无法检查：${current}（${e?.code || e?.message || e}）`)
    }
    if (st.isSymbolicLink()) return fail('symlink-ancestor', `路径祖先包含符号链接，拒绝写入：${current}`)
    if (!st.isDirectory()) return fail('not-dir', `路径祖先不是目录：${current}`)
  }
  let real
  try {
    real = await fsp.realpath(abs)
  } catch (e) {
    return fail('io', `路径 realpath 解析失败，无法确认边界：${abs}（${e?.message || e}）`)
  }
  return pass({ real })
}

// lstat(<dshHome>/storages)：符号链接 → dangerous；不存在 → missing；其余 → ok。
async function inspectStorages(dshHome) {
  const storages = path.join(dshHome, 'storages')
  let st
  try {
    st = await fsp.lstat(storages)
  } catch (e) {
    if (e?.code === 'ENOENT') return { state: 'missing', real: null }
    return { state: 'error', real: null, error: e }
  }
  if (st.isSymbolicLink()) return { state: 'dangerous', real: null }
  try {
    return { state: 'ok', real: await fsp.realpath(storages) }
  } catch (e) {
    return { state: 'error', real: null, error: e }
  }
}

// S1：写根校验。root 必须已存在且是真实目录、祖先无符号链接；
// 提供 dshHome 时，realpath(root) 不得位于 realpath(<dshHome>/storages) 之内。
// 不提供 dshHome（独立工具如 hub）时仅做结构校验；插件写路径必须传 dshHome。
export async function assertSafeRoot(root, { dshHome } = {}) {
  const chain = await assertRealDirChain(root)
  if (!chain.ok) return chain
  const rootReal = chain.real
  if (!dshHome) return pass({ rootReal, storagesReal: null, storagesState: 'unknown' })
  const storages = await inspectStorages(dshHome)
  if (storages.state === 'dangerous') {
    return fail('dangerous-storages', `检测到 ${path.join(dshHome, 'storages')} 是符号链接（危险配置），所有写入已禁用`)
  }
  if (storages.state === 'error') {
    return fail('io', `检查宿主 storages 失败：${storages.error?.message || storages.error}`)
  }
  if (storages.real && inside(storages.real, rootReal, true)) {
    return fail('protected-root', `写入根 ${rootReal} 解析后位于受保护的宿主目录 ${storages.real} 内`)
  }
  return pass({ rootReal, storagesReal: storages.real, storagesState: storages.state })
}

async function storagesDangerous(dshHome) {
  if (!dshHome) return null
  const storages = await inspectStorages(dshHome)
  if (storages.state === 'dangerous') {
    return fail('dangerous-storages', `检测到 ${path.join(dshHome, 'storages')} 是符号链接（危险配置），所有写入已禁用`)
  }
  return null
}

function cachedRejection(round, target) {
  const first = rejectedError(round, target)
  if (!first) return null
  return fail('rejected', `拒绝操作 ${target}：该目标本轮已拒绝，不再重试（首次原因：${first.message}）`)
}

// 在 root 内逐级校验 rel 的父目录：已存在 → 必须是非链接真实目录；
// create 模式下新建后立即 realpath 复核仍在 rootReal 内。
async function ensureParentsUnderRoot({ root, rootReal, rel, create = true }) {
  const parts = rel.split('/')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    let st
    try {
      st = await fsp.lstat(current)
    } catch (e) {
      if (e?.code !== 'ENOENT' || !create) return fail('io', `检查父目录 ${current} 失败：${e?.message || e}`)
      try {
        await fsp.mkdir(current)
      } catch (mkdirError) {
        return fail('io', `创建父目录 ${current} 失败：${mkdirError?.message || mkdirError}`)
      }
      let real
      try {
        real = await fsp.realpath(current)
      } catch (e) {
        return fail('io', `新建目录 ${current} realpath 解析失败，无法确认边界：${e?.message || e}`)
      }
      if (!inside(rootReal, real, true)) {
        return fail('outside-root', `新建目录 ${real} 解析后不在写入根 ${rootReal} 内`)
      }
      continue
    }
    if (st.isSymbolicLink()) return fail('symlink-parent', `拒绝写入：父目录是符号链接：${current}`)
    if (!st.isDirectory()) return fail('not-dir', `拒绝写入：父级不是目录：${current}`)
  }
  return pass()
}

// 追加写没有 root 锚点：向上找最近的已存在祖先，校验其链路后逐级补建缺失层。
async function ensureExistingDirChain(dir, { dshHome }) {
  const missing = []
  let anchor = dir
  for (;;) {
    try {
      await fsp.lstat(anchor)
      break
    } catch (e) {
      if (e?.code !== 'ENOENT') return fail('io', `检查目录 ${anchor} 失败：${e?.message || e}`)
      missing.push(anchor)
      const parent = path.dirname(anchor)
      if (parent === anchor) return fail('root-missing', `目录链直至文件系统根部均不存在：${dir}`)
      anchor = parent
    }
  }
  const chain = await assertRealDirChain(anchor)
  if (!chain.ok) return chain
  const anchorReal = chain.real
  const storages = await inspectStorages(dshHome)
  if (storages.state === 'dangerous') {
    return fail('dangerous-storages', `检测到 ${path.join(dshHome, 'storages')} 是符号链接（危险配置），所有写入已禁用`)
  }
  if (storages.real && inside(storages.real, anchorReal, true)) {
    return fail('protected-root', `目录 ${anchorReal} 解析后位于受保护的宿主目录 ${storages.real} 内`)
  }
  let dirReal = anchorReal
  for (const level of missing.reverse()) {
    try {
      await fsp.mkdir(level)
    } catch (e) {
      return fail('io', `创建目录 ${level} 失败：${e?.message || e}`)
    }
    try {
      dirReal = await fsp.realpath(level)
    } catch (e) {
      return fail('io', `新建目录 ${level} realpath 解析失败，无法确认边界：${e?.message || e}`)
    }
    if (!inside(anchorReal, dirReal, true)) {
      return fail('outside-root', `新建目录 ${dirReal} 解析后不在 ${anchorReal} 内`)
    }
    if (storages.real && inside(storages.real, dirReal, true)) {
      return fail('protected-root', `新建目录 ${dirReal} 解析后位于受保护的宿主目录 ${storages.real} 内`)
    }
  }
  return pass({ dirReal, storagesReal: storages.real })
}

async function closeQuietly(handle) {
  try { await handle.close() } catch { /* 已关闭 */ }
}

async function removeQuietly(file) {
  try { await fsp.rm(file, { force: true }) } catch { /* 尽力清理 */ }
}

// S1：受保护的原子写。rel 必须是安全的相对路径；写前 assertSafeRoot + 逐级父目录校验 +
// 目标 lstat（符号链接/非普通文件拒绝）；临时文件 O_CREAT|O_EXCL|O_NOFOLLOW 独占创建，
// rename 不跟随目标链接；写后复核目标为普通文件且父目录 realpath 仍在 root 内、不在 storages 内。
// 任一步失败：清理临时文件、按 round 标记拒绝（不再重试），返回结构化错误，不抛出。
export async function guardedWrite({ root, rel, bytes, dshHome, mode, round } = {}) {
  if (!isSafeRel(rel)) {
    return fail('unsafe-rel', `拒绝写入：${JSON.stringify(rel)} 不是安全的相对路径`)
  }
  const target = path.join(root, rel)
  const cached = cachedRejection(round, target)
  if (cached) return cached
  const result = await guardedWriteInner({ root, rel, bytes, dshHome, mode, target })
  if (!result.ok) markRejected(round, target, result.error)
  return result
}

async function guardedWriteInner({ root, rel, bytes, dshHome, mode, target }) {
  const rootCheck = await assertSafeRoot(root, { dshHome })
  if (!rootCheck.ok) return rootCheck
  const { rootReal } = rootCheck
  const parents = await ensureParentsUnderRoot({ root, rootReal, rel })
  if (!parents.ok) return parents
  try {
    const st = await fsp.lstat(target)
    if (st.isSymbolicLink()) return fail('symlink-target', `拒绝写入 ${target}：目标文件是符号链接`)
    if (!st.isFile()) return fail('not-file', `拒绝写入 ${target}：目标不是普通文件`)
  } catch (e) {
    if (e?.code !== 'ENOENT') return fail('io', `拒绝写入 ${target}：检查目标失败：${e?.message || e}`)
  }
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.tmp-${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}`)
  let handle = null
  for (let attempt = 0; !handle; attempt++) {
    try {
      handle = await fsp.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, mode)
    } catch (e) {
      if (e?.code === 'EEXIST' && attempt < 4) continue
      return fail('io', `拒绝写入 ${target}：创建临时文件失败：${e?.message || e}`)
    }
  }
  try {
    try {
      await handle.writeFile(bytes)
    } catch (e) {
      return fail('io', `拒绝写入 ${target}：写入临时文件失败：${e?.message || e}`)
    } finally {
      await closeQuietly(handle)
      handle = null
    }
    // assertSafeRoot 可能报告 storages “缺失”；写前（rename 前）再次 lstat 复核。
    const dangerous = await storagesDangerous(dshHome)
    if (dangerous) return dangerous
    try {
      await fsp.rename(tmp, target)
    } catch (e) {
      return fail('io', `拒绝写入 ${target}：原子替换失败：${e?.message || e}`)
    }
  } finally {
    if (handle) await closeQuietly(handle)
    await removeQuietly(tmp)
  }
  // 写后复核：目标必须是普通文件且父目录 realpath 仍在 root 内、不在 storages 内。
  try {
    const st = await fsp.lstat(target)
    if (st.isSymbolicLink()) return fail('symlink-target', `拒绝写入 ${target}：写后复核发现目标是符号链接`)
    if (!st.isFile()) return fail('not-file', `拒绝写入 ${target}：写后复核发现目标不是普通文件`)
  } catch (e) {
    return fail('io', `拒绝写入 ${target}：写后复核失败：${e?.message || e}`)
  }
  let dirReal
  try {
    dirReal = await fsp.realpath(dir)
  } catch (e) {
    // 写后父目录 realpath 失败：无法确认边界，必须按失败返回（不能当成功）。
    // 此时内容可能已落盘，调用方以返回的错误为准（写后复核只能发现、不能回滚）。
    return fail('io', `拒绝写入 ${target}：写后复核无法解析父目录 realpath（${e?.message || e}）`)
  }
  // storages 边界由 root 级校验承担（root 不在 storages 内 ⇒ 其子目录也不在）；
  // apply 落回 storages/session_projcache 是合法目标，由 assertApplyTarget 管辖具体禁点。
  if (!inside(rootReal, dirReal, true)) {
    return fail('outside-root', `拒绝写入 ${target}：写后复核发现目录解析为 ${dirReal}，不在 ${rootReal} 内`)
  }
  return pass({ target, bytes: bytes.length, tmp })
}

// S1（v6）：受保护的追加写（日志）。追加前 lstat 拒绝符号链接与硬链接（nlink>1，
// 防止日志文件是宿主数据文件的硬链接时追加损坏宿主 inode）；O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW
// 打开后再 fstat 复核为普通文件且 nlink===1（防“校验后、打开前”的 TOCTOU 替换）。
// 任何内部异常都转为结构化拒绝；提供 round 时被拒绝目标在轮内不再重试。
export async function guardedAppend({ file, bytes, dshHome, round } = {}) {
  const target = path.resolve(file)
  const cached = cachedRejection(round, target)
  if (cached) return cached
  const result = await guardedAppendInner({ file: target, bytes, dshHome })
  if (!result.ok) markRejected(round, target, result.error)
  return result
}

async function guardedAppendInner({ file, bytes, dshHome }) {
  try {
    const dangerous = await storagesDangerous(dshHome)
    if (dangerous) return dangerous
    const dirs = await ensureExistingDirChain(path.dirname(file), { dshHome })
    if (!dirs.ok) return dirs
    let st = null
    try {
      st = await fsp.lstat(file)
    } catch (e) {
      if (e?.code !== 'ENOENT') return fail('io', `拒绝追加 ${file}：检查目标失败：${e?.message || e}`)
    }
    if (st) {
      if (st.isSymbolicLink()) return fail('symlink-target', `拒绝追加 ${file}：目标是符号链接`)
      if (!st.isFile()) return fail('not-file', `拒绝追加 ${file}：目标不是普通文件`)
      if (st.nlink > 1) return fail('hardlink', `拒绝追加 ${file}：目标是硬链接（nlink=${st.nlink}），可能共享宿主数据文件的 inode`)
    }
    let handle
    try {
      handle = await fsp.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | O_NOFOLLOW)
    } catch (e) {
      if (e?.code === 'ELOOP' || e?.code === 'ENXIO') {
        return fail('symlink-target', `拒绝追加 ${file}：目标是符号链接或非常规文件（${e.code}）`)
      }
      return fail('io', `拒绝追加 ${file}：打开失败：${e?.message || e}`)
    }
    try {
      const fst = await handle.stat()
      if (!fst.isFile()) return fail('not-file', `拒绝追加 ${file}：打开后复核不是普通文件`)
      if (fst.nlink !== 1) return fail('hardlink', `拒绝追加 ${file}：打开后复核发现硬链接（nlink=${fst.nlink}）`)
      await handle.writeFile(bytes)
    } catch (e) {
      return fail('io', `拒绝追加 ${file}：写入失败：${e?.message || e}`)
    } finally {
      await closeQuietly(handle)
    }
    return pass({ file, bytes: bytes.length })
  } catch (e) {
    return fail('io', `拒绝追加 ${file}：内部异常：${e?.message || e}`)
  }
}

// S1（v6）：日志轮转。源文件必须是普通文件、非符号链接且 nlink===1；轮转目标若已存在，
// 同样必须是普通文件且非符号链接/硬链接——不得对多硬链接文件 rename。
export async function guardedRotate({ file, maxBytes, dshHome, suffix = '.1', round } = {}) {
  const target = path.resolve(file)
  const cached = cachedRejection(round, target)
  if (cached) return cached
  const result = await guardedRotateInner({ file: target, maxBytes, dshHome, suffix })
  if (!result.ok) markRejected(round, target, result.error)
  return result
}

async function guardedRotateInner({ file, maxBytes, dshHome, suffix }) {
  try {
    const dangerous = await storagesDangerous(dshHome)
    if (dangerous) return dangerous
    const dirs = await ensureExistingDirChain(path.dirname(file), { dshHome })
    if (!dirs.ok) return dirs
    let st
    try {
      st = await fsp.lstat(file)
    } catch (e) {
      if (e?.code === 'ENOENT') return pass({ rotated: false, size: 0 })
      return fail('io', `拒绝轮转 ${file}：检查失败：${e?.message || e}`)
    }
    if (st.isSymbolicLink()) return fail('symlink-target', `拒绝轮转 ${file}：目标是符号链接`)
    if (!st.isFile()) return fail('not-file', `拒绝轮转 ${file}：目标不是普通文件`)
    if (st.nlink > 1) return fail('hardlink', `拒绝轮转 ${file}：源文件是硬链接（nlink=${st.nlink}），不得对多链接文件 rename`)
    if (st.size <= maxBytes) return pass({ rotated: false, size: st.size })
    const dest = file + suffix
    let dst = null
    try {
      dst = await fsp.lstat(dest)
    } catch (e) {
      if (e?.code !== 'ENOENT') return fail('io', `拒绝轮转 ${file}：检查轮转目标失败：${e?.message || e}`)
    }
    if (dst) {
      if (dst.isSymbolicLink()) return fail('symlink-target', `拒绝轮转 ${file}：轮转目标 ${dest} 是符号链接`)
      if (!dst.isFile()) return fail('not-file', `拒绝轮转 ${file}：轮转目标 ${dest} 不是普通文件`)
      if (dst.nlink > 1) return fail('hardlink', `拒绝轮转 ${file}：轮转目标 ${dest} 是硬链接（nlink=${dst.nlink}）`)
    }
    try {
      await fsp.rename(file, dest)
    } catch (e) {
      return fail('io', `拒绝轮转 ${file}：重命名失败：${e?.message || e}`)
    }
    return pass({ rotated: true, size: st.size })
  } catch (e) {
    return fail('io', `拒绝轮转 ${file}：内部异常：${e?.message || e}`)
  }
}

// S2（v6）：受保护的目录创建。插件所有目录创建的统一入口：
// 从已存在的最近祖先做真实目录链校验（祖先符号链接、<dshHome>/storages 为符号链接、
// 解析后落入宿主 storages 都拒绝），逐级创建后 realpath 复核；已存在的目录同样全链校验。
export async function guardedMkdir(dir, { dshHome, round } = {}) {
  const target = path.resolve(dir)
  const cached = cachedRejection(round, target)
  if (cached) return cached
  const result = await guardedMkdirInner({ dir: target, dshHome })
  if (!result.ok) markRejected(round, target, result.error)
  return result
}

async function guardedMkdirInner({ dir, dshHome }) {
  try {
    return await ensureExistingDirChain(dir, { dshHome })
  } catch (e) {
    return fail('io', `拒绝创建目录 ${dir}：内部异常：${e?.message || e}`)
  }
}

// S1：受保护的删除。只允许删除 root 内、lstat 为普通文件的路径；父级校验与写入一致。
export async function guardedRemove({ root, rel, dshHome, round } = {}) {
  if (!isSafeRel(rel)) {
    return fail('unsafe-rel', `拒绝删除：${JSON.stringify(rel)} 不是安全的相对路径`)
  }
  const target = path.join(root, rel)
  const cached = cachedRejection(round, target)
  if (cached) return cached
  const rootCheck = await assertSafeRoot(root, { dshHome })
  if (!rootCheck.ok) {
    markRejected(round, target, rootCheck.error)
    return rootCheck
  }
  try {
    const st = await fsp.lstat(target)
    if (st.isSymbolicLink()) {
      const result = fail('symlink-target', `拒绝删除 ${target}：目标是符号链接`)
      markRejected(round, target, result.error)
      return result
    }
    if (!st.isFile()) {
      const result = fail('not-file', `拒绝删除 ${target}：目标不是普通文件`)
      markRejected(round, target, result.error)
      return result
    }
  } catch (e) {
    if (e?.code === 'ENOENT') return pass({ removed: false })
    const result = fail('io', `拒绝删除 ${target}：检查失败：${e?.message || e}`)
    markRejected(round, target, result.error)
    return result
  }
  const parents = await ensureParentsUnderRoot({ root, rootReal: rootCheck.rootReal, rel, create: false })
  if (!parents.ok) {
    markRejected(round, target, parents.error)
    return parents
  }
  try {
    await fsp.unlink(target)
  } catch (e) {
    const result = fail('io', `拒绝删除 ${target}：${e?.message || e}`)
    markRejected(round, target, result.error)
    return result
  }
  return pass({ removed: true })
}

// S1：apply 落回目标（sessions/attachments/projcache）的父级真实路径校验。
// 禁止：storages 为符号链接（危险配置→全部拒绝）；父级链路经过符号链接或非目录；
// 解析后父级为宿主 storages 根目录本身（即向 storages 根直写文件，如 workspace.json）。
// projcache 落回 storages/session_projcache/... 是合法目标，不受影响。
export async function assertApplyTarget({ dshHome, target } = {}) {
  const dangerous = await storagesDangerous(dshHome)
  if (dangerous) return dangerous
  const base = path.resolve(dshHome)
  const abs = path.resolve(target)
  const relToBase = path.relative(base, abs)
  if (relToBase === '' || path.isAbsolute(relToBase) || relToBase.startsWith('..')) {
    return fail('outside-root', `落回路径超出 dshHome：${target}`)
  }
  const parent = path.dirname(abs)
  const parts = path.relative(base, parent).split(path.sep).filter(Boolean)
  let current = base
  for (const part of parts) {
    current = path.join(current, part)
    let st
    try {
      st = await fsp.lstat(current)
    } catch (e) {
      if (e?.code === 'ENOENT') break // 缺失父级由 guardedWrite 逐级创建并校验
      return fail('io', `落回路径检查失败：${current}（${e?.message || e}）`)
    }
    if (st.isSymbolicLink()) return fail('symlink-parent', `落回路径父目录是符号链接，拒绝写入：${current}`)
    if (!st.isDirectory()) return fail('not-dir', `落回路径父级不是目录：${current}`)
  }
  const storages = await inspectStorages(dshHome)
  if (storages.state === 'error') {
    return fail('io', `检查宿主 storages 失败：${storages.error?.message || storages.error}`)
  }
  if (storages.real) {
    let parentReal = null
    try {
      parentReal = await fsp.realpath(parent)
    } catch (e) {
      // 父级尚不存在由 guardedWrite 逐级创建并复核；其余解析失败一律按拒绝处理。
      if (e?.code !== 'ENOENT') return fail('io', `落回父目录 realpath 解析失败，无法确认边界：${parent}（${e?.message || e}）`)
    }
    if (parentReal === storages.real) {
      return fail('protected-root', `落回目标父级解析为受保护的宿主目录 ${storages.real}，拒绝写入`)
    }
    let fileReal = null
    try {
      fileReal = await fsp.realpath(abs)
    } catch (e) {
      if (e?.code !== 'ENOENT') return fail('io', `落回目标 realpath 解析失败，无法确认边界：${abs}（${e?.message || e}）`)
    }
    if (fileReal === path.join(storages.real, 'workspace.json')) {
      return fail('protected-root', `落回目标解析为受保护的宿主索引 ${path.join(storages.real, 'workspace.json')}，拒绝写入`)
    }
  }
  return pass()
}
