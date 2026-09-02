@echo off
title SAUR BOT - Watchdog
cd /d "%~dp0"

:loop
echo [%date% %time%] Iniciando bot...
node dist/index.js >> saur-bot.log 2>&1
echo [%date% %time%] El bot se detuvo. Reiniciando en 5 segundos... >> saur-bot.log
echo [%date% %time%] El bot se detuvo. Reiniciando en 5 segundos...
timeout /t 5 /nobreak >nul
goto loop
