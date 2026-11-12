#!/usr/bin/env python3
"""把 Flipper Zero 的 USB 串口桥接成 TCP，让手机上的 DSH 也能连。

用法（在插着 Flipper 的电脑上运行）：
    pip install pyserial
    python3 flipper-bridge.py                 # 自动找 Flipper，监听 0.0.0.0:9757
    python3 flipper-bridge.py --port COM5     # Windows 指定串口
    python3 flipper-bridge.py --port /dev/ttyACM0 --tcp-port 9757

桥是透明的：DSH 插件自己会发 start_rpc_session，桥只负责搬运字节。
同一时间只服务一个客户端；新客户端连上会顶掉旧的，避免残留会话。
"""
import argparse
import socket
import sys
import threading
import time

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    print("缺少 pyserial，请先运行：pip install pyserial", file=sys.stderr)
    sys.exit(1)


def find_flipper():
    for port in list_ports.comports():
        if getattr(port, "vid", None) == 0x0483 and getattr(port, "pid", None) == 0x5740:
            return port.device
    for port in list_ports.comports():
        text = f"{port.device} {port.description}".lower()
        if "flipper" in text or "unygate" in text or "flip_" in text:
            return port.device
    return None


def local_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        ips.add(probe.getsockname()[0])
        probe.close()
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


class Bridge:
    def __init__(self, serial_port, baud, listen, tcp_port):
        self.ser = serial.Serial(serial_port, baud, timeout=0.2, write_timeout=3)
        self.listen = listen
        self.tcp_port = tcp_port
        self.client = None
        self.lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.running = True

    def serve(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((self.listen, self.tcp_port))
        server.listen(4)
        server.settimeout(0.5)
        threading.Thread(target=self.pump_serial, daemon=True).start()
        print(f"[bridge] 串口 {self.ser.port} @ {self.ser.baudrate} 已打开")
        print(f"[bridge] 监听 {self.listen}:{self.tcp_port}")
        for ip in local_ips():
            print(f"[bridge] 手机端填：tcp://{ip}:{self.tcp_port}")
        print("[bridge] Ctrl+C 退出")
        try:
            while self.running:
                try:
                    conn, addr = server.accept()
                except socket.timeout:
                    continue
                threading.Thread(target=self.handle_client, args=(conn, addr), daemon=True).start()
        finally:
            self.running = False
            server.close()
            try:
                self.ser.close()
            except Exception:
                pass

    def handle_client(self, conn, addr):
        print(f"[bridge] 客户端接入 {addr[0]}:{addr[1]}")
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        with self.lock:
            if self.client is not None:
                try:
                    self.client.close()
                except Exception:
                    pass
            self.client = conn
        try:
            while self.running:
                data = conn.recv(8192)
                if not data:
                    break
                with self.write_lock:
                    self.ser.write(data)
        except OSError:
            pass
        finally:
            with self.lock:
                if self.client is conn:
                    self.client = None
            try:
                conn.close()
            except Exception:
                pass
            print(f"[bridge] 客户端断开 {addr[0]}:{addr[1]}")

    def pump_serial(self):
        while self.running:
            try:
                data = self.ser.read(8192)
            except serial.SerialException as error:
                print(f"[bridge] 串口错误：{error}", file=sys.stderr)
                self.running = False
                break
            if not data:
                continue
            with self.lock:
                client = self.client
            if client is None:
                continue
            try:
                client.sendall(data)
            except OSError:
                with self.lock:
                    if self.client is client:
                        self.client = None


def main():
    parser = argparse.ArgumentParser(description="Flipper Zero 串口 ↔ TCP 桥")
    parser.add_argument("--port", help="串口设备，例如 /dev/ttyACM0 或 COM5（省略则自动找）")
    parser.add_argument("--baud", type=int, default=230400, help="波特率，默认 230400")
    parser.add_argument("--listen", default="0.0.0.0", help="监听地址，默认 0.0.0.0")
    parser.add_argument("--tcp-port", type=int, default=9757, help="TCP 端口，默认 9757")
    parser.add_argument("--list", action="store_true", help="列出串口后退出")
    args = parser.parse_args()

    if args.list:
        for port in list_ports.comports():
            print(f"{port.device}\t{port.description}\t{port.hwid}")
        return

    port = args.port or find_flipper()
    if not port:
        print("没找到 Flipper 串口。用 --list 看看，或 --port 手动指定。", file=sys.stderr)
        sys.exit(2)
    Bridge(port, args.baud, args.listen, args.tcp_port).serve()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[bridge] 再见")
    except serial.SerialException as error:
        print(f"[bridge] 打不开串口：{error}", file=sys.stderr)
        print("提示：Linux 需要把用户加入 dialout 组；Windows 先装好 USB CDC 驱动。", file=sys.stderr)
        sys.exit(3)
