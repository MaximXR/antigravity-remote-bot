@echo off
rem ============================================================================
rem Manual Startup for Remoat Telegram Bot (in visible console window)
rem 
rem Stops any running instance of the bot first (including hidden ones),
rem then launches the bot in the active command line window.
rem ============================================================================

echo [INFO] Checking and stopping any running bot instances...
call "%~dp0stop_bot.bat"

echo.
echo [INFO] Starting Remoat Telegram Bot...
call start_ide.bat
node dist/bin/cli.js start
pause


