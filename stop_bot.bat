@echo off
chcp 65001 >nul

set LOCK_FILE=%~dp0\.remoat\.bot.lock
set BOT_STOPPED=0

rem 1. Check if LOCK_FILE exists and terminate by PID
if not exist "%LOCK_FILE%" goto :check_processes

set /p BOT_PID=<"%LOCK_FILE%"
echo [INFO] Stopping Remoat Bot by PID (%BOT_PID%)...
taskkill /f /pid %BOT_PID% >nul 2>nul
if %errorlevel% equ 0 (
    set BOT_STOPPED=1
)
del /f /q "%LOCK_FILE%" >nul 2>nul

:check_processes
rem 2. Check if there are any active Remoat processes running (wmic check)
wmic process where "name='node.exe' and (commandline like '%%dist/bin/cli.js%%' or commandline like '%%dist\\bin\\cli.js%%' or commandline like '%%ts-node%%')" get processid 2>nul | findstr [0-9] >nul
if %errorlevel% equ 0 (
    set BOT_STOPPED=1
)

rem 3. Check via PowerShell as a fallback
powershell -NoProfile -Command "if (Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object CommandLine -match 'dist.bin.cli.js|ts-node') { exit 1 } else { exit 0 }" >nul 2>nul
if %errorlevel% equ 1 (
    set BOT_STOPPED=1
)

rem 4. If we detected active processes, run the termination commands
if %BOT_STOPPED% neq 1 goto :no_cleanup

echo [INFO] Cleaning up Remoat processes...
wmic process where "name='node.exe' and (commandline like '%%dist/bin/cli.js%%' or commandline like '%%dist\\bin\\cli.js%%' or commandline like '%%ts-node%%')" call terminate >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name = 'node.exe' and (commandline like '%%dist/bin/cli.js%%' or commandline like '%%dist\\bin\\cli.js%%' or commandline like '%%ts-node%%')\" | Invoke-CimMethod -MethodName Terminate" >nul 2>nul

echo [OK] Remoat Bot has been successfully stopped.
rem Allow OS to free up the ports
ping -n 3 127.0.0.1 >nul
goto :exit_script

:no_cleanup
echo [INFO] No active Remoat Bot processes were found running.

:exit_script
exit /b 0



