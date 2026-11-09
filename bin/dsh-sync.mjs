#!/usr/bin/env node
// v1.4.0 CLI：不依赖 DSH 进程。优先调用本机管理 API（127.0.0.1:<port>，x-dsh-sync-token），
// 服务不可用时回退为直接读写 <dataDir>/config.json，并提示「需重载/重启生效」。
// 定位：pluginRoot = 本文件上一级目录；dataDir = DSH_SYNC_HOME || ~/.dsh/plugin-sync。
// 只写插件自己的 config.json 与 dataDir/updates，绝不写 ~/.dsh/storages。
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readJson } from '../lib/util.js'
import { DEFAULTS, deepMerge, publicSettings, sanitizeConfigSet, saveConfig } from '../lib/config.js'
import { guardedMkdir } from '../lib/safe-writer.js'
import { checkUpdate, applyUpdate } from '../lib/update.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const dataDir = process.env.DSH_SYNC_HOME || path.join(os.homedir(), '.dsh', 'plugin-sync')
const configFile = path.join(dataDir, 'config.json')
const API_TIMEOUT_MS = Number(process.env.DSH_SYNC_API_TIMEOUT_MS) || 10000

function usage() {
  return `dsh-plugin-sync CLI（v1.4.0）

用法: dsh-sync <命令>

命令:
  status                              查看状态（优先管理 API，服务未运行时显示本地摘要）
  config get [key]                    查看配置（token 打码）
  config set '<json>'                 深合并写入配置，如 '{"deviceName":"laptop"}'
  config add-peer <name> <url> [token]   添加 peer
  config remove-peer <name>           移除 peer
  config set-token [token]            设置同步 token（省略则生成随机 token）
  config set-remap '<from>' '<to>'    添加工作区路径映射（绝对路径）
  config remove-remap <index>         按下标移除路径映射
  sync                                立即触发一轮同步（需要管理服务在运行）
  update check                        检查 GitHub 最新版本
  update apply [--version vX.Y.Z] [--force]   应用更新（默认最新；force 允许降级/重装）
  version                             显示插件版本
  help                                显示本帮助

安全: 管理端仅限本机回环访问且需要 x-dsh-sync-token；更新只替换插件安装目录白名单文件，'
重启 DSH 后生效。`
}

function fail(message) {
  console.error(`错误: ${message}`)
  process.exitCode = 1
}

function print(value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

async function localSettings() {
  const raw = await readJson(configFile, null)
  return deepMerge(DEFAULTS, isPlainObject(raw) ? raw : {})
}

async function rawConfig() {
  const raw = await readJson(configFile, null)
  return isPlainObject(raw) ? raw : {}
}

async function installedVersion() {
  try {
    return JSON.parse(await fsp.readFile(path.join(pluginRoot, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// 连接建立前失败（请求未送达、不可能有副作用）——可安全回退离线模式。
// ECONNREFUSED 是典型；EADDRNOTAVAIL（如 listenPort=0）/ENOTFOUND 等同属此类。
const PRE_CONNECT_CODES = new Set(['ECONNREFUSED'])

// 返回 null 仅表示「连接建立前失败」——可安全回退离线模式。
// v1.4.1（B3）：请求已发出后的超时/断连视为「结果未知」，直接报错而不是回退离线重试
// （写入类操作盲重试可能造成双写/状态错乱，必须先检查状态）。
async function apiCall(pathname, init = {}) {
  const settings = await localSettings()
  const port = settings.listenPort ?? 8789
  const token = settings.token || ''
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`请求超时（${API_TIMEOUT_MS}ms）`)), API_TIMEOUT_MS)
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      ...init,
      headers: { 'x-dsh-sync-token': token, ...(init.headers || {}) },
      signal: ac.signal,
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { error: text } }
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    if (ac.signal.aborted) {
      throw new Error(`管理 API ${pathname} 请求超时：结果未知，请检查服务状态后重试（${e?.message || e}）`)
    }
    const code = e?.cause?.code || e?.code || ''
    if (PRE_CONNECT_CODES.has(code)) return null
    throw new Error(`管理 API ${pathname} 请求失败：结果未知，请检查服务状态后重试（${e?.cause?.message || e?.message || e}）`)
  } finally {
    clearTimeout(timer)
  }
}

// 服务不可用时的本地落盘回退（guardedWrite 防护 + 明确提示需重载/重启）。
async function localWriteConfig(patch) {
  const made = await guardedMkdir(dataDir, { dshHome: path.dirname(dataDir) })
  if (!made.ok) throw new Error(`创建数据目录失败：${made.error.message}`)
  const next = deepMerge(await rawConfig(), patch)
  await saveConfig(configFile, next)
  console.log(`已直接写入 ${configFile}`)
  console.log('注意: 管理服务未运行，变更将在下次 DSH 启动/重载插件时生效。')
  return next
}

async function mutateConfig(patch, description) {
  // v1.4.1（B6）：打码/空 token 一律视为「不修改」，从 set 剔除；peers 打码 token 用本地真实值回填。
  const clean = sanitizeConfigSet(patch, await localSettings())
  const res = await apiCall('/v1/admin/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ set: clean }),
  })
  if (res) {
    if (!res.ok) {
      fail(`管理 API 写入失败（HTTP ${res.status}）：${res.data?.error || '未知错误'}`)
      return
    }
    print(`${description} 完成。${res.data?.needRestart ? 'needRestart=true：listenPort/role/bindHost/token 变更，需重启 DSH 生效。' : '下一轮同步自动生效。'}`)
    return
  }
  await localWriteConfig(clean)
}

