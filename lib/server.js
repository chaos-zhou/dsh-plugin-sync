import http from 'node:http'
import crypto from 'node:crypto'
import { MAX_BLOB_BYTES } from './limits.js'

const MAX_BODY = MAX_BLOB_BYTES

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

  if (pathname !== '/v1/ping') {
    const got = req.headers['x-dsh-sync-token']
    if (!token || got !== token) {
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
