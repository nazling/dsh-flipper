// 面板接口测试：/api/dsh-flipper/* 走真实 http，Manager 连的是模拟 Flipper。
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { startMockFlipper } from './mock-flipper.mjs'
import { FlipperManager } from '../lib/manager.js'
import { createFlipperRoutes } from '../lib/api.js'

process.env.DSH_HOME = process.env.DSH_HOME || path.join(os.tmpdir(), 'dsh-flipper-test')
delete process.env.FLIPPER_TCP
delete process.env.FLIPPER_SERIAL
delete process.env.FLIPPER_ENDPOINT

const mock = await startMockFlipper()
const manager = new FlipperManager()
manager.runtime = {
  transport: 'tcp',
  tcpHost: '127.0.0.1',
  tcpPort: mock.port,
  serialPath: '',
  baud: 230400,
  timeoutMs: 8000,
  link: 'auto',
}
const routes = createFlipperRoutes({ manager, getConfig: () => manager.config })
const server = http.createServer((req, res) => routes[0].handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/api/dsh-flipper`

async function api(path, body) {
  const response = await fetch(base + path, body === undefined
    ? { headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return response.json()
}

const checks = []
const ok = (name, fn) => checks.push({ name, fn })

ok('state：连接前是未连接且带配置/端口字段', async () => {
  const state = await api('/state')
  assert.equal(state.ok, true)
  assert.equal(state.connected, false)
  assert.equal(typeof state.config.transport, 'string')
  assert.ok(Array.isArray(state.ports))
  assert.equal(state.backend.platform, process.platform)
})

ok('connect + status：拿到固件、电量、存储、端点', async () => {
  const connected = await api('/connect', {})
  assert.equal(connected.ok, true, connected.error)
  assert.equal(connected.status.firmware, '1.2.3-mock')
  const status = await api('/status')
  assert.equal(status.ok, true, status.error)
  assert.equal(status.status.battery.level, 78)
  assert.equal(status.status.storage.total, 8 * 1024 * 1024 * 1024)
  assert.equal(status.status.link, 'usb')
})

ok('screen：返回 PNG dataUrl', async () => {
  const shot = await api('/screen?timeoutMs=4000')
  assert.equal(shot.ok, true, shot.error)
  assert.ok(shot.dataUrl.startsWith('data:image/png;base64,'))
  assert.equal(shot.width, 128)
  assert.equal(shot.height, 64)
})

ok('input：按键并回传新画面', async () => {
  const pressed = await api('/input', { key: 'down' })
  assert.equal(pressed.ok, true, pressed.error)
  assert.equal(pressed.sent.length, 1)
  assert.ok(String(pressed.screen).startsWith('data:image/png'))
  assert.deepEqual(mock.state.inputs.map((event) => event.key), [1, 1, 1])
})

ok('apps：内置 App 清单', async () => {
  const apps = await api('/apps')
  assert.equal(apps.ok, true)
  assert.ok(apps.apps.length >= 8)
})

ok('storage：列目录 + 写读文件', async () => {
  const list = await api('/storage', { action: 'list', path: '/ext' })
  assert.equal(list.ok, true, list.error)
  assert.equal(list.count, 3)
  const write = await api('/storage', { action: 'write', path: '/ext/panel.txt', content: 'hello panel', encoding: 'text' })
  assert.equal(write.ok, true, write.error)
  const read = await api('/storage', { action: 'read', path: '/ext/panel.txt', maxBytes: 4096 })
  assert.equal(read.ok, true, read.error)
  assert.equal(read.text, 'hello panel')
})

ok('cli：命令输出', async () => {
  const cli = await api('/cli', { command: 'power info' })
  assert.equal(cli.ok, true, cli.error)
  assert.ok(String(cli.output).includes('Charge level: 78'), cli.output)
})

ok('logs：有连接日志', async () => {
  const logs = await api('/logs?limit=10')
  assert.equal(logs.ok, true)
  assert.ok(Array.isArray(logs.lines))
})

ok('disconnect', async () => {
  const done = await api('/disconnect', {})
  assert.equal(done.ok, true)
  assert.equal(done.connected, false)
})

ok('未知接口返回 404 结构', async () => {
  const missing = await api('/nope')
  assert.equal(missing.ok, undefined)
  assert.ok(String(missing.error).includes('未知接口'))
})

ok('factory_reset 被 CLI 接口拦住', async () => {
  const blocked = await api('/cli', { command: 'factory_reset' })
  assert.equal(blocked.ok, false)
  assert.ok(String(blocked.error).includes('factory_reset'))
})

for (const check of checks) {
  try {
    await check.fn()
    console.log('PASS', check.name)
  } catch (error) {
    console.error('FAIL', check.name)
    console.error(error)
    process.exitCode = 1
  }
}

server.close()
await manager.disconnect()
await mock.close()
if (process.exitCode) console.error('有测试失败')
else console.log('\n全部通过')
