// Windows 串口：直接用 koffi 调 kernel32（CreateFileW/SetCommState/ReadFile/WriteFile）。
// 目的：电脑上不再需要 python + pyserial + tools/flipper-bridge.py。
// koffi 是 DSH 桌面端自带的依赖（app.asar.unpacked/node_modules/koffi），
// 找不到时由上层退回 tools/flipper-bridge.py 或 fs 直读。
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const OPEN_EXISTING = 3
const PURGE_ALL = 0x0001 | 0x0002 | 0x0004 | 0x0008
const ERROR_OPERATION_ABORTED = 995
const ERROR_DEVICE_NOT_CONNECTED = 1167
const ERROR_INVALID_HANDLE = 6
const ERROR_ACCESS_DENIED = 5

let moduleCache = null
let loadError = null

const KOFFI_TAIL = ['node_modules', 'koffi']
const UNPACKED_TAIL = ['app.asar.unpacked', 'node_modules', 'koffi']

/** 在 root 往下找 <任意目录>/resources/app.asar.unpacked/node_modules/koffi（带预算，避免扫盘）。 */
function walkForKoffi(root, maxDepth = 2, budget = 800) {
  const found = []
  const stack = [{ dir: root, depth: 0 }]
  let visited = 0
  while (stack.length > 0 && visited < budget) {
    const { dir, depth } = stack.pop()
    visited += 1
    found.push(path.join(dir, 'resources', ...UNPACKED_TAIL))
    found.push(path.join(dir, ...UNPACKED_TAIL))
    if (depth >= maxDepth) continue
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (name === 'node_modules' || name.startsWith('.') || name === '$Recycle.Bin' || name === 'Windows') continue
      stack.push({ dir: path.join(dir, name), depth: depth + 1 })
    }
  }
  return found
}

