@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "CANGXIA_SCROLL_NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%CANGXIA_SCROLL_NODE%" set "CANGXIA_SCROLL_NODE=node"
"%CANGXIA_SCROLL_NODE%" scripts\favorite-scroll\launch.mjs
if errorlevel 1 (
  echo.
  echo Startup failed. See the startup log in this folder.
  pause
)
endlocal
