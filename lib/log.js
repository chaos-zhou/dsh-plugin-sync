import fsp from 'node:fs/promises'
import path from 'node:path'
import { ensureDir } from './util.js'

const MAX_SIZE = 2 * 1024 * 1024

export function createLogger(logsDir) {
  const file = path.join(logsDir, 'sync.log')
  return {
    file,
    async write(level, msg, extra) {
      const line = `${new Date().toISOString()} [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`
      try {
        await ensureDir(logsDir)
        let st
        try {
          st = await fsp.stat(file)
        } catch {
          st = null
        }
        if (st && st.size > MAX_SIZE) {
          await fsp.rename(file, path.join(logsDir, 'sync.log.1'))
        }
        await fsp.appendFile(file, line)
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
