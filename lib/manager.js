// 高层 Flipper 客户端：连接管理 + 面向 AI 的语义操作。
import path from 'node:path'
import {
  FlipperError,
  FlipperRpc,
  sleep,
} from './rpc.js'
import {
  GPIO_PIN_MODE,
  GPIO_PINS,
  GPIO_PULL,
  INPUT_KEY,
  INPUT_TYPE,
  REBOOT_MODE,
  CMD,
  requests,
} from './messages.js'
import {
  TcpTransport,
  createSerialTransport,
  discoverSerialPorts,
  listSerialPorts,
  pickFlipperPort,
} from './transport.js'
import {
  encodePng,
  framebufferToBitmap,
  pngDataUrl,
  toAsciiArt,
  toBraille,
} from './screen.js'
import {
  ensureScreensDir,
  loadRuntimeConfig,
  mergeConfig,
  saveRuntimeConfig,
} from './config.js'

const BUILTIN_APPS = [
  { name: 'Sub-GHz', use: '300–928 MHz 无线信号：读取/分析/保存/发射 .sub（车库门、门铃、传感器）' },
  { name: '125 kHz RFID', use: '低频 RFID：读取/保存/模拟/写卡（.rfid）' },
  { name: 'NFC', use: '13.56 MHz NFC：读卡/模拟/保存 .nfc（Mifare、NTAG、门禁卡）' },
  { name: 'Infrared', use: '红外遥控：加载 .ir 遥控器并发射按键' },
  { name: 'iButton', use: 'Dallas iButton：读取/模拟/写入（.ibtn）' },
  { name: 'Bad USB', use: '把 Flipper 变成 USB 键盘，运行 .txt HID 脚本' },
  { name: 'U2F', use: 'U2F 安全密钥' },
  { name: 'GPIO', use: 'GPIO 引脚、UART/SPI/I2C 等（配合 flipper_gpio 或外部模块）' },
  { name: 'Music Player', use: '播放 .wav / .fmf 音乐' },
  { name: 'Snake', use: '贪吃蛇小游戏' },
  { name: 'Archive', use: '文件浏览器：浏览 /ext 下的 App 和文件' },
]

const RESOURCE_DIRS = [
  ['/ext/subghz', '.sub 无线信号'],
  ['/ext/nfc', '.nfc 卡片'],
  ['/ext/lfrfid', '.rfid 低频卡'],
  ['/ext/infrared', '.ir 红外遥控器'],
  ['/ext/badusb', '.txt BadUSB 脚本'],
  ['/ext/ibutton', '.ibtn iButton'],
  ['/ext/wav', '.wav 音频'],
  ['/ext/apps', '第三方 App（.fap / 子目录）'],
]

const TOOL_GUIDE = [
  { name: 'flipper_status', use: '连接状态、固件、电量、存储、当前 App 状态' },
  { name: 'flipper_capabilities', use: '设备里有什么：内置 App、第三方 FAP、资源文件、工作流' },
  { name: 'flipper_screen', use: '截屏，返回 ASCII（实际界面）和 PNG 路径' },
  { name: 'flipper_input', use: '按键 up/down/left/right/ok/back，可带 observe 自动截图' },
  { name: 'flipper_app', use: '启动/退出 App、load_file、button、get_error' },
  { name: 'flipper_storage', use: '列出/读/写/删除/重命名 SD 卡文件' },
  { name: 'flipper_system', use: '电源、时间、响铃、重启、property、桌面' },
  { name: 'flipper_gpio', use: 'GPIO 输入输出、上下拉、OTG' },
  { name: 'flipper_connect', use: '配置并连接（tcp:// 或 serial://）' },
  { name: 'flipper_cli', use: '仅 USB 串口直连时的 CLI；BLE 桥下不可用' },
]

const WORKFLOWS = [
  '观察：flipper_screen → 读 ASCII → 决定下一步；操作后再截一次确认',
  '回桌面：flipper_input keys=["back"]（必要时多按几次）',
  '打开 App：桌面 → flipper_app start name="NFC" args="RPC" → flipper_screen',
  '用文件：flipper_storage list <目录> → flipper_app start <App> args="RPC" → flipper_app load_file <路径> → flipper_screen',
  'Sub-GHz：list /ext/subghz → start Sub-GHz → load_file .sub → 选择发射（先征得用户同意）',
  'NFC：list /ext/nfc → start NFC → load_file .nfc → 选择 Read/Emulate',
  'BadUSB：list /ext/badusb → start Bad USB → load_file .txt → 选择 Run（先确认目标机器是用户的）',
]

