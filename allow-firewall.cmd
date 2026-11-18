@echo off
chcp 65001 >nul
title 允许手机访问
net session >nul 2>&1
if %errorlevel%==0 (
  netsh advfirewall firewall delete rule name="ChatGPT手机端" >nul 2>&1
  netsh advfirewall firewall add rule name="ChatGPT手机端" dir=in action=allow protocol=TCP localport=8787
  echo.
  echo   已放行 TCP 8787（仅入站，局域网可用）。
  echo   手机现在应该能打开 start.cmd 里显示的地址了。
  echo.
  pause
  exit /b 0
)
echo   需要管理员权限，正在弹出 UAC 提示，请点「是」...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
