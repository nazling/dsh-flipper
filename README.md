<div align="center">
  <img src="android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png" width="96" alt="dsh-flipper icon" />
  <h1>dsh-flipper</h1>
  <p><b>让 AI 通过 DSH 遥控 Flipper Zero</b></p>
  <p><b>安卓端适配dsh go 做了插件优化和适配</b></p>
  <p>看屏幕 · 按键 · 启动 App · 读写 SD 卡 · Sub-GHz / NFC / RFID / 红外 / BadUSB / GPIO</p>
  <p>电脑端自带侧边栏面板 + Win32 串口直连：<b>插上 USB 就能用，不用跑 python</b></p>
  <p>
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license" />
    <img src="https://img.shields.io/badge/DSH-0.2.x-0f766e" alt="DSH" />
    <img src="https://img.shields.io/badge/Android-6%2B-3ddc84" alt="Android" />
    <img src="https://img.shields.io/badge/Flipper%20FW-1.1.6-ff8c00" alt="Flipper firmware" />
  </p>
</div>

<p><a href="README.en.md">English</a> · 中文</p>

> 非官方项目，与 Flipper Devices Inc. 没有隶属关系。仅用于你自己的设备。

---

### 项目现状：连上了，但 AI 还没「会」用小海豚

**征集：DS（DeepSeek）使用小海豚的思考过程。**

因为本人缺少 AI 的思考过程与训练数据，AI 目前并不能熟练使用小海豚（Flipper Zero）。所以想在这里征集大家让 AI 操作小海豚时的思考过程：你怎么问的、它怎么判断当前屏幕、怎么在菜单里找路、哪儿点错了、最后怎么救回来。真实的过程比多少句提示词都值钱。

需要说清楚这个项目现在到底做到了什么：

- **做到了**：把 DSH 和小海豚连接起来（本机串口 / BLE 桥 / TCP 桥三条链路，外加桌面侧边栏面板），以及把「使用小海豚的基本方法」交给 AI（`flipper_*` 工具集、系统提示里的操作说明、随包的 `dsh-flipper` 技能手册）。
- **还没做到**：AI 尚未真正掌握使用小海豚的方法。屏幕是 128×64 的黑白像素，菜单层级靠图标和反白块表达，同一个键在不同界面含义不同，光靠工具说明书是学不会的——需要在真实任务里反复试错积累判断。

有思考过程想投喂、或者想聊聊怎么让 AI 更会用：**QQ 1132359085**

---

## 这是什么

**dsh-flipper** 把 Flipper Zero 变成一个 AI 可以操作的手持设备。仓库包含两部分：

| 部分 | 说明 |
|---|---|
| **DSH 插件**（根目录，Node.js） | 注册 `flipper_*` 工具：截屏、按键、启动 App、读写 SD 卡、GPIO、系统操作；往系统提示注入操作手册；随包注册 `dsh-flipper` 技能；**桌面 Web GUI 里有「Flipper」面板**（屏幕镜像 / 方向键 / App / SD 卡 / CLI / 一键连接）；dsh-go 手机端有「Flipper 状态」面板 |
| **Android BLE 桥**（`android/`） | 把 Flipper 的蓝牙串口桥接到本机 `127.0.0.1:9757`。DSH 引擎跑在 proot 里拿不到 Android BLE，所以需要这个原生桥 |

电脑插 USB 时最省事：插件直接用 **koffi 调 Win32 串口 API**（`CreateFileW` / `SetCommState` / `ReadFile` / `WriteFile`），不依赖 python、不编译原生模块，面板上点「连接」自动找 Flipper（VID `0483` / PID `5740`）的 COM 口。只有拿不到本机串口时，才需要 `tools/flipper-bridge.py` 那套 TCP 桥。

## 特性

