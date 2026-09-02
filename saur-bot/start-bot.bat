@echo off
title SAUR BOT - @inusaurai_bot
cd /d "%~dp0"

:: Build if dist is missing
if not exist dist\index.js (
    echo [+] Compilando por primera vez...
    call npx tsc
)

echo ========================================
echo   SAUR BOT - iniciando en segundo plano
echo   Log: saur-bot.log
echo ========================================
echo.

:: Launch detached with auto-restart watchdog
start "SAUR-BOT" /min cmd /c "watchdog.bat"

echo.
echo [OK] Bot lanzado en una ventana minimizada (SAUR-BOT).
echo      Si el proceso muere, se reinicia solo en 5 segundos.
echo.
echo Para detenerlo: doble clic en stop-bot.bat
echo Puedes cerrar esta ventana.
timeout /t 4 >nul
