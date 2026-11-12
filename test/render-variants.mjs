import fs from 'node:fs'
import { encodePng } from '../lib/screen.js'
const fb = fs.readFileSync('/tmp/flipper-frame.bin')
const W = 128, H = 64
function make(kind) {
  const px = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let bit = 0
      if (kind === 'h-msb') bit = (fb[y * 16 + (x >> 3)] >> (7 - (x & 7))) & 1
      if (kind === 'h-lsb') bit = (fb[y * 16 + (x >> 3)] >> (x & 7)) & 1
      if (kind === 'v-lsb') bit = (fb[(y >> 3) * 128 + x] >> (y & 7)) & 1
      if (kind === 'v-msb') bit = (fb[(y >> 3) * 128 + x] >> (7 - (y & 7))) & 1
      px[y * W + x] = bit
    }
  }
  return { width: W, height: H, pixels: px }
}
for (const kind of ['h-msb', 'h-lsb', 'v-lsb', 'v-msb']) {
  fs.writeFileSync(`/tmp/frame-${kind}.png`, encodePng(make(kind)))
}
console.log('done')
