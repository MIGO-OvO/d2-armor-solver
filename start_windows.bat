@echo off
setlocal
cd /d "%~dp0"

title Destiny 2 Armor Solver

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or is not available in PATH.
  echo Install Node.js 22.13.0 or newer, then run this file again.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not available in PATH.
  echo Reinstall Node.js with npm, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo [SETUP] Installing project dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
)

echo [START] Starting Destiny 2 Armor Solver...
echo Keep this window open while using the application.
echo Press Ctrl+C to stop the local server.
echo.

if /I "%~1"=="--no-open" (
  call npm.cmd run dev -- --host 127.0.0.1
) else (
  call npm.cmd run dev -- --host 127.0.0.1 --open
)

set "LAUNCH_EXIT_CODE=%ERRORLEVEL%"
if not "%LAUNCH_EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] The local server stopped unexpectedly.
  pause
)

exit /b %LAUNCH_EXIT_CODE%
