@echo off
chcp 65001 >nul

set LOCK_FILE=%USERPROFILE%\.remoat\.bot.lock
if not exist "%LOCK_FILE%" goto :not_running

set /p BOT_PID=<"%LOCK_FILE%"
echo [INFO] Stopping Remoat Bot (PID: %BOT_PID%)...
taskkill /f /pid %BOT_PID% >nul 2>nul
del /f /q "%LOCK_FILE%" >nul 2>nul
echo [OK] Bot stopped.
ping -n 4 127.0.0.1 >nul
exit /b 0

:not_running
echo [INFO] Bot is not running (no lock file found).
ping -n 4 127.0.0.1 >nul
exit /b 0
