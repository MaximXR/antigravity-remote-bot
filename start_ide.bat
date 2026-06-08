@echo off
rem ============================================================================
rem Запуск Antigravity IDE с поддержкой отладки (динамический выбор порта)
rem Starts Antigravity IDE with debugging enabled (dynamic port selection)
rem 
rem Сначала проверяет, работает ли уже IDE на каком-либо из поддерживаемых портов.
rem Если находит активный порт, скрипт завершается без перезапуска.
rem Если активных портов нет, он ищет первый свободный порт из списка предпочтительных,
rem останавливает зависшие процессы и запускает IDE на найденном порту в фоновом режиме.
rem ============================================================================

setlocal enabledelayedexpansion

rem Список портов, которые умеет сканировать бот
set SCANNED_PORTS=9223 9222 9333 9444 9555 9666 61390 61114 61113

rem 1. Проверяем, запущена ли уже IDE на одном из этих портов
for %%p in (%SCANNED_PORTS%) do (
    netstat -ano | find "LISTENING" | find ":%%p " >nul
    if !errorlevel! equ 0 (
        echo [INFO] Antigravity IDE is already running and active on port %%p.
        exit /b 0
    )
)

rem 2. Если IDE не запущена, ищем первый свободный порт для запуска
set LAUNCH_PORT=
for %%p in (9223 9333 9444 9555 9666) do (
    netstat -ano | find "LISTENING" | find ":%%p " >nul
    if !errorlevel! neq 0 (
        set LAUNCH_PORT=%%p
        goto :launch
    )
)

:notfound
echo [ERROR] No available ports found to launch the IDE (checked 9223 9333 9444 9555 9666).
echo         Please close other applications using these ports.
timeout /t 5 >nul
exit /b 1

:launch
echo [INFO] Stopping any hanging Antigravity instances...
taskkill /f /im "Antigravity IDE.exe" 2>nul
taskkill /f /im "Antigravity.exe" 2>nul

echo [INFO] Starting Antigravity IDE on port %LAUNCH_PORT%...
powershell -NoProfile -Command "Start-Process -FilePath \"$env:USERPROFILE\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe\" -ArgumentList '--remote-debugging-port=%LAUNCH_PORT%'"
echo [OK] Antigravity IDE launched on port %LAUNCH_PORT%.
timeout /t 3 >nul
exit /b 0
