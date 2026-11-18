@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem 需要先准备工具链（只做一次）：
rem   android\toolchain\jdk\jdk-17*\bin\javac.exe
rem   android\toolchain\buildtools\android-14\  (aapt2 / d8 / zipalign / apksigner)
rem   android\toolchain\platform\android-34\android.jar
rem 见 docs\tutorial.md 的「自己打 APK」一节，里面有下载地址和目录结构。
rem ---------------------------------------------------------------------------

set "JDK=%~dp0toolchain\jdk\jdk-17.0.21+9"
set "BT=%~dp0toolchain\buildtools\android-14"
set "PLAT=%~dp0toolchain\platform\android-34\android.jar"

if not exist "%JDK%\bin\javac.exe" (
  echo.
  echo   找不到 JDK：%JDK%
  echo   请按 docs\tutorial.md 准备工具链后重试。
  exit /b 1
)
if not exist "%PLAT%" (
  echo.
  echo   找不到 android.jar：%PLAT%
  echo   请按 docs\tutorial.md 准备工具链后重试。
  exit /b 1
)

set "JAVA_HOME=%JDK%"
set "PATH=%JDK%\bin;%PATH%"

rem 签名用的 keystore：没有就现生成一个（自己留好，换掉会导致无法覆盖安装）
if not exist keystore.jks (
  echo [0/7] generate keystore
  "%JDK%\bin\keytool.exe" -genkeypair -keystore keystore.jks -storepass chatpig123 -keypass chatpig123 -alias chatpig -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=ChatPig, OU=Personal, O=ChatPig, C=CN" >nul 2>&1
)

echo [1/7] compile resources
if exist build rmdir /s /q build
mkdir build\classes
mkdir build\dex
"%BT%\aapt2.exe" compile --dir res -o build\res.zip || goto fail

echo [2/7] link resources
"%BT%\aapt2.exe" link -o build\base.apk -I "%PLAT%" --manifest AndroidManifest.xml build\res.zip --min-sdk-version 26 --target-sdk-version 30 --version-code 1 --version-name 1.0 || goto fail

echo [3/7] javac
"%JDK%\bin\javac.exe" -nowarn -encoding UTF-8 -source 8 -target 8 -bootclasspath "%PLAT%" -d build\classes src\cn\dsh\chatgptmobile\*.java || goto fail

echo [4/7] d8
call "%BT%\d8.bat" --lib "%PLAT%" --min-api 26 --output build\dex build\classes\cn\dsh\chatgptmobile\*.class || goto fail

echo [5/7] package (resources.arsc kept stored)
python "%~dp0tools\mkapk.py" || goto fail

echo [6/7] zipalign
"%BT%\zipalign.exe" -f 4 build\unsigned.apk build\aligned.apk || goto fail

echo [7/7] sign
call "%BT%\apksigner.bat" sign --ks keystore.jks --ks-pass pass:chatpig123 --key-pass pass:chatpig123 --ks-key-alias chatpig --out "..\ChatPig手机助手.apk" build\aligned.apk || goto fail

echo.
echo   OK: ..\ChatPig手机助手.apk
exit /b 0

:fail
echo.
echo   BUILD FAILED - see messages above.
exit /b 1
