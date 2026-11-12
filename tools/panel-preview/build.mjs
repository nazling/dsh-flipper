// 面板预览脚手架：用真实 React 渲染 lib/client.js 的「Flipper」面板，fetch 全部打桩。
// 用途：改 UI 时不用重启 DSH 也能看效果。
//
//   node tools/panel-preview/build.mjs                     # 用内置占位屏
//   node tools/panel-preview/build.mjs ..\..\tmp-screen.png # 用一张真实截图（128x64 PNG）
//   # 然后随便起个静态服务器，例如 python -m http.server 8891，再打开
//   # http://127.0.0.1:8891/tools/panel-preview/panel-preview.html
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const screenArg = process.argv[2]
const PLACEHOLDER =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64"><rect width="128" height="64" fill="#0b0d10"/>' +
      '<g fill="#e8eaed"><rect x="6" y="6" width="116" height="12"/><rect x="6" y="24" width="70" height="8"/>' +
      '<rect x="6" y="36" width="86" height="8"/><rect x="6" y="48" width="52" height="8"/></g></svg>',
  ).toString('base64')

let dataUrl = PLACEHOLDER
if (screenArg && fs.existsSync(screenArg)) {
  dataUrl = 'data:image/png;base64,' + fs.readFileSync(screenArg).toString('base64')
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>dsh-flipper 面板预览</title>
<style>
  :root{
    --dsw-alias-bg-base:#14161a; --dsw-alias-label-primary:#e7e9ee; --dsw-alias-label-secondary:#98a0ac;
    --dsw-alias-label-tertiary:#7b8290; --dsw-alias-border-l1:rgba(255,255,255,.10); --dsw-alias-border-l2:rgba(255,255,255,.18);
    --dsw-alias-interactive-bg-hover:rgba(255,255,255,.07); --dsw-alias-button-primary-fill:#4c8dff;
    --dsw-alias-button-primary-hover:#3d7bea; --dsw-alias-label-primary-foreground:#fff;
    --dsw-alias-state-success-primary:#2ecc71; --dsw-alias-state-warn-primary:#f1c40f;
    --dsw-alias-state-error-primary:#e74c3c; --dsw-alias-state-business-primary:#4c8dff;
    --dsw-specific-input-major:rgba(8,10,14,.6); --dsw-font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
    --ds-font-family-code:ui-monospace,Consolas,monospace;
  }
  html,body{margin:0;height:100%;background:#14161a;color:#e7e9ee}
  #root{height:100vh;display:flex;flex-direction:column}
</style>
</head>
<body>
<div id="root"></div>
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script>
const SCREEN = ${JSON.stringify(dataUrl)};
const STATUS = {
  ok:true, connected:true, endpoint:'serial://COM6@230400', link:'serial', cliAvailable:true,
  firmware:'v1.1.6', hardware:'Flipper Zero', hardwareUid:'flip_demo',
  battery:{ level:100, voltage:4190, charging:false },
  storage:{ path:'/ext', total:8*1024*1024*1024, free:6.2*1024*1024*1024 },
  appState:null,
};
const STATE = {
  ok:true, connected:true, endpoint:'serial://COM6@230400', error:null,
  config:{ transport:'serial', serialPath:'COM6', tcpHost:'', tcpPort:9757, baud:230400, link:'auto' },
  ports:[
    { path:'COM6', label:'USB 串行设备 (COM6)', deviceId:'USB\\\\VID_0483&PID_5740&MI_00', isFlipper:true, kind:'flipper' },
    { path:'COM7', label:'蓝牙链接上的标准串行 (COM7)', deviceId:'BTHENUM', isFlipper:false, kind:'bluetooth' },
  ],
  backend:{ platform:'win32', win32Native:true, available:true, error:null },
};
const ROUTES = {
  'api/dsh-flipper/state': STATE,
  'api/dsh-flipper/status': { ok:true, status: STATUS },
  'api/dsh-flipper/screen': { ok:true, dataUrl: SCREEN, capturedAt:new Date().toISOString(), width:128, height:64 },
  'api/dsh-flipper/apps': { ok:true, apps:[{name:'Sub-GHz'},{name:'NFC'},{name:'RFID'},{name:'Infrared'},{name:'Bad USB'},{name:'GPIO'}] },
  'api/dsh-flipper/storage': { ok:true, path:'/ext', count:6, files:[
    { type:'dir', name:'apps', path:'/ext/apps' },
    { type:'dir', name:'subghz', path:'/ext/subghz' },
    { type:'dir', name:'nfc', path:'/ext/nfc' },
    { type:'file', name:'Manifest', path:'/ext/Manifest', size:128 },
    { type:'file', name:'readme.txt', path:'/ext/readme.txt', size:1024 },
  ]},
  'api/dsh-flipper/cli': { ok:true, output:'Usage:\\npower <cmd> <args>\\nCmd list:\\n\\toff\\t - shutdown power\\n\\treboot\\t - reboot', complete:true },
  'api/dsh-flipper/input': { ok:true, sent:[{key:'down',type:'short'}], screen: SCREEN },
  'api/dsh-flipper/connect': { ok:true, status: STATUS },
  'api/dsh-flipper/disconnect': { ok:true, connected:false },
  'api/dsh-flipper/app': { ok:true },
  'api/dsh-flipper/system': { ok:true },
  'api/dsh-flipper/ports': { ok:true, ports: STATE.ports },
};
window.fetch = async (url) => {
  const key = String(url).split('?')[0];
  return { ok:true, status:200, json:async () => ROUTES[key] ?? { ok:false, error:'stub 未定义 ' + key } };
};
window.__ModuleLoader__ = {
  load({ factory }) {
    const require = (name) => {
      if (name === 'react') return window.React;
      if (name === 'react/jsx-runtime') return null;
      throw new Error('preview: unknown module ' + name);
    };
    window.__flipperModule = factory(require);
  },
};
</script>
<script src="../../lib/client.js"></script>
<script>
const mod = window.__flipperModule;
const slots = {
  inject(name, cb) { cb(); return () => {}; },
  register(spec, component) {
    if (spec && spec.name === 'main') window.__page = component;
    if (spec && spec.name === 'sidebar.panellist') window.__icon = component;
    return () => {};
  },
};
mod.apply({ slots, effect: (fn) => { const dispose = fn(); return dispose; } });
if (window.__icon) {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;right:10px;top:10px;color:#4c8dff';
  document.body.append(probe);
  ReactDOM.createRoot(probe).render(React.createElement(window.__icon, { size: 22, active: true }));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(window.__page, {}));
</script>
</body>
</html>
`

const out = path.join(here, 'panel-preview.html')
fs.writeFileSync(out, html, 'utf8')
console.log('wrote ' + out)
