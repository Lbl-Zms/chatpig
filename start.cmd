@echo off
chcp 65001 >nul
title ChatPig 手机助手
cd /d "%~dp0"
echo.

rem 服务已经在跑？那就只检查/拉起 ChatGPT，不重复启动
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8787/api/health | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo   ChatPig 手机助手服务已在运行。
  node "tools\ensure.mjs"
  echo.
  echo   地址和配对码见上面 server 的输出，或扫“配对二维码.png”
  echo.
  timeout /t 4 >nul
  exit /b 0
)

echo   正在启动 ChatPig 手机助手…
echo   （会自动带调试端口打开 ChatGPT，约 40 秒后就绪）
echo.
node server.mjs
pause