function validateRemapPath(p, label) {
  if (typeof p !== 'string' || !p.length) return `${label} 不能为空`
  if (!p.startsWith('/') && !/^[A-Za-z]:\//.test(p)) return `${label} 必须是绝对路径（POSIX 或盘符，如 /Users/x 或 C:/x）`
  const parts = p.split('/').slice(1)
  if (parts.some((part) => part === '.' || part === '..')) return `${label} 不能包含 . 或 .. 段`
  return null
}

function checkRemapPeerArgs(args, want) {
  if (args.length < want) {
    fail(`参数不足：${want} 个必填参数。用 dsh-sync help 查看用法。`)
    return false
  }
  return true
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2)

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    print(usage())
    return
  }

  if (cmd === 'version') {
    print(await installedVersion())
    return
  }

  if (cmd === 'status') {
    const res = await apiCall('/v1/admin/status')
    if (res) {
      if (!res.ok) throw new Error(`管理 API 返回 HTTP ${res.status}：${res.data?.error || '未知错误'}`)
      print(res.data)
      return
    }
    const settings = await localSettings()
    // v1.4.1（B7）：本地摘要同样整体走 publicSettings（peers[].token 一并打码）。
    const masked = publicSettings(settings)
    print({
      note: '管理服务未运行，以下为本地 config.json 摘要（重启 DSH 后可见完整状态）',
      installedVersion: await installedVersion(),
      deviceName: settings.deviceName || os.hostname(),
      role: settings.role,
      listenPort: settings.listenPort,
      token: masked.token,
      peers: masked.peers,
      hubUrl: settings.hubUrl,
      repo: settings.repo,
      updateCheck: settings.updateCheck,
      autoApplyUpdate: settings.autoApplyUpdate,
    })
    return
  }

  if (cmd === 'sync') {
    const res = await apiCall('/v1/admin/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (!res) throw new Error('管理服务未运行，无法触发同步（请先启动 DSH）')
    if (!res.ok) throw new Error(`管理 API 返回 HTTP ${res.status}：${res.data?.error || '未知错误'}`)
    print(res.data.started ? '已触发一轮同步（后台执行中）。' : `未触发：${res.data.reason === 'inFlight' ? '已有同步在进行中' : res.data.reason}`)
    return
  }

  if (cmd === 'update') {
    if (sub === 'check') {
      const current = await installedVersion()
      const res = await apiCall('/v1/admin/update/check')
      let result
      if (res) {
        if (!res.ok) throw new Error(`管理 API 返回 HTTP ${res.status}：${res.data?.error || '未知错误'}`)
        result = res.data
      } else {
        const settings = await localSettings()
        result = await checkUpdate({ repo: settings.repo, currentVersion: current })
        result.via = 'direct（管理服务未运行，直接请求 GitHub）'
      }
      print(result)
      if (result.error) fail(result.error)
      else if (result.available) console.log(`有可用更新：${result.current} → ${result.latest}。运行 dsh-sync update apply 应用（需重启 DSH 生效）。`)
      else console.log('已是最新版本。')
      return
    }
    if (sub === 'apply') {
      const opts = { version: null, tag: null, force: false }
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]
        if (arg === '--force') opts.force = true
        else if (arg === '--version' || arg.startsWith('--version=')) {
          const raw = arg.includes('=') ? arg.split('=').slice(1).join('=') : rest[++i]
          opts.version = String(raw || '').trim()
          // v1.4.1（N3）：用户显式带 v 前缀时按原始 tag 下载；裸 semver 保持默认 v{version}。
          if (/^v\d/i.test(opts.version)) opts.tag = opts.version
        } else throw new Error(`未知参数：${arg}`)
      }
      // v1.4.1（N1）：不带 --version 时先检查更新，取 latest 再 apply；无更新则提示已最新。
      let latestTag = opts.tag
      if (!opts.version) {
        const settings = await localSettings()
        const current = await installedVersion()
        let check
        const cres = await apiCall('/v1/admin/update/check')
        if (cres) {
          if (!cres.ok) throw new Error(`管理 API 返回 HTTP ${cres.status}：${cres.data?.error || '未知错误'}`)
          check = cres.data
        } else {
          check = await checkUpdate({ repo: settings.repo, currentVersion: current })
        }
        if (check.error) throw new Error(`检查更新失败：${check.error}`)
        if (!check.available) {
          print({ note: '已是最新版本', current, latest: check.latest || current })
          return
        }
        opts.version = check.latest
        latestTag = check.latestTag || latestTag
      }
      const payload = { force: opts.force, version: opts.version.replace(/^v/, '') }
      if (latestTag) payload.tag = latestTag
      const res = await apiCall('/v1/admin/update/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let result
      if (res) {
        if (!res.ok) throw new Error(`管理 API 返回 HTTP ${res.status}：${res.data?.error || '未知错误'}`)
        result = res.data
      } else {
        const settings = await localSettings()
        result = await applyUpdate({
          repo: settings.repo,
          version: payload.version,
          tag: payload.tag,
          force: payload.force,
          installRoot: pluginRoot,
          dataDir,
        })
        result.via = 'direct（管理服务未运行，直接下载替换）'
      }
      if (result.applied) {
        print(result)
        console.log(`更新成功：${result.fromVersion} → ${result.toVersion}。请立即重启 DSH 加载新版本。`)
      } else {
        throw new Error(`更新失败：${result.error || '未知错误'}`)
      }
      return
    }
    throw new Error(`未知 update 子命令：${sub}（可用: check | apply）`)
  }

  if (cmd === 'config') {
    if (sub === 'get') {
      const key = rest[0]
      const res = await apiCall('/v1/admin/config')
      let settings
      if (res) {
        if (!res.ok) throw new Error(`管理 API 返回 HTTP ${res.status}：${res.data?.error || '未知错误'}`)
        settings = res.data.settings
      } else {
        settings = publicSettings(await localSettings())
        console.error('注意: 管理服务未运行，以下来自本地 config.json。')
      }
      if (!key) {
        print(settings)
        return
      }
      if (!Object.hasOwn(settings, key)) {
        fail(`配置项不存在：${key}`)
        return
      }
      print(settings[key])
      return
    }
    if (sub === 'set') {
      const json = rest[0]
      if (!json) throw new Error('用法: dsh-sync config set \'<json>\'')
      let patch
      try {
        patch = JSON.parse(json)
      } catch (e) {
        throw new Error('JSON 解析失败（请检查输入语法）')
      }
      if (!isPlainObject(patch)) throw new Error('set 参数必须是 JSON 对象')
      await mutateConfig(patch, '配置写入')
      return
    }
    if (sub === 'add-peer') {
      if (!checkRemapPeerArgs(rest, 2)) return
      const [name, url, token] = rest
      const settings = await localSettings()
      const peers = Array.isArray(settings.peers) ? settings.peers.filter(isPlainObject) : []
      if (peers.some((p) => p.name === name)) throw new Error(`peer 已存在：${name}（先 remove-peer 再添加）`)
      const peer = { name, url }
      if (token) peer.token = token
      peers.push(peer)
      await mutateConfig({ peers }, `添加 peer ${name}`)
      return
    }
    if (sub === 'remove-peer') {
      if (!checkRemapPeerArgs(rest, 1)) return
      const [name] = rest
      const settings = await localSettings()
      const peers = (Array.isArray(settings.peers) ? settings.peers : []).filter((p) => p?.name !== name)
      if ((settings.peers || []).length === peers.length) throw new Error(`未找到 peer：${name}`)
      await mutateConfig({ peers }, `移除 peer ${name}`)
      return
    }
    if (sub === 'set-token') {
      const token = rest[0] || crypto.randomBytes(24).toString('base64url')
      await mutateConfig({ token }, token ? '设置 token' : '生成并设置随机 token')
      return
    }
    if (sub === 'set-remap') {
      if (!checkRemapPeerArgs(rest, 2)) return
      const [from, to] = rest
      for (const [p, label] of [[from, 'from'], [to, 'to']]) {
        const bad = validateRemapPath(p, label)
        if (bad) throw new Error(bad)
      }
      const settings = await localSettings()
      const pathRemap = Array.isArray(settings.pathRemap) ? settings.pathRemap.filter(isPlainObject) : []
      pathRemap.push({ from, to })
      await mutateConfig({ pathRemap }, `添加路径映射 ${from} → ${to}`)
      return
    }
    if (sub === 'remove-remap') {
      if (!checkRemapPeerArgs(rest, 1)) return
      const index = Number(rest[0])
      if (!Number.isInteger(index) || index < 0) throw new Error('index 必须是非负整数（先 config get pathRemap 查看下标）')
      const settings = await localSettings()
      const pathRemap = Array.isArray(settings.pathRemap) ? settings.pathRemap.filter(isPlainObject) : []
      if (index >= pathRemap.length) throw new Error(`下标越界：pathRemap 共 ${pathRemap.length} 条`)
      const [removed] = pathRemap.splice(index, 1)
      await mutateConfig({ pathRemap }, `移除路径映射 #${index}（${removed.from} → ${removed.to}）`)
      return
    }
    throw new Error(`未知 config 子命令：${sub}（可用: get | set | add-peer | remove-peer | set-token | set-remap | remove-remap）`)
  }

  throw new Error(`未知命令：${cmd}（用 dsh-sync help 查看用法）`)
}

main().catch((e) => fail(e?.message || String(e)))
