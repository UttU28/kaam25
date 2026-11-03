@echo off
rem Airplane mode on, wait 5s (PHONE_AIRPLANE_SECONDS), off, then press GO / Test Again in Speedtest. No name = every connected phone; or e.g. airplaneToggle.bat "TMO 1"
cd /d "%~dp0"
"venv\Scripts\python.exe" -m kaam.phoneControl airplane %*
if errorlevel 1 pause
