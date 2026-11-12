---
name: dsh-flipper
description: 遥控 Flipper Zero：看屏幕、按键、启动 App、读写 SD 卡、Sub-GHz/NFC/RFID/IR/BadUSB 文件与 GPIO。用户提到 Flipper、Sub-GHz、NFC 读卡、红外遥控、BadUSB 时使用。
whenToUse: 用户要求查看或操作 Flipper Zero 时
---

# dsh-flipper：把 Flipper Zero 当成可遥控的手持工具


> 路径说明：本文件在 `skill/` 下，插件根目录是它的上一级；`tools/`、`lib/` 都在插件根目录。

## 前提

- 手机/平板：安装并运行「Flipper BLE 桥」App，日志显示 `TCP 监听 127.0.0.1:9757`，插件 `flipper_connect(endpoint="tcp://127.0.0.1:9757")`。
- 电脑（PC 端 DSH）：二选一
  - 电脑插 Flipper，关掉 qFlipper，运行 `python3 tools/flipper-bridge.py`，插件连 `tcp://电脑IP:9757`，`link="usb"`；
  - 或本机串口直连 `serial:///dev/ttyACM0`（Windows 用 `serial://COM5`），`link="serial"`。
- 插件已用 `flipper_connect` 连上；`flipper_status` 能返回 endpoint/link/固件/电量。
- 断连时：让用户重开桥 App 或重插 USB，再执行 `flipper_connect`。

## 连接类型与能力差异

先看 `flipper_status` 的 `link` 和 `cliAvailable`：

| link | 场景 | CLI |
|---|---|---|
| `ble` | 手机/平板的 Android BLE 桥 | ❌ 没有 CLI 文本通道，不要用 `flipper_cli` |
| `usb` | 电脑上的 `flipper-bridge.py` USB 桥 | ✅ 透明串口，可用 `flipper_cli` |
| `serial` | 电脑本机 `serial://` 直连 | ✅ 可用 `flipper_cli` |

PC 端的 DSH 装上同一个插件后，会得到同样的系统提示和 `dsh-flipper` 技能；工具完全一致，只是连接方式不同。

## 核心循环（自主操作）

1. `flipper_status`：确认连接、电量、当前 App。
2. `flipper_capabilities`：一次性知道内置 App、第三方 FAP、各资源目录里有什么。
3. `flipper_screen`：看当前界面；ASCII 就是实际 128x64 屏幕。
4. 行动：
   - 按键：`flipper_input`（up/down/left/right/ok/back；short/long）。
   - 启动 App：`flipper_app action=start name=... args="RPC"`。
   - 加载文件：`flipper_app action=load_file path=...`。
   - 文件：`flipper_storage`。
5. 再 `flipper_screen`（或 `flipper_input observe=true`）确认结果；不对就 BACK/调整。
6. 连续两次没有变化或报错，停下来向用户说明，不要盲试。

## 屏幕怎么读

- 128x64 单色；ASCII 用半块字符，一行对应屏幕两行像素。
- 顶部通常是状态栏（时间、电量、SD 卡、蓝牙）；中间是当前 App/菜单。
- 菜单选中项是反色块；看文字形状判断。
- 需要细看时用 `flipper_screen format="png"` 返回的路径 + `read_image`。

## 按键与菜单

- 桌面：DOWN 打开主菜单；OK 进入选中项；BACK 返回。
- 菜单/App：UP/DOWN 移动，OK 选择，BACK 返回上一层。
- 长按用 `type="long"`；普通点按是 `short`（默认）。
- 不要盲按一长串；每按 1–3 个键就截屏确认。

## 里面有什么

- 内置 App：Sub-GHz、125 kHz RFID、NFC、Infrared、iButton、Bad USB、U2F、GPIO、Music Player、Snake、Archive。
- 第三方 App：`/ext/apps` 下的 .fap 和 `/ext/apps_manifests` 里的名字；用 `flipper_capabilities` 或 `flipper_storage list /ext/apps` 查。
- 资源目录：
  - `/ext/subghz`：.sub 信号
  - `/ext/nfc`：.nfc 卡片
  - `/ext/lfrfid`：.rfid 低频卡
  - `/ext/infrared`：.ir 遥控器
  - `/ext/badusb`：.txt HID 脚本
  - `/ext/ibutton`：.ibtn
  - `/ext/wav`：音频
  - `/ext/apps_data`：App 数据
- 不要删 `/ext/.config`、`/ext/apps_manifests`、`/ext/update` 等系统目录。

## 典型任务

### 看屏幕 / 导航

`flipper_screen` → `flipper_input keys=["down","ok"] observe=true` → 读返回的屏幕。

### 启动 App

桌面（若在菜单里先 BACK）→ `flipper_app action=start name="NFC" args="RPC"` → `flipper_screen`。

- `args="RPC"` 才会启用 load_file/button。
- 报 `APP_SYSTEM_LOCKED`：说明菜单/其他 App 占着，先 BACK 回桌面。

### Sub-GHz 发射

1. `flipper_storage list /ext/subghz` 找 .sub
2. `flipper_app start name="Sub-GHz" args="RPC"`
3. `flipper_app load_file path="/ext/subghz/xxx.sub"`
4. `flipper_screen` 看是否到发射确认页
5. 征得用户同意后按 OK 发射；再截屏确认

### NFC 读卡/模拟

1. `list /ext/nfc` 或直接 start NFC
2. `load_file` 指定 .nfc
3. 屏幕选择 Read / Emulate / Save；需要用户把卡贴到 Flipper 背面
4. 截屏确认结果

### 红外

1. `list /ext/infrared` 找 .ir
2. `start Infrared` → `load_file .ir`
3. 屏幕选遥控器/按键；发射前确认

### BadUSB

1. `list /ext/badusb` 找 .txt
2. `start "Bad USB" args="RPC"` → `load_file .txt`
3. 屏幕选 Run；**只对用户自己的电脑**，并先确认

### GPIO

`flipper_gpio action=set_mode pin=PC0 mode=output` → `write`；读引脚用 `read`。接线前确认电压。

## 错误处理

- `ECONNREFUSED 127.0.0.1:9757`：桥 App 的 TCP 没起来；让用户看 App 日志有没有 `TCP 监听`。
- `BLE 断开`：App 里点「重新连接 Flipper」，再 `flipper_connect`。
- 截图是噪声：固件/解码器不匹配；让用户更新桥 App 或插件。
- `APP_SYSTEM_LOCKED`：BACK 回桌面再启动。
- `ERROR_STORAGE_NOT_EXIST`：路径不对，先 list 父目录。

## 安全

- 只操作用户自己的设备。
- 发射 RF/IR、模拟 NFC/RFID、运行 BadUSB 前必须让用户确认。
- 重启/恢复出厂/删除文件前必须确认；`factory_reset` 要用户明确说“恢复出厂”。
- 不要用 Flipper 干扰公共频段、门禁或他人设备。
