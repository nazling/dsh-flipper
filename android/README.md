# Flipper BLE 桥（Android）

把 **Flipper Zero 的蓝牙串口**桥接到手机/平板本地的 TCP：`127.0.0.1:9757`。  
DSH 的 `dsh-flipper` 插件连这个端口，就能在**不插线、不依赖电脑**的情况下看屏幕、按键、读写文件。

```
[Flipper] ⇄ BLE ⇄ [这个 App] ⇄ 127.0.0.1:9757 ⇄ [DSH 插件]
```

## 为什么需要它

DSH 引擎跑在 proot 里，拿不到 Android 的 BLE API；官方 App 的蓝牙连接也不给第三方复用。  
所以需要一个原生 Android 小程序，自己当 BLE 客户端，再把字节流转成本地 TCP。

## 协议要点

- 服务：`8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000`
- TX（Flipper → 手机，**INDICATE**）：`19ed82ae-ed21-4c9d-4145-228e61fe0000`
- RX（手机 → Flipper，**WRITE**）：`19ed82ae-ed21-4c9d-4145-228e62fe0000`
- 连上 BLE 后固件会自动开 RPC 会话，不需要再发 `start_rpc_session`
- 应用层是透明字节流，RPC 的 varint 分帧由 DSH 插件处理
- 插件连接时会发 `start_rpc_session\r`（USB 习惯），App 会吞掉并回一个换行

细节见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md)。

## 构建

### 方式 A：Android Studio（推荐普通用户）

1. 安装 Android Studio（含 JDK 17）
2. `Open` 这个 `android/` 目录，等待 Gradle 同步
3. 手机/平板开 USB 调试，连电脑，点 `Run`
4. 或 `Build → Build Bundle(s)/APK(s) → Build APK(s)`

### 方式 B：命令行（Debian/Ubuntu）

```sh
sudo apt install android-sdk-platform-23 android-sdk-build-tools apksigner
cd android
./build.sh
# 产物：flipper-ble-bridge.apk
```

`build.sh` 用 `aapt + javac + dx + zipalign + apksigner`，不依赖 Gradle。

## 安装与使用

1. Flipper：`设置 → 蓝牙 → ON`；关掉官方 Flipper App（会占用 BLE）
2. 安装并打开 App，允许定位权限（BLE 扫描需要）
3. 点「扫描并连接 Flipper」
4. 首次会配对：Flipper 屏幕显示 PIN，在系统弹窗输入
5. 看到日志 `TCP 监听 127.0.0.1:9757` 后，在 DSH 里：
   ```
   flipper_connect(endpoint="tcp://127.0.0.1:9757")
   ```

### 以前配对过？

如果日志出现 `CCCD 缺失` 或连上收不到数据：系统蓝牙 → 取消配对 Flipper → 关开蓝牙 → 回来重新扫描配对。App 里也有「取消配对 / 打开蓝牙设置」按钮。

## 注意

- **`flipper_cli` 不要用**：BLE 没有 CLI 文本通道；电脑 USB 桥/串口直连才可用。
- BLE 断开后点「重新连接 Flipper」。
- `targetSdk 25` 是为了免掉 Android 8+ 的通知渠道和 Android 12+ 的新蓝牙权限；侧载没问题，不能上架应用商店。
- 只监听 `127.0.0.1`，局域网其他设备访问不到。
- 配对信息由 Android 系统保存；换设备需要重新配对。
- 启动图标由项目作者提供，不在 MIT 授权范围内；见 [../NOTICE.md](../NOTICE.md)。

## 排障

| 现象 | 处理 |
|---|---|
| 扫描不到设备 | 确认 Flipper 蓝牙已开、官方 App 已强制停止、定位已开；8 秒后会列设备列表 |
| `CCCD 缺失` | 取消配对 + 关开蓝牙 + 重配对 |
| `TCP 服务失败: EPERM` | 缺少 `INTERNET` 权限；用 1.6+ 版本 |
| `APP_SYSTEM_LOCKED` | 菜单/文件浏览器占着 loader；先按 BACK 回桌面 |
| 连上但插件超时 | 看 App 日志有没有 `TCP 监听`；确认端口 9757 没被改 |