- **屏幕**：128x64 单色，ASCII（就是实际界面）/ 盲文点阵 / PNG（可 `read_image` 细看）
- **按键**：up / down / left / right / ok / back，短按/长按；`observe=true` 按键后自动截图
- **App**：启动、退出、加载文件、按钮、读取错误；内置 Sub-GHz、NFC、125 kHz RFID、红外、iButton、Bad USB、U2F、GPIO、Music Player
- **文件**：`/ext` 列出/读/写/删除/重命名/md5/stat
- **系统**：电量、时间、响铃、重启、property、桌面锁定/解锁
- **发现**：`flipper_capabilities` 一次返回内置 App、第三方 FAP、各资源目录的数量与示例、工具清单和工作流
- **AI 自主**：系统提示 + 随包技能 + 观察 → 行动 → 观察循环
- **桌面面板**（DSH Web GUI 侧边栏）：屏幕实时镜像、方向键、一键启动 App、SD 卡逐级浏览 + 文本预览、CLI 直通、串口下拉 + 连接/断开；和 AI 共用同一条 RPC 连接
- **无 python 连接**：Windows 走 Win32 串口直连；开机自动连一次；串口枚举能认出 Flipper
- **dsh-go 适配**：输入框上方状态条 + 会话侧边「Flipper 状态」面板（实时屏幕、电量/固件、方向键）+ 截图结果画成原生图片卡；手机自动按 `ble` 走 BLE 桥

## 截图

<p align="center">
  <img src="docs/screenshots/flipper-desktop-4x.png" width="420" alt="Flipper 桌面" />
  <img src="docs/screenshots/flipper-menu-4x.png" width="420" alt="Flipper 主菜单" />
</p>
<p align="center"><i>插件抓到的真实 Flipper 屏幕（128x64，放大 4 倍）</i></p>

## dsh-go 插件优化适配

手机上的 **dsh-go** 是 Flutter 原生界面，不是 Web 面板，所以插件单独做了一层适配：不走 `/api/dsh-flipper/*` 和 React 组件，而是直接用 `ctx.dshGo` 的原生组件，数据由同一份 `Manager` 供给，和 AI 共用一条 RPC 连接。

| 位置 | 做了什么 |
|---|---|
| 会话侧边「Flipper 状态」面板 | 128×64 屏幕镜像（5 秒一帧，PNG 直接内联进面板，不落盘）、电量 / 固件两个 metric、存储可用量、方向键 6 键（一按就回图）、刷新 / 连接 |
| 输入框上方状态条 | `Flipper 100%` / `Flipper 未连接`，15 秒刷一次；连不上就安静等，不弹窗打断对话 |
| 工具结果卡片 | `flipper_screen` 用 `presentationMeta['dsh-go/view']` 把截图直接画成原生图片卡，手机上不再是一条 PNG 路径 |
| 连接方式推断 | 手机环境自动判成 `link=ble`：只走 `tcp://127.0.0.1:9757`，不会去尝试没有的串口，`flipper_cli` 直接报「无 CLI 通道」 |

<p align="center">
  <img src="docs/screenshots/dsh-go-flipper-panel.jpg" width="720" alt="dsh-go 里的 Flipper 状态面板" />
</p>
<p align="center"><i>dsh-go「Flipper 状态」：屏幕实时镜像 + 电量 / 固件 + 存储，下面是方向键，已连接 BLE 桥 tcp://127.0.0.1:9757</i></p>

<p align="center">
  <img src="docs/screenshots/dsh-go-ble-bridge.jpg" width="720" alt="Android 端 Flipper BLE 桥" />
</p>
<p align="center"><i>Android 端 Flipper BLE 桥：扫描配对 → GATT 连接 → 本地 TCP 9757 监听，日志里能看到特征值、MTU 247 和每包字节数</i></p>

> 手机上没有 CLI 文本通道：`flipper_cli` 在 `ble` 下不可用，其余工具（屏幕、按键、App、文件、系统、GPIO）都能用。

## 架构

```mermaid
flowchart LR
  AI[DSH / AI] --> P[dsh-flipper 插件]
  UI[DSH 桌面面板] -->|/api/dsh-flipper/*| P
  P -->|Win32 串口 / serial://| F[Flipper Zero]
  P -.->|TCP 127.0.0.1:9757| B[Android BLE 桥]
  B -.->|BLE GATT| F
  P -.->|TCP| C[电脑 USB 桥]
  C -.-> F
```

