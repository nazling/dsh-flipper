// Flipper Zero RPC 客户端：varint 分帧、命令排队、屏幕流、CLI 切换。
import { EventEmitter } from 'node:events'
import { readVarint } from './proto.js'
import {
  CMD,
  STATUS,
  decodeMain,
  decodeBody,
  encodeMain,
  requests,
} from './messages.js'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class FlipperError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'FlipperError'
    if (status !== undefined) {
      this.status = status
      this.code = STATUS[status] ?? String(status)
    }
  }
}

/**
 * @param {object} transport 需实现 open/close/write，并发出 'data' 'close' 'error'
 */
export class FlipperRpc extends EventEmitter {
  constructor(transport, { timeoutMs = 8000, log = () => {} } = {}) {
    super()
    this.transport = transport
    this.timeoutMs = timeoutMs
    this.log = log
    this.connected = false
    this.mode = 'idle' // idle | handshake | rpc | cli
    this.buf = Buffer.alloc(0)
    this.cliBuf = Buffer.alloc(0)
    this.pending = new Map()
    this.nextId = 0
    this.queue = Promise.resolve()
    this.lastDataAt = 0
    this.handshakeData = ''
    this.lastFrame = null
    this.bytesIn = 0
    this.bytesOut = 0

    this.onTransportData = (chunk) => this.#onData(chunk)
    this.onTransportClose = () => this.#onClose()
  }

  // ---- 连接 ----

  async connect() {
    if (this.connected) return this
    this.mode = 'handshake'
    await this.transport.open()
    this.transport.on('data', this.onTransportData)
    this.transport.on('close', this.onTransportClose)
    this.transport.on('error', this.onTransportClose)

    this.buf = Buffer.alloc(0)
    await sleep(60)
    this.lastDataAt = Date.now()
    await this.#waitQuiet(120, 500)

    let lastError
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.log(`rpc: start session attempt ${attempt}`)
      this.handshakeData = ''
      await this.transport.write(Buffer.from('start_rpc_session\r'))
      await this.#waitHandshake(1000, 60)

      this.mode = 'rpc'
      this.buf = Buffer.alloc(0)
      try {
        await this.#requestRaw(requests.ping(Buffer.from('dsh')), { timeoutMs: 1600 })
        this.connected = true
        this.mode = 'rpc'
        this.log('rpc: session ready')
        return this
      } catch (error) {
        lastError = error
        this.connected = false
        this.mode = 'handshake'
        // 设备可能停在上一轮未关闭的 RPC 会话里：发一个 stop_session 把它推回 CLI，
        // 再补一个回车清掉 CLI 行缓冲。
        try {
          await this.transport.write(
            encodeMain({ id: 0, field: CMD.STOP_SESSION, payload: Buffer.alloc(0) }),
          )
        } catch {}
        await sleep(120)
        try {
          await this.transport.write(Buffer.from('\r'))
        } catch {}
        this.lastDataAt = Date.now()
        await this.#waitQuiet(140, 500)
      }
    }

