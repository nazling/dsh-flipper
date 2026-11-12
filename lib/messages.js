// Flipper Zero RPC 消息：字段号来自官方 flipperzero-protobuf（flipper.proto + 各子系统）。
// encodeMain/decodeMain 之外，这里只实现插件真正用到的命令。
import { Writer, parseFields, numField, bytesField, strField, subFields } from './proto.js'

export const CMD = {
  EMPTY: 4,
  STOP_SESSION: 19,

  SYSTEM_PING_REQUEST: 5,
  SYSTEM_PING_RESPONSE: 6,
  SYSTEM_REBOOT_REQUEST: 31,
  SYSTEM_DEVICE_INFO_REQUEST: 32,
  SYSTEM_DEVICE_INFO_RESPONSE: 33,
  SYSTEM_FACTORY_RESET_REQUEST: 34,
  SYSTEM_GET_DATETIME_REQUEST: 35,
  SYSTEM_GET_DATETIME_RESPONSE: 36,
  SYSTEM_SET_DATETIME_REQUEST: 37,
  SYSTEM_PLAY_ALERT_REQUEST: 38,
  SYSTEM_PROTOBUF_VERSION_REQUEST: 39,
  SYSTEM_PROTOBUF_VERSION_RESPONSE: 40,
  SYSTEM_POWER_INFO_REQUEST: 44,
  SYSTEM_POWER_INFO_RESPONSE: 45,

  STORAGE_INFO_REQUEST: 28,
  STORAGE_INFO_RESPONSE: 29,
  STORAGE_TIMESTAMP_REQUEST: 59,
  STORAGE_TIMESTAMP_RESPONSE: 60,
  STORAGE_STAT_REQUEST: 24,
  STORAGE_STAT_RESPONSE: 25,
  STORAGE_LIST_REQUEST: 7,
  STORAGE_LIST_RESPONSE: 8,
  STORAGE_READ_REQUEST: 9,
  STORAGE_READ_RESPONSE: 10,
  STORAGE_WRITE_REQUEST: 11,
  STORAGE_DELETE_REQUEST: 12,
  STORAGE_MKDIR_REQUEST: 13,
  STORAGE_MD5SUM_REQUEST: 14,
  STORAGE_MD5SUM_RESPONSE: 15,
  STORAGE_RENAME_REQUEST: 30,

  APP_START_REQUEST: 16,
  APP_LOCK_STATUS_REQUEST: 17,
  APP_LOCK_STATUS_RESPONSE: 18,
  APP_EXIT_REQUEST: 47,
  APP_LOAD_FILE_REQUEST: 48,
  APP_BUTTON_PRESS_REQUEST: 49,
  APP_BUTTON_RELEASE_REQUEST: 50,
  APP_BUTTON_PRESS_RELEASE_REQUEST: 75,
  APP_GET_ERROR_REQUEST: 63,
  APP_GET_ERROR_RESPONSE: 64,
  APP_STATE_RESPONSE: 58,

  GUI_START_SCREEN_STREAM_REQUEST: 20,
  GUI_STOP_SCREEN_STREAM_REQUEST: 21,
  GUI_SCREEN_FRAME: 22,
  GUI_SEND_INPUT_EVENT_REQUEST: 23,
  GUI_START_VIRTUAL_DISPLAY_REQUEST: 26,
  GUI_STOP_VIRTUAL_DISPLAY_REQUEST: 27,

  GPIO_SET_PIN_MODE: 51,
  GPIO_SET_INPUT_PULL: 52,
  GPIO_GET_PIN_MODE: 53,
  GPIO_GET_PIN_MODE_RESPONSE: 54,
  GPIO_READ_PIN: 55,
  GPIO_READ_PIN_RESPONSE: 56,
  GPIO_WRITE_PIN: 57,
  GPIO_GET_OTG_MODE: 72,
  GPIO_GET_OTG_MODE_RESPONSE: 73,
  GPIO_SET_OTG_MODE: 74,

  PROPERTY_GET_REQUEST: 61,
  PROPERTY_GET_RESPONSE: 62,

  DESKTOP_IS_LOCKED_REQUEST: 66,
  DESKTOP_UNLOCK_REQUEST: 67,
  DESKTOP_STATUS_SUBSCRIBE_REQUEST: 68,
  DESKTOP_STATUS_UNSUBSCRIBE_REQUEST: 69,
  DESKTOP_STATUS: 70,
}

