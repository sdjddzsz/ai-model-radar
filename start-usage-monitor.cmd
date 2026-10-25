@echo off
chcp 65001 >nul
title AILens 用量监控
cd /d "%~dp0"

:: 动态解析 node.exe（不写死 WorkBuddy 的版本目录：每次升级 Node 都会换目录）
set "NODE="
for /f "usebackq delims=" %%N in (`call "%~dp0tools\find-node.cmd"`) do set "NODE=%%N"
if not defined NODE (
    echo 错误：未找到 node.exe（可用环境变量 AILENS_NODE 指定完整路径）
    pause
    exit /b 1
)

:loop
:: 防重复实例：端口已被占用（另一个实例在跑）→ 等 60s 再查，避免双开刷错误日志
netstat -ano | findstr :9998 | findstr LISTENING >nul 2>&1
if %errorlevel% equ 0 (
    echo [%date% %time%] 端口 9998 已被占用（已有实例运行），等待 60 秒 >> usage-monitor.log
    timeout /t 60 /nobreak >nul
    goto loop
)

"%NODE%" usage-monitor.mjs >> usage-monitor.log 2>&1
echo [%date% %time%] 监控进程退出，5 秒后自动重启 >> usage-monitor.log
timeout /t 5 /nobreak >nul
goto loop
