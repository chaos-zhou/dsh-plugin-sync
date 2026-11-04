import path from 'node:path'
import { guardedAppend, guardedRotate } from './safe-writer.js'

const MAX_SIZE = 2 * 1024 * 1024
const MAX_REJECTED = 50

// v6：日志追加与轮转都经 safe-writer，并参与轮级拒绝缓存（同轮内被拒目标不再重试）。
// 拒绝不静默：记入 logger.rejected，由引擎在每个 cycle 末尾 drainRejected 并入 errors[]。
// （sync.log 是符号链接或硬链接、storages 为危险配置时，追加/轮转一律拒绝且不抛出。）
export function createLogger(logsDir, { dshHome } = {}) {
  const file = path.join(logsDir, 'sync.log')
  const home = dshHome || path.resolve(logsDir, '../..')
  const rejected = []
  let round = {}
  const noteRejection = (result, prefix) => {
    if (result.ok) return
    // 缓存型拒绝（code='rejected'）只是首次拒绝的重复，不再记录。
    if (result.code === 'rejected') return
    const message = `${prefix}${result.error?.message || result.error}`
    if (!rejected.includes(message) && rejected.length < MAX_REJECTED) rejected.push(message)
  }
  return {
    file,
    rejected,
    // 每个 cycle 开始时重置拒绝缓存（init 阶段共用首个 round）。
    newRound() { round = {} },
    // 取走累计的日志拒绝（去重、封顶），由调用方并入本轮 errors[]。
    drainRejected() { return rejected.splice(0, rejected.length) },
    async write(level, msg, extra) {
      const line = `${new Date().toISOString()} [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`
      try {
        const rotated = await guardedRotate({ file, maxBytes: MAX_SIZE, dshHome: home, round })
        if (!rotated.ok) {
          noteRejection(rotated, '日志轮转被拒绝：')
          return
        }
        const appended = await guardedAppend({ file, bytes: line, dshHome: home, round })
        if (!appended.ok) noteRejection(appended, '日志写入被拒绝：')
      } catch (e) {
        // safe-writer 不应抛出；万一异常逃逸同样视为拒绝记录，绝不静默。
        const message = `日志写入异常：${e?.message || e}`
        if (!rejected.includes(message) && rejected.length < MAX_REJECTED) rejected.push(message)
      }
    },
    info(msg, extra) {
      return this.write('info', msg, extra)
    },
    warn(msg, extra) {
      return this.write('warn', msg, extra)
    },
    error(msg, extra) {
      return this.write('error', msg, extra)
    },
  }
}
