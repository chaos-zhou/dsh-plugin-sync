import path from 'node:path'
import { createEngine } from './lib/engine.js'
import { publicSettings } from './lib/config.js'
import { createLogger } from './lib/log.js'

export const inject = ['tools']

export function apply(ctx, config) {
  const engine = createEngine({ rowConfig: config || {} })
  // v1.1 起插件不写宿主工作区索引；v1.2 起可选经宿主 workspaceRegistry/sessionPersistence
  // 事务 API 自动应用（registry 模式），服务不可用回退 proposal 模式。
  // v1.2.1 修正注入契约（BLOCKER 1）：Cordis 的 ctx.inject(deps, cb) 回调签名是
  // (injectCtx, config)，服务必须从回调参数（注入后的 Context）读取——此前把回调参数当
  // 服务数组解析，服务齐全也永远降级 proposal。回调返回的函数由宿主用作卸载清理，
  // 清理即 setServices(null) 立即回退 proposal。宿主无 inject/注入抛错保持 proposal，
  // 绝不向上抛。
  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['workspaceRegistry', 'sessionPersistence'], (injectCtx) => {
        engine.setServices(injectCtx && typeof injectCtx === 'object' ? injectCtx : null)
        return () => engine.setServices(null)
      })
    }
  } catch {
    engine.setServices(null)
  }
  const ready = engine.init().catch((e) => {
    // 不能抛到宿主：兜底日志经 safe-writer 的 logger（目标为符号链接时安全拒绝）
    if (engine.dataDir) {
      const logger = createLogger(path.join(engine.dataDir, 'logs'))
      logger.write('error', `init 失败: ${e?.message || e}`).catch(() => {})
    }
    return null
  })

  ctx.effect(() => {
    // 定时器必须在 init() 读到 settings 之后再启动，否则 settings 还是 undefined
    ready.then(() => engine.startTimer()).catch(() => {})
    return () => engine.close()
  })

  const outputBlock = {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'dsh_sync_status',
      description: '查看 dsh-plugin-sync 同步状态：设备、监听端口、peer 列表、会话数量、最近一轮同步结果等。',
      parameters: {},
      output: outputBlock,
      execute: async () => {
        await ready
        return engine.status()
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'dsh_sync_now',
      description: '立即执行一轮 dsh-plugin-sync 同步（导出 → 工作区合并 ↔ 各 peer 拉取/推送 → 落回），返回本轮摘要。',
      parameters: {},
      output: outputBlock,
      execute: async () => {
        await ready
        return engine.runCycle()
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'dsh_sync_config',
      description: '查看或修改 dsh-plugin-sync 设置。无参数返回当前设置（token 打码）；传 set 对象则深合并写入 config.json，返回新设置与 needRestart。',
      parameters: {
        set: {
          type: 'object',
          description: '要深合并写入的设置字段，例如 {"peers":[{"name":"MBP","url":"http://192.168.1.5:8789","token":"xxx"}]}；不传则只读。',
        },
      },
      output: outputBlock,
      execute: async (args) => {
        await ready
        const set = args && typeof args === 'object' ? args.set : undefined
        if (!set || typeof set !== 'object') {
          return { settings: publicSettings(engine.settings), needRestart: false }
        }
        return engine.updateSettings(set)
      },
    }),
  )
}
