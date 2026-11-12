import { startMockFlipper } from './mock-flipper.mjs'
const port = Number(process.argv[2] || 19757)
const mock = await startMockFlipper({ host: '127.0.0.1', port })
console.log('MOCK_PORT=' + mock.port)
process.on('SIGTERM', async () => { await mock.close(); process.exit(0) })
setInterval(() => {}, 1000)
