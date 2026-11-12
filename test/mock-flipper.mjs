// 离线模拟器：按固件的 RPC 行为回包，用来在没有真机时跑通整条链路。
import net from 'node:net'
import { Writer, parseFields, readVarint, numField, bytesField, strField } from '../lib/proto.js'
import { CMD, decodeMain, encodeMain } from '../lib/messages.js'

const pack = (fn) => {
  const w = new Writer()
  fn(w)
  return w.finish()
}

const fileMsg = (file) =>
  pack((w) =>
    w.msg(1, (f) => {
      f.uint(1, file.type === 'dir' ? 1 : 0)
      f.str(2, file.name)
      f.uint(3, file.size ?? 0)
      if (file.data) f.bytes(4, file.data)
      if (file.md5sum) f.str(5, file.md5sum)
    }),
  )

export function startMockFlipper({ host = '127.0.0.1', port = 0 } = {}) {
  const state = {
    inputs: [],
    commands: [],
    files: new Map([
      ['/ext/nfc/dump.nfc', Buffer.from('NFC dump demo\n'.repeat(60), 'utf8')],
      ['/ext/infrared/tv.ir', Buffer.from('name: Power\nprotocol: NEC\n', 'utf8')],
    ]),
    write: null,
    screenStream: false,
    rpcMode: false,
    appRunning: null,
    cliLog: [],
  }

  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    let cli = ''

    const sendMain = (fields) => socket.write(encodeMain(fields))
    const sendEmpty = (id, status = 0) =>
      sendMain({ id, status, field: CMD.EMPTY, payload: Buffer.alloc(0) })

    const sendScreen = () => {
      if (!state.screenStream) return
      const fb = Buffer.alloc(1024)
      // 与真机一致的纵向页格式：index=(y/8)*128+x，bit0 在最上面
      const set = (x, y) => {
        fb[(y >> 3) * 128 + x] |= 1 << (y & 7)
      }
      for (let x = 0; x < 128; x += 1) {
        set(x, 0)
        set(x, 63)
      }
      for (let y = 0; y < 64; y += 1) {
        set(0, y)
        set(127, y)
        set(Math.floor((y / 64) * 128), y)
      }
      sendMain({ id: 0, field: CMD.GUI_SCREEN_FRAME, payload: pack((w) => w.bytes(1, fb)) })
    }

    const handleRpc = (msg) => {
      const { id, field, payload } = msg
      state.commands.push(field)
      const fields = parseFields(payload)
      switch (field) {
        case CMD.SYSTEM_PING_REQUEST: {
          const data = bytesField(fields, 1) ?? Buffer.alloc(0)
          sendMain({
            id,
            field: CMD.SYSTEM_PING_RESPONSE,
            payload: pack((w) => w.bytes(1, data)),
          })
          break
        }
        case CMD.SYSTEM_DEVICE_INFO_REQUEST: {
          const entries = [
            ['firmware_version', '1.2.3-mock'],
            ['firmware_build_date', '2026-10-01'],
            ['firmware_commit', 'deadbeef'],
            ['hardware_model', 'Flipper Zero'],
            ['hardware_uid', 'FLIP-MOCK-0001'],
            ['hardware_ver', 'MOCK'],
          ]
          entries.forEach(([key, value], index) => {
            sendMain({
              id,
              field: CMD.SYSTEM_DEVICE_INFO_RESPONSE,
              hasNext: index < entries.length - 1,
              payload: pack((w) => {
                w.str(1, key)
                w.str(2, value)
              }),
            })
          })
          break
        }
        case CMD.SYSTEM_POWER_INFO_REQUEST: {
          const entries = [
            ['charge_level', '78'],
            ['battery_voltage', '4021'],
            ['charge_state', 'discharging'],
          ]
          entries.forEach(([key, value], index) => {
            sendMain({
              id,
              field: CMD.SYSTEM_POWER_INFO_RESPONSE,
              hasNext: index < entries.length - 1,
              payload: pack((w) => {
                w.str(1, key)
                w.str(2, value)
              }),
            })
          })
          break
        }
        case CMD.SYSTEM_PROTOBUF_VERSION_REQUEST:
          sendMain({
            id,
            field: CMD.SYSTEM_PROTOBUF_VERSION_RESPONSE,
            payload: pack((w) => {
              w.uint(1, 0)
              w.uint(2, 22)
            }),
          })
          break
        case CMD.STORAGE_INFO_REQUEST: {
          const p = strField(fields, 1)
          if (p !== '/ext') {
            sendEmpty(id, 7)
            break
          }
          sendMain({
            id,
            field: CMD.STORAGE_INFO_RESPONSE,
            payload: pack((w) => {
              w.uint(1, 8 * 1024 * 1024 * 1024)
              w.uint(2, 5 * 1024 * 1024 * 1024)
            }),
          })
          break
        }
        case CMD.STORAGE_LIST_REQUEST: {
          const dir = strField(fields, 1)
          const files =
            dir === '/ext'
              ? [
                  { type: 'dir', name: 'nfc' },
                  { type: 'dir', name: 'infrared' },
                  { type: 'file', name: 'notes.txt', size: 12 },
                ]
              : [...state.files.entries()]
                  .filter(([p]) => p.startsWith(dir + '/'))
                  .map(([p, data]) => ({ type: 'file', name: p.slice(dir.length + 1), size: data.length }))
          sendMain({
            id,
            field: CMD.STORAGE_LIST_RESPONSE,
            payload: pack((w) => {
              for (const file of files) w.raw(fileMsg(file))
            }),
          })
          break
        }
        case CMD.STORAGE_READ_REQUEST: {
          const p = strField(fields, 1)
          const data = state.files.get(p)
          if (!data) {
            sendEmpty(id, 7)
            break
          }
          let offset = 0
          do {
            const chunk = data.subarray(offset, offset + 512)
            offset += chunk.length
            sendMain({
              id,
              field: CMD.STORAGE_READ_RESPONSE,
              hasNext: offset < data.length,
              payload: pack((w) => w.msg(1, (f) => f.bytes(4, chunk))),
            })
          } while (offset < data.length)
          break
        }
        case CMD.STORAGE_WRITE_REQUEST: {
          const p = strField(fields, 1)
          const file = parseFields(bytesField(fields, 2) ?? Buffer.alloc(0))
          const data = bytesField(file, 4) ?? Buffer.alloc(0)
          if (!state.write || state.write.id !== id) {
            state.write = { id, path: p, chunks: [] }
          }
          state.write.chunks.push(data)
          if (!msg.hasNext) {
            state.files.set(p, Buffer.concat(state.write.chunks))
            const final = state.write
            state.write = null
            sendEmpty(final.id, 0)
          }
          break
        }
        case CMD.STORAGE_STAT_REQUEST: {
          const p = strField(fields, 1)
          const data = state.files.get(p)
          if (!data) {
            sendEmpty(id, 7)
            break
          }
          sendMain({
            id,
            field: CMD.STORAGE_STAT_RESPONSE,
            payload: pack((w) =>
              w.msg(1, (f) => {
                f.uint(1, 0)
                f.uint(3, data.length)
              }),
            ),
          })
          break
        }
        case CMD.STORAGE_MD5SUM_REQUEST:
          sendMain({
            id,
            field: CMD.STORAGE_MD5SUM_RESPONSE,
            payload: pack((w) => w.str(1, '0'.repeat(32))),
          })
          break
        case CMD.STORAGE_DELETE_REQUEST:
          state.files.delete(strField(fields, 1))
          sendEmpty(id, 0)
          break
        case CMD.STORAGE_MKDIR_REQUEST:
          sendEmpty(id, 0)
          break
        case CMD.STORAGE_RENAME_REQUEST: {
          const from = strField(fields, 1)
          const to = strField(fields, 2)
          const data = state.files.get(from)
          if (data) {
            state.files.delete(from)
            state.files.set(to, data)
          }
          sendEmpty(id, 0)
          break
        }
        case CMD.APP_START_REQUEST: {
          const name = strField(fields, 1)
          if (name !== 'Sub-GHz' && name !== 'Infrared' && name !== 'NFC') {
            sendEmpty(id, 15)
            break
          }
          state.appRunning = name
          sendEmpty(id, 0)
          break
        }
        case CMD.APP_EXIT_REQUEST:
          state.appRunning = null
          sendEmpty(id, 0)
          break
        case CMD.APP_LOAD_FILE_REQUEST:
          if (!state.appRunning) {
            sendEmpty(id, 21)
            break
          }
          sendEmpty(id, 0)
          break
        case CMD.APP_LOCK_STATUS_REQUEST:
          sendMain({
            id,
            field: CMD.APP_LOCK_STATUS_RESPONSE,
            payload: pack((w) => w.uint(1, 0)),
          })
          break
        case CMD.APP_GET_ERROR_REQUEST:
          sendMain({
            id,
            field: CMD.APP_GET_ERROR_RESPONSE,
            payload: pack((w) => {
              w.uint(1, 0)
              w.str(2, '')
            }),
          })
          break
        case CMD.GUI_START_SCREEN_STREAM_REQUEST:
          if (state.screenStream) {
            sendEmpty(id, 19)
            break
          }
          state.screenStream = true
          sendEmpty(id, 0)
          sendScreen()
          break
        case CMD.GUI_STOP_SCREEN_STREAM_REQUEST:
          state.screenStream = false
          sendEmpty(id, 0)
          break
        case CMD.GUI_SEND_INPUT_EVENT_REQUEST:
          state.inputs.push({ key: numField(fields, 1), type: numField(fields, 2) })
          sendEmpty(id, 0)
          break
        case CMD.SYSTEM_GET_DATETIME_REQUEST:
          sendMain({
            id,
            field: CMD.SYSTEM_GET_DATETIME_RESPONSE,
            payload: pack((w) =>
              w.msg(1, (d) => {
                d.uint(1, 17)
                d.uint(2, 30)
                d.uint(3, 5)
                d.uint(4, 8)
                d.uint(5, 11)
                d.uint(6, 2026)
                d.uint(7, 7)
              }),
            ),
          })
          break
        case CMD.SYSTEM_PLAY_ALERT_REQUEST:
          sendEmpty(id, 0)
          break
        case CMD.PROPERTY_GET_REQUEST:
          sendMain({
            id,
            field: CMD.PROPERTY_GET_RESPONSE,
            payload: pack((w) => {
              w.str(1, strField(fields, 1))
              w.str(2, 'mock-value')
            }),
          })
          break
        case CMD.GPIO_SET_PIN_MODE:
        case CMD.GPIO_SET_INPUT_PULL:
        case CMD.GPIO_WRITE_PIN:
        case CMD.GPIO_SET_OTG_MODE:
          sendEmpty(id, 0)
          break
        case CMD.GPIO_GET_PIN_MODE:
          sendMain({
            id,
            field: CMD.GPIO_GET_PIN_MODE_RESPONSE,
            payload: pack((w) => w.uint(1, 1)),
          })
          break
        case CMD.GPIO_READ_PIN:
          sendMain({
            id,
            field: CMD.GPIO_READ_PIN_RESPONSE,
            payload: pack((w) => w.uint(2, 1)),
          })
          break
        case CMD.DESKTOP_IS_LOCKED_REQUEST:
          sendMain({
            id,
            field: CMD.DESKTOP_STATUS,
            payload: pack((w) => w.uint(1, 0)),
          })
          break
        case CMD.STOP_SESSION:
          sendEmpty(id, 0)
          setTimeout(() => {
            state.rpcMode = false
            socket.write('>: ')
          }, 40)
          break
        default:
          sendEmpty(id, 3)
      }
    }

    const onRpcData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length === 0) return
        const head = readVarint(buffer, 0)
        if (!head) return
        const [length, offset] = head
        if (buffer.length < offset + length) return
        const frame = buffer.subarray(offset, offset + length)
        buffer = buffer.subarray(offset + length)
        handleRpc(decodeMain(frame))
      }
    }

    const onCliData = (chunk) => {
      cli += chunk.toString('binary')
      while (true) {
        const index = cli.indexOf('\r')
        if (index < 0) break
        const line = cli.slice(0, index)
        cli = cli.slice(index + 1)
        const command = line.trim()
        state.cliLog.push(command)
        if (!command) continue
        if (command === 'start_rpc_session') {
          socket.write('start_rpc_session\r\n')
          state.rpcMode = true
          buffer = Buffer.alloc(0)
          return
        }
        let output = ''
        if (command === 'power info') output = 'Charge level: 78%\nVoltage: 4021 mV'
        else if (command === 'storage list /ext') output = 'nfc\ninfrared'
        else output = `Unknown command: ${command}`
        socket.write(command + '\r\n' + output + '\r\n>: ')
      }
    }

    socket.on('data', (chunk) => {
      if (state.rpcMode) onRpcData(chunk)
      else onCliData(chunk)
    })
  })

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port } = server.address()
      resolve({
        port,
        host,
        state,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.close(() => done())
          }),
      })
    })
  })
}
