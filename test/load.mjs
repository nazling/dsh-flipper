process.env.DSH_HOME = '/tmp/dsh-flipper-test'
import { apply, Config } from '../index.js'

const tools = []
const panels = []
const strips = []
const config = {
  transport: 'auto', tcpHost: '', tcpPort: 9757, serialPath: '', baud: 230400, timeoutMs: 8000,
}
const services = {
  dshGo: {
    panel: (id, definition) => panels.push({ id, definition }),
    strip: (id, fn) => strips.push({ id, fn }),
  },
  systemPrompt: {
    section: (section) => { console.log('prompt section:', section.name, 'order', section.order) },
  },
  skills: {
    register: (definition) => {
      console.log('skill:', definition.name)
      return () => {}
    },
  },
}
const ctx = {
  config,
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
  inject: (_deps, callback) => callback({ ...services, tools: ctx.tools }),
}
apply(ctx, config)
console.log('tools:', tools.map((tool) => tool.name).join(', '))
console.log('panels:', panels.map((panel) => panel.id).join(', '))
console.log('strips:', strips.map((strip) => strip.id).join(', '))
for (const tool of tools) {
  if (!tool.parameters || tool.parameters.type !== 'object') throw new Error('bad parameters: ' + tool.name)
}
const view = panels[0].definition.view({}, {})
console.log('view ok:', view.type, view.children.length)
console.log('load ok')
