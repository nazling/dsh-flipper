// 走真实 defineTool 包装：验证输出能通过 JSON 校验，且 undefined 不泄漏。
import assert from 'node:assert/strict'
import { startMockFlipper } from './mock-flipper.mjs'
import { apply } from '../index.js'

process.env.DSH_HOME = '/tmp/dsh-flipper-test'
const mock = await startMockFlipper({ host: '127.0.0.1', port: 0 })
console.log('mock', mock.port)
const tools = []
const ctx = {
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
  inject: () => {},
}
const config = { transport: 'tcp', tcpHost: '127.0.0.1', tcpPort: mock.port, serialPath: '', baud: 230400, timeoutMs: 8000 }
// 清掉测试目录里可能存在的旧配置
apply(ctx, config)
const tool = (name) => tools.find((item) => item.name === name)
const assertLossless = (value, label) => {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, label + ' 不是 lossless JSON')
}
const exec = { signal: new AbortController().signal }

console.log('step status')
const status = await tool('flipper_status').execute({}, exec)
assertLossless(status, 'flipper_status')
assert.equal(status.firmware, '1.2.3-mock')
assert.equal(status.battery.charging, false)

console.log('step screen')
const caps = await tool('flipper_capabilities').execute({}, exec)
assertLossless(caps, 'flipper_capabilities')
assert.ok(caps.builtinApps.length > 5)
assert.ok(caps.resources['/ext/nfc'])

const screen = await tool('flipper_screen').execute({ format: 'braille' }, exec)
assertLossless(screen, 'flipper_screen')
assert.ok(screen.pngPath)

console.log('step list')
const list = await tool('flipper_storage').execute({ action: 'list', path: '/ext' }, exec)
assertLossless(list, 'flipper_storage')
assert.equal(list.count, 3)

console.log('step app')
const app = await tool('flipper_app').execute({ action: 'start', name: 'Sub-GHz' }, exec)
console.log('app ok')
assertLossless(app, 'flipper_app')

console.log('cli start')
const cli = await tool('flipper_cli').execute({ command: 'power info' }, exec)
console.log('cli ok', cli.complete)
assertLossless(cli, 'flipper_cli')
assert.ok(cli.output.includes('Charge level'))

console.log('PASS 工具输出与真实 defineTool 校验')
await tool('flipper_disconnect').execute({}, exec)
await mock.close()
console.log('closed')
