@echo off
rem ============================================================
rem  One-click commit + push
rem  Usage:  sync.cmd "what you changed"
rem ============================================================
cd /d "%~dp0"
if "%~1"=="" (set "MSG=update") else (set "MSG=%~1")
echo === git add ===
git add -A
echo === git commit ===
git commit -m "%MSG%"
if errorlevel 1 echo (nothing to commit, or commit failed - see above)
echo === git push (direct) ===
git push origin master
if errorlevel 1 (
  echo.
  echo [!] Direct push failed. Retrying once via local proxy...
  set HTTPS_PROXY=http://127.0.0.1:7890
  set HTTP_PROXY=http://127.0.0.1:7890
  git push origin master
)
echo.
if not errorlevel 1 (
  echo Done. Check https://github.com/sdjddzsz/ai-model-radar
) else (
  echo Failed. If you are in a network where github.com is blocked,
  echo turn on your accelerator and run this script again.
)
pause
