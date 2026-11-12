import fs from 'node:fs'
import { framebufferToBitmap, encodePng, toAsciiArt } from '../lib/screen.js'
const fb = fs.readFileSync('/tmp/flipper-frame.bin')
const bm = framebufferToBitmap(fb, 0)
fs.writeFileSync('/tmp/ble-frame.png', encodePng(bm))
console.log(toAsciiArt(bm).split('\n').slice(0, 12).join('\n'))
