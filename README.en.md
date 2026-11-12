# dsh-flipper

Control a **Flipper Zero** from [DeepSeek Harness](https://github.com/deepseek-ai) with natural
language: see its screen, press buttons, launch apps, read/write the SD card, and drive
Sub-GHz / NFC / RFID / Infrared / BadUSB / GPIO.

> Unofficial project. Not affiliated with Flipper Devices Inc. Use it only on your own devices.

## What's inside

| Part | Description |
|---|---|
| **DSH plugin** (repo root, Node.js) | Registers `flipper_*` tools, injects an operating guide into the system prompt, ships a `dsh-flipper` skill, and adds a status panel to the dsh-go mobile app |
| **Android BLE bridge** (`android/`) | Bridges the Flipper's Bluetooth serial profile to `127.0.0.1:9757`, because the DSH engine runs inside proot and cannot access Android BLE APIs |

A PC USB bridge (`tools/flipper-bridge.py`) is also included for `tcp://<pc>:9757`, and the
plugin can talk to a directly attached serial port with `serial:///dev/ttyACM0`.

## Features

- **Screen**: 128x64 monochrome; ASCII (the actual UI), braille, and PNG for `read_image`
- **Input**: up/down/left/right/ok/back, short/long; `observe=true` captures the screen after a keypress
- **Apps**: start/exit/load file/buttons; built-in Sub-GHz, NFC, 125 kHz RFID, Infrared, iButton, Bad USB, U2F, GPIO
- **Files**: list/read/write/delete/rename/md5/stat under `/ext`
- **System**: battery, time, alert, reboot, properties, desktop lock
- **Discovery**: `flipper_capabilities` returns installed FAPs, resource-file counts/examples, tools, and workflows
- **Agent loop**: system prompt + bundled skill + observe → act → observe
- **dsh-go panel**: live screen, battery, D-pad

## Architecture

```mermaid
flowchart LR
  AI[DSH / AI] --> P[dsh-flipper plugin]
  P -->|TCP 127.0.0.1:9757| B[Android BLE bridge]
  B -->|BLE GATT| F[Flipper Zero]
  P -.->|TCP| C[PC USB bridge]
  C -.-> F
```

## Quick start

```sh
git clone <repo-url> dsh-flipper
cd dsh-flipper
./install.sh          # Linux / macOS / phone proot
# Windows: .\install.ps1
```

Or install straight from GitHub: `dsh plugin --profile web add github:<you>/dsh-flipper`.

Restart the DSH engine, then connect:

- **Android BLE bridge**: install `dist/flipper-ble-bridge-1.6.apk`, turn on Flipper Bluetooth,
  pair (PIN on the Flipper), wait for `TCP 监听 127.0.0.1:9757`, then
  `flipper_connect(endpoint="tcp://127.0.0.1:9757")`.
- **PC USB bridge**: plug the Flipper into a PC, run `python3 tools/flipper-bridge.py`, then
  `flipper_connect(endpoint="tcp://<pc-ip>:9757")`.
- **Direct serial**: `flipper_connect(endpoint="serial:///dev/ttyACM0", link="serial")`.
- **PC-side DSH**: install the same plugin on the PC; it gets the same system prompt and
  `dsh-flipper` skill. Use `tcp://<pc-ip>:9757` with `link="usb"` (USB bridge) or
  `serial:///dev/ttyACM0` with `link="serial"`. `flipper_cli` works on `usb`/`serial`, not on
  `ble`. `link` defaults to `ble` on the phone and `usb`/`serial` on a PC.

## Tools

`flipper_connect`, `flipper_disconnect`, `flipper_status`, `flipper_capabilities`,
`flipper_screen`, `flipper_input`, `flipper_app`, `flipper_storage`, `flipper_system`,
`flipper_gpio`, `flipper_cli` (USB CLI only; not available over BLE).

## Protocol

BLE service/characteristics, varint framing, and the 128x64 page-major framebuffer are
documented in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Build / test

```sh
node test/e2e.mjs          # offline mock: protocol, screen, keys, storage, CLI
cd android && ./build.sh   # or open android/ in Android Studio
```

## License

MIT. The launcher icon is supplied by the project author and is not covered by the MIT
license — see [NOTICE.md](NOTICE.md).

中文说明见 [README.md](README.md)。
