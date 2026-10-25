@echo off
rem ============================================================
rem  find-node.cmd - print the full path of a usable node.exe
rem
rem  Why: WorkBuddy rotates its managed Node folder on every
rem  upgrade (e.g. versions\22.22.2-3 -> versions\22.22.2-6) and
rem  deletes the old one, so a hardcoded version path breaks with
rem  Windows Script Host error 80070002 ("system cannot find the
rem  file specified"). Never hardcode a version any more - call
rem  this script instead.
rem
rem  Lookup order:
rem    1) env var AILENS_NODE
rem    2) versions\current   (WorkBuddy writes the active version)
rem    3) newest folder under versions\ that contains node.exe
rem    4) node.exe found on PATH
rem
rem  stdout : exactly one line = full path (nothing at all if not found)
rem  exit   : 0 = found, 1 = not found
rem
rem  Usage in a .cmd/.bat:
rem    for /f "usebackq delims=" %%N in (`call "%~dp0tools\find-node.cmd"`) do set "NODE=%%N"
rem ============================================================
setlocal EnableExtensions EnableDelayedExpansion
set "BASE=%USERPROFILE%\.workbuddy\binaries\node"

rem --- 1) explicit override -------------------------------------
if defined AILENS_NODE if exist "%AILENS_NODE%" (
  echo(%AILENS_NODE%
  exit /b 0
)

rem --- 2) version manifest maintained by WorkBuddy --------------
if exist "%BASE%\versions\current" (
  set "VER="
  for /f "usebackq delims=" %%V in ("%BASE%\versions\current") do set "VER=%%V"
  if defined VER if exist "%BASE%\versions\!VER!\node.exe" (
    echo(%BASE%\versions\!VER!\node.exe
    exit /b 0
  )
)

rem --- 3) newest version folder ---------------------------------
for /f "delims=" %%D in ('dir /b /ad /o-d "%BASE%\versions" 2^>nul') do (
  if exist "%BASE%\versions\%%D\node.exe" (
    echo(%BASE%\versions\%%D\node.exe
    exit /b 0
  )
)

rem --- 4) PATH fallback -----------------------------------------
for %%P in (node.exe) do if not "%%~$PATH:P"=="" (
  echo(%%~$PATH:P
  exit /b 0
)

exit /b 1
