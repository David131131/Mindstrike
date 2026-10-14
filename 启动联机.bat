@echo off
rem ============================================================
rem  Mindstrike 联机服务器 · 一键启动 (Windows)
rem  双击本文件即可: 自动启动服务器并自动打开浏览器
rem  停止方法: 回到本窗口按 Ctrl+C, 然后关闭窗口
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   警告: 未检测到 Node.js!
  echo   请先到 https://nodejs.org 下载安装 LTS 版, 装好后重新双击本文件。
  echo.
  pause
  exit /b 1
)

set MS_OPEN=1
echo.
echo   Mindstrike 联机服务器启动中…(就绪后会自动打开浏览器)
echo.
node server.js
echo.
echo   服务器已停止。
pause
