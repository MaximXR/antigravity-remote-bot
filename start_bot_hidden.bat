@chcp 65001 >nul
@echo off
SetLocal EnableExtensions
rem ============================================================================
rem Скрытый запуск Remoat Telegram-бота (без черного окна консоли)
rem Hidden Startup for Remoat Telegram Bot (no console window)
rem 
rem Сначала останавливает любой запущенный экземпляр бота, затем
rem запускает бота в фоновом режиме через VBScript-обёртку над
rem внутренним файлом _start_bot_background.bat.
rem ============================================================================

echo [INFO] Stopping any running bot instances before startup...
call "%~dp0stop_bot.bat"

echo.
echo [INFO] Starting Remoat Bot in background mode...
echo Set WshShell = CreateObject("WScript.Shell") > "%temp%\remoat_start.vbs"
echo scriptPath = "%~dp0" >> "%temp%\remoat_start.vbs"
echo WshShell.CurrentDirectory = scriptPath >> "%temp%\remoat_start.vbs"
echo WshShell.Run "cmd.exe /c _start_bot_background.bat", 0, False >> "%temp%\remoat_start.vbs"
wscript.exe "%temp%\remoat_start.vbs"
del "%temp%\remoat_start.vbs"
echo [OK] Startup script initialized.
ping -n 2 127.0.0.1 >nul
exit

