@echo off
title Bitunix Auto Trade Bot - BTCUSDT
color 0A
cd /d "%~dp0"

echo ===================================================
echo     Bitunix BTCUSDT Auto-Trade Tool & Dashboard
echo ===================================================
echo.

set "PY_CMD=C:\Users\hamma\AppData\Local\Python\bin\python.exe"

if not exist "%PY_CMD%" (
    set "PY_CMD=python"
)

echo Starting Flask Server and Bot Engine...
echo Opening Web Dashboard at http://127.0.0.1:5000 ...

start "" http://127.0.0.1:5000

"%PY_CMD%" app.py
pause
