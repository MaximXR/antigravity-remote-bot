@chcp 65001 >nul
@echo off
SetLocal EnableExtensions
rem ============================================================================
rem Hidden Startup for Remoat Telegram Bot (no console window)
rem 
rem Automatically stops any running instance of the bot first,
rem then launches the bot in the background using a VBScript wrapper
rem over _start_bot_background.bat.
rem ============================================================================

echo [INFO] Checking and stopping any running bot instances...
call "%~dp0stop_bot.bat"

echo.
echo [INFO] Starting Remoat Bot in background mode...
echo Set WshShell = CreateObject("WScript.Shell") > "%temp%\remoat_start.vbs"
echo scriptPath = "%~dp0" >> "%temp%\remoat_start.vbs"
echo WshShell.CurrentDirectory = scriptPath >> "%temp%\remoat_start.vbs"
echo WshShell.Run "cmd.exe /c _start_bot_background.bat", 0, False >> "%temp%\remoat_start.vbs"
wscript.exe "%temp%\remoat_start.vbs"
del "%temp%\remoat_start.vbs"
exit



