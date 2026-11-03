@echo off
rem Press GO / Test Again on the open Speedtest page. No name = every connected phone; or e.g. speedTest.bat "TMO 1"
cd /d "%~dp0"
"venv\Scripts\python.exe" -m kaam.phoneControl speedtest %*
if errorlevel 1 pause
