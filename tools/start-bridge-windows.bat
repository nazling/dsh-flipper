@echo off
cd /d "%~dp0"
echo Installing pyserial...
python -m pip install --user pyserial
echo.
echo Starting Flipper bridge (keep this window open)...
python flipper-bridge.py
pause
