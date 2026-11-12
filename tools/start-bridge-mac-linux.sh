#!/bin/sh
cd "$(dirname "$0")" || exit 1
python3 -m pip install --user pyserial
python3 flipper-bridge.py
