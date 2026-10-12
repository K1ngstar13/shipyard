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

node scripts/start.mjs --stop-only

if exist node_modules\.shipyard-lock (
  fc /b package-lock.json node_modules\.shipyard-lock >nul
  if not errorlevel 1 goto dependencies_ready
)
(
  echo   First run, installing what Shipyard needs. This takes a minute.
  call npm ci --no-audit --no-fund --loglevel=error || goto fail
  copy /y package-lock.json node_modules\.shipyard-lock >nul
)
:dependencies_ready

echo   Building the site...
call node scripts/build-site.mjs all || goto fail

node scripts/start.mjs
exit /b 0

:fail
echo.
echo   That step failed. The error above says why.
echo.
pause
exit /b 1