const APP_NAMES = [
  'Sub-GHz',
  'Infrared',
  'NFC',
  'RFID',
  'iButton',
  'Bad USB',
  'U2F',
  'GPIO',
  'Music Player',
  'Snake',
]

export class FlipperManager {
  constructor({ defaults = {}, log = () => {} } = {}) {
    this.defaults = defaults
    this.runtime = loadRuntimeConfig()
    this.rpc = null
    this.connecting = null
    this.info = null
    this.infoAt = 0
    this.lastStatus = null
    this.lastError = null
    this.appState = null
    this.capabilitiesCache = null
    this.capabilitiesAt = 0
    this.logLines = []
    this.log = (line) => {
      this.logLines.push(`${new Date().toISOString()} ${line}`)
      if (this.logLines.length > 80) this.logLines.shift()
      log(line)
    }
  }

  get config() {
    return mergeConfig(this.defaults, this.runtime)
  }

  /** auto: 手机上（dsh-go 环境）默认 BLE；电脑默认串口直连，配了 TCP 才算桥。 */
  linkMode(config = this.config) {
    const configured = String(config.link || 'auto')
    if (configured !== 'auto') return configured
    if (process.env.DSH_GO_RUNTIME_ROOT) return 'ble'
    if (config.transport === 'tcp' || (config.transport === 'auto' && config.tcpHost)) return 'usb'
    if (config.transport === 'serial' || config.serialPath) return 'serial'
    // 电脑端 auto 且没配 TCP：走本机串口
    return 'serial'
  }

  endpointLabel(config = this.config) {
    if (config.transport === 'tcp' || (config.transport === 'auto' && config.tcpHost)) {
      return `tcp://${config.tcpHost || '?'}:${config.tcpPort}`
    }
    if (config.transport === 'serial' || (config.transport === 'auto' && config.serialPath)) {
      return `serial://${config.serialPath || '?'}`
    }
    return '未配置'
  }

  /** 修改并持久化连接配置；端点变了就断开重连。 */
  async configure(patch = {}) {
    const before = this.endpointLabel()
    const next = { ...this.runtime }
    if (patch.transport !== undefined) next.transport = String(patch.transport)
    if (patch.host !== undefined) next.tcpHost = String(patch.host)
    if (patch.port !== undefined) next.tcpPort = Number(patch.port)
    if (patch.serialPath !== undefined) next.serialPath = String(patch.serialPath)
    if (patch.baud !== undefined) next.baud = Number(patch.baud)
    if (patch.timeoutMs !== undefined) next.timeoutMs = Number(patch.timeoutMs)
    if (patch.link !== undefined) next.link = String(patch.link)
    this.runtime = await saveRuntimeConfig(next)
    const after = this.endpointLabel()
    if (before !== after) await this.disconnect()
    return { ...this.config }
  }

  async disconnect() {
    const rpc = this.rpc
    this.rpc = null
    this.info = null
    this.infoAt = 0
    this.lastStatus = null
    this.appState = null
    this.capabilitiesCache = null
    this.capabilitiesAt = 0
    if (rpc) {
      try {
        await rpc.disconnect()
      } catch {}
    }
  }

