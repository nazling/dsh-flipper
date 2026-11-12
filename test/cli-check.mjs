import { TcpTransport } from '../lib/transport.js'
import { FlipperRpc } from '../lib/rpc.js'
const rpc = new FlipperRpc(new TcpTransport({ host: process.argv[2] || '127.0.0.1', port: Number(process.argv[3] || 9757) }))
await rpc.connect()
for (const cmd of ['date', 'power info']) {
  const r = await rpc.runCli(cmd, { timeoutMs: 8000 })
  console.log('CMD', cmd, 'complete=', r.complete)
  console.log(JSON.stringify(r.output))
}
await rpc.disconnect()
