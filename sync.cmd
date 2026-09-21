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
echo === git push ===
git push
echo.
echo Done. Check https://github.com to confirm.
pause
