@echo off
chcp 65001 >nul

set LOCK_FILE=%~dp0\.remoat\.bot.lock
set BOT_STOPPED=0

rem 1. Попытка остановки по PID из Lock-файла
if not exist "%LOCK_FILE%" goto :check_processes

set /p BOT_PID=<"%LOCK_FILE%"
echo [INFO] Stopping Remoat Bot by PID (%BOT_PID%)...
taskkill /f /pid %BOT_PID% >nul 2>nul
if %errorlevel% equ 0 (
    set BOT_STOPPED=1
)
del /f /q "%LOCK_FILE%" >nul 2>nul

:check_processes
rem 2. Проверка, запущены ли еще какие-либо процессы Remoat
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"name = 'node.exe' and (commandline like '%%dist/bin/cli.js%%' or commandline like '%%dist\\bin\\cli.js%%' or commandline like '%%ts-node%%')\") { exit 1 } else { exit 0 }" >nul 2>nul
if %errorlevel% neq 1 goto :final_status

echo [INFO] Cleaning up remaining Remoat processes...
wmic process where "name='node.exe' and (commandline like '%%dist/bin/cli.js%%' or commandline like '%%dist\\bin\\cli.js%%' or commandline like '%%ts-node%%')" call terminate >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name = 'node.exe' and (commandline like '%%dist/bin/cli.js%%' or commandline like '%%dist\\bin\\cli.js%%' or commandline like '%%ts-node%%')\" | Invoke-CimMethod -MethodName Terminate" >nul 2>nul
set BOT_STOPPED=1

:final_status
if %BOT_STOPPED% equ 1 (
    echo [OK] Remoat Bot has been successfully stopped.
    rem Даем операционной системе 2 секунды освободить порт перед новым запуском
    ping -n 3 127.0.0.1 >nul
) else (
    echo [INFO] No active Remoat Bot processes were found running.
)

exit /b 0