/** 从某个目录往上爬，找装备包里的 koffi（resources 摆放 / 普通 node_modules 两种形态）。 */
function springboard(startDir, ancestors = 6) {
  const found = []
  let dir = startDir
  for (let level = 0; level < ancestors && dir; level += 1) {
    found.push(path.join(dir, ...KOFFI_TAIL))
    found.push(path.join(dir, 'resources', ...UNPACKED_TAIL))
    found.push(path.join(dir, ...UNPACKED_TAIL))
    // 安装目录常常是 <父目录>/<产品名>/resources/app.asar.unpacked/...
    if (level < 2) found.push(...walkForKoffi(dir, 2))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

/** 候选路径：先按正常解析，再从 DSH 安装目录借；Electron 下走 process.resourcesPath。 */
function koffiCandidates() {
  const list = []
  if (process.env.DSH_FLIPPER_KOFFI) list.push(path.resolve(process.env.DSH_FLIPPER_KOFFI))
  const resources = process.resourcesPath ? String(process.resourcesPath) : ''
  if (resources) {
    list.push(path.join(resources, 'app.asar.unpacked', 'node_modules', 'koffi'))
    list.push(path.join(resources, 'app', 'node_modules', 'koffi'))
  }
  const execDir = process.execPath ? path.dirname(process.execPath) : ''
  if (execDir) list.push(...springboard(execDir))
  try {
    list.push(...springboard(process.cwd(), 5))
  } catch {}
  try {
    const moduleDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    list.push(...springboard(moduleDir, 5))
  } catch {}
  return [...new Set(list.filter(Boolean))]
}

/** 懒加载 koffi：失败返回 null，不影响插件其他功能。 */
export function loadKoffi() {
  if (moduleCache) return moduleCache
  if (loadError !== null) return null
  const tries = ['koffi', ...koffiCandidates()]
  for (const candidate of tries) {
    try {
      const requireFrom = createRequire(
        candidate.endsWith('koffi') ? path.join(candidate, 'noop.js') : path.join(process.cwd(), 'noop.js'),
      )
      const loaded = requireFrom(candidate)
      if (loaded && typeof loaded.load === 'function') {
        moduleCache = loaded
        return moduleCache
      }
    } catch (error) {
      loadError = error
    }
  }
  return null
}

/** koffi 可用性（只探测，不打开串口）。 */
export function win32SerialAvailable() {
  if (process.platform !== 'win32') return false
  return loadKoffi() !== null
}

function nativeApi() {
  const koffi = loadKoffi()
  if (!koffi) throw new Error('没有可用的 koffi（DSH 桌面端自带）。可以改用 TCP 桥：tools/flipper-bridge.py')
  if (nativeApi.cache) return nativeApi.cache
  const kernel32 = koffi.load('kernel32.dll')
  const api = {
    CreateFileW: kernel32.func(
      'void * __stdcall CreateFileW(str16 lpFileName, uint32 dwDesiredAccess, uint32 dwShareMode, void *lpSecurityAttributes, uint32 dwCreationDisposition, uint32 dwFlagsAndAttributes, void *hTemplateFile)',
    ),
    SetCommState: kernel32.func('bool __stdcall SetCommState(void *hFile, const void *lpDCB)'),
    SetCommTimeouts: kernel32.func('bool __stdcall SetCommTimeouts(void *hFile, const void *lpCommTimeouts)'),
    SetupComm: kernel32.func('bool __stdcall SetupComm(void *hFile, uint32 dwInQueue, uint32 dwOutQueue)'),
    PurgeComm: kernel32.func('bool __stdcall PurgeComm(void *hFile, uint32 dwFlags)'),
    ReadFile: kernel32.func(
      'bool __stdcall ReadFile(void *hFile, _Out_ uint8_t *lpBuffer, uint32 nNumberOfBytesToRead, _Out_ uint32 *lpNumberOfBytesRead, void *lpOverlapped)',
    ),
    WriteFile: kernel32.func(
      'bool __stdcall WriteFile(void *hFile, const uint8_t *lpBuffer, uint32 nNumberOfBytesToWrite, _Out_ uint32 *lpNumberOfBytesWritten, void *lpOverlapped)',
    ),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *hObject)'),
    EscapeCommFunction: kernel32.func('bool __stdcall EscapeCommFunction(void *hFile, uint32 dwFunc)'),
    GetLastError: kernel32.func('uint32 __stdcall GetLastError()'),
  }
  nativeApi.cache = api
  return api
}

/** PC 上的串口名统一成设备路径（COM10 以上不加前缀会 ENOENT）。 */
export function windowsDevicePath(name) {
  const clean = String(name || '').trim()
  if (!clean) return ''
  if (clean.startsWith('\\\\')) return clean
  return '\\\\.\\' + clean.replace(/^\\+\.\\/, '')
}

function buildDcb(baud) {
  // DCB 结构 28 字节：binary | DTR_CONTROL_ENABLE | RTS_CONTROL_ENABLE
  const dcb = Buffer.alloc(28)
  dcb.writeUInt32LE(28, 0)
  dcb.writeUInt32LE(Number(baud) || 230400, 4)
  dcb.writeUInt32LE(0x1011, 8)
  dcb.writeUInt32LE(0, 12)
  dcb.writeUInt16LE(4096, 14)
  dcb.writeUInt16LE(4096, 16)
  dcb.writeUInt8(8, 18)
  dcb.writeUInt8(0, 19)
  dcb.writeUInt8(0, 20)
  dcb.writeInt8(0x11, 21)
  dcb.writeInt8(0x13, 22)
  dcb.writeInt8(0, 23)
  dcb.writeInt8(0, 24)
  dcb.writeInt8(0, 25)
  return dcb
}

function buildTimeouts() {
  // ReadIntervalTimeout=MAXDWORD + 两个 0：ReadFile 立即返回缓冲区里的字节，不阻塞线程。
  const timeouts = Buffer.alloc(20)
  timeouts.writeUInt32LE(0xffffffff, 0)
  timeouts.writeUInt32LE(0, 4)
  timeouts.writeUInt32LE(0, 8)
  timeouts.writeUInt32LE(0, 12)
  timeouts.writeUInt32LE(0, 16)
  return timeouts
}

/** 把 GetLastError 变成能看懂的提示。 */
function explain(code, name) {
  if (code === ERROR_ACCESS_DENIED) return `串口 ${name} 被占用（qFlipper / 另一个 DSH / 桥进程还开着）`
  if (code === 2) return `找不到串口 ${name}，确认 USB 线插好、设备已开机`
  if (code === ERROR_DEVICE_NOT_CONNECTED) return `串口 ${name} 已断开`
  if (code === ERROR_INVALID_HANDLE) return `串口 ${name} 句柄无效`
  return `打开串口 ${name} 失败（Win32 错误 ${code}）`
}

/**
 * Win32 串口传输层，接口与 SerialTransport 一致（open/write/close + data/close/error）。
 */
export class Win32SerialTransport extends EventEmitter {
  constructor({ path: devicePath, baud = 230400, pollMs = 4, readChunk = 8192, log = () => {} } = {}) {
    super()
    this.name = String(devicePath || '')
    this.path = windowsDevicePath(this.name)
    this.baud = Number(baud) || 230400
    this.pollMs = pollMs
    this.readChunk = readChunk
    this.log = log
    this.handle = null
    this.running = false
    this.timer = null
    this.description = `serial://${this.name}@${this.baud}`
    this.bytesIn = 0
    this.bytesOut = 0
  }

  async open() {
    if (this.handle) return
    const api = nativeApi()
    const handle = api.CreateFileW(this.path, GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, 0, null)
    const code = api.GetLastError()
    const invalid = handle === null || handle === undefined || handle === -1n || String(handle) === '-1'
    if (invalid) throw new Error(explain(code, this.name))
    this.handle = handle
    if (!api.SetCommState(handle, buildDcb(this.baud))) {
      const err = api.GetLastError()
      this.#release()
      throw new Error(`串口 ${this.name} 波特率设置失败（Win32 错误 ${err}）`)
    }
    api.SetupComm(handle, 8192, 8192)
    api.SetCommTimeouts(handle, buildTimeouts())
    api.PurgeComm(handle, PURGE_ALL)
    this.running = true
    this.#pump()
  }

  #release() {
    const api = nativeApi()
    const handle = this.handle
    this.handle = null
    if (handle) {
      try {
        api.CloseHandle(handle)
      } catch {}
    }
  }

  #pump() {
    if (!this.running) return
    const api = nativeApi()
    const handle = this.handle
    if (!handle) return
    const buffer = Buffer.allocUnsafe(this.readChunk)
    const read = [0]
    let ok = false
    try {
      ok = api.ReadFile(handle, buffer, buffer.length, read, null)
    } catch (error) {
      this.#fail(error)
      return
    }
    const count = read[0] >>> 0
    if (count > 0) {
      this.bytesIn += count
      this.emit('data', Buffer.from(buffer.subarray(0, count)))
    }
    if (!ok) {
      const code = api.GetLastError()
      if (code !== 0 && code !== ERROR_OPERATION_ABORTED) {
        this.#fail(new Error(explain(code, this.name)))
        return
      }
    }
    this.timer = setTimeout(() => this.#pump(), count > 0 ? 0 : this.pollMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  #fail(error) {
    if (!this.running) return
    this.running = false
    this.#release()
    this.emit('error', error)
    this.emit('close')
  }

  async write(buffer) {
    const api = nativeApi()
    const handle = this.handle
    if (!handle) throw new Error('串口未打开')
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    let offset = 0
    while (offset < data.length) {
      const written = [0]
      const chunk = data.subarray(offset)
      const ok = api.WriteFile(handle, chunk, chunk.length, written, null)
      if (!ok) {
        const code = api.GetLastError()
        throw new Error(explain(code, this.name))
      }
      const count = written[0] >>> 0
      if (count === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2))
        continue
      }
      this.bytesOut += count
      offset += count
    }
  }

  async flush() {
    if (!this.handle) return
    nativeApi().PurgeComm(this.handle, PURGE_ALL)
  }

  async close() {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.#release()
  }
}

/** 简单探测：能不能以读写方式打开这个串口（会短暂占用端口，随后释放）。 */
export function probeSerialPath(name) {
  if (process.platform !== 'win32' || !win32SerialAvailable()) return { ok: false, reason: 'unsupported' }
  try {
    const api = nativeApi()
    const handle = api.CreateFileW(windowsDevicePath(name), GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, 0, null)
    const code = api.GetLastError()
    const invalid = handle === null || handle === undefined || handle === -1n || String(handle) === '-1'
    if (invalid) return { ok: false, reason: explain(code, name) }
    api.CloseHandle(handle)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

/** 给面板/日志用：koffi 是否加载成功，失败原因是什么。 */
export function koffiDiagnostics() {
  return {
    available: moduleCache !== null,
    error: loadError ? String(loadError.message || loadError).slice(0, 300) : null,
  }
}
