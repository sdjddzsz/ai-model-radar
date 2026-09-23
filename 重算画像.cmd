@echo off
chcp 936 >nul
rem ============================================================
rem  任务画像重算 —— 不用经过任何人，双击就跑
rem  扫描近 14 天的工作日志与产物，重新分配各任务的日均调用次数
rem  旧画像会自动备份为 profile.local.mjs.bak
rem ============================================================
cd /d "%~dp0"
set "NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE%" set "NODE=node"

echo.
echo   先看看会改成什么样（不写文件）：
echo.
"%NODE%" profile-scan.mjs --dry
echo.
set /p GO=  写入吗？[Y=写入 / 其他=取消] :
if /i not "%GO%"=="Y" goto cancel

"%NODE%" profile-scan.mjs
echo.
echo   完成。打开 http://localhost:8765/#plan 看（服务会自动热加载，不用重启；
echo   页面最多 5 分钟自己跟上，也可以直接刷新浏览器）。
echo   想还原：把 profile.local.mjs.bak 复制回 profile.local.mjs
echo.
pause
exit /b 0

:cancel
echo.
echo   已取消，什么都没改。
echo.
pause
