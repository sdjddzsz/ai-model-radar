@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Check if already running
netstat -ano | findstr :9998 | findstr LISTENING >nul 2>&1
if %errorlevel% equ 0 (
    echo [9998 already running] Opening panel...
    start "" http://127.0.0.1:9998/usage-monitor.html
    goto :eof
)

rem Start node in its own MINIMIZED window (independent of this .bat window).
rem /b would share this console and die when the window closes - /min gives it its own.
rem NOTE: a real path to node.exe is required - PATH node fails silently.
rem       Resolved at runtime: WorkBuddy rotates the versions\22.22.2-x folder.
set "NODE="
for /f "usebackq delims=" %%N in (`call "%~dp0tools\find-node.cmd"`) do set "NODE=%%N"
if not defined NODE (
    echo [FAILED] node.exe not found - set AILENS_NODE or check tools\find-node.cmd
    pause
    exit /b 1
)
start "AILens-9998" /min "%NODE%" usage-monitor.mjs

rem Wait 3s then verify and open browser
timeout /t 3 /nobreak >nul
netstat -ano | findstr :9998 | findstr LISTENING >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Panel: http://127.0.0.1:9998/usage-monitor.html
    start "" http://127.0.0.1:9998/usage-monitor.html
) else (
    echo [FAILED] Check usage-monitor.log
    pause
)