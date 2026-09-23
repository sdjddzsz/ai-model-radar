@echo off
rem ============================================================
rem  AI Model Radar launcher (portable, no hardcoded paths)
rem  Requirement: Node.js 22+ available in PATH
rem ============================================================
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Install Node 22+ from https://nodejs.org
  pause
  exit /b 1
)
rem ---- 自动更新开关（去掉行首的 rem 即生效）----
rem set AILENS_START_REFRESH=always   每次启动都全量重抓（默认 stale：缓存超 10 分钟才重抓）
rem set AILENS_STALE_MIN=10            stale 模式下"缓存还算新"的分钟数
rem set AILENS_AUTO_HOURS=6            常驻期间每隔几小时自动重抓（设 0 = 只靠启动那一次）
start "AILens" /min node server.mjs
node start.mjs
exit /b 0
