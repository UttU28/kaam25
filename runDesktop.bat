@echo off
rem The older desktop window (CustomTkinter). Don't run it together with the web app:
rem both talk to the Chrome extension on the same port.
cd /d "%~dp0"
start "" "venv\Scripts\pythonw.exe" desktop\app.py
