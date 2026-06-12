@echo off
rem ============================================================================
rem Ручной запуск Remoat Telegram-бота (в видимом окне консоли)
rem Manual Startup for Remoat Telegram Bot (in visible console window)
rem 
rem Сначала останавливает любой запущенный экземпляр бота (включая скрытый),
rem затем запускает бота в активном окне командной строки. Позволяет видеть
rem логи работы в реальном времени. В конце добавлена пауза.
rem ============================================================================

echo [INFO] Stopping any running bot instances before startup...
call "%~dp0stop_bot.bat"

echo.
echo [INFO] Starting Remoat Telegram Bot...
call start_ide.bat
node dist/bin/cli.js start
pause

