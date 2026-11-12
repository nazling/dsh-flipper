// dsh-flipper 的浏览器半边：DSH Web GUI 里的「Flipper」面板。
// - 侧边栏一行 + 中间栏整页（走官方 slots 座位，不接管 DOM）
// - 屏幕镜像、方向键、App 启动、SD 卡浏览、CLI、连接/断开
// - 所有操作走 host 半边的 /api/dsh-flipper/*（本机回环）
// 打包格式跟着 DSH 的模块加载器：window.__ModuleLoader__.load({ id, factory })。
window.__ModuleLoader__.load({
  id: 'dsh-flipper',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef
    const useCallback = React.useCallback

    /** 侧边栏行 id 与中间栏页面 key 必须一致。 */
    const PANEL_ID = 'flipper'
    /** 行顺序：Plugins 0 / Schedule 10 / board 20 / skill-explorer 30。 */
    const PANEL_ORDER = 40

    const API = {
      state: 'api/dsh-flipper/state',
      status: 'api/dsh-flipper/status',
      ports: 'api/dsh-flipper/ports',
      connect: 'api/dsh-flipper/connect',
      disconnect: 'api/dsh-flipper/disconnect',
      screen: 'api/dsh-flipper/screen',
      input: 'api/dsh-flipper/input',
      apps: 'api/dsh-flipper/apps',
      app: 'api/dsh-flipper/app',
      storage: 'api/dsh-flipper/storage',
      cli: 'api/dsh-flipper/cli',
      system: 'api/dsh-flipper/system',
      logs: 'api/dsh-flipper/logs',
    }

    /** 文档相对路径：GUI 可能部署在子路径下，根绝对的 /api 会跑偏。 */
    async function post(name, body) {
      const response = await fetch(API[name] ?? name, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      return readResponse(response)
    }

    async function get(name, query) {
      const base = API[name] ?? name
      const url = query ? base + '?' + new URLSearchParams(query).toString() : base
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      return readResponse(response)
    }

    async function readResponse(response) {
      let data = null
      try {
        data = await response.json()
      } catch {}
      if (!response.ok) throw new Error((data && data.error) || 'HTTP ' + response.status)
      if (data && data.ok === false) throw new Error(data.error || '操作失败')
      return data ?? {}
    }

    const bytes = (n) => {
      if (n === null || n === undefined) return '—'
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let value = Number(n)
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return (value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[unit]
    }

    const timeText = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

    const KEYS = [
      { key: 'up', label: '↑', title: '上' },
      { key: 'left', label: '←', title: '左' },
      { key: 'ok', label: 'OK', title: '确定 / 长按当确认' },
      { key: 'right', label: '→', title: '右' },
      { key: 'down', label: '↓', title: '下' },
      { key: 'back', label: '返回', title: 'Back' },
    ]

    const QUICK_APPS = ['Sub-GHz', 'NFC', 'RFID', 'Infrared', 'iButton', 'Bad USB', 'GPIO', 'Music Player']

    const CSS = `
.dfl-root{height:100%;min-height:0;display:flex;flex-direction:column;font-family:var(--dsw-font-family,system-ui,-apple-system,'Segoe UI',sans-serif);color:var(--dsw-alias-label-primary,#e7e9ee);background:var(--dsw-alias-bg-base,transparent);font-size:13px}
.dfl-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04))}
.dfl-brand{display:flex;align-items:center;gap:8px;font-weight:600;letter-spacing:.01em}
.dfl-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#7b8290);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-label-tertiary,#7b8290) 18%,transparent)}
.dfl-dot.on{background:var(--dsw-alias-state-success-primary,#2ecc71);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#2ecc71) 20%,transparent)}
.dfl-dot.busy{background:var(--dsw-alias-state-warn-primary,#f1c40f)}
.dfl-dot.err{background:var(--dsw-alias-state-error-primary,#e74c3c)}
.dfl-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#98a0ac);font-variant-numeric:tabular-nums}
.dfl-spacer{flex:1}
.dfl-body{flex:1;min-height:0;overflow:auto;display:grid;grid-template-columns:minmax(300px,1fr) minmax(300px,392px);gap:14px;padding:14px 16px 28px;align-content:start}
@media (max-width:920px){.dfl-body{grid-template-columns:1fr}}
.dfl-col{display:flex;flex-direction:column;gap:14px;min-width:0}
.dfl-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));padding:12px;min-width:0}
.dfl-card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.dfl-card-title{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#98a0ac)}
.dfl-screen{position:relative;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:#06080c;aspect-ratio:2/1;max-width:min(100%,620px);max-height:min(40vh,320px);margin:0 auto;display:flex;align-items:center;justify-content:center;overflow:hidden}
.dfl-screen img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
.dfl-screen-empty{font-size:12px;color:#7b8290;text-align:center;line-height:1.7;padding:0 24px}
.dfl-caption{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#7b8290);font-variant-numeric:tabular-nums}
.dfl-keys{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}
.dfl-btn{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10));color:inherit;border-radius:9px;padding:8px 10px;font-size:12px;font-family:inherit;cursor:pointer;transition:background .12s ease,border-color .12s ease,transform .06s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfl-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.4))}
.dfl-btn:active:not(:disabled){transform:translateY(1px)}
.dfl-btn:disabled{opacity:.45;cursor:not-allowed}
.dfl-btn.primary{background:var(--dsw-alias-button-primary-fill,#4c8dff);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}
.dfl-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3d7bea)}
.dfl-btn.wide{grid-column:1 / -1}
.dfl-btn.mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace)}
.dfl-select,.dfl-input{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));background:var(--dsw-specific-input-major,rgba(10,12,16,.35));color:inherit;border-radius:8px;padding:6px 8px;font-size:12px;font-family:inherit;min-width:0}
.dfl-select:focus,.dfl-input:focus{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c8dff) 55%,transparent);outline-offset:0}
.dfl-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dfl-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px}
.dfl-kv dt{color:var(--dsw-alias-label-secondary,#98a0ac)}
.dfl-kv dd{margin:0;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfl-bar{height:5px;border-radius:999px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.2));overflow:hidden;margin-top:6px}
.dfl-bar>i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary,#2ecc71)}
.dfl-bar>i.low{background:var(--dsw-alias-state-warn-primary,#f1c40f)}
.dfl-bar>i.crit{background:var(--dsw-alias-state-error-primary,#e74c3c)}
.dfl-apps{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}
.dfl-files{display:flex;flex-direction:column;gap:4px;max-height:230px;overflow:auto}
.dfl-file{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:7px;cursor:pointer;font-size:12px;border:1px solid transparent}
.dfl-file:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));border-color:var(--dsw-alias-border-l1,rgba(128,128,128,.2))}
.dfl-file .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfl-file .size{color:var(--dsw-alias-label-tertiary,#7b8290);font-size:11px;font-variant-numeric:tabular-nums}
.dfl-file .kind{color:var(--dsw-alias-label-tertiary,#7b8290);width:14px;text-align:center}
.dfl-pre{margin:0;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:190px;overflow:auto;color:var(--dsw-alias-label-secondary,#aeb6c2);background:var(--dsw-specific-input-major,rgba(8,10,14,.5));border-radius:8px;padding:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}
.dfl-toast{position:sticky;bottom:0;margin:0 16px 12px;padding:8px 12px;border-radius:10px;font-size:12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));background:var(--dsw-alias-bg-layer-1,rgba(20,24,30,.92));backdrop-filter:blur(6px)}
.dfl-toast.err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e74c3c) 55%,transparent);color:var(--dsw-alias-state-error-primary,#ff8f88)}
.dfl-toast.ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2ecc71) 50%,transparent);color:var(--dsw-alias-state-success-primary,#6ee7a8)}
.dfl-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#7b8290);line-height:1.65}
.dfl-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.16));margin:10px 0}
.dfl-tag{font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.26));color:var(--dsw-alias-label-secondary,#98a0ac)}
.dfl-tag.good{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2ecc71) 50%,transparent);color:var(--dsw-alias-state-success-primary,#6ee7a8)}
.dfl-tag.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f1c40f) 50%,transparent);color:var(--dsw-alias-state-warn-primary,#f1c40f)}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-flipper-style]')) return
      const style = document.createElement('style')
      style.setAttribute('data-dsh-flipper-style', '')
      style.textContent = CSS
      document.head.append(style)
    }

    // ---- 小部件 ----

    function Card(props) {
      return h(
        'section',
        { className: 'dfl-card' },
        h(
          'div',
          { className: 'dfl-card-head' },
          h('span', { className: 'dfl-card-title' }, props.title),
          props.sub ? h('span', { className: 'dfl-meta' }, props.sub) : null,
          h('span', { className: 'dfl-spacer' }),
          props.extra ?? null,
        ),
        props.children,
      )
    }

    function Btn(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dfl-btn' + (props.variant ? ' ' + props.variant : '') + (props.wide ? ' wide' : ''),
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title,
        },
        props.children,
      )
    }

    function Screen({ dataUrl, connected, caption, busy }) {
      return h(
        'div',
        { className: 'dfl-screen' },
        dataUrl
          ? h('img', { src: dataUrl, alt: 'Flipper 屏幕' })
          : h(
              'div',
              { className: 'dfl-screen-empty' },
              connected ? '还没有画面，点下面的「截图」' : '未连接：先在上面选串口，再点「连接」',
            ),
      )
    }

    function KeyPad({ disabled, onKey, busyKey }) {
      const layout = [
        [null, { key: 'up', label: '↑' }, null],
        [{ key: 'left', label: '←' }, { key: 'ok', label: 'OK' }, { key: 'right', label: '→' }],
        [null, { key: 'down', label: '↓' }, null],
      ]
      return h(
        'div',
        { className: 'dfl-keys' },
        layout.flatMap((row, rowIndex) =>
          row.map((cell, cellIndex) =>
            cell
              ? h(
                  'button',
                  {
                    key: cell.key,
                    type: 'button',
                    className: 'dfl-btn',
                    disabled: disabled || busyKey === cell.key,
                    onClick: () => onKey(cell.key),
                    title: cell.key,
                  },
                  busyKey === cell.key ? '…' : cell.label,
                )
              : h('span', { key: 'gap-' + rowIndex + '-' + cellIndex }),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dfl-btn wide',
            disabled,
            onClick: () => onKey('back', { long: true }),
            title: '长按返回',
          },
          '长按返回（回桌面）',
        ),
      )
    }

    function DeviceInfo({ status }) {
      if (!status) {
        return h('div', { className: 'dfl-hint' }, '连上之后这里显示固件、电量、存储和当前 App。')
      }
      const battery = status.battery || {}
      const level = typeof battery.level === 'number' ? battery.level : null
      const tone = level === null ? '' : level < 15 ? 'crit' : level < 40 ? 'low' : ''
      return h(
        'div',
        null,
        h(
          'dl',
          { className: 'dfl-kv' },
          h('dt', null, '端点'),
          h('dd', { title: status.endpoint }, status.endpoint || '—'),
          h('dt', null, '固件'),
          h('dd', null, status.firmware || '—'),
          h('dt', null, '硬件'),
          h('dd', null, (status.hardware || '—') + (status.hardwareUid ? ' · ' + status.hardwareUid : '')),
          h('dt', null, '电量'),
          h('dd', null, level === null ? '—' : level + '%' + (battery.voltage ? ' · ' + (battery.voltage / 1000).toFixed(2) + ' V' : '') + (battery.charging === true ? ' · 充电中' : '')),
          h('dt', null, '存储'),
          h(
            'dd',
            null,
            status.storage
              ? bytes(status.storage.free) + ' 可用 / ' + bytes(status.storage.total)
              : '—',
          ),
          h('dt', null, '当前 App'),
          h('dd', null, status.appState || '桌面'),
        ),
        level === null
          ? null
          : h('div', { className: 'dfl-bar' }, h('i', { className: tone, style: { width: Math.max(2, level) + '%' } })),
      )
    }

    // ---- 主页面 ----

    function FlipperPage() {
      const [panel, setPanel] = useState({ connected: false, endpoint: '', config: null, ports: [], backend: null, error: null })
      const [status, setStatus] = useState(null)
      const [screen, setScreen] = useState(null)
      const [port, setPort] = useState('')
      const [baud, setBaud] = useState(230400)
      const [manualPort, setManualPort] = useState('')
      const [auto, setAuto] = useState(true)
      const [busy, setBusy] = useState('')
      const [busyKey, setBusyKey] = useState('')
      const [toast, setToast] = useState(null)
      const [files, setFiles] = useState({ path: '/ext', entries: [], loading: false })
      const [preview, setPreview] = useState(null)
      const [cliText, setCliText] = useState('')
      const [cliOut, setCliOut] = useState('')
      const [apps, setApps] = useState([])
      const alive = useRef(true)
      const panelRef = useRef(panel)
      const screenAt = useRef(0)

      const say = useCallback((text, tone) => {
        setToast({ text, tone: tone || 'ok', at: Date.now() })
      }, [])

      useEffect(() => {
        panelRef.current = panel
      }, [panel])

      const refreshPanel = useCallback(async () => {
        try {
          const data = await get('state')
          if (!alive.current) return
          setPanel(data)
          const config = data.config || {}
          setPort((current) => current || config.serialPath || '')
          setBaud((current) => (config.baud ? config.baud : current))
        } catch (error) {
          if (alive.current) setToast({ text: '读取状态失败：' + error.message, tone: 'err', at: Date.now() })
        }
      }, [])

      const refreshScreen = useCallback(async () => {
        if (!panelRef.current.connected) return
        try {
          const shot = await get('screen', { timeoutMs: 2500 })
          if (!alive.current || !shot.dataUrl) return
          screenAt.current = Date.now()
          setScreen(shot.dataUrl)
        } catch (error) {
          if (alive.current) setToast({ text: '截图失败：' + error.message, tone: 'err', at: Date.now() })
        }
      }, [])

      const refreshStatus = useCallback(async () => {
        if (!panelRef.current.connected) {
          setStatus(null)
          return
        }
        try {
          const data = await get('status')
          if (alive.current) setStatus(data.status || null)
        } catch (error) {
          if (alive.current) setToast({ text: '设备信息读取失败：' + error.message, tone: 'err', at: Date.now() })
        }
      }, [])

      const loadFiles = useCallback(async (target) => {
        const path = target || '/ext'
        setFiles((current) => ({ ...current, path, loading: true }))
        try {
          const data = await post('storage', { action: 'list', path })
          if (!alive.current) return
          setFiles({ path, entries: data.files || [], loading: false })
        } catch (error) {
          if (!alive.current) return
          setFiles((current) => ({ ...current, loading: false }))
          setToast({ text: '列目录失败：' + error.message, tone: 'err', at: Date.now() })
        }
      }, [])

      // 初次挂载：读状态 + App 清单 + 端口
      useEffect(() => {
        alive.current = true
        refreshPanel()
        get('apps')
          .then((data) => alive.current && setApps(data.apps || []))
          .catch(() => {})
        return () => {
          alive.current = false
        }
      }, [refreshPanel])

      // 面板状态轮询
      useEffect(() => {
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') refreshPanel()
        }, 5000)
        return () => clearInterval(timer)
      }, [refreshPanel])

      // 设备信息轮询（比对屏幕轮询轻，别太频繁打扰设备）
      useEffect(() => {
        if (!panel.connected) {
          setStatus(null)
          return undefined
        }
        refreshStatus()
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') refreshStatus()
        }, 15000)
        return () => clearInterval(timer)
      }, [panel.connected, refreshStatus])

      // 屏幕镜像轮询
      useEffect(() => {
        if (!panel.connected || !auto) return undefined
        refreshScreen()
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') refreshScreen()
        }, 1100)
        return () => clearInterval(timer)
      }, [panel.connected, auto, refreshScreen])

      const doConnect = useCallback(async () => {
        const path = (manualPort || port || '').trim()
        setBusy('connect')
        setToast(null)
        try {
          const data = await post('connect', path ? { path, baud } : { baud })
          if (!alive.current) return
          await refreshPanel()
          const endpoint = data.status && data.status.endpoint
          say(path ? '已连接 ' + (endpoint || path) : '已连接 ' + (endpoint || 'Flipper'))
          refreshStatus()
          refreshScreen()
          if (panelRef.current.connected || data.status) loadFiles('/ext')
        } catch (error) {
          if (alive.current) say('连接失败：' + error.message, 'err')
        } finally {
          if (alive.current) setBusy('')
        }
      }, [port, manualPort, baud, refreshPanel, refreshStatus, refreshScreen, loadFiles, say])

      const doDisconnect = useCallback(async () => {
        setBusy('disconnect')
        try {
          await post('disconnect')
          if (!alive.current) return
          setScreen(null)
          setStatus(null)
          await refreshPanel()
          say('已断开')
        } catch (error) {
          if (alive.current) say('断开失败：' + error.message, 'err')
        } finally {
          if (alive.current) setBusy('')
        }
      }, [refreshPanel, say])

      const pressKey = useCallback(
        async (key, options) => {
          if (!panelRef.current.connected) {
            say('还没连接 Flipper', 'err')
            return
          }
          setBusyKey(key)
          try {
            const data = await post('input', { key, type: options && options.long ? 'long' : 'short' })
            if (!alive.current) return
            if (data.screen) {
              screenAt.current = Date.now()
              setScreen(data.screen)
            }
          } catch (error) {
            if (alive.current) say('按键失败：' + error.message, 'err')
          } finally {
            if (alive.current) setBusyKey('')
          }
        },
        [say],
      )

      const launchApp = useCallback(
        async (name) => {
          if (!panelRef.current.connected) {
            say('还没连接 Flipper', 'err')
            return
          }
          setBusy('app:' + name)
          try {
            await post('app', { action: 'start', name, args: 'RPC' })
            if (!alive.current) return
            say('已启动 ' + name)
            setTimeout(() => {
              if (alive.current) refreshScreen()
            }, 700)
          } catch (error) {
            if (alive.current) say('启动 ' + name + ' 失败：' + error.message, 'err')
          } finally {
            if (alive.current) setBusy('')
          }
        },
        [refreshScreen, say],
      )

      const openEntry = useCallback(
        async (entry) => {
          if (entry.type === 'dir') {
            loadFiles(entry.path)
            return
          }
          setPreview({ path: entry.path, text: '读取中…' })
          try {
            const data = await post('storage', { action: 'read', path: entry.path, maxBytes: 20000 })
            if (!alive.current) return
            setPreview({
              path: entry.path,
              text: data.text !== undefined ? data.text : '(二进制文件，' + bytes(data.size) + ')',
            })
          } catch (error) {
            if (alive.current) setPreview({ path: entry.path, text: '读取失败：' + error.message })
          }
        },
        [loadFiles],
      )

      const runCli = useCallback(async () => {
        const command = cliText.trim()
        if (!command) return
        setBusy('cli')
        try {
          const data = await post('cli', { command })
          if (!alive.current) return
          setCliOut('$ ' + command + '\n' + (data.output || '(没有输出)'))
        } catch (error) {
          if (alive.current) setCliOut('$ ' + command + '\n✗ ' + error.message)
        } finally {
          if (alive.current) setBusy('')
        }
      }, [cliText])

      const parentOf = (path) => {
        const parts = String(path || '/ext').split('/').filter(Boolean)
        parts.pop()
        return parts.length ? '/' + parts.join('/') : '/'
      }

      const portOptions = (panel.ports || []).map((item) => ({
        value: item.path,
        label:
          (item.isFlipper ? '🖋 ' : '') +
          item.path +
          (item.isFlipper ? ' · Flipper' : item.label && item.label.includes('(') ? '' : ' · ' + (item.label || '串口')),
      }))
      const connected = panel.connected === true
      const backend = panel.backend || {}

      return h(
        'div',
        { className: 'dfl-root', 'data-dsh-flipper-view': '', 'data-dsh-plugin': 'dsh-flipper' },
        h(
          'header',
          { className: 'dfl-head' },
          h(
            'div',
            { className: 'dfl-brand' },
            h('span', { className: 'dfl-dot' + (connected ? ' on' : panel.error ? ' err' : '') }),
            'Flipper',
            h(
              'span',
              { className: 'dfl-meta' },
              connected ? panel.endpoint || '已连接' : '未连接',
            ),
          ),
          h('span', { className: 'dfl-spacer' }),
          h(
            'select',
            {
              className: 'dfl-select',
              value: port,
              onChange: (event) => {
                setPort(event.target.value)
                setManualPort('')
              },
              title: '本机串口',
            },
            portOptions.length === 0 ? h('option', { value: '' }, '没发现串口') : null,
            portOptions.map((item) => h('option', { key: item.value, value: item.value }, item.label)),
            port && !portOptions.some((item) => item.value === port)
              ? h('option', { value: port }, port + '（已保存）')
              : null,
          ),
          h(
            'select',
            {
              className: 'dfl-select',
              value: String(baud),
              onChange: (event) => setBaud(Number(event.target.value)),
              title: '波特率（USB CDC 一般无所谓）',
            },
            ['230400', '115200', '9600'].map((value) => h('option', { key: value, value }, value)),
          ),
          connected
            ? h(Btn, { onClick: doDisconnect, disabled: busy === 'disconnect' }, busy === 'disconnect' ? '断开中…' : '断开')
            : h(Btn, { variant: 'primary', onClick: doConnect, disabled: busy === 'connect' }, busy === 'connect' ? '连接中…' : '连接'),
          h(
            Btn,
            {
              onClick: () => {
                refreshPanel()
                refreshStatus()
                refreshScreen()
                say('已刷新')
              },
              title: '重新读取状态与画面',
            },
            '刷新',
          ),
          h(Btn, { onClick: () => get('ports', { refresh: '1' }).then(() => refreshPanel()).catch(() => {}), title: '重新枚举串口' }, '找端口'),
        ),

        h(
          'div',
          { className: 'dfl-body' },
          h(
            'div',
            { className: 'dfl-col' },
            h(
              Card,
              {
                title: '屏幕',
                extra: h(
                  'button',
                  {
                    type: 'button',
                    className: 'dfl-tag' + (auto ? ' good' : ''),
                    onClick: () => setAuto((value) => !value),
                    title: '自动刷新屏幕（约 1 秒一帧）',
                    style: { cursor: 'pointer', background: 'transparent' },
                  },
                  auto ? '自动刷新' : '手动',
                ),
              },
              h(Screen, { dataUrl: screen, connected }),
              h(
                'div',
                { className: 'dfl-caption' },
                h('span', null, screen ? '128 × 64' : '—'),
                h('span', { className: 'dfl-spacer' }),
                h('span', null, screen ? timeText() : ''),
              ),
              h(KeyPad, { disabled: !connected, onKey: pressKey, busyKey }),
              h(
                'div',
                { className: 'dfl-row', style: { marginTop: 10 } },
                h(Btn, { onClick: refreshScreen, disabled: !connected }, '截图'),
                h(
                  Btn,
                  {
                    onClick: async () => {
                      if (!connected) return
                      setBusy('desktop')
                      try {
                        await post('input', { keys: ['back', 'back', 'back'], delayMs: 90 })
                        if (alive.current) {
                          say('已回桌面')
                          refreshScreen()
                        }
                      } catch (error) {
                        if (alive.current) say('操作失败：' + error.message, 'err')
                      } finally {
                        if (alive.current) setBusy('')
                      }
                    },
                    disabled: !connected || busy === 'desktop',
                  },
                  '回桌面',
                ),
                h(
                  Btn,
                  {
                    onClick: async () => {
                      if (!connected) return
                      try {
                        await post('system', { action: 'alert' })
                        if (alive.current) say('Flipper 已响铃')
                      } catch (error) {
                        if (alive.current) say('响铃失败：' + error.message, 'err')
                      }
                    },
                    disabled: !connected,
                  },
                  '响铃找它',
                ),
              ),
              h(
                'div',
                { className: 'dfl-hint', style: { marginTop: 10 } },
                backend.win32Native
                  ? 'Windows 串口由插件直接调 Win32 API：插上就跑，不用 python 桥。'
                  : '当前平台走系统串口；如果打不开，可以用 tools/flipper-bridge.py 起 TCP 桥再连 127.0.0.1:9757。',
              ),
            ),

            h(
              Card,
              { title: '设备' },
              h(DeviceInfo, { status }),
            ),

            h(
              Card,
              { title: 'SD 卡', sub: files.path },
              h(
                'div',
                { className: 'dfl-row', style: { marginBottom: 8 } },
                h(Btn, { onClick: () => loadFiles(parentOf(files.path)), disabled: !connected || files.loading }, '↑ 上一级'),
                h(Btn, { onClick: () => loadFiles('/ext'), disabled: !connected || files.loading }, '/ext'),
                h(Btn, { onClick: () => loadFiles('/ext/apps'), disabled: !connected || files.loading }, '/ext/apps'),
                h(Btn, { onClick: () => loadFiles('/ext/subghz'), disabled: !connected || files.loading }, 'subghz'),
                h(Btn, { onClick: () => loadFiles('/ext/nfc'), disabled: !connected || files.loading }, 'nfc'),
              ),
              h(
                'div',
                { className: 'dfl-files' },
                files.loading
                  ? h('div', { className: 'dfl-hint' }, '读取中…')
                  : files.entries.length === 0
                    ? h('div', { className: 'dfl-hint' }, connected ? '点上面按钮列目录' : '未连接')
                    : files.entries.map((entry) =>
                        h(
                          'div',
                          {
                            key: entry.path || entry.name,
                            className: 'dfl-file',
                            onClick: () => openEntry(entry),
                            title: entry.path || entry.name,
                          },
                          h('span', { className: 'kind' }, entry.type === 'dir' ? '▸' : '·'),
                          h('span', { className: 'name' }, entry.name + (entry.type === 'dir' ? '/' : '')),
                          h('span', { className: 'size' }, entry.type === 'dir' ? '' : bytes(entry.size)),
                        ),
                      ),
              ),
              preview
                ? h(
                    'div',
                    { style: { marginTop: 8 } },
                    h('div', { className: 'dfl-caption' }, preview.path),
                    h('pre', { className: 'dfl-pre' }, preview.text),
                  )
                : null,
            ),
          ),

          h(
            'div',
            { className: 'dfl-col' },
            h(
              Card,
              { title: '启动 App' },
              h(
                'div',
                { className: 'dfl-apps' },
                QUICK_APPS.map((name) =>
                  h(
                    Btn,
                    {
                      key: name,
                      onClick: () => launchApp(name),
                      disabled: !connected || busy === 'app:' + name,
                      title: '以 RPC 模式启动 ' + name,
                    },
                    busy === 'app:' + name ? '…' : name,
                  ),
                ),
              ),
              apps.length > 0
                ? h(
                    'div',
                    { className: 'dfl-hint', style: { marginTop: 8 } },
                    '设备内置：' + apps.slice(0, 6).map((item) => item.name).join('、') + ' 等',
                  )
                : null,
            ),

            h(
              Card,
              { title: 'CLI', sub: connected ? '命令直通' : '需要串口连接' },
              h(
                'div',
                { className: 'dfl-row' },
                h('input', {
                  className: 'dfl-input',
                  style: { flex: 1, minWidth: 120 },
                  value: cliText,
                  placeholder: '例如 power info / storage list /ext',
                  onChange: (event) => setCliText(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') runCli()
                  },
                }),
                h(Btn, { onClick: runCli, disabled: !connected || busy === 'cli' }, busy === 'cli' ? '执行中…' : '执行'),
              ),
              cliOut ? h('pre', { className: 'dfl-pre', style: { marginTop: 8 } }, cliOut) : null,
            ),

            h(
              Card,
              { title: '连接参数' },
              h(
                'div',
                { className: 'dfl-col', style: { gap: 8 } },
                h('input', {
                  className: 'dfl-input',
                  value: manualPort,
                  placeholder: '手动填串口（COM6 / /dev/ttyACM0），优先于上面下拉框',
                  onChange: (event) => setManualPort(event.target.value),
                }),
                h(
                  'div',
                  { className: 'dfl-hint' },
                  '手机/平板连这台电脑时，填 tcp://电脑局域网IP:9757（先在电脑上跑 tools/flipper-bridge.py）。',
                ),
                h(
                  'div',
                  { className: 'dfl-row' },
                  h(
                    'span',
                    { className: 'dfl-tag' + (backend.win32Native ? ' good' : backend.error ? ' warn' : '') },
                    backend.win32Native ? 'Win32 串口直连' : backend.error ? 'koffi 不可用' : '系统串口',
                  ),
                  h('span', { className: 'dfl-tag' }, (panel.ports || []).length + ' 个串口'),
                  panel.error ? h('span', { className: 'dfl-tag warn' }, '上次错误：' + String(panel.error).slice(0, 40)) : null,
                ),
              ),
            ),
          ),
        ),

        toast
          ? h(
              'div',
              { className: 'dfl-toast' + (toast.tone === 'err' ? ' err' : toast.tone === 'warn' ? '' : ' ok') },
              toast.text,
            )
          : null,
      )
    }

    function FlipperIcon({ size }) {
      const s = typeof size === 'number' && size > 0 ? size : 18
      return h(
        'svg',
        {
          width: s,
          height: s,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 5, y: 2.5, width: 14, height: 19, rx: 3 }),
        h('circle', { cx: 12, cy: 8.5, r: 2.6 }),
        h('path', { d: 'M8.6 15.4h6.8' }),
        h('path', { d: 'M9.4 18h5.2' }),
      )
    }

    /** 注册侧边栏行 + 中间栏页面；任何一步失败都只记日志，不让 GUI 启动失败。 */
    function registerPanel(ctx) {
      const slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return () => {}
      const disposers = []
      try {
        disposers.push(
          slots.inject('sidebar.panellist', () =>
            slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: PANEL_ORDER,
                label: () => 'Flipper',
              },
              FlipperIcon,
            ),
          ),
        )
      } catch (error) {
        console.warn('[dsh-flipper] sidebar row registration failed', error)
      }
      try {
        disposers.push(
          slots.inject('main', () =>
            slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                inject: () => ({}),
              },
              FlipperPage,
            ),
          ),
        )
      } catch (error) {
        console.warn('[dsh-flipper] main page registration failed', error)
      }
      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {}
        }
      }
    }

    /** 需要的客户端服务：slots 提供座位，layout 让面板能被切到前台。 */
    const inject = ['slots']

    function apply(ctx) {
      ensureStyle()
      let dispose = () => {}
      try {
        dispose = registerPanel(ctx)
      } catch (error) {
        console.warn('[dsh-flipper] panel mount failed', error)
      }
      try {
        ctx.effect(() => () => dispose(), 'dsh-flipper: panel')
      } catch {}
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