- 电脑直连（首选）：`Flipper --USB--> DSH 插件（Win32 串口 API）`，面板与 AI 同一条连接
- 蓝牙链路：`Flipper --BLE--> Android 桥 --TCP localhost--> DSH 插件`
- 电脑兼容链路：`Flipper --USB--> flipper-bridge.py --TCP--> DSH 插件`
- 桌面面板：`浏览器 --fetch /api/dsh-flipper/*--> 插件（只允许本机回环）`

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

### 1. 安装 DSH 插件

```sh
git clone <repo-url> dsh-flipper
cd dsh-flipper
./install.sh          # Linux / macOS / 手机 proot
# Windows: .\install.ps1
```

`install.sh` 会把插件复制到 `$DSH_HOME/dsh-go/plugins/dsh-flipper`，再执行 `dsh plugin add`；dsh-go 用户建议就用这个方式（引擎重置会保留）。

也可以手动：

```sh
dsh plugin --profile web add "$PWD"
```

不落盘、直接从 GitHub 安装（把 `<you>` 换成你的账号）：

```sh
dsh plugin --profile web add github:<you>/dsh-flipper
```

装完在 App **设置 → 引擎 → 重启引擎**。插件零运行时依赖，要求 Node 20+、DSH `>= 0.2.1-rc.2 < 0.3.0`。

### 2. 连接 Flipper

#### A. 电脑本机直连（推荐，插上就能用）

Flipper 插 USB，关掉 qFlipper，**不需要跑任何脚本**：

- 图形方式：DSH 侧边栏 →「Flipper」→ 串口下拉里选带 `Flipper` 标记的端口（一般是 `COM6`）→「连接」。屏幕镜像、方向键、App、SD 卡、CLI 都在这个面板里。
- 对话方式：`flipper_connect()` 不给参数（自动挑 Flipper 串口）或 `flipper_connect(endpoint="serial://COM6")`。

Windows 上插件自己调 `kernel32.dll` 的串口 API（koffi 是 DSH 桌面端自带依赖），所以没有 `pip install` 这一步；Linux/macOS 走系统串口（`serial:///dev/ttyACM0`，Linux 需要用户在 `dialout` 组）。

#### B. Android 蓝牙桥（手机用，无线）

1. 安装 [`dist/flipper-ble-bridge-1.6.apk`](dist/flipper-ble-bridge-1.6.apk)（debug 签名，侧载）。  
   在 GitHub 上打开这个文件点 **Download**，手机上点开安装并允许「安装未知应用」；也可以从 Releases 下载
2. Flipper：`设置 → 蓝牙 → ON`；关掉官方 Flipper App（会占用 BLE）
3. 打开桥 App，允许定位权限，点「扫描并连接 Flipper」
4. 首次配对：Flipper 屏幕显示 PIN，在系统弹窗输入
5. 日志出现 `TCP 监听 127.0.0.1:9757` 即成功

然后在 DSH 里：

```text
flipper_connect(endpoint="tcp://127.0.0.1:9757")
```

#### C. 电脑 TCP 桥（串口被占用 / 手机连电脑时）

电脑插 Flipper，关掉 qFlipper：

```sh
pip install pyserial
python3 tools/flipper-bridge.py
```

记下打印的 `tcp://192.168.x.x:9757`，在 DSH 里 `flipper_connect` 这个地址。Windows 可双击 `tools/start-bridge-windows.bat`。

### 3. 桌面面板

DSH Web GUI 侧边栏的「Flipper」页：

| 区域 | 内容 |
|---|---|
| 顶部 | 串口下拉（自动识别 Flipper）、波特率、连接/断开、刷新、找端口 |
| 屏幕 | 128×64 实时镜像（约 1 秒一帧，可关自动刷新）、方向键 / OK / 长按返回、截图、回桌面、响铃 |
| 设备 | 端点、固件、硬件、电量（含电压/充电）、存储、当前 App |
| SD 卡 | `/ext` 逐级浏览，常用目录快捷键，文本文件直接预览 |
| 启动 App | 一键以 RPC 模式启动 Sub-GHz / NFC / RFID / 红外 / iButton / Bad USB / GPIO / 音乐 |
| CLI | 命令直通（串口链路下可用），ANSI 颜色会被清掉 |

