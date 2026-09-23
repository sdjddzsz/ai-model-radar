@echo off
rem ============================================================
rem  One-click commit + push
rem  Usage:  sync.cmd "what you changed"
rem  Route chain: direct -> local proxy (62923) -> GitHub Data API
rem ============================================================
cd /d "%~dp0"
if "%~1"=="" (set "MSG=update") else (set "MSG=%~1")

echo === git add ===
git add -A
echo === git commit ===
git commit -m "%MSG%"
if errorlevel 1 echo (nothing to commit, or commit failed - see above)

echo === route 1/3: direct ===
git push origin master
if not errorlevel 1 goto done

echo.
echo [!] Direct push failed. Retrying via local proxy 127.0.0.1:62923...
set HTTPS_PROXY=http://127.0.0.1:62923
set HTTP_PROXY=http://127.0.0.1:62923
echo === route 2/3: proxy ===
git push origin master
if not errorlevel 1 goto done

echo.
echo [!] Proxy failed too. Falling back to GitHub Data API (api.github.com)...
echo === route 3/3: api ===
node push-via-api.mjs "%MSG%"
if not errorlevel 1 goto done

echo.
echo [X] All three routes failed - remote is NOT updated.
pause
exit /b 1

:done
echo.
echo Done. https://github.com/sdjddzsz/ai-model-radar
pause