  async ensure() {
    // 只要会话还活着就直接复用：CLI 切换期间 mode 是 handshake/cli，此时若另开一条
    // 连接，会对着同一个串口/TCP 再发一次开始会话（Windows 上等于占两次端口）。
    // 命令本身有队列，排在 CLI 后面的请求会在 mode 回到 rpc 之后才真正发出去。
    if (this.rpc && this.rpc.connected) return this.rpc
    if (!this.connecting) {
      this.connecting = this.#connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  async #connect() {
    const config = this.config
    const transport = await this.#createTransport(config)
    const rpc = new FlipperRpc(transport, {
      timeoutMs: config.timeoutMs || 8000,
      log: (line) => this.log(line),
    })
    rpc.on('close', () => {
      if (this.rpc === rpc) {
        this.rpc = null
        this.lastStatus = null
      }
    })
    try {
      rpc.on('app-state', (state) => {
        this.appState = { state, at: Date.now() }
      })
      await rpc.connect()
      this.rpc = rpc
      this.lastError = null
      return rpc
    } catch (error) {
      this.lastError = error.message
      try {
        await rpc.disconnect()
      } catch {}
      throw new FlipperError(
        `${error.message}（当前端点：${this.endpointLabel(config)}）`,
        { cause: error },
      )
    }
  }

  async #createTransport(config) {
    const mode = config.transport || 'auto'
    if (mode === 'tcp' || (mode === 'auto' && config.tcpHost)) {
      if (!config.tcpHost) throw new FlipperError('TCP 模式缺少主机地址，请先在面板里选串口或填写电脑 IP')
      return new TcpTransport({ host: config.tcpHost, port: Number(config.tcpPort) || 9757 })
    }
    if (mode === 'serial' || (mode === 'auto' && config.serialPath)) {
      if (!config.serialPath) throw new FlipperError('串口模式缺少设备路径：在面板里选一个串口（比如 COM6）')
      return createSerialTransport({
        path: config.serialPath,
        baud: Number(config.baud) || 230400,
        log: (line) => this.log(line),
      })
    }
    // auto：先把本机串口列出来，优先 Flipper，其次第一个非蓝牙串口。
    const picked = await pickFlipperPort().catch(() => null)
    if (picked) {
      this.log(`auto: 使用串口 ${picked.path}${picked.isFlipper ? '（识别为 Flipper）' : ''}`)
      return createSerialTransport({
        path: picked.path,
        baud: Number(config.baud) || 230400,
        log: (line) => this.log(line),
      })
    }
    const ports = discoverSerialPorts()
    if (ports.length) return createSerialTransport({ path: ports[0], baud: Number(config.baud) || 230400 })
    throw new FlipperError(
      '没找到可用的 Flipper 串口。电脑插 USB 后点面板里的「刷新端口」；确认没被 qFlipper 占用。手机走 BLE 桥时填 tcp://电脑IP:9757。',
    )
  }

  /** 本机串口列表（面板下拉框用）。 */
  async ports({ refresh = false } = {}) {
    const ports = await listSerialPorts({ refresh }).catch(() => [])
    return { ok: true, ports: Array.isArray(ports) ? ports : [] }
  }

  // ---- 信息 ----

  async status({ refresh = false } = {}) {
    const rpc = await this.ensure()
    const config = this.config
    const now = Date.now()
    if (refresh || !this.info || now - this.infoAt > 60_000) {
      const messages = await rpc.request(requests.deviceInfo(), { timeoutMs: 8000 })
      const map = {}
      for (const message of messages) {
        if (message.body?.key) map[message.body.key] = message.body.value
      }
      this.info = map
      this.infoAt = now
    }

    let power = {}
    try {
      const messages = await rpc.request(requests.powerInfo(), { timeoutMs: 6000 })
      for (const message of messages) {
        if (message.body?.key) power[message.body.key] = message.body.value
      }
    } catch (error) {
      this.log('power info failed: ' + error.message)
    }

    let storage = null
    for (const sourcePath of ['/ext', '/']) {
      try {
        const messages = await rpc.request(requests.storageInfo(sourcePath), { timeoutMs: 5000 })
        const body = messages[0]?.body
        if (body) {
          storage = { path: sourcePath, total: body.totalSpace, free: body.freeSpace }
          break
        }
      } catch {}
    }

    let protobuf = null
    try {
      const messages = await rpc.request(requests.protobufVersion(), { timeoutMs: 4000 })
      protobuf = messages[0]?.body ?? null
    } catch {}

    const battery = parseBattery(power)
    const link = this.linkMode()
    // info 可能被并发 disconnect() 清空，这里用本地快照，避免 status 直接崩在 null 上
    const info = this.info ?? {}
    const status = {
      ok: true,
      connected: true,
      endpoint: rpc.transport.description,
      transport: config.transport || 'auto',
      serialPath: config.serialPath || '',
      tcpHost: config.tcpHost || '',
      tcpPort: config.tcpPort || 9757,
      baud: config.baud || 230400,
      link,
      cliAvailable: link !== 'ble',
      firmware: info.firmware_version ?? '',
      firmwareBuild: info.firmware_build_date ?? '',
      firmwareCommit: info.firmware_commit ?? '',
      hardware: info.hardware_model ?? '',
      hardwareUid: info.hardware_uid ?? '',
      hardwareVersion: info.hardware_ver ?? '',
      protobuf,
      battery,
      storage,
      appState: this.appState ? this.appState.state : null,
      info,
      power,
    }
    this.lastStatus = status
    return status
  }

