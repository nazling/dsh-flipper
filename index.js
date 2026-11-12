// dsh-flipper — 让 AI 通过 RPC 操作 Flipper Zero，并在 dsh-go 手机端提供状态面板。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { FlipperManager, APP_NAMES } from './lib/manager.js'
import { loadSkillDefinition } from './lib/skill.js'
import { parseEndpoint } from './lib/transport.js'
import { GPIO_PINS } from './lib/messages.js'

// 本地插件可能装在 profile 之外（dsh-go 的 plugins 目录），此时 @deepseek-ai/* 不在
// 模块解析路径上；先按正常解析，失败再从 DSH 安装目录借一条解析路径。
async function loadDshModule(name) {
  try {
    return await import(name)
  } catch (first) {
    const candidates = [process.argv[1], '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'].filter(Boolean)
    for (const base of candidates) {
      try {
        const requireFrom = createRequire(resolvePath(base))
        const file = requireFrom.resolve(name)
        return await import(pathToFileURL(file).href)
      } catch {}
    }
    throw first
  }
}

const { defineTool } = await loadDshModule('@deepseek-ai/dsh-tools')
const { default: Schema } = await loadDshModule('@deepseek-ai/schemastery')

export const name = 'flipper'
export const inject = ['tools']

export const Config = Schema.object({
  transport: Schema.string()
    .default('auto')
    .description('连接方式：auto / tcp / serial')
    .volatile(),
  tcpHost: Schema.string()
    .default('')
    .description('TCP 桥的主机名或局域网 IP（手机用法）')
    .volatile(),
  tcpPort: Schema.number().default(9757).description('TCP 桥端口').volatile(),
  serialPath: Schema.string()
    .default('')
    .description('串口路径，例如 /dev/ttyACM0；电脑直连时用')
    .volatile(),
  baud: Schema.number().default(230400).description('串口波特率').volatile(),
  timeoutMs: Schema.number().default(8000).description('单条 RPC 超时（毫秒）').volatile(),
}).description('Flipper Zero 连接配置。改了会立即生效；连接参数优先用 flipper_connect 保存的值。')

const SYSTEM_PROMPT = [
  '你可以通过 dsh-flipper 工具遥控用户的 Flipper Zero。连接可能是：手机/平板的 Android BLE 桥（tcp://127.0.0.1:9757，link=ble，没有 CLI）、电脑 USB 桥 flipper-bridge.py（tcp://电脑IP:9757，link=usb，CLI 可用）、或电脑本机串口（serial:///dev/ttyACM0 / COMx，link=serial，CLI 可用）。',
  'Flipper 是一台多功能无线/硬件工具：Sub-GHz、125 kHz RFID、NFC、红外、iButton、Bad USB、U2F、GPIO、音乐播放器，以及 /ext 下的第三方 App 和信号文件。',
  '工作方式：先 flipper_status 确认 endpoint/link；用 flipper_capabilities 了解设备里的 App 和文件；操作前 flipper_screen 看界面；用 flipper_input 按键或 flipper_app 启动 App/加载文件；操作后再 flipper_screen 确认（或 flipper_input observe=true）。',
  '屏幕是 128x64 单色，ASCII 输出就是实际界面；需要细节时读 PNG。',
  'link=ble 时不要用 flipper_cli（没有 CLI 通道）；usb/serial 才可用。',
  '不要盲按键；菜单里 BACK 返回。发射 Sub-GHz/红外、模拟 NFC/RFID、运行 BadUSB、重启/恢复出厂前必须先征得用户确认；只操作用户自己的设备。',
  '详细手册：skill "dsh-flipper"。',
].join('\n')

const OUT = { type: 'object', additionalProperties: true }
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return value.toString('base64')
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = sanitize(item)
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (typeof value === 'bigint') return Number(value)
  return value
}

const clip = (text, limit = 12000) =>
  text.length > limit ? text.slice(0, limit) + `\n…（已截断，原长 ${text.length} 字）` : text
