#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { createSyncServer, listen, closeServer } from './lib/server.js'
import { createStore } from './lib/store.js'
import { readJson, writeJson, atomicWrite, ensureDir } from './lib/util.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--token') out.token = argv[++i]
    else if (a === '--data') out.data = argv[++i]
    else if (a === '--bind') out.bind = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv)

if (args.help) {
  console.log('用法: node hub.mjs --port 8790 --token <TOKEN> --data <DIR> [--bind 0.0.0.0]')
  process.exit(0)
}

const dataDir = path.resolve(args.data || path.join(os.homedir(), '.dsh-sync-hub'))
const token = args.token || ''
const bindHost = token ? args.bind || '0.0.0.0' : '127.0.0.1'
const port = Number.isFinite(args.port) ? args.port : 8790

await ensureDir(dataDir)

const store = createStore(dataDir)
const manifestFile = path.join(dataDir, 'manifest.json')
const manifest = await readJson(manifestFile, {})
let saveQueued = false

function saveManifest() {
  if (saveQueued) return
  saveQueued = true
  setTimeout(() => {
    saveQueued = false
    writeJson(manifestFile, manifest).catch(() => {})
  }, 100)
}

const server = createSyncServer({
  token: () => token,
  getDevice: () => `hub-${os.hostname()}`,
  getRole: () => 'hub',
  getVersion: () => '1.0.0',
  getIndex: async () => manifest,
  getBlob: (sha1) => store.getBlob(sha1),
  putBlob: async (buf, rel) => {
    const sha1 = await store.putBlob(buf, rel)
    if (rel && !rel.includes('..') && !path.isAbsolute(rel)) {
      manifest[rel] = { sha1, size: buf.length, mtime: Date.now() }
      saveManifest()
    }
    return sha1
  },
})

const actual = await listen(server, port, bindHost)
if (!token) {
  console.log('[warn] 未设置 token，服务只绑定 127.0.0.1，局域网内其他设备无法访问。建议：node hub.mjs --token <随机长字符串>')
}

const addresses = []
if (bindHost === '0.0.0.0' || bindHost === '::') {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) addresses.push(`http://${ni.address}:${actual}`)
    }
  }
}
addresses.push(`http://127.0.0.1:${actual}`)

console.log(`dsh-sync hub 已启动`)
console.log(`  数据目录: ${dataDir}`)
console.log(`  token:    ${token ? token.slice(0, 6) + '******（客户端配置用完整 token）' : '（未设置）'}`)
console.log(`  监听地址:`)
for (const a of addresses) console.log(`    ${a}/v1  （客户端 peers 填 ${a}）`)
console.log('Ctrl+C 退出。')

let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`\n收到 ${signal}，正在关闭…`)
  try {
    await writeJson(manifestFile, manifest)
    await closeServer(server)
  } catch {
    // 尽力而为
  }
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
