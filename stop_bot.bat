@chcp 65001 >nul
@echo off
SetLocal EnableExtensions
rem ============================================================================
rem Остановка Remoat Telegram-бота (для фонового/скрытого режима)
rem Stopping Remoat Telegram Bot (for background/hidden mode)
rem 
rem Проверяет файл блокировки бота, считывает идентификатор процесса (PID)
rem и принудительно завершает его работу. Очищает за собой файл блокировки.
rem ============================================================================

set LOCK_FILE="%USERPROFILE%\.remoat\.bot.lock"
if not exist %LOCK_FILE% (
    echo [INFO] Bot is not running (no lock file found).
    timeout /t 3 >nul
    exit /b 0
)

set /p BOT_PID=<%LOCK_FILE%
echo [INFO] Stopping Remoat Bot (PID: %BOT_PID%)...
taskkill /f /pid %BOT_PID% >nul 2>nul
del /f /q %LOCK_FILE% >nul 2>nul
echo [OK] Bot stopped.
timeout /t 3 >nul
