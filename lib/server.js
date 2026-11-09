import http from 'node:http'
import crypto from 'node:crypto'
import { MAX_BLOB_BYTES } from './limits.js'
import { ADMIN_HTML } from './admin-html.js'

const MAX_BODY = MAX_BLOB_BYTES

// v1.4.0：管理端（/admin 与 /v1/admin/*）只允许本机回环访问，且必须带 x-dsh-sync-token。
// 回环判定取 socket 真实地址（不信任 X-Forwarded-* 头）。
// v1.4.1（B5）：token 只认 x-dsh-sync-token 头（不再接受 query token）；比较用
// sha256+timingSafeEqual（长度无关、常数时间）；所有管理路由额外校验 Host 头为本机回环
// （防 DNS rebinding）；非 GET 还要求 content-type: application/json 且 Origin（若有）为回环
// （防跨站表单/CSRF）。
function isLoopback(req) {
  const addr = req?.socket?.remoteAddress || ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

// Host 头（含端口）的 host 部分必须是回环地址/localhost。
function isLoopbackHost(host) {
  if (typeof host !== 'string' || !host.trim()) return false
  let h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end > 0 && h.slice(1, end) === '::1'
  }
  h = h.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

function isLoopbackOrigin(origin) {
  try {
    return isLoopbackHost(new URL(String(origin)).host)
  } catch {
    return false
  }
}

// v1.4.1（B5/N2）：先 sha256 归一到定长，再 timingSafeEqual——长度无关且常数时间。
function tokensMatch(got, want) {
  const a = crypto.createHash('sha256').update(String(got ?? '')).digest()
  const b = crypto.createHash('sha256').update(String(want ?? '')).digest()
  return crypto.timingSafeEqual(a, b)
}

function sendHtml(res, code, html) {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(html)
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) {
      req.resume()
      reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
      return
    }
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > MAX_BODY) {
        done = true
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('error', (e) => {
      if (!done) {
        done = true
        reject(e)
      }
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks))
      }
    })
  })
}

export function createSyncServer(ops) {
  const server = http.createServer((req, res) => {
    handle(req, res, ops).catch((e) => {
      const code = e?.statusCode || 500
      try {
        sendJson(res, code, { error: String(e?.message || e) })
      } catch {
        // 连接已断
      }
    })
  })
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  return server
}

async function handle(req, res, ops) {
  const url = new URL(req.url, 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)
  const token = ops.token() || ''

  // v1.4.1（B5）管理端鉴权链：socket 回环（403）→ Host 回环（403）→ token 仅认
  // x-dsh-sync-token 头（401，/v1/admin/* 必须；GET /admin 页面免 token）→ 非 GET 还要
  // content-type: application/json 且 Origin（若有）为回环（403）。全部响应 no-store。
  if (pathname === '/admin' || pathname.startsWith('/v1/admin/')) {
    const admin = ops.admin
    if (!admin) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: 'forbidden: 管理端只允许本机回环访问' })
      return
    }
    if (!isLoopbackHost(req.headers.host)) {
      sendJson(res, 403, { error: 'forbidden: Host 必须为本机回环' })
      return
    }
    const isPage = pathname === '/admin' && req.method === 'GET'
    const got = req.headers['x-dsh-sync-token']
    if (!isPage) {
      if (!token || !tokensMatch(got, token)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
    }
    if (req.method !== 'GET') {
      const ct = String(req.headers['content-type'] || '').trim().toLowerCase()
      if (!ct.startsWith('application/json')) {
        sendJson(res, 415, { error: 'unsupported media type: 非 GET 管理请求要求 content-type: application/json' })
        return
      }
      const origin = req.headers.origin
      if (origin !== undefined && !isLoopbackOrigin(origin)) {
        sendJson(res, 403, { error: 'forbidden: 跨站 Origin 被拒绝' })
        return
      }
    }
    await handleAdmin(req, res, url, pathname, admin)
    return
  }

  if (pathname !== '/v1/ping') {
    const got = req.headers['x-dsh-sync-token']
    if (!token || !tokensMatch(got, token)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
  }

  if (req.method === 'GET' && pathname === '/v1/ping') {
    sendJson(res, 200, {
      ok: true,
      device: ops.getDevice(),
      role: ops.getRole(),
      version: ops.getVersion(),
    })
    return
  }

  if (req.method === 'GET' && pathname === '/v1/index') {
    const files = await ops.getIndex()
    sendJson(res, 200, {
      version: 1,
      device: ops.getDevice(),
      updatedAt: new Date().toISOString(),
      files,
    })
    return
  }

  const blobMatch = pathname.match(/^\/v1\/blob\/([0-9a-zA-Z]+)$/)
  if (blobMatch) {
    const sha1 = blobMatch[1]
    if (req.method === 'GET') {
      const buf = await ops.getBlob(sha1)
      if (buf === null || buf === undefined) {
        sendJson(res, 404, { error: 'blob not found' })
        return
      }
      if (buf.length > MAX_BLOB_BYTES) {
        sendJson(res, 413, { error: 'blob too large' })
        return
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': buf.length,
        'cache-control': 'no-store',
      })
      res.end(buf)
      return
    }
    if (req.method === 'PUT') {
      const body = await readBody(req)
      const actual = crypto.createHash('sha1').update(body).digest('hex')
      if (actual !== sha1) {
        sendJson(res, 400, { error: `sha1 mismatch: got ${actual}, want ${sha1}` })
        return
      }
      const rel = req.headers['x-dsh-sync-path']
      await ops.putBlob(body, typeof rel === 'string' && rel ? rel : undefined)
      sendJson(res, 200, { ok: true, sha1: actual, size: body.length })
      return
    }
  }

  sendJson(res, 404, { error: 'not found' })
}

async function handleAdmin(req, res, url, pathname, admin) {
  const parseJsonBody = async () => {
    const raw = (await readBody(req)).toString('utf8')
    try {
      return raw ? JSON.parse(raw) : {}
    } catch {
      throw Object.assign(new Error('body 不是合法 JSON'), { statusCode: 400 })
    }
  }
  if (req.method === 'GET' && pathname === '/admin') {
    sendHtml(res, 200, typeof admin.html === 'string' ? admin.html : ADMIN_HTML)
    return
  }
  if (req.method === 'GET' && pathname === '/v1/admin/status') {
    sendJson(res, 200, await admin.getStatus())
    return
  }
  if (req.method === 'GET' && pathname === '/v1/admin/config') {
    sendJson(res, 200, await admin.getConfig())
    return
  }
  if (req.method === 'PUT' && pathname === '/v1/admin/config') {
    const body = await parseJsonBody()
    if (!body || typeof body !== 'object' || Array.isArray(body) || !body.set || typeof body.set !== 'object' || Array.isArray(body.set)) {
      sendJson(res, 400, { error: 'body 应为 {"set":{...}}' })
      return
    }
    sendJson(res, 200, await admin.putConfig(body.set))
    return
  }
  if (req.method === 'POST' && pathname === '/v1/admin/sync') {
    sendJson(res, 200, await admin.triggerSync())
    return
  }
  if (req.method === 'GET' && pathname === '/v1/admin/update/check') {
    sendJson(res, 200, await admin.updateCheck())
    return
  }
  if (req.method === 'POST' && pathname === '/v1/admin/update/apply') {
    const body = await parseJsonBody()
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { error: 'body 应为 JSON 对象 {version?, force?}' })
      return
    }
    sendJson(res, 200, await admin.updateApply(body))
    return
  }
  sendJson(res, 404, { error: 'not found' })
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      resolve(server.address().port)
    })
  })
}

export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
}
