@echo off
REM Double-click this file to start Shipyard on Windows.
cd /d "%~dp0"
echo.
echo   Shipyard
echo   %cd%
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js isn't installed yet. Get the LTS download from https://nodejs.org
  echo   Install it, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   First run, installing what Shipyard needs. This takes a minute.
  call npm install --no-audit --no-fund --loglevel=error || goto fail
)

echo   Building the site...
call node scripts/build-site.mjs all || goto fail

if "%PORT%"=="" set PORT=4173
start "" "http://localhost:%PORT%/panel.html"
echo.
echo   Shipyard is running.
echo     Control panel   http://localhost:%PORT%/panel.html
echo     Your apps       http://localhost:%PORT%/launcher.html
echo.
echo   Leave this window open. Close it, or press Ctrl+C, to stop.
echo.
node scripts/serve.mjs
exit /b 0

:fail
echo.
echo   That step failed. The error above says why.
echo.
pause
exit /b 1