export const STATUS = {
  0: 'OK',
  1: 'ERROR',
  2: 'ERROR_DECODE',
  3: 'ERROR_NOT_IMPLEMENTED',
  4: 'ERROR_BUSY',
  5: 'ERROR_STORAGE_NOT_READY',
  6: 'ERROR_STORAGE_EXIST',
  7: 'ERROR_STORAGE_NOT_EXIST',
  8: 'ERROR_STORAGE_INVALID_PARAMETER',
  9: 'ERROR_STORAGE_DENIED',
  10: 'ERROR_STORAGE_INVALID_NAME',
  11: 'ERROR_STORAGE_INTERNAL',
  12: 'ERROR_STORAGE_NOT_IMPLEMENTED',
  13: 'ERROR_STORAGE_ALREADY_OPEN',
  14: 'ERROR_CONTINUOUS_COMMAND_INTERRUPTED',
  15: 'ERROR_INVALID_PARAMETERS',
  16: 'ERROR_APP_CANT_START',
  17: 'ERROR_APP_SYSTEM_LOCKED',
  18: 'ERROR_STORAGE_DIR_NOT_EMPTY',
  19: 'ERROR_VIRTUAL_DISPLAY_ALREADY_STARTED',
  20: 'ERROR_VIRTUAL_DISPLAY_NOT_STARTED',
  21: 'ERROR_APP_NOT_RUNNING',
  22: 'ERROR_APP_CMD_ERROR',
  58: 'ERROR_GPIO_MODE_INCORRECT',
  59: 'ERROR_GPIO_UNKNOWN_PIN_MODE',
}

export const INPUT_KEY = { up: 0, down: 1, right: 2, left: 3, ok: 4, back: 5 }
export const INPUT_TYPE = { press: 0, release: 1, short: 2, long: 3, repeat: 4 }
export const INPUT_KEY_NAME = Object.fromEntries(Object.entries(INPUT_KEY).map(([k, v]) => [v, k]))
export const INPUT_TYPE_NAME = Object.fromEntries(Object.entries(INPUT_TYPE).map(([k, v]) => [v, k]))

export const GPIO_PINS = ['PC0', 'PC1', 'PC3', 'PB2', 'PB3', 'PA4', 'PA6', 'PA7']
export const GPIO_PIN_MODE = { output: 0, input: 1 }
export const GPIO_PULL = { none: 0, up: 1, down: 2 }
export const REBOOT_MODE = { os: 0, dfu: 1, update: 2 }

const pack = (fn) => {
  const w = new Writer()
  fn(w)
  return w.finish()
}

export function encodeMain({ id = 0, status = 0, hasNext = false, field, payload = Buffer.alloc(0) }) {
  const w = new Writer()
  w.uint(1, id)
  w.uint(2, status)
  w.bool(3, hasNext)
  w.tag(field, 2)
  w.varint(payload.length)
  w.raw(payload)
  const body = w.finish()
  // 固件用 PB_ENCODE_DELIMITED：消息前面必须带 varint 长度。
  const prefix = new Writer()
  prefix.varint(body.length)
  return Buffer.concat([prefix.finish(), body])
}

export function decodeMain(buf) {
  const fields = parseFields(buf)
  let content
  for (const f of fields) {
    if (f.field > 3) {
      content = f
      break
    }
  }
  return {
    id: numField(fields, 1),
    status: numField(fields, 2),
    hasNext: numField(fields, 3) !== 0,
    field: content ? content.field : 0,
    payload: content && content.wire === 2 ? content.value : Buffer.alloc(0),
  }
}

