process.env.DSH_HOME = '/tmp/dsh-flipper-test'
import { FlipperManager } from '../lib/manager.js'
const m = new FlipperManager({ defaults: { transport: 'tcp', tcpHost: '127.0.0.1', tcpPort: 9757 } })
const t0 = Date.now()
const caps = await m.capabilities()
console.log('elapsed', Date.now() - t0, 'ms')
console.log('firmware', caps.device.firmware, 'battery', caps.device.battery?.level)
console.log('externalApps', caps.externalApps.length, caps.externalApps.slice(0, 8))
for (const [dir, info] of Object.entries(caps.resources)) {
  console.log(dir, info.error ? 'ERR ' + info.error : `${info.total} items, ${info.fileCount} files`, (info.files || []).slice(0, 4))
}
await m.disconnect()
