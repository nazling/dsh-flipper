# Changelog

## 0.3.0 — 2026-11-12

桌面端改造：电脑上插 USB 就能用，不需要再手动跑 python 桥。

新增：

- **桌面 GUI 面板**（`lib/client.js`，走 DSH 官方 `slots` 座位）：侧边栏「Flipper」行 + 中间栏整页。
  - 屏幕实时镜像（默认 1 秒一帧，可关）、方向键 / OK / 长按返回、截图、回桌面、响铃
  - 串口下拉（自动标出 Flipper）、波特率、连接 / 断开 / 刷新 / 找端口
  - 设备信息卡（固件、硬件、电量 + 电压 + 充电、存储、当前 App）
  - 一键以 RPC 模式启动 Sub-GHz / NFC / RFID / 红外 / iButton / Bad USB / GPIO / 音乐
  - SD 卡逐级浏览 + 文本文件预览；CLI 命令直通（去 ANSI 颜色）
- **面板接口族** `/api/dsh-flipper/*`（`lib/api.js`）：state / ports / connect / disconnect /
  status / screen / input / apps / app / storage / cli / system / logs，只允许本机回环访问。
- **Win32 串口直连**（`lib/serial-koffi.js`）：用 koffi 调 `CreateFileW` / `SetCommState` /
  `SetCommTimeouts` / `ReadFile` / `WriteFile`，绕开 python 桥；koffi 从 DSH 安装目录自动找，
  找不到才退回 fs 直读或 `tools/flipper-bridge.py`。
- **串口枚举**（`lib/ports.js`）：Windows 用 CIM 拿 `VID_0483&PID_5740` 认出 Flipper，
  带 15 秒缓存；Linux/macOS 走 `/dev` + sysfs。
- `autoConnect` 配置（默认开）：DSH 启动后自动连一次本机 Flipper。

修复：

- `link` 在电脑串口直连时误报 `usb`，现在是 `serial`；电脑 TCP 桥才是 `usb`。
- `flipper_cli` 在真实设备上输出为空：切回 CLI 后第一个字节会被吞（`power info` → `ower info`），
  现在先补一个回车、等提示符稳定再发命令；回显剥离也重写了，命令不存在时不再吐提示符残渣。
- `serial://COM10+` 在 Windows 上打不开（现在统一加 `\\.\` 设备前缀）。

测试：

- 新增 `test/api-e2e.mjs`：11 项面板接口断言（含 `factory_reset` 拦截、未知接口 404）。
- 真机验证：firmware `v1.1.6`，`status` / `screen` / `input` / `storage` / `cli` 全部通过。

## 0.2.0 / bridge 1.6 — 2026-11-12

First public release, tested against a real Flipper Zero (firmware `v1.1.6`, protobuf `0.25`).

Plugin:

- 11 tools: connect/disconnect/status/capabilities/screen/input/app/storage/system/gpio/cli
- `flipper_capabilities`: built-in apps, external FAPs, resource-file counts/examples, tools, workflows
- System prompt section describing the remote-control workflow
- Bundled `dsh-flipper` skill with the full operating manual
- `observe=true` on `flipper_input` / `flipper_app` (act + screenshot in one call)
- dsh-go status strip and side panel (live screen, battery, D-pad)
- App-state tracking (`started` / `closed`)

Android bridge:

- Fixed reversed TX/RX UUIDs (`...61...` is TX/INDICATE, `...62...` is RX/WRITE)
- Added `INTERNET` permission (local TCP listen failed with `EPERM` without it)
- Reset `isRunning` on BLE disconnect so reconnects actually work
- Refresh GATT cache when the CCCD is missing; pairing guidance and unpair button
- Device picker fallback for renamed Flippers
- Mint card UI, dark log panel, clear button, launcher icon

## 1.0 — 2026-11-12

- Initial Android BLE bridge: scan/pair, GATT serial, TCP `127.0.0.1:9757`
- Handles the plugin's `start_rpc_session` handshake and echoes it
