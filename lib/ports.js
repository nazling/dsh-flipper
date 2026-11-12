// 串口枚举：Windows 走 PowerShell/CIM（能拿到 VID_0483&PID_5740，认出 Flipper），
// Linux/macOS 走 /dev + sysfs。结果缓存 15 秒，避免 UI 每次刷新都去查一遍。
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const FLIPPER_VID = '0483'
const FLIPPER_PID = '5740'
const CACHE_MS = 15_000

let cache = { at: 0, ports: [] }
let inflight = null

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @()
foreach ($d in Get-CimInstance -ClassName Win32_PnPEntity) {
  $name = [string]$d.Name
  if ($name -match '\\((COM\\d+)\\)') {
    $port = $Matches[1]
    $rows += [pscustomobject]@{
      path = $port
      label = $name
      deviceId = [string]$d.DeviceID
      status = [string]$d.Status
      manufacturer = [string]$d.Manufacturer
    }
  }
}
if ($rows.Count -eq 0) {
  foreach ($n in (Get-ItemProperty 'HKLM:\\HARDWARE\\DEVICEMAP\\SERIALCOMM' -ErrorAction SilentlyContinue).PSObject.Properties) {
    if ($n.Name -notlike 'PS*') { $rows += [pscustomobject]@{ path = [string]$n.Value; label = [string]$n.Name; deviceId = ''; status = 'Unknown'; manufacturer = '' } }
  }
}
$rows | ConvertTo-Json -Compress -Depth 4
`

function shellForWindows() {
  return process.env.DSH_FLIPPER_POWERSHELL || 'powershell.exe'
}

async function listWindowsPorts() {
  let raw = ''
  for (const shell of [shellForWindows(), 'pwsh.exe']) {
    try {
      const { stdout } = await execFileP(
        shell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
        { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
      )
      raw = String(stdout || '')
      if (raw.trim()) break
    } catch (error) {
      if (shell === 'pwsh.exe' && !raw) {
        return { ports: [], error: `枚举串口失败：${String(error.message).slice(0, 120)}` }
      }
    }
  }
  const text = raw.trim()
  if (!text) return { ports: [] }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ports: [], error: '串口枚举输出不是 JSON' }
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const ports = rows
    .filter((row) => row && row.path)
    .map((row) => {
      const id = String(row.deviceId || '').toUpperCase()
      const label = String(row.label || row.path)
      const isFlipper =
        id.includes(`VID_${FLIPPER_VID}&PID_${FLIPPER_PID}`) || /flipper|unygate|flip_/i.test(label + ' ' + id)
      return {
        path: String(row.path),
        label,
        deviceId: id,
        isFlipper,
        kind: /bluetooth|蓝牙/i.test(label) ? 'bluetooth' : isFlipper ? 'flipper' : 'serial',
        status: row.status ? String(row.status) : '',
      }
    })
    .sort((a, b) => Number(b.isFlipper) - Number(a.isFlipper) || a.path.localeCompare(b.path))
  return { ports }
}

function listPosixPorts() {
  const ports = []
  let names = []
  try {
    names = fs.readdirSync('/dev')
  } catch {
    return { ports }
  }
  for (const name of names) {
    if (!/^(ttyACM|ttyUSB|cu\.usbmodem|cu\.usbserial|tty\.usbmodem)/.test(name)) continue
    const devicePath = '/dev/' + name
    let vid = ''
    let pid = ''
    if (process.platform === 'linux') {
      try {
        const base = `/sys/class/tty/${name}/device/..`
        vid = fs.readFileSync(base + '/idVendor', 'utf8').trim()
        pid = fs.readFileSync(base + '/idProduct', 'utf8').trim()
      } catch {}
    }
    const isFlipper = process.platform === 'linux' ? vid === FLIPPER_VID && pid === FLIPPER_PID : /usbmodem/i.test(name)
    ports.push({
      path: devicePath,
      label: devicePath,
      deviceId: vid && pid ? `VID_${vid}&PID_${pid}` : '',
      isFlipper,
      kind: isFlipper ? 'flipper' : 'serial',
      status: 'OK',
    })
  }
  ports.sort((a, b) => Number(b.isFlipper) - Number(a.isFlipper) || a.path.localeCompare(b.path))
  return { ports }
}

/** 本机串口列表；Flipper 排在最前。 */
export async function listSerialPorts({ refresh = false } = {}) {
  const now = Date.now()
  if (!refresh && cache.ports.length && now - cache.at < CACHE_MS) return cache.ports
  if (!refresh && !cache.ports.length && now - cache.at < 2500) return cache.ports
  if (inflight) return inflight
  const task = (async () => {
    const result = process.platform === 'win32' ? await listWindowsPorts() : listPosixPorts()
    cache = { at: Date.now(), ports: result.ports, error: result.error }
    return result.ports
  })()
  inflight = task.finally(() => {
    inflight = null
  })
  return inflight
}

/** 枚举失败时的原因（给 UI 显示）。 */
export function lastPortError() {
  return cache.error || null
}

/** 自动挑选：优先 Flipper，其次第一个非蓝牙串口。 */
export async function pickFlipperPort() {
  const ports = await listSerialPorts()
  const flipper = ports.find((port) => port.isFlipper)
  if (flipper) return flipper
  const serial = ports.find((port) => port.kind !== 'bluetooth')
  return serial || null
}
