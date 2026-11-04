import path from 'node:path'
import { guardedAppend, guardedRotate } from './safe-writer.js'

const MAX_SIZE = 2 * 1024 * 1024

// v5：日志追加与轮转都经 safe-writer。sync.log 是符号链接（如指向宿主 storages/workspace.json）
// 或 storages 为符号链接的危险配置时，追加/轮转一律拒绝且不抛出。
export function createLogger(logsDir, { dshHome } = {}) {
  const file = path.join(logsDir, 'sync.log')
  const home = dshHome || path.resolve(logsDir, '../..')
  return {
    file,
    async write(level, msg, extra) {
      const line = `${new Date().toISOString()} [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`
      try {
        const rotated = await guardedRotate({ file, maxBytes: MAX_SIZE, dshHome: home })
        if (!rotated.ok) return
        const appended = await guardedAppend({ file, bytes: line, dshHome: home })
        if (!appended.ok) return
      } catch {
        // 日志失败不影响主流程
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