    this.mode = 'idle'
    this.#detach()
    try {
      await this.transport.close()
    } catch {}
    throw new FlipperError(
      '没能和 Flipper 建立 RPC 会话。请确认：设备已连接、没被 qFlipper/其他 App 占用，串口权限正常。' +
        (lastError ? `（最后一次：${lastError.message}）` : ''),
      { cause: lastError },
    )
  }

  async disconnect() {
    const wasRpc = this.mode === 'rpc' && this.connected
    if (wasRpc) {
      try {
        await Promise.race([
          this.#requestRaw(requests.stopSession(), { timeoutMs: 800 }),
          sleep(900),
        ])
      } catch {}
    }
    this.connected = false
    this.mode = 'idle'
    this.#detach()
    try {
      await this.transport.close()
    } catch {}
    this.#rejectAll(new FlipperError('Flipper 连接已关闭'))
  }

  #detach() {
    this.transport.off('data', this.onTransportData)
    this.transport.off('close', this.onTransportClose)
    this.transport.off('error', this.onTransportClose)
  }

  #onClose() {
    if (!this.connected) return
    this.connected = false
    this.mode = 'idle'
    this.emit('close')
    this.#rejectAll(new FlipperError('Flipper 连接断开'))
  }

  #onData(chunk) {
    this.bytesIn += chunk.length
    this.lastDataAt = Date.now()
    if (this.mode === 'handshake') {
      // CLI 会回显 start_rpc_session 并以换行结束；等它出现再切到 protobuf，
      // 否则回显字节会被当成 RPC 帧，后续 ping 全部错位。
      this.handshakeData += chunk.toString('latin1')
      if (this.handshakeData.length > 4096) this.handshakeData = this.handshakeData.slice(-4096)
      return
    }
    if (this.mode === 'cli') {
      this.cliBuf = Buffer.concat([this.cliBuf, chunk])
      this.emit('cli-data')
      return
    }
    if (this.mode !== 'rpc') return
    this.buf = Buffer.concat([this.buf, chunk])
    this.#drainFrames()
  }

  #drainFrames() {
    for (;;) {
      if (this.buf.length === 0) return
      let head
      try {
        head = readVarint(this.buf, 0)
      } catch {
        this.buf = Buffer.alloc(0)
        return
      }
      if (!head) return
      const [length, offset] = head
      if (length > 4 * 1024 * 1024) {
        this.log(`rpc: 异常帧长度 ${length}，清空缓冲`)
        this.buf = Buffer.alloc(0)
        return
      }
      if (this.buf.length < offset + length) return
      const frame = this.buf.subarray(offset, offset + length)
      this.buf = this.buf.subarray(offset + length)
      let msg
      try {
        msg = decodeMain(frame)
      } catch (error) {
        this.log(`rpc: 解帧失败 ${error.message}`)
        continue
      }
      this.#handleMessage(msg)
    }
  }

  #handleMessage(msg) {
    let body = {}
    try {
      body = decodeBody(msg.field, msg.payload)
    } catch (error) {
      this.log(`rpc: 解码内容失败 field=${msg.field} ${error.message}`)
    }
    msg.body = body

    if (msg.field === CMD.GUI_SCREEN_FRAME) {
      const frame = {
        data: body.data ?? Buffer.alloc(0),
        orientation: body.orientation ?? 0,
        at: Date.now(),
      }
      // 帧可能和 start 的 OK 同包到达；先存一份，避免等待者还没挂上就丢了。
      this.lastFrame = frame
      this.emit('screen', frame)
      return
    }
    if (msg.field === CMD.APP_STATE_RESPONSE) {
      this.emit('app-state', body.state)
      return
    }
    if (msg.field === CMD.DESKTOP_STATUS) {
      this.emit('desktop-status', body)
      return
    }

    const waiter = this.pending.get(msg.id)
    if (!waiter) {
      this.emit('unsolicited', msg)
      return
    }
    waiter.messages.push(msg)
    if (!msg.hasNext) this.#settle(waiter)
  }

  #settle(waiter) {
    clearTimeout(waiter.timer)
    this.pending.delete(waiter.id)
    const bad = waiter.messages.find((m) => m.status !== 0)
    if (bad) {
      waiter.reject(
        new FlipperError(`Flipper 返回 ${STATUS[bad.status] ?? bad.status}`, { status: bad.status }),
      )
    } else {
      waiter.resolve(waiter.messages)
    }
  }

  #rejectAll(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  // ---- 命令 ----

  #enqueue(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 排队执行，避免多个工具同时操作 Flipper 的内部会话状态。 */
  request(spec, options = {}) {
    return this.#enqueue(() => this.#requestRaw(spec, options))
  }

  #requestRaw(spec, { timeoutMs } = {}) {
    if (this.mode !== 'rpc') {
      return Promise.reject(new FlipperError('Flipper RPC 会话未就绪'))
    }
    const id = this.nextId >= 0xfffffffe ? 1 : this.nextId + 1
    this.nextId = id
    const timeout = timeoutMs ?? this.timeoutMs
    const payload = encodeMain({ id, field: spec.field, payload: spec.payload })
    this.bytesOut += payload.length

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new FlipperError(`等待 Flipper 响应超时（${timeout}ms）`))
      }, timeout)
      this.pending.set(id, { id, resolve, reject, timer, messages: [] })
    })

    this.transport.write(payload).catch((error) => {
      const waiter = this.pending.get(id)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.pending.delete(id)
        waiter.reject(new FlipperError('发送失败：' + error.message, { cause: error }))
      }
    })

    return promise
  }

  async #waitHandshake(maxMs, settleMs) {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      if (this.handshakeData.includes('\n')) break
      await sleep(10)
    }
    await sleep(settleMs)
  }

  async #waitQuiet(quietMs, maxMs) {
    const start = Date.now()
    for (;;) {
      const now = Date.now()
      if (now - this.lastDataAt >= quietMs) return
      if (now - start >= maxMs) return
      await sleep(20)
    }
  }

  // ---- 屏幕 ----

  /** 抓一帧屏幕（128x64 1bpp）。内部会自己开关屏幕流。 */
  screenshot({ timeoutMs = 5000 } = {}) {
    return this.#enqueue(async () => {
      let started = false
      this.lastFrame = null
      try {
        await this.#requestRaw(requests.guiStartScreenStream(), { timeoutMs: 3000 })
        started = true
      } catch (error) {
        if (error.status === 19) {
          // 上一次流没有关掉：关掉再来
          try {
            await this.#requestRaw(requests.guiStopScreenStream(), { timeoutMs: 2000 })
          } catch {}
          await this.#requestRaw(requests.guiStartScreenStream(), { timeoutMs: 3000 })
          started = true
        } else {
          throw error
        }
      }
      try {
        const frame = this.lastFrame ?? (await this.#waitScreenFrame(timeoutMs))
        return frame
      } finally {
        if (started) {
          try {
            await this.#requestRaw(requests.guiStopScreenStream(), { timeoutMs: 2000 })
          } catch {}
        }
      }
    })
  }

  #waitScreenFrame(timeoutMs) {
    return new Promise((resolve, reject) => {
      const onFrame = (frame) => {
        cleanup()
        resolve(frame)
      }
      const onClose = () => {
        cleanup()
        reject(new FlipperError('屏幕流期间连接断开'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new FlipperError('等待 Flipper 屏幕帧超时（屏幕可能没有刷新）'))
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        this.off('screen', onFrame)
        this.off('close', onClose)
      }
      this.on('screen', onFrame)
      this.on('close', onClose)
    })
  }

  // ---- 文件读写（多帧） ----

  async readFile(path) {
    const messages = await this.request(requests.storageRead(path), { timeoutMs: 15000 })
    const chunks = []
    for (const msg of messages) {
      const file = msg.body?.file
      if (file?.data?.length) chunks.push(file.data)
    }
    return Buffer.concat(chunks)
  }

  async list(path, options) {
    const messages = await this.request(requests.storageList(path, options), { timeoutMs: 20000 })
    const files = []
    for (const msg of messages) files.push(...(msg.body?.files ?? []))
    return files
  }

  /** 分块写文件：所有分片共用同一个 command_id，固件只在最后回一个响应。 */
  writeFile(path, buffer, { chunkSize = 512, timeoutMs = 20000 } = {}) {
    return this.#enqueue(async () => {
      if (this.mode !== 'rpc') throw new FlipperError('Flipper RPC 会话未就绪')
      const id = this.nextId >= 0xfffffffe ? 1 : this.nextId + 1
      this.nextId = id
      const total = Math.max(1, Math.ceil(buffer.length / chunkSize))
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new FlipperError(`写入超时（${timeoutMs}ms）`))
        }, timeoutMs)
        this.pending.set(id, { id, resolve, reject, timer, messages: [] })
      })
      try {
        for (let index = 0; index < total; index += 1) {
          const chunk = buffer.subarray(index * chunkSize, Math.min(buffer.length, (index + 1) * chunkSize))
          const frame = encodeMain({
            id,
            field: CMD.STORAGE_WRITE_REQUEST,
            hasNext: index < total - 1,
            payload: requests.storageWrite(path, chunk).payload,
          })
          this.bytesOut += frame.length
          await this.transport.write(frame)
        }
      } catch (error) {
        const waiter = this.pending.get(id)
        if (waiter) {
          clearTimeout(waiter.timer)
          this.pending.delete(id)
        }
        throw new FlipperError('写入发送失败：' + error.message, { cause: error })
      }
      return promise
    })
  }

  // ---- CLI ----

  /** 临时退出 RPC，跑一条 CLI 命令，再恢复 RPC。返回命令输出。 */
  runCli(command, { timeoutMs = 8000 } = {}) {
    return this.#enqueue(async () => {
      if (!this.connected) throw new FlipperError('尚未连接 Flipper')
      const trimmed = String(command).trim()
      if (!trimmed) throw new FlipperError('命令为空')
      if (/^start_rpc_session$/i.test(trimmed)) throw new FlipperError('不能手动执行 start_rpc_session')

      this.mode = 'handshake'
      try {
        await this.transport.write(
          encodeMain({ id: 0, field: CMD.STOP_SESSION, payload: Buffer.alloc(0) }),
        )
      } catch (error) {
        this.mode = 'idle'
        throw new FlipperError('关闭 RPC 会话失败：' + error.message, { cause: error })
      }
      // 等会话关闭的 OK 和 CLI 提示符都到齐、串口安静下来，再切文本模式；
      // 否则提示符会被当成命令的输出，命令就“没有输出”了。
      this.lastDataAt = Date.now()
      await this.#waitQuiet(300, 1500)
      this.mode = 'cli'
      this.cliBuf = Buffer.alloc(0)
      try {
        await this.transport.write(Buffer.from(trimmed + '\r'))
      } catch (error) {
        await this.#resumeRpc()
        throw new FlipperError('发送 CLI 命令失败：' + error.message, { cause: error })
      }

      const { text, complete } = await this.#readCliUntilPrompt(timeoutMs)
      const output = stripCliEcho(text, trimmed)
      await this.#resumeRpc()
      return { command: trimmed, output, complete }
    })
  }

  async #resumeRpc() {
    this.mode = 'handshake'
    this.buf = Buffer.alloc(0)
    this.handshakeData = ''
    try {
      await this.transport.write(Buffer.from('start_rpc_session\r'))
    } catch {
      this.connected = false
      this.mode = 'idle'
      return
    }
    await this.#waitHandshake(1200, 60)
    this.mode = 'rpc'
    this.buf = Buffer.alloc(0)
    try {
      await this.#requestRaw(requests.ping(Buffer.alloc(0)), { timeoutMs: 1500 })
      this.connected = true
    } catch {
      this.connected = false
      this.mode = 'idle'
    }
  }

  #readCliUntilPrompt(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now()
      let done = false
      const check = () => {
        if (done) return
        const index = this.cliBuf.indexOf('>:')
        if (index >= 0) {
          done = true
          cleanup()
          resolve({ text: this.cliBuf.subarray(0, index).toString('utf8'), complete: true })
          return
        }
        if (Date.now() - start >= timeoutMs) {
          done = true
          cleanup()
          resolve({ text: this.cliBuf.toString('utf8'), complete: false })
        }
      }
      const onData = () => check()
      const timer = setInterval(check, 40)
      const cleanup = () => {
        clearInterval(timer)
        this.off('cli-data', onData)
      }
      this.on('cli-data', onData)
      check()
    })
  }
}

function stripCliEcho(text, command) {
  let out = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const firstBreak = out.indexOf('\n')
  if (firstBreak >= 0) {
    const firstLine = out.slice(0, firstBreak).trim()
    if (firstLine.endsWith(command)) out = out.slice(firstBreak + 1)
  } else if (out.trim().endsWith(command)) {
    out = ''
  }
  return out.replace(/\n{3,}/g, '\n\n').trimEnd()
}
