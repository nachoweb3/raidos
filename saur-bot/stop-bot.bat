@echo off
title SAUR BOT - Stop
echo Buscando el bot...
echo.

:: Kill node processes running our dist/index.js via wmic (precise)
wmic process where "name='node.exe' and commandline like '%%dist\\index.js%%'" get processid 2>nul | findstr /r "[0-9]" > "%temp%\saur_pids.txt"

set FOUND=0
for /f %%p in (%temp%\saur_pids.txt) do (
    echo Deteniendo PID %%p ...
    taskkill //PID %%p //F >nul 2>&1
    set FOUND=1
)

:: Also close the watchdog window
taskkill //FI "WINDOWTITLE eq SAUR BOT - Watchdog*" //F >nul 2>&1

del "%temp%\saur_pids.txt" 2>nul

if %FOUND%==0 (
    echo [!] No se encontro ningun bot corriendo.
) else (
    echo [OK] Bot detenido.
)
echo.
pause
