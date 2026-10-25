@echo off
chcp 65001 >nul
title AILens Usage Monitor (9998)
cd /d "%~dp0"
:loop
netstat -ano | findstr :9998 | findstr LISTENING >nul 2>&1
if %errorlevel% equ 0 (
    echo [9998 already running, waiting 60s]
    timeout /t 60 /nobreak >nul
    goto loop
)
set "NODE="
for /f "usebackq delims=" %%N in (`call "%~dp0tools\find-node.cmd"`) do set "NODE=%%N"
if not defined NODE (
  echo [%date% %time%] node.exe not found - set AILENS_NODE >> usage-monitor.log
  timeout /t 60 /nobreak >nul
  goto loop
)
"%NODE%" usage-monitor.mjs >> usage-monitor.log 2>&1
echo [%date% %time%] monitor exited, restarting in 5s >> usage-monitor.log
timeout /t 5 /nobreak >nul
goto loop
