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
start "AILens" /min node server.mjs
node start.mjs
exit /b 0
