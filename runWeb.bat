@echo off
rem Kaam25 web app: opens http://127.0.0.1:5000 (or the next free port) in your browser.
rem First run sets itself up: creates venv, installs requirements.txt, creates .env from .env.example.
rem Already running? The old copy stops and this window takes over. Keep this window open (minimized is fine)
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

rem A package added since the first run (e.g. segno for QR codes): install what's missing.
"venv\Scripts\python.exe" -c "import flask, dotenv, openpyxl, segno" >nul 2>&1 || "venv\Scripts\python.exe" -m pip install -r requirements.txt

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo Created .env from .env.example. Fill in your values in Notepad, save, close it,
  echo then double-click runWeb.bat again.
  start "" notepad ".env"
  pause
  exit /b 0
)

rem Exit code 75 = Settings saved .env and asked for a restart: start again in this window.
set KAAM_LAUNCHER=1
set KAAM_ARGS=
:run
"venv\Scripts\python.exe" -m web.server %KAAM_ARGS%
if %errorlevel%==75 goto restart
if errorlevel 1 pause
goto :eof

:restart
echo.
echo Restarting with the new settings ...
set KAAM_ARGS=--after-restart
goto run