export function decodeFile(fields) {
  const file = {
    type: numField(fields, 1) === 1 ? 'dir' : 'file',
    name: strField(fields, 2),
    size: numField(fields, 3),
    md5sum: strField(fields, 5),
  }
  const data = bytesField(fields, 4)
  if (data !== undefined) file.data = data
  return file
}

const decodeDateTime = (fields) => ({
  hour: numField(fields, 1),
  minute: numField(fields, 2),
  second: numField(fields, 3),
  day: numField(fields, 4),
  month: numField(fields, 5),
  year: numField(fields, 6),
  weekday: numField(fields, 7),
})

/** 把响应 payload 解成可读对象。未知字段原样返回，方便排查固件版本差异。 */
export function decodeBody(field, payload) {
  const f = parseFields(payload)
  switch (field) {
    case CMD.SYSTEM_PING_RESPONSE:
      return { data: bytesField(f, 1) ?? Buffer.alloc(0) }
    case CMD.SYSTEM_DEVICE_INFO_RESPONSE:
    case CMD.SYSTEM_POWER_INFO_RESPONSE:
      return { key: strField(f, 1), value: strField(f, 2) }
    case CMD.SYSTEM_GET_DATETIME_RESPONSE: {
      const d = subFields(f, 1)
      return { datetime: d.length ? decodeDateTime(d[0]) : null }
    }
    case CMD.SYSTEM_PROTOBUF_VERSION_RESPONSE:
      return { major: numField(f, 1), minor: numField(f, 2) }
    case CMD.STORAGE_INFO_RESPONSE:
      return { totalSpace: numField(f, 1), freeSpace: numField(f, 2) }
    case CMD.STORAGE_TIMESTAMP_RESPONSE:
      return { timestamp: numField(f, 1) }
    case CMD.STORAGE_STAT_RESPONSE: {
      const file = subFields(f, 1)
      return { file: file.length ? decodeFile(file[0]) : null }
    }
    case CMD.STORAGE_LIST_RESPONSE:
      return { files: subFields(f, 1).map(decodeFile) }
    case CMD.STORAGE_READ_RESPONSE: {
      const file = subFields(f, 1)
      return { file: file.length ? decodeFile(file[0]) : null }
    }
    case CMD.STORAGE_MD5SUM_RESPONSE:
      return { md5sum: strField(f, 1) }
    case CMD.APP_LOCK_STATUS_RESPONSE:
      return { locked: numField(f, 1) !== 0 }
    case CMD.APP_STATE_RESPONSE:
      return { state: numField(f, 1) === 1 ? 'started' : 'closed' }
    case CMD.APP_GET_ERROR_RESPONSE:
      return { code: numField(f, 1), text: strField(f, 2) }
    case CMD.GUI_SCREEN_FRAME:
      return {
        data: bytesField(f, 1) ?? Buffer.alloc(0),
        orientation: numField(f, 2),
      }
    case CMD.GPIO_GET_PIN_MODE_RESPONSE:
      return { mode: numField(f, 1) === 1 ? 'input' : 'output' }
    case CMD.GPIO_READ_PIN_RESPONSE:
      // 注意：固件里 value 的字段号是 2，不是 1
      return { value: numField(f, 2) }
    case CMD.GPIO_GET_OTG_MODE_RESPONSE:
      return { enabled: numField(f, 1) === 1 }
    case CMD.PROPERTY_GET_RESPONSE:
      return { key: strField(f, 1), value: strField(f, 2) }
    case CMD.DESKTOP_STATUS:
      return { locked: numField(f, 1) !== 0 }
    case CMD.EMPTY:
      return {}
    default:
      return { raw: payload.toString('hex') }
  }
}