面板走 `/api/dsh-flipper/*`（只允许本机回环），和 AI 用同一个 Manager 实例，不会重复占串口。

### PC 端 DSH 也能用

PC 上安装同一个插件即可，模型会拿到**同样的系统提示和 `dsh-flipper` 技能**。区别只在连接方式和 `link` 字段：

| 场景 | 连接方式 | link | `flipper_cli` |
|---|---|---|---|
| 电脑串口直连 | 面板点连接 / `flipper_connect(endpoint="serial://COM6")` | `serial` | ✅ |
| 手机/平板 | Android BLE 桥，`tcp://127.0.0.1:9757` | `ble` | ❌ 无 CLI 通道 |
| 电脑 TCP 桥 | `python3 tools/flipper-bridge.py` → `tcp://电脑IP:9757` | `usb` | ✅ |

- `flipper_connect` 的 `link` 不填时按环境自动推断：手机（dsh-go 环境）= `ble`，电脑串口 = `serial`，电脑 TCP 桥 = `usb`。
- PC 端安装：`dsh plugin --profile desktop add <repo>`，然后重启 DSH（面板与接口在启动时挂载）。

## 工具

| 工具 | 作用 |
|---|---|
| `flipper_connect` | 配置并连接（`tcp://` / `serial://`） |
| `flipper_disconnect` | 断开连接 |
| `flipper_status` | 连接、固件、电量、存储、当前 App 状态 |
| `flipper_capabilities` | 设备里有什么：内置 App、第三方 FAP、资源文件、工作流 |
| `flipper_screen` | 截屏（ASCII / 盲文 / PNG） |
| `flipper_input` | 按键；`observe=true` 自动回图 |
| `flipper_app` | 启动/退出 App、`load_file`、`button`、`get_error` |
| `flipper_storage` | 列出/读/写/删除/重命名/md5/stat |
| `flipper_system` | 电量、时间、响铃、重启、property、桌面 |
| `flipper_gpio` | GPIO 输入输出、上下拉、OTG |
| `flipper_cli` | CLI（仅 USB 串口直连；BLE 下不可用） |

## AI 自主操作

插件会往系统提示注入一段 Flipper 操作说明，并随包注册 `dsh-flipper` 技能。模型的工作循环：

1. `flipper_status` 确认连接
2. `flipper_capabilities` 了解设备里的 App 和文件
3. `flipper_screen` 看当前界面
4. `flipper_input`（`observe=true`）或 `flipper_app` 行动
5. 再截图确认，不对就 BACK 调整

示例说法：

- 「看看 Flipper 现在什么界面」
- 「打开 NFC，把卡贴上去读一下」
- 「列出 /ext/subghz，然后发射 Flip1.sub」
- 「把 /ext/nfc 的文件按时间排一下」

发射 Sub-GHz/红外、模拟 NFC/RFID、运行 BadUSB、重启/恢复出厂前，模型会先征求你的同意。

## 配置

`flipper_connect` 会把连接参数写到 `~/.dsh/flipper/config.json`：

```json
{
  "transport": "auto",
  "tcpHost": "",
  "tcpPort": 9757,
  "serialPath": "COM6",
  "baud": 230400,
  "timeoutMs": 8000,
  "link": "auto"
}
```

`link` 可以是 `auto` / `ble` / `usb` / `serial`；它决定 `flipper_status` 报告 `cliAvailable` 的真假。也支持环境变量 `FLIPPER_TCP=host:port` / `FLIPPER_SERIAL=/dev/ttyACM0`。截图默认保存到 `~/.dsh/flipper/screens/`。

插件设置里还有 `autoConnect`（默认 `true`）：DSH 启动约 1 秒后自动连一次本机 Flipper，失败就等面板里点连接。`DSH_FLIPPER_KOFFI` 可以手动指定 koffi 路径（一般不用动）。

## 构建

### 插件

无构建、零依赖：

```sh
node test/e2e.mjs        # 协议 + 截图 + 按键 + 存储 + CLI（离线模拟器）
node test/api-e2e.mjs    # 面板接口族 /api/dsh-flipper/*（离线模拟器）
node test/panel-mount.mjs # 走真实 index.js 挂载：工具 / 系统提示 / 技能 / 面板路由（需要本机 DSH）
node test/tool-e2e.mjs   # 走真实 defineTool 校验（需要本机 DSH）
```

