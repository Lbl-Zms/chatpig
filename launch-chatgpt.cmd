@echo off
chcp 65001 >nul
rem 带调试端口启动 ChatGPT，供手机端接管
set "EXE=C:\Program Files\WindowsApps\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe"
if not exist "%EXE%" (
  for /d %%D in ("C:\Program Files\WindowsApps\OpenAI.Codex_*") do if exist "%%D\app\ChatGPT.exe" set "EXE=%%D\app\ChatGPT.exe"
)
echo 启动: %EXE%
start "" "%EXE%" --remote-debugging-port=9222
