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
set "WORK_DIR=%~dp0"
if "%WORK_DIR:~-1%"=="\" set "WORK_DIR=%WORK_DIR:~0,-1%"
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process cmd.exe -ArgumentList '/c _start_bot_background.bat' -WindowStyle Hidden -WorkingDirectory '%WORK_DIR%'"
exit