  cached() {
    return {
      connected: Boolean(this.rpc && this.rpc.connected),
      endpoint: this.rpc?.transport?.description ?? this.endpointLabel(),
      firmware: this.info?.firmware_version ?? '',
      battery: this.lastStatus?.battery?.level ?? null,
      error: this.lastError,
    }
  }

  // ---- 屏幕 ----

  async screen({ format = 'ascii', save = true, timeoutMs = 5000 } = {}) {
    const rpc = await this.ensure()
    const frame = await rpc.screenshot({ timeoutMs })
    const bitmap = framebufferToBitmap(frame.data, frame.orientation)
    const png = encodePng(bitmap)
    let pngPath = null
    if (save !== false) {
      const dir = await ensureScreensDir()
      const stamp = new Date()
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 14)
      pngPath = path.join(dir, `screen-${stamp}.png`)
      const fsp = await import('node:fs/promises')
      await fsp.writeFile(pngPath, png)
    }
    const result = {
      ok: true,
      width: bitmap.width,
      height: bitmap.height,
      orientation: frame.orientation,
      capturedAt: new Date(frame.at).toISOString(),
      pngPath,
      dataUrl: pngDataUrl(png),
    }
    if (format === 'ascii' || format === 'both') result.ascii = toAsciiArt(bitmap)
    if (format === 'braille' || format === 'both') result.braille = toBraille(bitmap)
    return result
  }

  // ---- 按键 ----

  async press(keys, { delayMs = 140 } = {}) {
    const rpc = await this.ensure()
    const list = Array.isArray(keys) ? keys : [keys]
    if (list.length === 0) throw new FlipperError('至少要给一个按键')
    if (list.length > 30) throw new FlipperError('一次最多 30 个按键')
    const sent = []
    for (let index = 0; index < list.length; index += 1) {
      const item = typeof list[index] === 'string' ? { key: list[index] } : list[index]
      const key = String(item.key ?? '').toLowerCase()
      const type = String(item.type ?? 'short').toLowerCase()
      if (!(key in INPUT_KEY)) {
        throw new FlipperError(`不认识的按键 ${key}；可用：${Object.keys(INPUT_KEY).join(' / ')}`)
      }
      if (!(type in INPUT_TYPE)) {
        throw new FlipperError(`不认识的按键类型 ${type}；可用：${Object.keys(INPUT_TYPE).join(' / ')}`)
      }
      await sendKey(rpc, key, type)
      sent.push({ key, type })
      if (index < list.length - 1) {
        const wait = Number(item.delayMs ?? delayMs)
        if (wait > 0) await sleep(Math.min(wait, 5000))
      }
    }
    return { ok: true, sent }
  }

  // ---- App ----

  async app({ action, name, args = '', path: filePath, index = 0, text = '' }) {
    const rpc = await this.ensure()
    switch (action) {
      case 'start': {
        if (!name) throw new FlipperError('start 需要 name，例如 Sub-GHz / Infrared / NFC / Bad USB')
        await rpc.request(requests.appStart(name, args), { timeoutMs: 10000 })
        return {
          ok: true,
          action,
          name,
          args,
          note: 'App 已启动。用 args="RPC" 启动的 App 才支持 load_file / button。',
        }
      }
      case 'exit':
        await rpc.request(requests.appExit(), { timeoutMs: 6000 })
        return { ok: true, action, note: '已请求退出当前 App' }
      case 'load_file':
        if (!filePath) throw new FlipperError('load_file 需要 path')
        await rpc.request(requests.appLoadFile(filePath), { timeoutMs: 8000 })
        return { ok: true, action, path: filePath, note: '文件已交给当前 App（需要以 RPC 模式启动）' }
      case 'lock_status': {
        const messages = await rpc.request(requests.appLockStatus(), { timeoutMs: 4000 })
        return { ok: true, action, locked: messages[0]?.body?.locked ?? null }
      }
      case 'button': {
        const type = String(text || 'press').toLowerCase()
        const request =
          type === 'release'
            ? requests.appButtonRelease()
            : type === 'press_release'
              ? requests.appButtonPressRelease(index, args)
              : requests.appButtonPress(index, args)
        await rpc.request(request, { timeoutMs: 8000 })
        return { ok: true, action, type, index, args }
      }
      case 'error': {
        const messages = await rpc.request(requests.appGetError(), { timeoutMs: 4000 })
        return { ok: true, action, error: messages[0]?.body ?? null }
      }
      default:
        throw new FlipperError(`不支持的 app action: ${action}（start/exit/load_file/lock_status/button/error）`)
    }
  }

  // ---- 存储 ----

  async storage({
    action,
    path: filePath,
    to,
    content,
    encoding = 'auto',
    recursive = false,
    includeMd5 = false,
    maxBytes = 262144,
  }) {
    const rpc = await this.ensure()
    switch (action) {
      case 'list': {
        const files = await rpc.list(filePath || '/ext', { includeMd5 })
        files.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
        return { ok: true, action, path: filePath || '/ext', count: files.length, files }
      }
      case 'read': {
        const buffer = await rpc.readFile(filePath)
        const truncated = buffer.length > maxBytes
        const slice = truncated ? buffer.subarray(0, maxBytes) : buffer
        const result = {
          ok: true,
          action,
          path: filePath,
          size: buffer.length,
          truncated,
        }
        if (encoding === 'base64') {
          result.base64 = slice.toString('base64')
        } else if (encoding === 'text' || (encoding === 'auto' && looksText(slice))) {
          result.text = slice.toString('utf8')
        } else {
          result.base64 = slice.toString('base64')
          result.note = '二进制内容，已用 base64 返回'
        }
        return result
      }
      case 'write': {
        if (!filePath) throw new FlipperError('write 需要 path')
        const buffer = Buffer.from(content ?? '', encoding === 'base64' ? 'base64' : 'utf8')
        if (buffer.length === 0) throw new FlipperError('内容为空')
        if (buffer.length > 2 * 1024 * 1024) throw new FlipperError('单次写入上限 2 MiB')
        await rpc.writeFile(filePath, buffer, { timeoutMs: 30000 })
        return { ok: true, action, path: filePath, size: buffer.length }
      }
      case 'delete':
        await rpc.request(requests.storageDelete(filePath, recursive), { timeoutMs: 10000 })
        return { ok: true, action, path: filePath, recursive }
      case 'mkdir':
        await rpc.request(requests.storageMkdir(filePath), { timeoutMs: 6000 })
        return { ok: true, action, path: filePath }
      case 'rename':
        if (!to) throw new FlipperError('rename 需要 to')
        await rpc.request(requests.storageRename(filePath, to), { timeoutMs: 8000 })
        return { ok: true, action, from: filePath, to }
      case 'md5': {
        const messages = await rpc.request(requests.storageMd5sum(filePath), { timeoutMs: 15000 })
        return { ok: true, action, path: filePath, md5: messages[0]?.body?.md5sum ?? '' }
      }
      case 'stat': {
        const messages = await rpc.request(requests.storageStat(filePath), { timeoutMs: 6000 })
        return { ok: true, action, path: filePath, file: messages[0]?.body?.file ?? null }
      }
      case 'info': {
        const messages = await rpc.request(requests.storageInfo(filePath || '/ext'), { timeoutMs: 6000 })
        return { ok: true, action, path: filePath || '/ext', ...(messages[0]?.body ?? {}) }
      }
      default:
        throw new FlipperError(`不支持的 storage action: ${action}（list/read/write/delete/mkdir/rename/md5/stat/info）`)
    }
  }

  // ---- CLI ----

  async cli(command, { timeoutMs = 8000 } = {}) {
    const rpc = await this.ensure()
    const result = await rpc.runCli(command, { timeoutMs })
    return { ok: true, ...result }
  }

  // ---- GPIO ----

  async gpio({ action, pin, value, mode, pull }) {
    const rpc = await this.ensure()
    const index = resolvePin(pin)
    switch (action) {
      case 'set_mode': {
        const m = String(mode || '').toLowerCase()
        if (!(m in GPIO_PIN_MODE)) throw new FlipperError('mode 只能是 output / input')
        await rpc.request(requests.gpioSetMode(index, GPIO_PIN_MODE[m]), { timeoutMs: 5000 })
        return { ok: true, action, pin: GPIO_PINS[index], mode: m }
      }
      case 'get_mode': {
        const messages = await rpc.request(requests.gpioGetMode(index), { timeoutMs: 5000 })
        return { ok: true, action, pin: GPIO_PINS[index], mode: messages[0]?.body?.mode ?? '' }
      }
      case 'set_pull': {
        const p = String(pull || '').toLowerCase()
        if (!(p in GPIO_PULL)) throw new FlipperError('pull 只能是 none / up / down')
        await rpc.request(requests.gpioSetPull(index, GPIO_PULL[p]), { timeoutMs: 5000 })
        return { ok: true, action, pin: GPIO_PINS[index], pull: p }
      }
      case 'read': {
        const messages = await rpc.request(requests.gpioRead(index), { timeoutMs: 5000 })
        return { ok: true, action, pin: GPIO_PINS[index], value: messages[0]?.body?.value ?? null }
      }
      case 'write':
        await rpc.request(requests.gpioWrite(index, Number(value) ? 1 : 0), { timeoutMs: 5000 })
        return { ok: true, action, pin: GPIO_PINS[index], value: Number(value) ? 1 : 0 }
      case 'otg_status': {
        const messages = await rpc.request(requests.gpioGetOtg(), { timeoutMs: 5000 })
        return { ok: true, action, enabled: messages[0]?.body?.enabled ?? null }
      }
      case 'otg':
        await rpc.request(requests.gpioSetOtg(Boolean(value)), { timeoutMs: 5000 })
        return { ok: true, action, enabled: Boolean(value) }
      default:
        throw new FlipperError(`不支持的 gpio action: ${action}（set_mode/get_mode/set_pull/read/write/otg/otg_status）`)
    }
  }

  // ---- 系统 ----

  async system({ action, mode, property, datetime, confirm }) {
    const rpc = await this.ensure()
    switch (action) {
      case 'info': {
        const messages = await rpc.request(requests.deviceInfo(), { timeoutMs: 8000 })
        const map = {}
        for (const message of messages) if (message.body?.key) map[message.body.key] = message.body.value
        return { ok: true, action, info: map }
      }
      case 'power': {
        const messages = await rpc.request(requests.powerInfo(), { timeoutMs: 6000 })
        const map = {}
        for (const message of messages) if (message.body?.key) map[message.body.key] = message.body.value
        return { ok: true, action, power: map, battery: parseBattery(map) }
      }
      case 'datetime': {
        const messages = await rpc.request(requests.getDatetime(), { timeoutMs: 5000 })
        const dt = messages[0]?.body?.datetime ?? null
        return {
          ok: true,
          action,
          datetime: dt,
          iso: dt ? formatDateTime(dt) : null,
        }
      }
      case 'set_datetime': {
        const dt = parseDateTimeInput(datetime)
        await rpc.request(requests.setDatetime(dt), { timeoutMs: 5000 })
        return { ok: true, action, datetime: dt }
      }
      case 'alert':
        await rpc.request(requests.alert(), { timeoutMs: 5000 })
        return { ok: true, action, note: '已让 Flipper 响铃 + 亮屏' }
      case 'reboot': {
        const m = String(mode || 'os').toLowerCase()
        if (!(m in REBOOT_MODE)) throw new FlipperError('mode 只能是 os / dfu / update')
        await rpc.request(requests.reboot(REBOOT_MODE[m]), { timeoutMs: 5000 }).catch(() => {})
        return { ok: true, action, mode: m, note: '已发送重启命令，连接会断开' }
      }
      case 'property': {
        if (!property) throw new FlipperError('property 需要 key，例如 devinfo.firmware_version')
        const messages = await rpc.request(requests.propertyGet(property), { timeoutMs: 5000 })
        return { ok: true, action, property, value: messages[0]?.body?.value ?? '' }
      }
      case 'desktop_status': {
        const messages = await rpc.request(requests.desktopIsLocked(), { timeoutMs: 4000 })
        return { ok: true, action, locked: messages[0]?.body?.locked ?? null }
      }
      case 'unlock':
        await rpc.request(requests.desktopUnlock(), { timeoutMs: 4000 })
        return { ok: true, action, note: '已发送解锁桌面请求' }
      case 'factory_reset': {
        if (confirm !== 'FACTORY RESET') {
          throw new FlipperError('这是恢复出厂设置，会把用户数据全部清掉。确认时把 confirm 写成 "FACTORY RESET"。')
        }
        await rpc.request(requests.factoryReset(), { timeoutMs: 5000 }).catch(() => {})
        return { ok: true, action, note: '已发送恢复出厂设置，设备会重启' }
      }
      default:
        throw new FlipperError(
          `不支持的 system action: ${action}（info/power/datetime/set_datetime/alert/reboot/property/desktop_status/unlock/factory_reset）`,
        )
    }
  }

  /** 一次性把设备里的 App、资源文件、工具和工作流整理出来。 */
  async capabilities({ refresh = false } = {}) {
    const now = Date.now()
    if (!refresh && this.capabilitiesCache && now - this.capabilitiesAt < 60_000) {
      return this.capabilitiesCache
    }
    const rpc = await this.ensure()
    const status = await this.status()
    const resources = {}
    for (const [dir, label] of RESOURCE_DIRS) {
      try {
        const files = await rpc.list(dir)
        const dirs = files.filter((file) => file.type === 'dir')
        const plain = files.filter((file) => file.type === 'file')
        resources[dir] = {
          label,
          total: files.length,
          fileCount: plain.length,
          dirs: dirs.slice(0, 8).map((file) => file.name),
          files: plain.slice(0, 8).map((file) => file.name),
        }
      } catch (error) {
        resources[dir] = { label, error: String(error.message).slice(0, 80) }
      }
    }

    let externalApps = []
    try {
      const manifests = await rpc.list('/ext/apps_manifests')
      externalApps = manifests
        .filter((file) => file.type === 'file')
        .map((file) => file.name.replace(/\.(fapmeta|fim)$/i, ''))
        .slice(0, 40)
    } catch {}
    if (externalApps.length === 0) {
      try {
        const apps = await rpc.list('/ext/apps')
        externalApps = apps.filter((file) => file.type === 'dir').map((file) => file.name).slice(0, 40)
      } catch {}
    }

    const result = {
      ok: true,
      generatedAt: new Date().toISOString(),
      device: {
        endpoint: status.endpoint,
        link: status.link,
        cliAvailable: status.cliAvailable,
        firmware: status.firmware,
        hardware: status.hardware,
        hardwareUid: status.hardwareUid,
        protobuf: status.protobuf,
        battery: status.battery,
        storage: status.storage,
        appState: status.appState,
      },
      builtinApps: BUILTIN_APPS,
      externalApps,
      resources,
      tools: TOOL_GUIDE,
      workflows: WORKFLOWS,
      notes: [
        '屏幕是 128x64 单色，ASCII 每一行就是实际界面。',
        '菜单/App 里 BACK 返回；桌面按 DOWN 打开主菜单。',
        '菜单或文件浏览器打开时，flipper_app start 可能返回 APP_SYSTEM_LOCKED；先按 BACK 回桌面再启动。',
        'link=ble 时没有 CLI 文本通道，不要用 flipper_cli；link=usb/serial（电脑 USB 桥或串口直连）可用。',
        '手机/平板用 Android BLE 桥；PC 端 DSH 用电脑 USB 桥（tools/flipper-bridge.py）或 serial:// 直连。',
        '发射 Sub-GHz/红外、模拟 NFC/RFID、运行 BadUSB、重启或恢复出厂前，先征得用户明确同意；只操作用户自己的设备。',
      ],
    }
    this.capabilitiesCache = result
    this.capabilitiesAt = now
    return result
  }

  async readProperty(key) {
    const messages = await (await this.ensure()).request(requests.propertyGet(key), { timeoutMs: 5000 })
    return messages[0]?.body?.value ?? ''
  }

  /** 面板/状态条用的轻量查询：能连就连，失败不抛。 */
  async peek() {
    try {
      const status = await this.status()
      return {
        ok: true,
        connected: true,
        status,
      }
    } catch (error) {
      return {
        ok: false,
        connected: false,
        error: error.message,
      }
    }
  }

  /** 只要 PNG dataUrl（桌面面板镜像用，不落盘）。 */
  async screenPng({ timeoutMs = 3500 } = {}) {
    const shot = await this.screen({ format: 'png', save: false, timeoutMs })
    return {
      ok: true,
      dataUrl: shot.dataUrl,
      orientation: shot.orientation,
      capturedAt: shot.capturedAt,
      width: shot.width,
      height: shot.height,
    }
  }

  /** 内置 App 清单（面板按钮用）。 */
  apps() {
    return { ok: true, apps: BUILTIN_APPS, appState: this.appState ? this.appState.state : null }
  }

  /** 最近的连接日志（面板底部状态区）。 */
  recentLogs(limit = 40) {
    return { ok: true, lines: this.logLines.slice(-Math.max(1, Math.min(200, limit))) }
  }
}

