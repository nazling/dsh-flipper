#!/data/data/com.termux/files/usr/bin/bash
# termux-usb 会把 USB fd 作为 $1 传进来；转交给 Python 桥。
exec python "$HOME/flipper-termux-bridge.py" "$1"
