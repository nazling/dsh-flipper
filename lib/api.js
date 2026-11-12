// 面板用的 HTTP 接口族：/api/dsh-flipper/*
// 浏览器半边（lib/client.js）只通过这里操作 Flipper —— 电脑端不用敲命令、不用开 python。
// 只允许本机回环访问：面板操作包括按键、发文件、跑 CLI，不能给局域网随便调。
import { koffiDiagnostics, win32SerialAvailable } from './serial-koffi.js'

const PREFIX = '/api/dsh-flipper'
const BODY_LIMIT = 1024 * 1024

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  if (LOOPBACK.has(address)) return true
  // 桌面端有时走 unix socket / 内部代理
  return address === '' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体太大（上限 1 MiB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

const asNum = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 造路由表。返回 [{kind:'prefix', path, handler}]，交给 ctx.webServer.register。
 */
export function createFlipperRoutes({ manager, getConfig = () => ({}) }) {
  const handlers = {
    'GET state': async () => {
      const ports = await manager.ports().then((result) => result.ports).catch(() => [])
      const cached = manager.cached()
      const config = getConfig()
      return {
        ok: true,
        connected: cached.connected,
        endpoint: cached.endpoint,
        error: manager.lastError,
        config: {
          transport: config.transport ?? 'auto',
          serialPath: config.serialPath ?? '',
          tcpHost: config.tcpHost ?? '',
          tcpPort: config.tcpPort ?? 9757,
          baud: config.baud ?? 230400,
          link: config.link ?? 'auto',
        },
        ports,
        backend: {
          platform: process.platform,
          win32Native: win32SerialAvailable(),
          ...koffiDiagnostics(),
        },
      }
    },

    'GET status': async () => {
      const status = await manager.status()
      return { ok: true, status }
    },

    'GET ports': async (req) => {      const url = new URL(req.url ?? '/', 'http://x')
      const refresh = url.searchParams.get('refresh') === '1'
      const result = await manager.ports({ refresh })
      return { ok: true, ports: result.ports }
    },

    'POST connect': async (_req, body) => {
      const patch = {}
      if (body.transport) patch.transport = String(body.transport)
      if (body.path) {
        patch.serialPath = String(body.path)
        patch.transport = 'serial'
        patch.tcpHost = ''
      }
      if (body.host) {
        patch.tcpHost = String(body.host)
        patch.transport = 'tcp'
      }
      if (body.port !== undefined) patch.tcpPort = asNum(body.port, 9757)
      if (body.baud !== undefined) patch.baud = asNum(body.baud, 230400)
      if (body.link) patch.link = String(body.link)
      if (Object.keys(patch).length) await manager.configure(patch)
      await manager.disconnect()
      const status = await manager.status({ refresh: true })
      return { ok: true, status }
    },

    'POST disconnect': async () => {
      await manager.disconnect()
      return { ok: true, connected: false }
    },

    'GET screen': async (req) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const withAscii = url.searchParams.get('ascii') === '1'
      const timeoutMs = asNum(url.searchParams.get('timeoutMs'), 3500)
      if (withAscii) {
        const shot = await manager.screen({ format: 'ascii', save: false, timeoutMs })
        return { ok: true, ...shot }
      }
      return manager.screenPng({ timeoutMs })
    },

    'POST input': async (_req, body) => {
      const keys = Array.isArray(body.keys) ? body.keys : body.key ? [{ key: String(body.key), type: body.type ?? 'short' }] : []
      if (keys.length === 0) throw new Error('keys 不能为空')
      const result = await manager.press(keys, { delayMs: asNum(body.delayMs, 120) })
      let screen = null
      if (body.observe !== false) {
        try {
          screen = (await manager.screenPng({ timeoutMs: 2500 })).dataUrl
        } catch {}
      }
      return { ok: true, ...result, screen }
    },

    'GET apps': async () => manager.apps(),

    'POST app': async (_req, body) => {
      const result = await manager.app({
        action: String(body.action || 'start'),
        name: body.name ? String(body.name) : undefined,
        args: body.args === undefined ? undefined : String(body.args),
        path: body.path ? String(body.path) : undefined,
        index: asNum(body.index, 0),
        text: body.buttonType ? String(body.buttonType) : 'press',
      })
      return { ok: true, ...result }
    },

    'GET capabilities': async (req) => {
      const url = new URL(req.url ?? '/', 'http://x')
      return manager.capabilities({ refresh: url.searchParams.get('refresh') === '1' })
    },

    'POST storage': async (_req, body) => {
      return manager.storage({
        action: String(body.action || 'list'),
        path: body.path ? String(body.path) : undefined,
        to: body.to ? String(body.to) : undefined,
        content: body.content,
        encoding: body.encoding ? String(body.encoding) : 'auto',
        recursive: body.recursive === true,
        includeMd5: body.includeMd5 === true,
        maxBytes: asNum(body.maxBytes, 65536),
      })
    },

    'POST cli': async (_req, body) => {
      const command = String(body.command || '').trim()
      if (!command) throw new Error('command 不能为空')
      if (/^factory_reset\b/i.test(command)) throw new Error('面板里不给跑 factory_reset，请用 flipper_system 工具确认后执行')
      return manager.cli(command, { timeoutMs: asNum(body.timeoutMs, 8000) })
    },

    'POST system': async (_req, body) => {
      return manager.system({
        action: String(body.action || 'info'),
        mode: body.mode ? String(body.mode) : undefined,
        property: body.property ? String(body.property) : undefined,
        datetime: body.datetime ? String(body.datetime) : undefined,
        confirm: body.confirm,
      })
    },

    'GET logs': async (req) => {
      const url = new URL(req.url ?? '/', 'http://x')
      return manager.recentLogs(asNum(url.searchParams.get('limit'), 40))
    },
  }

  async function handle(req, res) {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: 'forbidden: 只允许本机访问' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const name = url.pathname.slice(PREFIX.length).replace(/^\/+/, '')
    const method = String(req.method || 'GET').toUpperCase()
    const handler = handlers[`${method} ${name}`]
    if (!handler) {
      sendJson(res, 404, { error: `未知接口 ${method} ${url.pathname}` })
      return
    }
    try {
      const body = method === 'POST' ? await readBody(req) : {}
      const result = await handler(req, body ?? {})
      sendJson(res, 200, result ?? { ok: true })
    } catch (error) {
      const message = String(error?.message || error)
      sendJson(res, 200, { ok: false, error: message })
    }
  }

  return [
    {
      kind: 'prefix',
      path: PREFIX,
      handler: handle,
    },
  ]
}

export { PREFIX as FLIPPER_API_PREFIX }
