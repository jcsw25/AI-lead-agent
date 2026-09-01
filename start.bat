@echo off
REM ---------------------------------------------------------------------------
REM  AI Lead Generator Agent - local launcher
REM
REM  Double-click this file. It starts the database and the app in their own
REM  windows, then opens the browser. Everything runs on this machine.
REM
REM  To stop: close the two windows it opens (or press Ctrl+C in each).
REM ---------------------------------------------------------------------------

cd /d "%~dp0"
title AI Lead Generator Agent

echo.
echo   AI Lead Generator Agent - starting locally
echo   ------------------------------------------
echo.

REM --- dependencies -----------------------------------------------------------
if not exist "node_modules\" (
  echo   First run: installing dependencies. This takes a minute...
  call npm install
  if errorlevel 1 goto :failed
)

REM --- environment ------------------------------------------------------------
if not exist ".env" (
  echo   Creating .env from .env.example
  copy /y ".env.example" ".env" >nul
)

REM --- database ---------------------------------------------------------------
set FIRSTRUN=0
if not exist ".pgdata\" set FIRSTRUN=1

netstat -ano | findstr /c:"127.0.0.1:5432" | findstr /i "LISTENING" >nul
if not errorlevel 1 (
  echo   Database is already running - reusing it.
  goto :dbready
)

echo   Starting database...
start "Lead Agent - Database" cmd /k "npm run db:dev"

echo   Waiting for the database to accept connections...
set /a TRIES=0
:waitdb
ping -n 3 127.0.0.1 >nul
netstat -ano | findstr /c:"127.0.0.1:5432" | findstr /i "LISTENING" >nul
if not errorlevel 1 goto :dbready
set /a TRIES+=1
if %TRIES% GEQ 20 (
  echo   Database did not start. Check the "Lead Agent - Database" window for errors.
  goto :failed
)
goto :waitdb

:dbready
echo   Database ready.

if "%FIRSTRUN%"=="1" (
  echo   First run: creating tables and seeding demo data...
  call npm run db:push
  if errorlevel 1 goto :failed
  call npm run db:seed
  if errorlevel 1 goto :failed
  REM Without this a fresh install has no A-to-B theses, so nothing can be
  REM matched and every company is rejected for having no pairing.
  call npm run db:seed:pairings
  if errorlevel 1 goto :failed
)

REM --- app --------------------------------------------------------------------
netstat -ano | findstr /c:":3000" | findstr /i "LISTENING" >nul
if not errorlevel 1 (
  echo   App is already running - reusing it.
  goto :appready
)

echo   Starting the app...
start "Lead Agent - App" cmd /k "npm run dev"

echo   Waiting for the app...
set /a TRIES=0
:waitapp
ping -n 3 127.0.0.1 >nul
netstat -ano | findstr /c:":3000" | findstr /i "LISTENING" >nul
if not errorlevel 1 goto :appready
set /a TRIES+=1
if %TRIES% GEQ 25 (
  echo   App did not start. Check the "Lead Agent - App" window for errors.
  goto :failed
)
goto :waitapp

:appready
echo.
echo   Ready. Opening http://localhost:3000
echo.
start "" http://localhost:3000
ping -n 4 127.0.0.1 >nul
exit /b 0

:failed
echo.
echo   Startup failed. See the messages above.
echo.
pause
exit /b 1
