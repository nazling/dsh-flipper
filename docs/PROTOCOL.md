# Flipper Zero RPC / BLE protocol notes

This document records what `dsh-flipper` and the Android bridge actually implement.
Field numbers come from
[flipperzero-protobuf](https://github.com/flipperdevices/flipperzero-protobuf); BLE
UUIDs and behavior come from
[flipperzero-firmware](https://github.com/flipperdevices/flipperzero-firmware)
(`targets/f7/ble_glue/services/serial_service.c`).

## Transports

```
USB serial (CDC ACM)   →  raw protobuf stream, CLI by default
TCP (PC bridge)        →  raw serial bytes over TCP
BLE (Android bridge)   →  GATT writes/indications, RPC session opens automatically
```

The DSH plugin speaks the same RPC protocol over all three; only the session bootstrap
differs.

## BLE GATT

Service:

```
8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000
```

Characteristics:

| Name | UUID | Direction | Properties |
|---|---|---|---|
| TX | `19ed82ae-ed21-4c9d-4145-228e61fe0000` | Flipper → client | READ + **INDICATE** |
| RX | `19ed82ae-ed21-4c9d-4145-228e62fe0000` | client → Flipper | READ + WRITE + WRITE_NO_RESPONSE |
| Flow control | `19ed82ae-ed21-4c9d-4145-228e63fe0000` | Flipper → client | READ + NOTIFY (4-byte big-endian free buffer) |
| RPC status | `19ed82ae-ed21-4c9d-4145-228e64fe0000` | both | READ + WRITE + NOTIFY (`0` = session closed) |

CCCD: `00002902-0000-1000-8000-00805f9b34fb`, value `0x02 0x00` (indications).

> Note: some public PoCs swap TX/RX. The firmware's `.inc` byte arrays are little-endian;
> decoding them gives TX = `...61...` and RX = `...62...`. This project follows the
> firmware. A correct TX characteristic reports properties `0x22` (READ + INDICATE) and
> has one CCCD; `0x0E` means you are looking at the writable RX.

The BLE profile starts an RPC session (`RpcOwnerBle`) on connection; no CLI handshake is
involved. The Android bridge therefore **swallows** a leading `start_rpc_session\r` sent by
the plugin (which is a USB/CLI habit) and echoes `start_rpc_session\r\n` back, then forwards
the following protobuf bytes.

## Framing

Messages are `PB_ENCODE_DELIMITED`: a varint length followed by a `Main` protobuf message.

```
Main {
  uint32 command_id = 1;
  CommandStatus command_status = 2;   // 0 = OK, omitted on success
  bool has_next = 3;                  // multi-frame responses
  oneof content { ... }               // fields 4..75
}
```

`command_status` is omitted when OK (proto3 default). Multi-frame responses repeat the
same `command_id`; the last frame has `has_next = false`.

## Content fields used here

| Field | Message |
|---|---|
| 4 | Empty |
| 5 / 6 | system ping request / response |
| 7 / 8 | storage list request / response |
| 9 / 10 | storage read request / response |
| 11 | storage write request |
| 12 | storage delete |
| 13 | storage mkdir |
| 14 / 15 | storage md5sum |
| 16 | app start |
| 17 / 18 | app lock status |
| 19 | stop session |
| 20 / 21 / 22 / 23 | GUI start stream / stop stream / screen frame / input event |
| 24 / 25 | storage stat |
| 28 / 29 | storage info |
| 30 | storage rename |
| 31 | system reboot |
| 32 / 33 | device info |
| 35 / 36 | datetime |
| 38 | audiovisual alert |
| 39 / 40 | protobuf version |
| 44 / 45 | power info |
| 47 | app exit |
| 48 | app load file |
| 49 / 50 / 75 | app button press / release / press-release |
| 51–57 | GPIO set mode / pull / get mode / read / write |
| 58 | app state (started / closed, unsolicited) |
| 61 / 62 | property get |
| 63 / 64 | app error |
| 66–70 | desktop lock / unlock / status |
| 72–74 | GPIO OTG mode |

## Sessions

### USB serial

1. Open the port (230400 baud; ignored by CDC ACM).
2. Send the CLI command `start_rpc_session\r`.
3. Wait for the CLI echo newline, then speak protobuf.
4. To return to the CLI, send `Main { stop_session }`; the CLI prompt is `>: `.

### BLE

No text handshake. The serial profile opens the RPC session when the GATT link is
established. `flipper_cli` is therefore unavailable over BLE: there is no CLI transport.

### Stop / reconnect

`stop_session` closes the RPC session. On BLE the GATT link stays up with RPC status
inactive; the Android bridge's “重新连接 Flipper” cycles the GATT link to start a new
session.

## Storage multi-frame

- **Read**: response frames carry a `File` with up to 512 bytes of `data`; `has_next` is
  true until the final frame (which can be empty for a zero-byte file).
- **Write**: send chunks of ≤512 bytes with the **same** `command_id`; `has_next` is true
  for all but the last chunk, and the device replies once after the last chunk.
- **List**: `File` entries are repeated inside one `ListResponse`; very large directories
  can span multiple frames with `has_next`.

## Screen frames

`ScreenFrame`:

```proto
message ScreenFrame {
  bytes data = 1;               // 1024 bytes
  ScreenOrientation orientation = 2; // 0..3
}
```

Framebuffer layout (SSD1306-style, page-major):

```
index = (y / 8) * 128 + x
pixel = (data[index] >> (y % 8)) & 1   // bit 0 = top row
```

This is **not** horizontal MSB-first. Decoding it the wrong way produces noise that still
looks like a valid 1024-byte frame. `lib/screen.js` uses the page-major layout and then
applies the orientation (0 / 180 / 90 / 270).

Screen stream:

1. Send `gui_start_screen_stream_request` (20); the device replies OK.
2. Frames arrive as `gui_screen_frame` (22) whenever the GUI commits. The firmware does
   **not** set `command_id` on these frames (it is 0), so do not filter by request id.
3. Send `gui_stop_screen_stream_request` (21) to stop.
4. Starting twice returns `ERROR_VIRTUAL_DISPLAY_ALREADY_STARTED` (19).

The plugin caches the latest frame to avoid losing one that arrives in the same TCP chunk
as the start response.

## Timings / limits

- BLE MTU is negotiated (observed 414 on Android); writes are chunked to `MTU - 3`.
- The Flipper's BLE TX sends 243-byte indication chunks; the stream is reassembled by the
  plugin.
- The RPC client serializes commands and keeps a 60 s cache for device info and
  capabilities.

## Tested

Flipper Zero firmware `v1.1.6`, protobuf `0.25`, Android 14 tablet, DSH `0.2.2-rc.1`.
Other firmware versions may differ; check `flipper_capabilities` / `flipper_status` first.
