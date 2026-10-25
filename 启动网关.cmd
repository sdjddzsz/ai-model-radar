@echo off
rem ============================================================
rem  AILens gateway launcher (ASCII-only on purpose: .cmd must
rem  survive being read in any console codepage).
rem  Finds node.exe at runtime (WorkBuddy rotates the version
rem  folder on every upgrade), then starts gw-daemon.mjs in its
rem  own minimized console so it outlives this script.
rem ============================================================
setlocal

set "BASE=D:\WorkBuddy\AILens"
if not exist "%BASE%\gw-daemon.mjs" (
  echo [AILens] missing %BASE%\gw-daemon.mjs
  exit /b 1
)

set "NODE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current" (
  set /p VER=<"%USERPROFILE%\.workbuddy\binaries\node\versions\current"
)
if defined VER if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%VER%\node.exe" (
  set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\%VER%\node.exe"
)

if not defined NODE (
  for /f "delims=" %%D in ('dir /b /ad /o-d "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do (
    if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%D\node.exe" (
      if not defined NODE set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\%%D\node.exe"
    )
  )
)

if not defined NODE (
  echo [AILens] node.exe not found under %%USERPROFILE%%\.workbuddy\binaries\node\versions
  exit /b 1
)

cd /d "%BASE%"
start "AILensGateway" /min "%NODE%" "%BASE%\gw-daemon.mjs"
exit /b 0
