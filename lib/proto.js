// 极简 protobuf 编解码。只覆盖 Flipper RPC 用到的两种 wire type：
//   varint(0) 与 length-delimited(2)。
// 不引入 protobufjs：插件要在手机上的 proot 环境里零依赖安装。

export class Writer {
  constructor() {
    this.parts = []
  }

  raw(buf) {
    this.parts.push(buf)
    return this
  }

  varint(value) {
    let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)))
    if (v < 0n) v = BigInt.asUintN(64, v)
    const out = []
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n))
      v >>= 7n
    }
    out.push(Number(v))
    this.parts.push(Buffer.from(out))
    return this
  }

  tag(field, wire) {
    return this.varint((field << 3) | wire)
  }

  /** proto3 语义：0 不编码 */
  uint(field, value) {
    if (value === undefined || value === null || Number(value) === 0) return this
    this.tag(field, 0)
    return this.varint(value)
  }

  bool(field, value) {
    return value ? this.uint(field, 1) : this
  }

  bytes(field, buf) {
    if (!buf || buf.length === 0) return this
    this.tag(field, 2)
    this.varint(buf.length)
    return this.raw(buf)
  }

  str(field, value) {
    if (value === undefined || value === null || value === '') return this
    return this.bytes(field, Buffer.from(String(value), 'utf8'))
  }

  msg(field, build) {
    const sub = new Writer()
    build(sub)
    const buf = sub.finish()
    this.tag(field, 2)
    this.varint(buf.length)
    return this.raw(buf)
  }

  finish() {
    return Buffer.concat(this.parts)
  }
}

/** 读一个 varint；offset 处数据不完整时返回 null。 */
export function readVarint(buf, offset = 0) {
  let result = 0
  let shift = 0
  let i = offset
  while (i < buf.length) {
    const byte = buf[i]
    i += 1
    result += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return [result, i]
    shift += 7
    if (shift > 63) throw new Error('varint 过长')
  }
  return null
}

export function parseFields(buf) {
  const fields = []
  let i = 0
  while (i < buf.length) {
    const head = readVarint(buf, i)
    if (!head) throw new Error('protobuf 字段头不完整')
    const [tag, afterTag] = head
    i = afterTag
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) {
      const v = readVarint(buf, i)
      if (!v) throw new Error('protobuf varint 不完整')
      fields.push({ field, wire, value: v[0] })
      i = v[1]
    } else if (wire === 2) {
      const l = readVarint(buf, i)
      if (!l) throw new Error('protobuf 长度不完整')
      const len = l[0]
      i = l[1]
      if (i + len > buf.length) throw new Error('protobuf 长度越界')
      fields.push({ field, wire, value: buf.subarray(i, i + len) })
      i += len
    } else if (wire === 1) {
      fields.push({ field, wire, value: buf.subarray(i, i + 8) })
      i += 8
    } else if (wire === 5) {
      fields.push({ field, wire, value: buf.subarray(i, i + 4) })
      i += 4
    } else {
      throw new Error('不支持的 protobuf wire type ' + wire)
    }
  }
  return fields
}

export function numField(fields, field, fallback = 0) {
  for (const f of fields) if (f.field === field && f.wire === 0) return f.value
  return fallback
}

export function bytesField(fields, field) {
  for (const f of fields) if (f.field === field && f.wire === 2) return f.value
  return undefined
}

export function strField(fields, field, fallback = '') {
  const b = bytesField(fields, field)
  return b === undefined ? fallback : b.toString('utf8')
}

export function subFields(fields, field) {
  return fields.filter((f) => f.field === field && f.wire === 2).map((f) => parseFields(f.value))
}
