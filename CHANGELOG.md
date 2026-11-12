# Changelog

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
