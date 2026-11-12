import fs from 'node:fs'
import { TcpTransport } from '../lib/transport.js'
import { FlipperRpc } from '../lib/rpc.js'
const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 9757)
const rpc = new FlipperRpc(new TcpTransport({ host, port }))
await rpc.connect()
const frame = await rpc.screenshot()
fs.writeFileSync('/tmp/flipper-frame.bin', frame.data)
console.log('bytes', frame.data.length, 'orientation', frame.orientation)
await rpc.disconnect()
