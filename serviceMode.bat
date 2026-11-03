@echo off
rem Phone split screen: Service Mode (*#0011#) on top, Speedtest below. No name = every connected phone
cd /d "%~dp0"
"venv\Scripts\python.exe" -m kaam.phoneControl serviceMode %*
if errorlevel 1 pause
