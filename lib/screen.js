// Flipper 128x64 单色帧缓冲 → PNG / ASCII / 盲文点阵。
// 帧缓冲布局：每行 16 字节，每字节 8 个横向像素，MSB 在最左。
import zlib from 'node:zlib'

export const SCREEN_WIDTH = 128
export const SCREEN_HEIGHT = 64
export const SCREEN_BYTES = (SCREEN_WIDTH * SCREEN_HEIGHT) / 8

export function normalizeFramebuffer(data) {
  if (!data) return Buffer.alloc(SCREEN_BYTES)
  if (data.length === SCREEN_BYTES) return data
  const out = Buffer.alloc(SCREEN_BYTES)
  data.copy(out, 0, 0, Math.min(data.length, SCREEN_BYTES))
  return out
}

/** 返回 0/1 位图，已按 orientation 旋转。 */
export function framebufferToBitmap(data, orientation = 0) {
  const fb = normalizeFramebuffer(data)
  // Flipper 的 Canvas 是 SSD1306 式的纵向页格式：
  //   index = (y / 8) * 128 + x，bit 0 是最上面那一行。
  const src = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT)
  for (let y = 0; y < SCREEN_HEIGHT; y += 1) {
    const page = (y >> 3) * SCREEN_WIDTH
    const bit = y & 7
    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      src[y * SCREEN_WIDTH + x] = (fb[page + x] >> bit) & 1
    }
  }
  const turns = ((orientation % 4) + 4) % 4
  if (turns === 0) return { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, pixels: src }
  let width = SCREEN_WIDTH
  let height = SCREEN_HEIGHT
  let current = src
  for (let i = 0; i < turns; i += 1) {
    const next = new Uint8Array(current.length)
    const nw = height
    const nh = width
    for (let y = 0; y < nh; y += 1) {
      for (let x = 0; x < nw; x += 1) {
        next[y * nw + x] = current[(nh - 1 - x) * width + y]
      }
    }
    current = next
    width = nw
    height = nh
  }
  return { width, height, pixels: current }
}

export function bitmapToGray(bitmap) {
  const out = Buffer.alloc(bitmap.width * bitmap.height)
  for (let i = 0; i < out.length; i += 1) out[i] = bitmap.pixels[i] ? 0 : 255
  return out
}

// ---- PNG ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

export function encodePng(bitmap) {
  const { width, height } = bitmap
  const gray = bitmapToGray(bitmap)
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0 // filter: none
    gray.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- 文本 ----

/** 半块字符：1 字符 = 1x2 像素，128x32，文字最容易辨认。 */
export function toAsciiArt(bitmap) {
  const { width, height, pixels } = bitmap
  const lines = []
  for (let y = 0; y < height; y += 2) {
    let line = ''
    for (let x = 0; x < width; x += 1) {
      const top = pixels[y * width + x]
      const bottom = y + 1 < height ? pixels[(y + 1) * width + x] : 0
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line.replace(/\s+$/u, ''))
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text || '（屏幕是空白的）'
}

/** 盲文点阵：1 字符 = 2x4 像素，64x16，最省 token。 */
export function toBraille(bitmap) {
  const { width, height, pixels } = bitmap
  const lines = []
  const dots = [
    [0, 0, 0x01],
    [0, 1, 0x02],
    [0, 2, 0x04],
    [1, 0, 0x08],
    [1, 1, 0x10],
    [1, 2, 0x20],
    [0, 3, 0x40],
    [1, 3, 0x80],
  ]
  for (let y = 0; y < height; y += 4) {
    let line = ''
    for (let x = 0; x < width; x += 2) {
      let bits = 0
      for (const [dx, dy, bit] of dots) {
        const px = x + dx
        const py = y + dy
        if (px < width && py < height && pixels[py * width + px]) bits |= bit
      }
      line += String.fromCodePoint(0x2800 + bits)
    }
    lines.push(line.replace(/\u2800+$/u, ''))
  }
  return lines.join('\n').trim() || '（屏幕是空白的）'
}

export function pngDataUrl(png) {
  return 'data:image/png;base64,' + png.toString('base64')
}