`lib/client.js` 是浏览器半边，零构建（`window.__ModuleLoader__.load` 包装 + `React.createElement`）。改 UI 时可以先看离线预览：

```sh
node tools/panel-preview/build.mjs        # 生成 tools/panel-preview/panel-preview.html
python -m http.server 8891                # 仓库根目录起静态服务器
# 打开 http://127.0.0.1:8891/tools/panel-preview/panel-preview.html
```

### Android 桥

用 Android Studio 打开 `android/`，或：

```sh
cd android
./build.sh
# 需要 Debian/Ubuntu 的 android-sdk-platform-23、android-sdk-build-tools、apksigner
```

`targetSdk 25` 是为了避开新系统的通知渠道和 Android 12+ 蓝牙权限限制；仅适合侧载。详见 [android/README.md](android/README.md)。

> `dist` 里的 APK 用本机 debug key 签名。你自己用 `android/` 重建时签名不同，覆盖安装失败就先卸载旧版再装。

## 协议

- BLE GATT 服务/特征 UUID、RPC 自动会话、varint 分帧、128x64 纵向页帧格式、USB 与 BLE 的差异：见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。
- 固件侧依据：[flipperzero-firmware](https://github.com/flipperdevices/flipperzero-firmware)、[flipperzero-protobuf](https://github.com/flipperdevices/flipperzero-protobuf)。

## 兼容性

- 实测：Flipper Zero 固件 `v1.1.6`，protobuf `0.25`，Android 14 平板（PC 模式），DSH `0.2.2-rc.1`。
- 其他固件字段/帧格式可能不同；截图是噪声时先核对 `docs/PROTOCOL.md`。
- BLE 下没有 CLI 文本通道，`flipper_cli` 不可用；USB 串口直连可用。

## 安全与合规

- 仅用于你自己的设备。
- 发射射频/红外、模拟 NFC/RFID、运行 BadUSB 可能受当地法律限制，请先确认。
- 不要干扰公共频段、门禁或他人设备。
- TCP 桥没有鉴权：只监听本地或可信局域网。

## 排障

| 现象 | 处理 |
|---|---|
| `ECONNREFUSED 127.0.0.1:9757` | 桥 App 没监听：看 App 日志有没有 `TCP 监听`；确认 APK 是 1.6+（含 `INTERNET` 权限） |
| `CCCD 缺失` / 连上收不到数据 | 先在系统蓝牙取消配对、关开蓝牙，再重新配对；确认 TX/RX UUID 没写反 |
| `APP_SYSTEM_LOCKED` | 菜单/文件浏览器占着 loader，先按 BACK 回桌面 |
| 截图是噪声 | 帧格式/固件不匹配；核对 [docs/PROTOCOL.md](docs/PROTOCOL.md) 的纵向页格式 |
| BLE 断开 | App 里点「重新连接 Flipper」，再 `flipper_connect` |

## 目录结构

```text
.
├── index.js              # DSH 插件入口（工具 + 系统提示 + dsh-go 面板）
├── lib/                  # protobuf / RPC / 传输 / 屏幕 / 管理器
├── skill/                # 随包技能（完整操作手册）
├── tools/                # 电脑 USB 桥、Termux 桥
├── test/                 # 离线模拟器与端到端测试
├── android/              # Android BLE 桥源码
├── docs/                 # 协议、架构、截图
├── dist/                 # 预编译 APK
├── install.sh / .ps1     # 一键安装插件
└── .github/workflows/    # CI
```

## License

MIT，见 [LICENSE](LICENSE)。

`android/` 的启动图标由项目作者提供，**不在 MIT 授权范围内**；如果你不是作者，请在发布前替换，见 [NOTICE.md](NOTICE.md)。

## 致谢

- [flipperzero-firmware](https://github.com/flipperdevices/flipperzero-firmware) / [flipperzero-protobuf](https://github.com/flipperdevices/flipperzero-protobuf)
- [DeepSeek Harness](https://github.com/deepseek-ai)
- pyserial
