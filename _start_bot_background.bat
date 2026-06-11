@chcp 65001 >nul
@echo off
SetLocal EnableExtensions
rem ============================================================================
rem [СЛУЖЕБНЫЙ СКРИПТ] Запуск Telegram-бота в фоновом режиме
rem [INTERNAL SCRIPT] Starts the Telegram bot in background mode
rem 
rem ВНИМАНИЕ: Не запускайте этот файл вручную.
rem Он предназначен для вызова из скрипта start_bot_hidden.bat.
rem В отличие от start_bot.bat, этот файл не содержит команды "pause",
rem что позволяет фоновому процессу завершиться корректно и без зависаний.
rem ============================================================================

call start_ide.bat
if not exist temp mkdir temp
node dist/bin/cli.js start >> temp\bot_run.log 2>&1
