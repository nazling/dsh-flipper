// 运行时配置：连接方式、超时、截图目录。
// 优先级：环境变量 > $DSH_HOME/flipper/config.json > 插件设置里的默认值。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULTS = {
  transport: 'auto', // auto | tcp | serial
  tcpHost: '',
  tcpPort: 9757,
  serialPath: '',
  baud: 230400,
  timeoutMs: 8000,
  // auto: 手机/平板(BLE 桥) = ble；电脑串口 = serial；电脑 TCP 桥 = usb
  link: 'auto',
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function stateDir() {
  return path.join(dshHome(), 'flipper')
}

export function screensDir() {
  return path.join(stateDir(), 'screens')
}

export function configPath() {
  return path.join(stateDir(), 'config.json')
}

export function loadRuntimeConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    // 只返回文件里真正写过的键：空文件不能把插件设置里的连接参数盖掉。
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function saveRuntimeConfig(config) {
  await fsp.mkdir(stateDir(), { recursive: true })
  const clean = { ...DEFAULTS, ...config }
  await fsp.writeFile(configPath(), JSON.stringify(clean, null, 2) + '\n', 'utf8')
  return clean
}

export function mergeConfig(base = {}, runtime = {}, env = process.env) {
  const merged = { ...DEFAULTS, ...base, ...runtime }
  const tcp = env.FLIPPER_TCP || env.FLIPPER_ENDPOINT
  if (tcp && /:\d+$/.test(tcp)) {
    const index = tcp.lastIndexOf(':')
    merged.transport = 'tcp'
    merged.tcpHost = tcp.slice(0, index).replace(/^tcp:\/\//, '')
    merged.tcpPort = Number(tcp.slice(index + 1))
  }
  const serial = env.FLIPPER_SERIAL
  if (serial) {
    merged.transport = 'serial'
    merged.serialPath = serial
  }
  return merged
}

export async function ensureScreensDir() {
  const dir = screensDir()
  await fsp.mkdir(dir, { recursive: true })
  return dir
}
