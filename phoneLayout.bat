@echo off
rem Set up desk: unlock the phones, Service Mode + Speedtest and Vysor where missing (skips what is done), Chrome on the left half, each phone a quarter on the right
cd /d "%~dp0"
"venv\Scripts\python.exe" -m kaam.deskLayout %*
if errorlevel 1 pause