const textResult = (value) => [{ type: 'text', text: value }]
const bytes = (n) => {
  if (n === null || n === undefined) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = Number(n)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

let manager = null
let disposers = []

function ensureManager(config) {
  const defaults = {}
  for (const key of ['transport', 'tcpHost', 'tcpPort', 'serialPath', 'baud', 'timeoutMs']) {
    if (config[key] !== undefined && config[key] !== null) defaults[key] = config[key]
  }
  if (!manager) manager = new FlipperManager({ defaults })
  else manager.defaults = defaults
  return manager
}

function resolveConfig(config) {
  const out = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    out[key] = value && typeof value.get === 'function' ? value.get() : value
  }
  return out
}

// ---- 渲染 ----

function renderConnect(_args, value) {
  if (!value.ok) return textResult(`连接失败：${value.error ?? '未知错误'}`)
  return textResult(
    `Flipper 已连接：${value.endpoint}\n固件 ${value.firmware || '未知'} · 硬件 ${value.hardware || '未知'}`,
  )
}

function renderStatus(_args, value) {
  const lines = [
    `Flipper 已连接 · ${value.endpoint} · ${value.link ?? '?'} · CLI ${value.cliAvailable ? '可用' : '不可用'}`,
    `固件 ${value.firmware || '未知'}${value.firmwareBuild ? `（${value.firmwareBuild}）` : ''}`,
    `硬件 ${value.hardware || '未知'}${value.hardwareUid ? ` · ${value.hardwareUid}` : ''}`,
  ]
  if (value.battery?.level !== null && value.battery?.level !== undefined) {
    const voltage = value.battery.voltage ? ` · ${(value.battery.voltage / 1000).toFixed(2)} V` : ''
    const charging = value.battery.charging === true ? ' · 充电中' : ''
    lines.push(`电量 ${value.battery.level}%${voltage}${charging}`)
  }
  if (value.storage) {
    lines.push(`存储 ${value.storage.path}：可用 ${bytes(value.storage.free)} / 共 ${bytes(value.storage.total)}`)
  }
  if (value.protobuf) lines.push(`protobuf ${value.protobuf.major}.${value.protobuf.minor}`)
  if (value.appState) lines.push(`当前 App：${value.appState}`)
  return textResult(lines.join('\n'))
}

function renderCapabilities(_args, value) {
  const device = value.device || {}
  const lines = [
    `Flipper 能力地图 · ${device.link || '?'} · 固件 ${device.firmware || '?'} · 电量 ${device.battery?.level ?? '?'}%` +
      ` · CLI ${device.cliAvailable ? '可用' : '不可用'}` +
      (device.appState ? ` · App ${device.appState}` : ''),
    '内置 App：' + value.builtinApps.map((app) => `${app.name}（${app.use}）`).join('；'),
  ]
  if (value.externalApps?.length) {
    lines.push(`第三方 App（${value.externalApps.length}）：` + value.externalApps.join('、'))
  }
  lines.push('资源：')
  for (const [dir, info] of Object.entries(value.resources || {})) {
    if (info.error) {
      lines.push(`- ${dir}：读取失败（${info.error}）`)
      continue
    }
    const parts = []
    if (info.dirs?.length) parts.push('目录 ' + info.dirs.join('、'))
    if (info.files?.length) parts.push('文件 ' + info.files.join('、'))
    lines.push(
      `- ${dir}：${info.total} 项（${info.fileCount} 个文件）` +
        (parts.length ? ' — ' + parts.join('；') : ''),
    )
  }
  lines.push('工作流：' + value.workflows.join(' / '))
  lines.push('注意：' + value.notes.join(' '))
  return textResult(lines.join('\n'))
}

function renderScreen(_args, value) {
  const parts = [`Flipper 屏幕 ${value.width}x${value.height} · 方向 ${value.orientation} · ${value.capturedAt}`]
  if (value.ascii) parts.push(value.ascii)
  if (value.braille) parts.push('盲文点阵（更紧凑）：\n' + value.braille)
  if (value.pngPath) parts.push(`PNG 已保存：${value.pngPath}\n需要细看时用 read_image 读这个路径。`)
  return textResult(parts.join('\n\n'))
}

function renderInput(_args, value) {
  const head =
    `已发送 ${value.sent.length} 个按键：` +
    value.sent.map((item) => `${item.key}(${item.type})`).join(' → ')
  return textResult(value.screen ? `${head}\n\n--- 当前屏幕 ---\n${value.screen}` : head)
}

