import fsp from 'node:fs/promises'
import path from 'node:path'
import { createEngine } from './lib/engine.js'
import { publicSettings } from './lib/config.js'

export const inject = ['tools']

export function apply(ctx, config) {
  // 可选服务独立注入：宿主未提供或稍后卸载时，工具仍可用并退回建议文件模式。
  let storageDomain
  try {
    ctx.inject?.(['storageDomain'], (dctx) => {
      const service = dctx.storageDomain
      storageDomain = service
      dctx.effect?.(() => () => {
        if (storageDomain === service) storageDomain = undefined
      })
    })
  } catch {
    storageDomain = undefined
  }
  const engine = createEngine({
    rowConfig: config || {},
    getWorkspaceDomain: () => storageDomain?.get('workspace'),
  })
  const ready = engine.init().catch((e) => {
    // 不能抛到宿主：尽力写入日志文件
    const dir = path.join(engine.dataDir || '', 'logs')
    fsp.mkdir(dir, { recursive: true })
      .then(() => fsp.appendFile(path.join(dir, 'sync.log'), `${new Date().toISOString()} [error] init 失败: ${e?.message || e}\n`))
      .catch(() => {})
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
