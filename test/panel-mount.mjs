// 插件挂载测试：走真实 index.js apply()，用假 ctx 检查工具、系统提示、技能、面板路由都挂上了。
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

process.env.DSH_HOME = process.env.DSH_HOME || path.join(os.tmpdir(), 'dsh-flipper-test')
const tools = []
const routes = []
const promptSections = []
const skills = []

const fakeContext = {
  tools: {
    register: (definition) => {
      tools.push(definition)
      return () => {}
    },
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
  systemPrompt: { section: (section) => promptSections.push(section) },
  skills: { register: (definition) => skills.push(definition) },
  // index.js 用 ctx.inject(['service'], cb) 挂载可选能力
  inject: (services, callback) => {
    const target = {}
    let ready = true
    for (const service of services) {
      if (fakeContext[service]) target[service] = fakeContext[service]
      else ready = false
    }
    if (ready) callback(target)
    return () => {}
  },
  get: (name) => fakeContext[name],
}

apply(fakeContext, { transport: 'auto', autoConnect: false, baud: 230400, timeoutMs: 8000 })

const checks = []
const ok = (name, fn) => checks.push({ name, fn })

ok('注册了 11 个工具', () => {
  const names = tools.map((tool) => tool.name).sort()
  assert.equal(names.length, 11, names.join(','))
  for (const expected of ['flipper_connect', 'flipper_screen', 'flipper_cli', 'flipper_system']) {
    assert.ok(names.includes(expected), 'missing ' + expected)
  }
})

ok('系统提示注入了 flipper 段', () => {
  const section = promptSections.find((item) => item.name === 'tool:flipper')
  assert.ok(section, '没有 tool:flipper 段')
  assert.ok(section.text.includes('Flipper'))
  assert.ok(section.text.includes('面板'))
})

ok('技能已注册', () => {
  assert.ok(skills.length >= 1)
  assert.ok(JSON.stringify(skills[0]).includes('Flipper'))
})

ok('面板路由挂在 /api/dsh-flipper', () => {
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/api/dsh-flipper')
})

ok('路由拒绝非本机请求', async () => {
  const sent = []
  const req = { method: 'GET', url: '/api/dsh-flipper/state', socket: { remoteAddress: '192.168.1.50' } }
  const res = {
    writeHead: (status) => sent.push(status),
    end: () => {},
  }
  await routes[0].handler(req, res)
  assert.equal(sent[0], 403)
})

ok('未知接口返回 404 结构', async () => {
  let body = ''
  const req = { method: 'GET', url: '/api/dsh-flipper/nope', socket: { remoteAddress: '127.0.0.1' } }
  const res = {
    writeHead: () => {},
    end: (chunk) => {
      body += chunk ? String(chunk) : ''
    },
  }
  await routes[0].handler(req, res)
  const parsed = JSON.parse(body)
  assert.ok(String(parsed.error).includes('未知接口'))
})

for (const check of checks) {
  try {
    const result = check.fn()
    if (result && typeof result.then === 'function') await result
    console.log('PASS', check.name)
  } catch (error) {
    console.error('FAIL', check.name)
    console.error(error)
    process.exitCode = 1
  }
}

if (process.exitCode) console.error('有测试失败')
else console.log('\n全部通过')
