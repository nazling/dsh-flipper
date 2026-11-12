// 传输层：TCP（手机/局域网常用）与串口（电脑直连）。
// 电脑串口优先走 lib/serial-koffi.js：直接调 Win32 API，不需要 python 桥，
// 也不需要编译原生模块。koffi 不可用时退回 POSIX fs/stty，再不行就用 tools/flipper-bridge.py。
import net from 'node:net'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { Win32SerialTransport, win32SerialAvailable } from './serial-koffi.js'
import { listSerialPorts, pickFlipperPort } from './ports.js'

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class TcpTransport extends EventEmitter {
  constructor({ host, port, connectTimeoutMs = 6000 }) {
    super()
    this.host = host
    this.port = port
    this.connectTimeoutMs = connectTimeoutMs
    this.socket = null
    this.description = `tcp://${host}:${port}`
  }

  open() {
    if (this.socket) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port })
      this.socket = socket
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`连接 ${this.host}:${this.port} 超时`))
      }, this.connectTimeoutMs)
      socket.setNoDelay(true)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        if (this.socket === socket) this.socket = null
        reject(error)
      })
      socket.on('data', (chunk) => this.emit('data', chunk))
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null
        this.emit('close')
      })
    })
  }

  write(buffer) {
    if (!this.socket) return Promise.reject(new Error('TCP 连接未建立'))
    return new Promise((resolve, reject) => {
      this.socket.write(buffer, (error) => (error ? reject(error) : resolve()))
    })
  }

  async close() {
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.removeAllListeners('data')
      socket.destroy()
    }
  }
}

export class SerialTransport extends EventEmitter {
  constructor({ path, baud = 230400 }) {
    super()
    this.path = path
    this.baud = baud
    this.handle = null
    this.running = false
    this.readBuffer = Buffer.alloc(8192)
    this.description = `serial://${path}@${baud}`
  }

  async open() {
    if (this.handle) return
    await configureSerial(this.path, this.baud)
    const flags =
      process.platform === 'win32'
        ? fs.constants.O_RDWR
        : fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK
    this.handle = await fsp.open(this.path, flags)
    this.running = true
    this.loop = this.#readLoop()
    this.loop.catch(() => {})
  }

  async #readLoop() {
    while (this.running) {
      let bytesRead
      try {
        ;({ bytesRead } = await this.handle.read(this.readBuffer, 0, this.readBuffer.length, null))
      } catch (error) {
        if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK' || error.code === 'EINTR') {
          await sleep(8)
          continue
        }
        if (this.running) {
          this.running = false
          this.emit('error', error)
          this.emit('close')
        }
        return
      }
      if (bytesRead > 0) {
        this.emit('data', Buffer.from(this.readBuffer.subarray(0, bytesRead)))
      } else {
        await sleep(10)
      }
    }
  }

  async write(buffer) {
    if (!this.handle) throw new Error('串口未打开')
    let offset = 0
    while (offset < buffer.length) {
      try {
        const { bytesWritten } = await this.handle.write(
          buffer,
          offset,
          buffer.length - offset,
          null,
        )
        offset += bytesWritten
        if (bytesWritten === 0) await sleep(5)
      } catch (error) {
        if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK' || error.code === 'EINTR') {
          await sleep(5)
          continue
        }
        throw error
      }
    }
  }

  async close() {
    this.running = false
    const handle = this.handle
    this.handle = null
    if (handle) {
      try {
        await handle.close()
      } catch {}
    }
  }
}

async function configureSerial(path, baud) {
  if (process.platform === 'win32') {
    const name = path.replace(/^\\\\\.\\/, '')
    try {
      await execFileP('mode', [`${name}`, `BAUD=${baud}`, 'PARITY=n', 'DATA=8', 'STOP=1'])
    } catch {}
    return
  }
  const flag = process.platform === 'darwin' ? '-f' : '-F'
  try {
    await execFileP('stty', [flag, path, String(baud), 'raw', '-echo', '-echoe', '-echok', '-echoctl', '-echoke'])
  } catch (error) {
    throw new Error(`串口初始化失败（stty ${path}）：${error.message}`)
  }
}

/** 找找本机像 Flipper 的串口（同步版，仅 POSIX 有用；Windows 请用 listSerialPorts）。 */
export function discoverSerialPorts() {
  const found = []
  if (process.platform === 'win32') return found
  let names = []
  try {
    names = fs.readdirSync('/dev')
  } catch {
    return found
  }
  for (const name of names) {
    if (!/^(ttyACM|ttyUSB|cu\.usbmodem|tty\.usbmodem)/.test(name)) continue
    const path = '/dev/' + name
    let isFlipper = true
    if (process.platform === 'linux' && name.startsWith('tty')) {
      try {
        const base = `/sys/class/tty/${name}/device/..`
        const vid = fs.readFileSync(base + '/idVendor', 'utf8').trim()
        const pid = fs.readFileSync(base + '/idProduct', 'utf8').trim()
        isFlipper = vid === '0483' && pid === '5740'
      } catch {
        isFlipper = false
      }
    }
    if (isFlipper) found.push(path)
  }
  return found
}

/**
 * 按平台造一个串口传输层。
 * Windows 且 koffi 可用 → Win32 直调（推荐）；否则退回 fs/stty 版本。
 */
export function createSerialTransport({ path, baud = 230400, log = () => {} } = {}) {
  if (!path) throw new Error('串口模式缺少设备路径')
  if (process.platform === 'win32' && win32SerialAvailable()) {
    return new Win32SerialTransport({ path, baud, log })
  }
  return new SerialTransport({ path, baud })
}

export { listSerialPorts, pickFlipperPort }

/** 解析 "tcp://192.168.1.5:9757" 或 "serial:///dev/ttyACM0" */
export function parseEndpoint(text) {
  const value = String(text || '').trim()
  if (!value) return null
  if (value.startsWith('tcp://')) {
    const rest = value.slice(6)
    const index = rest.lastIndexOf(':')
    if (index < 0) throw new Error('TCP 地址要写成 tcp://host:port')
    return { kind: 'tcp', host: rest.slice(0, index), port: Number(rest.slice(index + 1)) }
  }
  if (value.startsWith('serial://')) {
    return { kind: 'serial', path: value.slice(9) }
  }
  if (/^[\w.-]+:\d+$/.test(value)) {
    const index = value.lastIndexOf(':')
    return { kind: 'tcp', host: value.slice(0, index), port: Number(value.slice(index + 1)) }
  }
  if (value.startsWith('/dev/') || value.startsWith('COM')) {
    return { kind: 'serial', path: value }
  }
  return null
}
