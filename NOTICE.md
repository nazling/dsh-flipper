# NOTICE

## Trademarks

Flipper Zero is a trademark of Flipper Devices Inc. This project is an
independent, unofficial integration and is not affiliated with or endorsed by
Flipper Devices Inc.

## App icon

The launcher icon under `android/app/src/main/res/mipmap-*` was supplied by the
project author. It is **not** covered by the MIT license in this repository.
If you are not the rights holder, replace it with your own artwork before
redistributing the app.

## Protocol references

The RPC field numbers and BLE service/characteristic UUIDs are derived from the
public Flipper Zero firmware and protobuf definitions:

- https://github.com/flipperdevices/flipperzero-firmware
- https://github.com/flipperdevices/flipperzero-protobuf

Those projects are licensed separately (GPL-3.0 for the firmware).

## Signing

`dist/flipper-ble-bridge-1.6.apk` is signed with a local debug key for
sideloading only. Rebuild it from `android/` and sign with your own key for any
public release.
