@echo off
chcp 65001 >nul

set LOCK_FILE=%~dp0\.remoat\.bot.lock
set BOT_STOPPED=0

if not exist "%LOCK_FILE%" goto :no_lock_fallback

set /p BOT_PID=<"%LOCK_FILE%"
echo [INFO] Stopping Remoat Bot by PID (%BOT_PID%)...
taskkill /f /pid %BOT_PID% >nul 2>nul
if %errorlevel% equ 0 (
    set BOT_STOPPED=1
)
del /f /q "%LOCK_FILE%" >nul 2>nul

:no_lock_fallback
echo [INFO] Cleaning up any remaining or frozen Remoat processes...
wmic process where "name='node.exe' and (commandline like '%%dist/bin/cli.js%%' or commandline like '%%dist\\bin\\cli.js%%' or commandline like '%%ts-node%%')" call terminate >nul 2>nul
if %errorlevel% equ 0 (
    set BOT_STOPPED=1
)

if %BOT_STOPPED% equ 1 (
    echo [OK] Remoat Bot has been successfully stopped.
) else (
    echo [INFO] No active Remoat Bot processes were found running.
)

ping -n 3 127.0.0.1 >nul
exit /b 0
