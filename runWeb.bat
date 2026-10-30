@echo off
rem Kaam25 web app: opens http://127.0.0.1:5000 (or the next free port) in your browser.
rem First run sets itself up: creates venv, installs requirements.txt, creates .env from .env.example.
rem Already running? It just opens the app again. Keep this window open (minimized is fine)
rem while you work; close it (or Ctrl+C) to stop the app.
cd /d "%~dp0"
title Kaam25: 13 Bhai gaadi chalayega - close this window to stop the app

if not exist "venv\Scripts\python.exe" (
  echo First run: creating the Python environment in venv ...
  python -m venv venv
  if errorlevel 1 (
    echo.
    echo Python wasn't found. Install Python 3.10 or newer from https://www.python.org/downloads/
    echo and tick "Add python.exe to PATH" in the installer, then double-click runWeb.bat again.
    pause
    exit /b 1
  )
  echo Installing requirements ...
  "venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo.
    echo Installing the requirements failed - see the messages above.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo Created .env from .env.example. Fill in your values in Notepad, save, close it,
  echo then double-click runWeb.bat again.
  start "" notepad ".env"
  pause
  exit /b 0
)

"venv\Scripts\python.exe" -m web.server
if errorlevel 1 pause