// ---- 请求构造 ----

const emptyPayload = Buffer.alloc(0)

export const requests = {
  stopSession: () => ({ field: CMD.STOP_SESSION, payload: emptyPayload }),
  ping: (data = Buffer.alloc(0)) => ({
    field: CMD.SYSTEM_PING_REQUEST,
    payload: pack((w) => w.bytes(1, data)),
  }),
  deviceInfo: () => ({ field: CMD.SYSTEM_DEVICE_INFO_REQUEST, payload: emptyPayload }),
  powerInfo: () => ({ field: CMD.SYSTEM_POWER_INFO_REQUEST, payload: emptyPayload }),
  protobufVersion: () => ({ field: CMD.SYSTEM_PROTOBUF_VERSION_REQUEST, payload: emptyPayload }),
  getDatetime: () => ({ field: CMD.SYSTEM_GET_DATETIME_REQUEST, payload: emptyPayload }),
  setDatetime: (dt) => ({
    field: CMD.SYSTEM_SET_DATETIME_REQUEST,
    payload: pack((w) =>
      w.msg(1, (d) => {
        d.uint(1, dt.hour)
        d.uint(2, dt.minute)
        d.uint(3, dt.second)
        d.uint(4, dt.day)
        d.uint(5, dt.month)
        d.uint(6, dt.year)
        d.uint(7, dt.weekday)
      }),
    ),
  }),
  alert: () => ({ field: CMD.SYSTEM_PLAY_ALERT_REQUEST, payload: emptyPayload }),
  reboot: (mode = 0) => ({
    field: CMD.SYSTEM_REBOOT_REQUEST,
    payload: pack((w) => w.uint(1, mode)),
  }),
  factoryReset: () => ({ field: CMD.SYSTEM_FACTORY_RESET_REQUEST, payload: emptyPayload }),

  storageInfo: (path = '/') => ({
    field: CMD.STORAGE_INFO_REQUEST,
    payload: pack((w) => w.str(1, path)),
  }),
  storageTimestamp: (path) => ({
    field: CMD.STORAGE_TIMESTAMP_REQUEST,
    payload: pack((w) => w.str(1, path)),
  }),
  storageStat: (path) => ({
    field: CMD.STORAGE_STAT_REQUEST,
    payload: pack((w) => w.str(1, path)),
  }),
  storageList: (path, { includeMd5 = false, filterMaxSize = 0 } = {}) => ({
    field: CMD.STORAGE_LIST_REQUEST,
    payload: pack((w) => {
      w.str(1, path)
      w.bool(2, includeMd5)
      w.uint(3, filterMaxSize)
    }),
  }),
  storageRead: (path) => ({
    field: CMD.STORAGE_READ_REQUEST,
    payload: pack((w) => w.str(1, path)),
  }),
  storageWrite: (path, chunk) => ({
    field: CMD.STORAGE_WRITE_REQUEST,
    payload: pack((w) => {
      w.str(1, path)
      w.msg(2, (file) => file.bytes(4, chunk))
    }),
  }),
  storageDelete: (path, recursive = false) => ({
    field: CMD.STORAGE_DELETE_REQUEST,
    payload: pack((w) => {
      w.str(1, path)
      w.bool(2, recursive)
    }),
  }),
  storageMkdir: (path) => ({
    field: CMD.STORAGE_MKDIR_REQUEST,
    payload: pack((w) => w.str(1, path)),
  }),
  storageMd5sum: (path) => ({
    field: CMD.STORAGE_MD5SUM_REQUEST,
    payload: pack((w) => w.str(1, path)),
  }),
  storageRename: (oldPath, newPath) => ({
    field: CMD.STORAGE_RENAME_REQUEST,
    payload: pack((w) => {
      w.str(1, oldPath)
      w.str(2, newPath)
    }),
  }),

  appStart: (name, args = '') => ({
    field: CMD.APP_START_REQUEST,
    payload: pack((w) => {
      w.str(1, name)
      w.str(2, args)
    }),
  }),
  appLockStatus: () => ({ field: CMD.APP_LOCK_STATUS_REQUEST, payload: emptyPayload }),
  appExit: () => ({ field: CMD.APP_EXIT_REQUEST, payload: emptyPayload }),
  appLoadFile: (path) => ({
    field: CMD.APP_LOAD_FILE_REQUEST,
    payload: pack((w) => w.str(1, path)),
  }),
  appButtonPress: (index = 0, args = '') => ({
    field: CMD.APP_BUTTON_PRESS_REQUEST,
    payload: pack((w) => {
      w.str(1, args)
      w.uint(2, index)
    }),
  }),
  appButtonRelease: () => ({ field: CMD.APP_BUTTON_RELEASE_REQUEST, payload: emptyPayload }),
  appButtonPressRelease: (index = 0, args = '') => ({
    field: CMD.APP_BUTTON_PRESS_RELEASE_REQUEST,
    payload: pack((w) => {
      w.str(1, args)
      w.uint(2, index)
    }),
  }),
  appGetError: () => ({ field: CMD.APP_GET_ERROR_REQUEST, payload: emptyPayload }),

  guiStartScreenStream: () => ({
    field: CMD.GUI_START_SCREEN_STREAM_REQUEST,
    payload: emptyPayload,
  }),
  guiStopScreenStream: () => ({ field: CMD.GUI_STOP_SCREEN_STREAM_REQUEST, payload: emptyPayload }),
  guiSendInput: (key, type) => ({
    field: CMD.GUI_SEND_INPUT_EVENT_REQUEST,
    payload: pack((w) => {
      w.uint(1, key)
      w.uint(2, type)
    }),
  }),

  gpioSetMode: (pin, mode) => ({
    field: CMD.GPIO_SET_PIN_MODE,
    payload: pack((w) => {
      w.uint(1, pin)
      w.uint(2, mode)
    }),
  }),
  gpioSetPull: (pin, pull) => ({
    field: CMD.GPIO_SET_INPUT_PULL,
    payload: pack((w) => {
      w.uint(1, pin)
      w.uint(2, pull)
    }),
  }),
  gpioGetMode: (pin) => ({
    field: CMD.GPIO_GET_PIN_MODE,
    payload: pack((w) => w.uint(1, pin)),
  }),
  gpioRead: (pin) => ({
    field: CMD.GPIO_READ_PIN,
    payload: pack((w) => w.uint(1, pin)),
  }),
  gpioWrite: (pin, value) => ({
    field: CMD.GPIO_WRITE_PIN,
    payload: pack((w) => {
      w.uint(1, pin)
      w.uint(2, value ? 1 : 0)
    }),
  }),
  gpioGetOtg: () => ({ field: CMD.GPIO_GET_OTG_MODE, payload: emptyPayload }),
  gpioSetOtg: (enabled) => ({
    field: CMD.GPIO_SET_OTG_MODE,
    payload: pack((w) => w.uint(1, enabled ? 1 : 0)),
  }),

  propertyGet: (key) => ({
    field: CMD.PROPERTY_GET_REQUEST,
    payload: pack((w) => w.str(1, key)),
  }),

  desktopIsLocked: () => ({ field: CMD.DESKTOP_IS_LOCKED_REQUEST, payload: emptyPayload }),
  desktopUnlock: () => ({ field: CMD.DESKTOP_UNLOCK_REQUEST, payload: emptyPayload }),
  desktopStatusSubscribe: () => ({
    field: CMD.DESKTOP_STATUS_SUBSCRIBE_REQUEST,
    payload: emptyPayload,
  }),
  desktopStatusUnsubscribe: () => ({
    field: CMD.DESKTOP_STATUS_UNSUBSCRIBE_REQUEST,
    payload: emptyPayload,
  }),
}
