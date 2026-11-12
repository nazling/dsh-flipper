// 离线端到端测试：模拟 Flipper ↔ RPC 客户端 ↔ 高层 Manager。
// 运行：DSH_HOME=/tmp/dsh-flipper-test node test/e2e.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startMockFlipper } from './mock-flipper.mjs'
import { TcpTransport } from '../lib/transport.js'
import { FlipperRpc } from '../lib/rpc.js'
import { FlipperManager } from '../lib/manager.js'
import { toAsciiArt, toBraille, framebufferToBitmap, encodePng } from '../lib/screen.js'

process.env.DSH_HOME = process.env.DSH_HOME || '/tmp/dsh-flipper-test'

const checks = []
function ok(name, fn) {
  checks.push({ name, fn })
}

ok('低层 ping', async () => {
  const mock = await startMockFlipper()
  const rpc = new FlipperRpc(new TcpTransport({ host: '127.0.0.1', port: mock.port }))
  await rpc.connect()
  const messages = await rpc.request({ field: 5, payload: Buffer.from([0x0a, 0x03, 0x64, 0x73, 0x68]) })
  assert.equal(messages[0].field, 6)
  assert.equal(messages[0].body.data.toString(), 'dsh')
  await rpc.disconnect()
  await mock.close()
})

ok('Manager 状态/屏幕/按键/存储/CLI/App', async () => {
  const mock = await startMockFlipper()
  const manager = new FlipperManager()
  manager.runtime = {
    transport: 'tcp',
    tcpHost: '127.0.0.1',
    tcpPort: mock.port,
    serialPath: '',
    baud: 230400,
    timeoutMs: 8000,
  }

  const status = await manager.status()
  assert.equal(status.ok, true)
  assert.equal(status.firmware, '1.2.3-mock')
  assert.equal(status.battery.level, 78)
  assert.equal(status.battery.voltage, 4021)
  assert.equal(status.storage.total, 8 * 1024 * 1024 * 1024)
  assert.equal(status.protobuf.minor, 22)

  const screen = await manager.screen({ format: 'both', save: false })
  assert.equal(screen.width, 128)
  assert.equal(screen.height, 64)
  assert.ok(screen.ascii.includes('█') || screen.ascii.includes('▀') || screen.ascii.includes('▄'))
  assert.ok(screen.braille.length > 0)
  assert.ok(screen.dataUrl.startsWith('data:image/png;base64,'))

  const png = Buffer.from(screen.dataUrl.split(',')[1], 'base64')
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const pressed = await manager.press(['down', 'ok'], { delayMs: 10 })
  assert.equal(pressed.sent.length, 2)
  assert.deepEqual(
    mock.state.inputs.map((event) => event.key),
    [1, 1, 1, 4, 4, 4],
  )
  assert.deepEqual(
    mock.state.inputs.map((event) => event.type),
    [0, 2, 1, 0, 2, 1],
  )

  const list = await manager.storage({ action: 'list', path: '/ext' })
  assert.equal(list.count, 3)
  assert.equal(list.files[0].type, 'dir')

  const payload = Buffer.from('hello flipper\n'.repeat(90), 'utf8')
  const written = await manager.storage({
    action: 'write',
    path: '/ext/test.txt',
    content: payload.toString('base64'),
    encoding: 'base64',
  })
  assert.equal(written.size, payload.length)

  const read = await manager.storage({ action: 'read', path: '/ext/test.txt', encoding: 'text' })
  assert.equal(read.size, payload.length)
  assert.equal(read.text, payload.toString('utf8'))

  const cli = await manager.cli('power info')
  assert.equal(cli.complete, true)
  assert.ok(cli.output.includes('Charge level: 78'))
  const statusAfterCli = await manager.status()
  assert.equal(statusAfterCli.connected, true)

  const app = await manager.app({ action: 'start', name: 'Sub-GHz', args: 'RPC' })
  assert.equal(app.ok, true)
  const load = await manager.app({ action: 'load_file', path: '/ext/subghz/door.sub' })
  assert.equal(load.ok, true)

  const datetime = await manager.system({ action: 'datetime' })
  assert.equal(datetime.iso, '2026-11-08T17:30:05')

  const stats = await manager.system({ action: 'info' })
  assert.equal(stats.info.hardware_model, 'Flipper Zero')

  await manager.disconnect()
  await mock.close()
})

ok('屏幕渲染纯函数', async () => {
  const fb = Buffer.alloc(1024)
  fb[0] = 0x01
  fb[7 * 128 + 127] = 0x80
  const bitmap = framebufferToBitmap(fb, 0)
  assert.equal(bitmap.pixels[0], 1)
  const ascii = toAsciiArt(bitmap)
  assert.ok(ascii.startsWith('▀') || ascii.startsWith('█'))
  const braille = toBraille(bitmap)
  assert.ok(braille.startsWith('⠁'))
  const png = encodePng(bitmap)
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
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

if (process.exitCode) {
  console.error('有测试失败')
} else {
  console.log('\n全部通过')
}
