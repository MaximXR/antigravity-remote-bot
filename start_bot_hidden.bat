@echo off
rem ============================================================================
rem Скрытый запуск Remoat Telegram-бота (без черного окна консоли)
rem Hidden Startup for Remoat Telegram Bot (no console window)
rem 
rem Запускает бота в фоновом режиме, используя VBScript-обёртку над
rem внутренним файлом _start_bot_background.bat. Консольное окно
rem автоматически закрывается сразу после старта процесса.
rem 
rem Для остановки бота запустите stop_bot.bat.
rem ============================================================================

echo Set WshShell = CreateObject("WScript.Shell") > "%temp%\remoat_start.vbs"
echo scriptPath = "%~dp0" >> "%temp%\remoat_start.vbs"
echo WshShell.CurrentDirectory = scriptPath >> "%temp%\remoat_start.vbs"
echo WshShell.Run "cmd.exe /c _start_bot_background.bat", 0, False >> "%temp%\remoat_start.vbs"
wscript.exe "%temp%\remoat_start.vbs"
del "%temp%\remoat_start.vbs"
exit