// ---- 工具函数 ----

async function sendKey(rpc, key, type) {
  const code = INPUT_KEY[key]
  if (type === 'short' || type === 'long') {
    await rpc.request(requests.guiSendInput(code, INPUT_TYPE.press), { timeoutMs: 4000 })
    await sleep(35)
    await rpc.request(requests.guiSendInput(code, INPUT_TYPE[type]), { timeoutMs: 4000 })
    await sleep(35)
    await rpc.request(requests.guiSendInput(code, INPUT_TYPE.release), { timeoutMs: 4000 })
    return
  }
  await rpc.request(requests.guiSendInput(code, INPUT_TYPE[type]), { timeoutMs: 4000 })
}

function resolvePin(pin) {
  const value = String(pin || '').toUpperCase()
  const index = GPIO_PINS.indexOf(value)
  if (index < 0) throw new FlipperError(`引脚要用 ${GPIO_PINS.join(' / ')}`)
  return index
}

function toNumber(value) {
  const n = Number.parseFloat(String(value))
  return Number.isFinite(n) ? n : null
}

export function parseBattery(power) {
  const map = power || {}
  const entries = Object.entries(map)
  const pick = (patterns) => {
    for (const [key, value] of entries) {
      if (patterns.some((re) => re.test(key))) return { key, value }
    }
    return null
  }
  const levelEntry =
    pick([/charge_level/i, /battery.*level/i, /charge.*percent/i, /percent/i, /^charge$/i]) ??
    pick([/level/i])
  let level = levelEntry ? toNumber(levelEntry.value) : null
  if (level !== null && level > 0 && level <= 1) level = Math.round(level * 100)
  if (level !== null) level = Math.max(0, Math.min(100, Math.round(level)))

  const voltageEntry = pick([/voltage/i])
  let voltage = voltageEntry ? toNumber(voltageEntry.value) : null
  if (voltage !== null && voltage > 0 && voltage < 10) voltage = Math.round(voltage * 1000)

  const stateEntry = pick([/charge.*state/i, /charging/i, /power.*state/i])
  let charging = null
  if (stateEntry) {
    const raw = String(stateEntry.value).toLowerCase()
    if (/discharg|not.?charg|full|false|off|\bno\b/.test(raw)) charging = false
    else if (/charg|true|yes|\bon\b|\b1\b/.test(raw)) charging = true
  }

  return { level, voltage, charging, raw: map }
}

function looksText(buffer) {
  if (buffer.length === 0) return true
  let suspicious = 0
  for (const byte of buffer) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1
  }
  return suspicious / buffer.length < 0.02
}

function formatDateTime(dt) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.year}-${pad(dt.month)}-${pad(dt.day)}T${pad(dt.hour)}:${pad(dt.minute)}:${pad(dt.second)}`
}

function parseDateTimeInput(input) {
  if (!input) throw new FlipperError('set_datetime 需要 datetime，例如 2026-11-08T17:30:00')
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) throw new FlipperError('datetime 格式无法识别，用 ISO 时间')
  return {
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    day: date.getDate(),
    month: date.getMonth() + 1,
    year: date.getFullYear(),
    weekday: date.getDay() === 0 ? 7 : date.getDay(),
  }
}

export { APP_NAMES, CMD }