function renderApp(_args, value) {
  if (value.action === 'lock_status') return textResult(`App 锁状态：${value.locked ? '已锁定' : '未锁定'}`)
  if (value.action === 'error') return textResult(`App 错误：${JSON.stringify(value.error)}`)
  if (value.action === 'start') {
    return textResult(
      `已启动 ${value.name}${value.args ? `（args=${value.args}）` : ''}。\n${value.note ?? ''}` +
        (value.screen ? `\n\n--- 当前屏幕 ---\n${value.screen}` : ''),
    )
  }
  if (value.action === 'load_file') {
    return textResult(
      `已把 ${value.path} 交给当前 App。\n${value.note ?? ''}` +
        (value.screen ? `\n\n--- 当前屏幕 ---\n${value.screen}` : ''),
    )
  }
  return textResult(JSON.stringify(value, null, 2))
}

function renderStorage(_args, value) {
  if (value.action === 'list') {
    const lines = [`${value.path} · ${value.count} 项`]
    for (const file of value.files) {
      lines.push(file.type === 'dir' ? `[目录] ${file.name}/` : `[文件] ${file.name}  ${bytes(file.size)}`)
    }
    return textResult(lines.join('\n'))
  }
  if (value.action === 'read') {
    const head = `${value.path} · ${bytes(value.size)}${value.truncated ? ' · 已截断' : ''}`
    if (value.text !== undefined) return textResult(`${head}\n\n${clip(value.text, 16000)}`)
    return textResult(`${head}\n\n(base64)\n${clip(value.base64 ?? '', 16000)}`)
  }
  if (value.action === 'info') return textResult(`${value.path}\n总容量 ${bytes(value.totalSpace)}\n可用 ${bytes(value.freeSpace)}`)
  return textResult(JSON.stringify(value, null, 2))
}

function renderCli(_args, value) {
  const status = value.complete ? '命令完成' : '超时，可能仍在执行'
  return textResult(`$ ${value.command}\n（${status}）\n\n${clip(value.output || '（没有输出）')}`)
}

function renderGpio(_args, value) {
  return textResult(JSON.stringify(value, null, 2))
}

function renderSystem(_args, value) {
  if (value.action === 'info') {
    return textResult(
      Object.entries(value.info)
        .map(([key, val]) => `${key}: ${val}`)
        .join('\n'),
    )
  }
  if (value.action === 'power') {
    return textResult(
      Object.entries(value.power)
        .map(([key, val]) => `${key}: ${val}`)
        .join('\n') + (value.battery?.level != null ? `\n电量: ${value.battery.level}%` : ''),
    )
  }
  if (value.action === 'datetime') return textResult(`Flipper 时间：${value.iso ?? JSON.stringify(value.datetime)}`)
  return textResult(JSON.stringify(value, null, 2))
}

// ---- 工具 ----

