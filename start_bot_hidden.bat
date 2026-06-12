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
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process cmd.exe -ArgumentList '/c _start_bot_background.bat' -WindowStyle Hidden -WorkingDirectory '%~dp0'"
exit



