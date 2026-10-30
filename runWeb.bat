@echo off
rem Kaam25 web app: opens http://127.0.0.1:5000 (or the next free port) in your browser.
rem Already running? It just opens the app again. Keep this window open (minimized is fine)
rem while you work; close it (or Ctrl+C) to stop the app.
cd /d "%~dp0"
title Kaam25 web - close this window to stop the app
"venv\Scripts\python.exe" -m web.server
if errorlevel 1 pause
