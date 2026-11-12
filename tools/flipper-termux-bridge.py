#!/usr/bin/env python3
# Termux 专用：把 Flipper 的 USB CDC 端点桥接成本地 TCP。
# 由 termux-usb 启动，读取 TERMUX_USB_FD，不需要 root。
#
# 用法（Termux 里）：
#   pkg install termux-api python libusb
#   termux-usb -l
#   termux-usb -r -e "python ~/flipper-termux-bridge.py" /dev/bus/usb/001/002
#
# 然后在 DSH 里：flipper_connect(endpoint="tcp://127.0.0.1:9757")

import ctypes
import os
import socket
import sys
import threading
import time

PORT = int(os.environ.get("FLIPPER_BRIDGE_PORT", "9757"))
def _fd_from_args():
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        return int(sys.argv[1])
    return int(os.environ.get("TERMUX_USB_FD", "0") or 0)


FD = _fd_from_args()
IN_EP = 0x81
OUT_EP = 0x01
BUF_SIZE = 4096

c_void_p = ctypes.c_void_p
c_int = ctypes.c_int
c_uint = ctypes.c_uint
c_ubyte = ctypes.c_ubyte
c_uint16 = ctypes.c_uint16

LIBUSB_ERROR_TIMEOUT = -7


def log(*args):
    print("[flipper-bridge]", *args, flush=True)


def load_libusb():
    candidates = [
        "libusb-1.0.so",
        "libusb-1.0.so.0",
        "/data/data/com.termux/files/usr/lib/libusb-1.0.so",
    ]
    for name in candidates:
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    log("找不到 libusb，请先在 Termux 里运行：pkg install libusb")
    sys.exit(1)


def main():
    if FD <= 0:
        log("没有 TERMUX_USB_FD。不要直接运行这个脚本，用：")
        log('termux-usb -e "$HOME/flipper-termux-run.sh" /dev/bus/usb/001/002')
        return 1

    lib = load_libusb()
    # 只包装 termux-usb 给的 fd，不做设备枚举（Termux 下必须这样）。
    lib.libusb_set_option.argtypes = [c_void_p, c_int]
    lib.libusb_set_option.restype = c_int
    lib.libusb_set_option(None, 2)  # LIBUSB_OPTION_NO_DEVICE_DISCOVERY
    lib.libusb_init.argtypes = [ctypes.POINTER(c_void_p)]
    lib.libusb_init.restype = c_int
    lib.libusb_wrap_sys_device.argtypes = [c_void_p, c_int, ctypes.POINTER(c_void_p)]
    lib.libusb_wrap_sys_device.restype = c_int
    lib.libusb_set_auto_detach_kernel_driver.argtypes = [c_void_p, c_int]
    lib.libusb_set_auto_detach_kernel_driver.restype = c_int
    lib.libusb_detach_kernel_driver.argtypes = [c_void_p, c_int]
    lib.libusb_detach_kernel_driver.restype = c_int
    lib.libusb_claim_interface.argtypes = [c_void_p, c_int]
    lib.libusb_claim_interface.restype = c_int
    lib.libusb_control_transfer.argtypes = [
        c_void_p,
        c_ubyte,
        c_ubyte,
        c_uint16,
        c_uint16,
        ctypes.POINTER(c_ubyte),
        c_uint16,
        c_uint,
    ]
    lib.libusb_control_transfer.restype = c_int
    lib.libusb_bulk_transfer.argtypes = [
        c_void_p,
        c_ubyte,
        ctypes.POINTER(c_ubyte),
        c_int,
        ctypes.POINTER(c_int),
        c_uint,
    ]
    lib.libusb_bulk_transfer.restype = c_int

    ctx = c_void_p()
    if lib.libusb_init(ctypes.byref(ctx)) != 0:
        log("libusb_init 失败")
        return 1
    handle = c_void_p()
    rc = lib.libusb_wrap_sys_device(ctx, FD, ctypes.byref(handle))
    if rc != 0:
        log(f"libusb_wrap_sys_device 失败（{rc}）。Termux:API 或 USB 授权可能没弄好")
        return 1

    lib.libusb_set_auto_detach_kernel_driver(handle, 1)
    for iface in (0, 1):
        rc = lib.libusb_detach_kernel_driver(handle, iface)
        if rc == 0:
            log(f"已解绑内核驱动 interface {iface}")

    claimed = None
    for iface in (1, 0):
        rc = lib.libusb_claim_interface(handle, iface)
        if rc == 0:
            claimed = iface
            break
    if claimed is None:
        log("claim interface 失败。先强制停止官方 Flipper App（它可能占着 USB），再重跑本脚本")
        return 1
    log(f"已占用 interface {claimed}")

    # CDC：115200 8N1，再拉 DTR/RTS；Flipper 不关心波特率，但需要 DTR。
    line_coding = (c_ubyte * 7)(0x00, 0xC2, 0x01, 0x00, 0x00, 0x00, 0x08)
    lib.libusb_control_transfer(handle, 0x21, 0x20, 0, 0, line_coding, 7, 1000)
    lib.libusb_control_transfer(handle, 0x21, 0x22, 0x03, 0, None, 0, 1000)

    current = {"conn": None}
    lock = threading.Lock()
    running = True
    buf = (c_ubyte * BUF_SIZE)()
    transferred = c_int()

    def reader():
        while running:
            rc = lib.libusb_bulk_transfer(
                handle, IN_EP, buf, BUF_SIZE, ctypes.byref(transferred), 500
            )
            if rc == LIBUSB_ERROR_TIMEOUT:
                continue
            if rc < 0:
                time.sleep(0.2)
                continue
            if transferred.value <= 0:
                continue
            data = bytes(buf[: transferred.value])
            with lock:
                conn = current["conn"]
            if conn is None:
                continue
            try:
                conn.sendall(data)
            except OSError:
                pass

    threading.Thread(target=reader, daemon=True).start()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", PORT))
    server.listen(1)
    log(f"就绪：监听 127.0.0.1:{PORT}，等 DSH 连接")

    while True:
        conn, _ = server.accept()
        with lock:
            current["conn"] = conn
        log("DSH 已连接")
        try:
            while True:
                data = conn.recv(BUF_SIZE)
                if not data:
                    break
                offset = 0
                while offset < len(data):
                    chunk = (c_ubyte * (len(data) - offset)).from_buffer_copy(data[offset:])
                    rc = lib.libusb_bulk_transfer(
                        handle,
                        OUT_EP,
                        chunk,
                        len(data) - offset,
                        ctypes.byref(transferred),
                        1000,
                    )
                    if rc < 0:
                        log(f"bulk OUT 失败（{rc}）")
                        break
                    offset += transferred.value
        except OSError:
            pass
        finally:
            with lock:
                current["conn"] = None
            try:
                conn.close()
            except OSError:
                pass
            log("DSH 断开，继续等")


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except KeyboardInterrupt:
        log("退出")
