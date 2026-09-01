@echo off
REM Stops the local database and app started by start.bat.
REM Only touches the processes listening on 5432 and 3000.

cd /d "%~dp0"
title AI Lead Generator Agent - stopping

echo.
echo   Stopping AI Lead Generator Agent...
echo.

call :killport 3000 "app"
call :killport 5432 "database"

echo.
echo   Done. Your data in .pgdata is untouched.
echo.
ping -n 3 127.0.0.1 >nul
exit /b 0

:killport
set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:":%~1" ^| findstr /i "LISTENING"') do (
  if not "%%P"=="0" (
    taskkill /f /pid %%P >nul 2>&1
    if not errorlevel 1 (
      echo   Stopped %~2 ^(pid %%P^)
      set "FOUND=1"
    )
  )
)
if not defined FOUND echo   No %~2 was running on port %~1
exit /b 0