const KEYS = ['up', 'down', 'left', 'right', 'ok', 'back']
const KEY_TYPES = ['short', 'long', 'press', 'release', 'repeat']

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {}
  }
  disposers = []
  const manager = ensureManager(config)

  const push = (definition) => {
    disposers.push(ctx.tools.register(definition))
  }

  push(
    defineTool({
      name: 'flipper_connect',
      description:
        '配置并连接 Flipper Zero。手机用法：先在电脑上跑 tools/flipper-bridge.py（Flipper 插电脑），再给 endpoint="tcp://电脑局域网IP:9757"。电脑本机直连可给 endpoint="serial:///dev/ttyACM0"。不给参数时使用已保存的配置并尝试连接。',
      parameters: {
        endpoint: { type: 'string', description: 'tcp://host:port 或 serial:///dev/ttyACM0' },
        transport: { type: 'string', enum: ['auto', 'tcp', 'serial'], description: '连接方式' },
        host: { type: 'string', description: 'TCP 主机' },
        port: { type: 'integer', description: 'TCP 端口，默认 9757' },
        serialPath: { type: 'string', description: '串口设备路径' },
        baud: { type: 'integer', description: '串口波特率，默认 230400' },
        link: {
          type: 'string',
          enum: ['auto', 'ble', 'usb', 'serial'],
          description: '连接类型：ble=手机蓝牙桥（无 CLI）；usb=电脑 USB 桥；serial=电脑串口直连。auto 按环境推断',
        },
      },
      output: { schema: OUT, render: renderConnect },
      async execute(args) {
        if (args.endpoint) {
          const parsed = parseEndpoint(args.endpoint)
          if (!parsed) throw new Error('endpoint 要写成 tcp://host:port 或 serial:///dev/ttyACM0')
          if (parsed.kind === 'tcp') await manager.configure({ transport: 'tcp', host: parsed.host, port: parsed.port })
          else await manager.configure({ transport: 'serial', serialPath: parsed.path })
        }
        const patch = {}
        if (args.transport) patch.transport = args.transport
        if (args.host) patch.host = args.host
        if (args.port) patch.port = args.port
        if (args.serialPath) patch.serialPath = args.serialPath
        if (args.baud) patch.baud = args.baud
        if (args.link) patch.link = args.link
        if (Object.keys(patch).length) await manager.configure(patch)
        await manager.disconnect()
        return sanitize({ ok: true, ...(await manager.status({ refresh: true })) })
      },
    }),
  )

  push(
    defineTool({
      name: 'flipper_disconnect',
      description: '断开与 Flipper 的连接，释放串口或 TCP 桥。之后调用其他工具会自动重连。',
      parameters: {},
      output: { schema: OUT, render: () => textResult('已断开 Flipper 连接') },
      async execute() {
        await manager.disconnect()
        return { ok: true, disconnected: true }
      },
    }),
  )

  push(
    defineTool({
      name: 'flipper_status',
      description:
        '查看 Flipper 连接状态、连接类型（link=ble/usb/serial）、CLI 是否可用、固件/硬件、电量、存储、protobuf 和当前 App。开始任何 Flipper 操作前先调用它确认连接。',
      parameters: {
        refresh: { type: 'boolean', description: 'true 时跳过设备信息缓存，重新读取' },
      },
      output: { schema: OUT, render: renderStatus },
      async execute(args) {
        return sanitize(await manager.status({ refresh: args.refresh === true }))
      },
    }),
  )

  push(
    defineTool({
      name: 'flipper_capabilities',
      description:
        '一次性了解这台 Flipper 里有什么：固件/电量/存储、内置 App 及用途、第三方 FAP、Sub-GHz/NFC/RFID/IR/BadUSB/音频资源文件数量与示例、可用工具和工作流。开始任何 Flipper 操作前先调用它。',
      parameters: {
        refresh: { type: 'boolean', description: 'true 重新扫描（默认缓存 60 秒）' },
      },
      output: { schema: OUT, render: renderCapabilities },
      async execute(args) {
        return sanitize(await manager.capabilities({ refresh: args.refresh === true }))
      },
    }),
  )

  push(
    defineTool({
      name: 'flipper_screen',
      description:
        '抓取 Flipper 当前屏幕（128x64 单色）。返回 ASCII（就是实际界面）、盲文点阵和 PNG 路径。操作 App 的关键：先截图确认界面，再按键/启动 App，再截图确认结果；PNG 可用 read_image 细看。',
      parameters: {
        format: {
          type: 'string',
          enum: ['ascii', 'braille', 'png', 'both'],
          description: 'ascii=半块字符（默认，易读）；braille=盲文点阵（省 token）；png=只存文件；both=两种文本都给',
        },
        save: { type: 'boolean', description: '是否保存 PNG，默认 true' },
        timeoutMs: { type: 'integer', description: '等首帧的超时，默认 5000ms' },
      },
      output: {
        schema: OUT,
        render: renderScreen,
        presentationMeta: (_args, value) => {
          if (!value?.dataUrl) return {}
          return {
            'dsh-go/view': {
              type: 'stack',
              title: 'Flipper 屏幕',
              children: [
                { type: 'image', src: value.dataUrl, aspect: 2, alt: 'Flipper 屏幕' },
                { type: 'text', text: value.pngPath ? `PNG：${value.pngPath}` : '已抓取屏幕' },
              ],
            },
          }
        },
      },
      async execute(args) {
        return sanitize(await manager.screen({
          format: args.format ?? 'ascii',
          save: args.save !== false,
          timeoutMs: args.timeoutMs ?? 5000,
        }))
      },
    }),
  )

  push(
    defineTool({
      name: 'flipper_input',
      description:
        '按 Flipper 的实体键（up/down/left/right/ok/back）。short=普通点按，long=长按。可以一次给一串按键做菜单导航；observe=true 会在按键后自动截图并返回当前屏幕，适合“按一下看结果”的自主循环。按键前最好先 flipper_screen 看界面，不要盲按。',
      parameters: {
        keys: {
          type: 'array',
          required: true,
          description: '按键序列，例如 ["down","ok"] 或 [{key:"ok",type:"long"}]',
          items: {
            oneOf: [
              { type: 'string', enum: KEYS },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: { type: 'string', enum: KEYS, description: '按键' },
                  type: { type: 'string', enum: KEY_TYPES, description: '默认 short' },
                  delayMs: { type: 'integer', description: '这个键之后等多久（毫秒）' },
                },
              },
            ],
          },
        },
        delayMs: { type: 'integer', description: '默认键间延迟，默认 140ms' },
        observe: { type: 'boolean', description: 'true=按键后立即截图并返回屏幕' },
      },
      output: { schema: OUT, render: renderInput },
      async execute(args) {
        if (!Array.isArray(args.keys) || args.keys.length === 0) throw new Error('keys 不能为空')
        const result = await manager.press(args.keys, { delayMs: args.delayMs ?? 140 })
        if (args.observe) {
          try {
            const shot = await manager.screen({ format: 'ascii', save: false })
            return sanitize({ ...result, screen: shot.ascii, png: shot.pngPath })
          } catch {}
        }
        return sanitize(result)
      },
    }),
  )

  push(
    defineTool({
      name: 'flipper_app',
      description:
        `启动/退出 Flipper App，或把文件交给当前 App。常用 App：${APP_NAMES.join('、')}。` +
        '要用 load_file/button 控制 App 时 start 的 args 传 "RPC"。从桌面启动最稳；菜单/文件浏览器打开时报 APP_SYSTEM_LOCKED 就先按 BACK 回桌面。observe=true 会在操作后自动截图。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['start', 'exit', 'load_file', 'lock_status', 'button', 'error'],
          description: '操作',
        },
        name: { type: 'string', description: 'App 名，例如 Sub-GHz / Infrared / NFC / Bad USB' },
        args: { type: 'string', description: '启动参数；"RPC" 表示启用 RPC 控制' },
        path: { type: 'string', description: 'load_file 时的文件路径，例如 /ext/subghz/door.sub' },
        index: { type: 'integer', description: 'button 时的按钮下标，默认 0' },
        buttonType: { type: 'string', enum: ['press', 'release', 'press_release'], description: 'button 类型' },
        observe: { type: 'boolean', description: 'true=操作后立即截图并返回屏幕' },
      },
      output: { schema: OUT, render: renderApp },
      async execute(args) {
        const result = await manager.app({
          action: args.action,
          name: args.name,
          args: args.args,
          path: args.path,
          index: args.index ?? 0,
          text: args.buttonType ?? 'press',
        })
        if (args.observe && ['start', 'exit', 'load_file'].includes(args.action)) {
          try {
            const shot = await manager.screen({ format: 'ascii', save: false })
            result.screen = shot.ascii
          } catch {}
        }
        return sanitize(result)
      },
    }),
  )

  push(
    defineTool({
      name: 'flipper_storage',
      description:
        '读写 Flipper 存储（/ext 是 SD 卡，/int 是内部）。list 看目录，read 读文件，write 写文本或 base64，另有 delete/mkdir/rename/md5/stat/info。写坏系统文件会影响设备，删改前先想清楚。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'read', 'write', 'delete', 'mkdir', 'rename', 'md5', 'stat', 'info'],
          description: '操作',
        },
        path: { type: 'string', description: '目标路径，例如 /ext/nfc' },
        to: { type: 'string', description: 'rename 的新路径' },
        content: { type: 'string', description: 'write 的内容（文本或 base64）' },
        encoding: { type: 'string', enum: ['auto', 'text', 'base64'], description: '读写编码，默认 auto' },
        recursive: { type: 'boolean', description: 'delete 时递归删除目录' },
        includeMd5: { type: 'boolean', description: 'list 时计算 md5' },
      },
      output: { schema: OUT, render: renderStorage },
      async execute(args) {
        return sanitize(await manager.storage({
          action: args.action,
          path: args.path,
          to: args.to,
          content: args.content,
          encoding: args.encoding ?? 'auto',
          recursive: args.recursive === true,
          includeMd5: args.includeMd5 === true,
        }))
      },
    }),
  )

  push(
    defineTool({
      name: 'flipper_cli',
      description:
        '在 Flipper 上执行一条 CLI 命令并返回输出（会临时退出 RPC，执行完自动恢复）。**link=ble 时不可用（BLE 没有 CLI 文本通道）；电脑 USB 桥或串口直连可用。** 先看 flipper_status 的 link/cliAvailable。',
      parameters: {
        command: { type: 'string', required: true, description: 'CLI 命令，例如 "power info"' },
        timeoutMs: { type: 'integer', description: '等待输出的上限，默认 8000ms' },
      },
      output: { schema: OUT, render: renderCli },
      async execute(args) {
        const command = String(args.command ?? '').trim()
        if (/^factory_reset\b/i.test(command)) throw new Error('禁止用 CLI 恢复出厂设置；确实要做请用 flipper_system + confirm')
        return sanitize(await manager.cli(command, { timeoutMs: args.timeoutMs ?? 8000 }))
      },
    }),
  )

  push(
    defineTool({
      name: 'flipper_gpio',
      description:
        '控制 Flipper 的 GPIO 引脚（PC0/PC1/PC3/PB2/PB3/PA4/PA6/PA7）：设输入输出、上下拉、读写电平、OTG 供电。接线前确认电压，别把 5V 灌进 3.3V 引脚。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['set_mode', 'get_mode', 'set_pull', 'read', 'write', 'otg', 'otg_status'],
          description: '操作',
        },
        pin: { type: 'string', enum: GPIO_PINS, description: '引脚名' },
        mode: { type: 'string', enum: ['output', 'input'], description: 'set_mode 用' },
        pull: { type: 'string', enum: ['none', 'up', 'down'], description: 'set_pull 用' },
        value: { type: 'integer', enum: [0, 1], description: 'write/otg 用' },
      },
      output: { schema: OUT, render: renderGpio },
      async execute(args) {
        return sanitize(await manager.gpio({
          action: args.action,
          pin: args.pin,
          value: args.value,
          mode: args.mode,
          pull: args.pull,
        }))
      },
    }),
  )

  push(
    defineTool({
      name: 'flipper_system',
      description:
        'Flipper 系统级操作：设备信息、电源、读写时间、响铃找设备、重启（os/dfu/update）、读 property、桌面锁定/解锁。factory_reset 会清空用户数据，必须把 confirm 写成 "FACTORY RESET"。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: [
            'info',
            'power',
            'datetime',
            'set_datetime',
            'alert',
            'reboot',
            'property',
            'desktop_status',
            'unlock',
            'factory_reset',
          ],
          description: '操作',
        },
        mode: { type: 'string', enum: ['os', 'dfu', 'update'], description: 'reboot 模式' },
        property: { type: 'string', description: 'property key，例如 devinfo.firmware_version' },
        datetime: { type: 'string', description: 'set_datetime 的 ISO 时间，例如 2026-11-08T18:00:00' },
        confirm: { type: 'string', description: 'factory_reset 时必须写 "FACTORY RESET"' },
      },
      output: { schema: OUT, render: renderSystem },
      async execute(args) {
        return sanitize(await manager.system({
          action: args.action,
          mode: args.mode,
          property: args.property,
          datetime: args.datetime,
          confirm: args.confirm,
        }))
      },
    }),
  )

  // ---- 系统提示：让模型知道它能遥控 Flipper、该怎么观察-行动-观察 ----
  ctx.inject(['systemPrompt'], (sctx) => {
    if (!sctx.systemPrompt || typeof sctx.systemPrompt.section !== 'function') return
    sctx.systemPrompt.section({
      name: 'tool:flipper',
      order: 2250,
      text: SYSTEM_PROMPT,
    })
  })

  // ---- 随包技能：完整操作手册，模型可用 skill("dsh-flipper") 加载 ----
  ctx.inject(['skills'], (sctx) => {
    if (!sctx.skills || typeof sctx.skills.register !== 'function') return
    const definition = loadSkillDefinition()
    if (!definition) return
    try {
      disposers.push(sctx.skills.register(definition))
    } catch {}
  })

  // ---- dsh-go：右侧「Flipper 状态」面板 + 输入框状态条 ----
  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('flipper', {
      view: () => ({
        type: 'stack',
        title: 'Flipper',
        children: [
          { type: 'text', text: { $: 'data.status' } },
          { type: 'image', src: { $: 'data.screen' }, aspect: 2, caption: { $: 'data.caption' } },
          {
            type: 'row',
            children: [
              { type: 'metric', label: '电量', value: { $: 'data.battery' } },
              { type: 'metric', label: '固件', value: { $: 'data.firmware' } },
            ],
          },
          { type: 'text', text: { $: 'data.storage' } },
          {
            type: 'row',
            children: [
              {
                type: 'actions',
                items: [
                  { label: '←', action: 'left' },
                  { label: '↑', action: 'up' },
                  { label: '→', action: 'right' },
                ],
              },
              {
                type: 'actions',
                items: [
                  { label: '↓', action: 'down' },
                  { label: 'OK', action: 'ok' },
                  { label: '返回', action: 'back' },
                ],
              },
            ],
          },
          {
            type: 'actions',
            items: [
              { label: '刷新', action: 'refresh' },
              { label: '连接', action: 'connect' },
            ],
          },
        ],
      }),
      data: (_scope, emit) => {
        let alive = true
        let busy = false
        let retryAt = 0
        let screen = null
        const tick = async () => {
          if (!alive || busy) return
          if (!manager.cached().connected && Date.now() < retryAt) {
            emit({ status: 'Flipper 未连接（稍后自动重试）' })
            return
          }
          busy = true
          try {
            const status = await manager.status()
            try {
              const shot = await manager.screen({ format: 'png', save: false, timeoutMs: 3500 })
              screen = shot.dataUrl
            } catch {}
            retryAt = 0
            emit({
              status: `已连接 · ${status.endpoint}`,
              screen,
              caption: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
              battery: status.battery.level == null ? '—' : `${status.battery.level}%`,
              firmware: status.firmware || '—',
              storage: status.storage
                ? `存储可用 ${bytes(status.storage.free)} / ${bytes(status.storage.total)}`
                : '存储不可用',
            })
          } catch (error) {
            retryAt = Date.now() + 20_000
            if (alive) emit({ status: `连接失败：${String(error.message).slice(0, 60)}` })
          } finally {
            busy = false
          }
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      },
      actions: {
        refresh: async () => {
          try {
            const shot = await manager.screen({ format: 'png', save: false, timeoutMs: 3500 })
            return { patch: { screen: shot.dataUrl, caption: new Date().toLocaleTimeString('zh-CN', { hour12: false }) } }
          } catch (error) {
            return { toast: String(error.message).slice(0, 40) }
          }
        },
        connect: async () => {
          try {
            await manager.status({ refresh: true })
            return { toast: 'Flipper 已连接', refresh: true }
          } catch (error) {
            return { toast: String(error.message).slice(0, 40) }
          }
        },
        up: () => quickKey('up'),
        down: () => quickKey('down'),
        left: () => quickKey('left'),
        right: () => quickKey('right'),
        ok: () => quickKey('ok'),
        back: () => quickKey('back'),
      },
    })

    ctx.dshGo.strip('flipper-status', (_scope, emit, caps) => {
      void caps
      const tick = () => {
        const state = manager.cached()
        if (state.connected) {
          emit({
            text: `Flipper ${state.battery == null ? '' : state.battery + '%'}`.trim(),
            icon: 'bolt',
            tone: 'good',
          })
        } else {
          emit({ text: 'Flipper 未连接', icon: 'bolt' })
        }
      }
      tick()
      const timer = setInterval(tick, 15_000)
      return () => clearInterval(timer)
    })
  })

  async function quickKey(key) {
    try {
      await manager.press([{ key, type: 'short' }])
      const shot = await manager.screen({ format: 'png', save: false, timeoutMs: 3500 })
      return {
        patch: {
          screen: shot.dataUrl,
          caption: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        },
      }
    } catch (error) {
      return { toast: String(error.message).slice(0, 40) }
    }
  }
}
